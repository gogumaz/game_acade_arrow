// 관리자 테스트 플레이 (§11.6 · admin §9.5 — 계획 T10 · ADM-107)
//
// 무집계는 WU-04 `'free'` 경로가 이미 보장한다. 여기서는 ① 관찰 모델(도달 보드·보드별 시간·
// 오입력) ② 구간·시드 지정 재현 ③ 앱 전 경로에서 크레딧·랭킹·통계·점수 분포가 **전부 그대로**
// 인지를 판정한다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, PARAM_TIERS } from '../../src/core/adminParams';
import {
  TEST_PLAY_DEFAULT,
  TIER_REPRESENTATIVE_BOARD,
  TestPlaySession,
  asBoardTier,
  testPlayBoardSource,
  tierOfBoard,
} from '../../src/game/admin/testPlay';
import type { BoardSource } from '../../src/game/boardSource';
import type { RunSnapshot } from '../../src/game/runController';
import { TEST_PLAY_ABORT_HOLD_MS } from '../../src/game/app';
import { TUTORIAL_IDLE_MS } from '../../src/game/timing';
import { flushAsync, makeAdmin, makeApp, openBoard } from './harness';

function snap(boardNumber: number, lastBlock: RunSnapshot['lastBlock'] = null): RunSnapshot {
  return {
    boardNumber,
    tier: 'WARMUP',
    tierLabel: '워밍업',
    chains: [],
    focusPath: [],
    focusId: null,
    removing: [],
    timeRemainingMs: 60000,
    hearts: 3,
    displayScore: 0,
    comboCentis: 100,
    maxComboCentis: 100,
    chainsLeft: 1,
    chainsTotal: 1,
    hint: { state: 'READY', targetId: null, cooldownLeftMs: 0 },
    hintUses: 0,
    lastBlock,
    lastClear: null,
    transitioning: false,
    continueCount: 0,
    clearedBoards: 0,
    tutorial: false,
  };
}

describe('12-1 구간·시드 지정 (§6.6 보드 단위 재현성)', () => {
  it('구간마다 대표 보드 번호가 있다', () => {
    expect(TIER_REPRESENTATIVE_BOARD).toEqual({
      WARMUP: 1,
      RHYTHM: 4,
      PRESSURE: 7,
      MASTER: 10,
      ENDLESS: 13,
    });
  });

  it('대표 보드 번호가 실제로 그 구간이다', () => {
    for (const tier of PARAM_TIERS) {
      expect(tierOfBoard(TIER_REPRESENTATIVE_BOARD[tier])).toBe(tier);
    }
  });

  it('기본 사양은 워밍업 시드 1이다', () => {
    expect(TEST_PLAY_DEFAULT).toEqual({ tier: 'WARMUP', seed: 1 });
  });

  it('래퍼가 보드 번호를 지정 구간으로 사상한다', () => {
    const seen: number[] = [];
    const base: BoardSource = {
      next: (req) => {
        seen.push(req.boardNumber);
        return openBoard(1, req.boardNumber);
      },
    };
    const wrapped = testPlayBoardSource(base, { tier: 'MASTER', seed: 3 });
    wrapped.next({ boardNumber: 1, seed: 'x' });
    wrapped.next({ boardNumber: 2, seed: 'x' });
    expect(seen).toEqual([10, 11]);
  });

  it('시드 문자열이 구간·시드·보드로 결정된다 (같은 지정 → 같은 시드)', () => {
    const seeds: string[] = [];
    const base: BoardSource = {
      next: (req) => {
        seeds.push(req.seed);
        return openBoard(1, req.boardNumber);
      },
    };
    const a = testPlayBoardSource(base, { tier: 'PRESSURE', seed: 9 });
    a.next({ boardNumber: 1, seed: 'ignored' });
    const b = testPlayBoardSource(base, { tier: 'PRESSURE', seed: 9 });
    b.next({ boardNumber: 1, seed: 'ignored' });
    expect(seeds[0]).toBe(seeds[1]);
    expect(seeds[0]).toContain('PRESSURE');
    expect(seeds[0]).toContain('9');
  });

  it('시드가 다르면 보드 시드도 다르다', () => {
    const seeds: string[] = [];
    const base: BoardSource = {
      next: (req) => {
        seeds.push(req.seed);
        return openBoard(1, req.boardNumber);
      },
    };
    testPlayBoardSource(base, { tier: 'WARMUP', seed: 1 }).next({ boardNumber: 1, seed: '' });
    testPlayBoardSource(base, { tier: 'WARMUP', seed: 2 }).next({ boardNumber: 1, seed: '' });
    expect(seeds[0]).not.toBe(seeds[1]);
  });

  it('구간 타입이 `boardSource.Tier`와 호환된다', () => {
    expect(asBoardTier('ENDLESS')).toBe('ENDLESS');
  });
});

describe('12-2 결과 관찰 (§11.6 결과 5항목)', () => {
  it('시작 전에는 비활성이다', () => {
    const s = new TestPlaySession();
    expect(s.active).toBe(false);
    expect(s.lastReport).toBe(null);
  });

  it('시작하면 활성이 되고 사양을 기억한다', () => {
    const s = new TestPlaySession();
    s.begin({ tier: 'MASTER', seed: 4 }, 0);
    expect(s.active).toBe(true);
    expect(s.currentSpec).toEqual({ tier: 'MASTER', seed: 4 });
  });

  it('도달 보드 최댓값을 센다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1), 0);
    s.observe(snap(2), 1000);
    s.observe(snap(3), 2000);
    expect(s.end({ score: 0, grade: null }, 3000).boardReached).toBe(3);
  });

  it('보드별 클리어 시간을 남긴다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1), 0);
    s.observe(snap(2), 1200);
    const report = s.end({ score: 0, grade: null }, 3000);
    expect(report.boardTimes).toEqual([
      { board: 1, ms: 1200 },
      { board: 2, ms: 1800 },
    ]);
  });

  it('막힘 전이를 오입력으로 센다 (core·flow API 추가 없이)', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1), 0);
    s.observe(snap(1, { chainId: 3, blockers: [4], atMs: 100 }), 100);
    s.observe(snap(1, { chainId: 3, blockers: [4], atMs: 100 }), 150); // 같은 막힘 — 중복 없음
    s.observe(snap(1, null), 200);
    s.observe(snap(1, { chainId: 5, blockers: [6], atMs: 300 }), 300);
    expect(s.end({ score: 0, grade: null }, 400).mistakes).toBe(2);
  });

  it('같은 사슬이라도 시각이 다르면 다른 오입력이다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1, { chainId: 3, blockers: [], atMs: 100 }), 100);
    s.observe(snap(1, { chainId: 3, blockers: [], atMs: 200 }), 200);
    expect(s.end({ score: 0, grade: null }, 300).mistakes).toBe(2);
  });

  it('점수와 등급을 결과에 담는다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1), 0);
    const report = s.end({ score: 12345, grade: 'A' }, 5000);
    expect(report.score).toBe(12345);
    expect(report.grade).toBe('A');
    expect(report.totalMs).toBe(5000);
  });

  it('종료 뒤에는 비활성이고 결과가 남는다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1), 0);
    s.end({ score: 1, grade: 'C' }, 100);
    expect(s.active).toBe(false);
    expect(s.lastReport?.score).toBe(1);
  });

  it('비활성 상태의 관찰은 무시한다', () => {
    const s = new TestPlaySession();
    s.observe(snap(5), 0);
    expect(s.lastReport).toBe(null);
  });

  it('런이 없으면(null 스냅샷) 아무 일도 없다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(null, 100);
    expect(s.end({ score: 0, grade: null }, 200).boardReached).toBe(0);
  });

  it('다시 시작하면 이전 집계가 지워진다', () => {
    const s = new TestPlaySession();
    s.begin(TEST_PLAY_DEFAULT, 0);
    s.observe(snap(1, { chainId: 1, blockers: [], atMs: 1 }), 0);
    s.end({ score: 5, grade: 'C' }, 100);
    s.begin({ tier: 'RHYTHM', seed: 2 }, 200);
    s.observe(snap(1), 200);
    const report = s.end({ score: 0, grade: null }, 300);
    expect(report.mistakes).toBe(0);
    expect(report.spec.tier).toBe('RHYTHM');
  });
});

describe('12-3 컨트롤러 화면', () => {
  it('TIER·SEED를 레버로 바꾼다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    rig.press('RIGHT');
    expect(rig.admin.view().rows[0].value).toBe('RHYTHM');
    rig.press('DOWN');
    rig.press('RIGHT');
    expect(rig.admin.view().rows[1].value).toBe('2');
  });

  it('시드는 1 아래로 내려가지 않는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    rig.press('DOWN');
    rig.press('LEFT');
    rig.press('LEFT');
    expect(rig.admin.view().rows[1].value).toBe('1');
  });

  it('구간 목록 끝에서 멈춘다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    for (let i = 0; i < 10; i += 1) rig.press('RIGHT');
    expect(rig.admin.view().rows[0].value).toBe('ENDLESS');
    for (let i = 0; i < 10; i += 1) rig.press('LEFT');
    expect(rig.admin.view().rows[0].value).toBe('WARMUP');
  });

  it('`TEST PLAY · NO CREDIT / NO RANKING / NO STATS` 배너가 있다 (admin 부록 A)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    expect(rig.admin.view().rows.find((r) => r.id === 'testplay.banner')?.value).toBe(
      'TEST PLAY · NO CREDIT / NO RANKING / NO STATS'
    );
  });

  it('START가 테스트 플레이 포트를 부른다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    expect(rig.focus('testplay.start')).toBe(true);
    rig.press('BUTTON1');
    expect(rig.testPlayCalls.started).toBe(1);
  });

  it('검증 오류가 있으면 테스트 플레이도 막힌다 (§11.5 "저장·테스트 불가")', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_GRADE']);
    for (let i = 0; i < 300; i += 1) rig.press('LEFT');
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    rig.focus('testplay.start');
    rig.press('BUTTON1');
    expect(rig.testPlayCalls.started).toBe(0);
    expect(rig.admin.view().toast?.level).toBe('error');
  });

  it('시작·종료가 감사 로그에 남는다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    rig.focus('testplay.start');
    rig.press('BUTTON1');
    rig.admin.endTestPlay({ score: 1000, grade: 'C' });
    const logs = rig.audits.filter((e) => e.kind === 'TEST_PLAY');
    expect(logs.map((e) => e.target)).toEqual(['START', 'END']);
    expect(rig.testPlayCalls.stopped).toBe(1);
  });

  it('결과 5항목이 화면에 뜬다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    rig.focus('testplay.start');
    rig.press('BUTTON1');
    rig.clock.advance(4000);
    rig.admin.tick();
    rig.admin.endTestPlay({ score: 4321, grade: 'B' });
    const rows = rig.admin.view().rows;
    for (const id of [
      'testplay.r.board',
      'testplay.r.miss',
      'testplay.r.score',
      'testplay.r.grade',
      'testplay.r.time',
    ]) {
      expect(rows.some((r) => r.id === id)).toBe(true);
    }
    expect(rows.find((r) => r.id === 'testplay.r.score')?.value).toBe('4,321');
  });
});

describe('12-4 무집계 (ADM-107 — 앱 전 경로)', () => {
  it('테스트 런은 크레딧·통계·랭킹·점수 분포를 건드리지 않는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    const before = {
      balance: rig.app.credits.balance(),
      view: rig.app.credits.view(),
      ranking: rig.app.ranking.size,
    };

    rig.app.setTestPlay(true);
    rig.send('SERVICE'); // ATTRACT → ADMIN
    rig.send('SERVICE'); // ADMIN → READY (테스트 플레이는 크레딧 없이도 시작 가능)
    rig.send('START');
    expect(['TUTORIAL', 'RUN']).toContain(rig.app.flow.screen);

    expect(rig.app.credits.balance()).toEqual(before.balance);
    expect(rig.app.credits.view()).toEqual(before.view);
    expect(rig.app.ranking.size).toBe(before.ranking);
    expect(rig.app.credits.view().scoreSamples).toBe(0);
  });

  it('런을 **끝까지** 돌려도 통계·랭킹·점수 분포가 그대로다 (무집계의 실제 위험 구간)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    const before = {
      balance: rig.app.credits.balance(),
      view: rig.app.credits.view(),
      ranking: rig.app.ranking.size,
      creditLog: rig.storage.kv.dump('credit_log.csv'),
    };

    rig.press('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    for (let i = 0; i < 6; i += 1) {
      const view = rig.app.admin.view();
      if (view.rows[view.cursor]?.id === 'testplay.start') break;
      rig.send('DOWN');
    }
    rig.send('BUTTON1');
    await flushAsync();

    // 튜토리얼 → 본 런
    rig.clock.advance(TUTORIAL_IDLE_MS);
    rig.app.flow.tick();
    expect(rig.app.flow.screen).toBe('RUN');

    // 점수를 실제로 낸다 — 보드의 안전 사슬을 전부 당긴다
    for (let i = 0; i < 6; i += 1) {
      rig.press('BUTTON1');
      rig.clock.advance(300);
      rig.app.flow.tick();
    }
    expect(rig.app.flow.snapshot().run?.displayScore ?? 0).toBeGreaterThan(0);

    // 세션 시간을 소진해 런을 끝낸다 → CONTINUE(차단) → RESULT → 세션 종료
    rig.clock.advance(FACTORY_ADMIN_PARAMS.core.sessionTimeSec * 1000);
    rig.app.flow.tick();
    if (rig.app.flow.screen === 'CONTINUE') rig.press('BUTTON2');
    expect(rig.app.flow.screen).toBe('RESULT');
    const result = rig.app.flow.snapshot().result;
    expect(result?.score ?? 0).toBeGreaterThan(0);
    expect(result?.qualifies).toBe(false); // 랭킹 후보가 되지 않는다
    rig.press('BUTTON1'); // RESULT 종료 = 세션 종료(집계 지점)

    const after = {
      balance: rig.app.credits.balance(),
      view: rig.app.credits.view(),
      ranking: rig.app.ranking.size,
      creditLog: rig.storage.kv.dump('credit_log.csv'),
    };
    expect(after.balance).toEqual(before.balance);
    expect(after.view).toEqual(before.view);
    expect(after.view.scoreSamples).toBe(0); // 점수 분포 표본 미적립
    expect(after.view.boardHistogram).toEqual([]); // 도달 보드 히스토그램 미적립
    expect(after.view.occupancySessions).toBe(before.view.occupancySessions);
    expect(after.ranking).toBe(0);
    expect(after.creditLog).toBe(before.creditLog);
    // 관리자로 되돌아왔다
    expect(rig.app.flow.screen).toBe('ADMIN');
    expect(rig.app.isTestPlay()).toBe(false);
  });

  it('테스트 플레이는 컨티뉴가 차단된다 (CRD-607)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.app.setTestPlay(true);
    expect(rig.app.credits.canContinue()).toBe(false);
    expect(rig.app.credits.canStart()).toBe(true);
  });

  it('테스트 중 코인은 정상 적립한다 (§11.6)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.app.setTestPlay(true);
    rig.send('COIN');
    expect(rig.app.credits.balance().paid).toBe(1);
    expect(rig.app.credits.view().coinPulseTotal).toBe(1);
  });

  it('`G` 2초 홀드로 편집 화면에 돌아오고 **작업 사본이 남는다** (§11.6)', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.press('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.send('RIGHT'); // 작업 사본 편집
    expect(rig.app.admin.draft.core.sessionTimeSec).toBe(121);

    rig.app.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    for (let i = 0; i < 6; i += 1) {
      const view = rig.app.admin.view();
      if (view.rows[view.cursor]?.id === 'testplay.start') break;
      rig.send('DOWN');
    }
    rig.send('BUTTON1');
    await flushAsync();
    expect(rig.app.flow.screen).not.toBe('ADMIN');

    // 0.5초 홀드는 복귀하지 않는다
    rig.input.down('BUTTON2');
    rig.clock.advance(500);
    rig.input.up('BUTTON2');
    expect(rig.app.flow.screen).not.toBe('ADMIN');

    // 2초 홀드로 복귀
    rig.input.down('BUTTON2');
    rig.clock.advance(TEST_PLAY_ABORT_HOLD_MS);
    rig.input.up('BUTTON2');
    expect(rig.app.flow.screen).toBe('ADMIN');
    expect(rig.app.isTestPlay()).toBe(false);
    // 편집하던 화면과 작업 사본이 그대로다
    expect(rig.app.admin.currentPath).toEqual(['PARAMS', 'P_TESTPLAY']);
    expect(rig.app.admin.draft.core.sessionTimeSec).toBe(121);
    expect(rig.app.admin.testPlayReport).not.toBe(null);
  });

  it('테스트 플레이 밖에서는 `G` 홀드가 아무 일도 하지 않는다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.press('SERVICE');
    rig.input.down('BUTTON2');
    rig.clock.advance(TEST_PLAY_ABORT_HOLD_MS * 2);
    rig.input.up('BUTTON2');
    expect(rig.app.flow.screen).toBe('ADMIN');
  });

  it('테스트 플레이 시작이 관리자 화면에서 지정 구간 보드를 요청한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.app.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    rig.send('RIGHT'); // TIER → RHYTHM
    for (let i = 0; i < 6; i += 1) {
      const view = rig.app.admin.view();
      if (view.rows[view.cursor]?.id === 'testplay.start') break;
      rig.send('DOWN');
    }
    rig.boardNumbers.length = 0;
    rig.send('BUTTON1'); // START TEST PLAY
    await flushAsync();
    expect(rig.app.isTestPlay()).toBe(true);
    // 미니 튜토리얼은 전용 보드라 공급원을 거치지 않는다 — 본 런에 들어가야 지정 구간이 나온다
    rig.clock.advance(TUTORIAL_IDLE_MS);
    rig.app.flow.tick();
    expect(rig.app.flow.screen).toBe('RUN');
    expect(rig.boardNumbers.some((n) => n >= TIER_REPRESENTATIVE_BOARD.RHYTHM)).toBe(true);
  });
});
