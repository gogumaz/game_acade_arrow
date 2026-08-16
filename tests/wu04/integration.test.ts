// 통합 — `createApp()` 전 경로로 인수 CRD-601~607 · SES-208~209를 판정한다.
//
// 여기서만 할 수 있는 두 가지
//   ① **프로세스 재기동** — 같은 저장소(`MemoryKeyValue`) 위에서 `createApp()`을 두 번 부른다.
//      크래시 뒤 부팅과 완전히 같은 경로라 CRD-606을 자동 판정할 수 있다.
//   ② **CSV 문자열 그대로 단언** — §12 실제 플레이 증거와 같은 내용을 기계가 다시 확인한다.

import { describe, it, expect } from 'vitest';
import { createChain } from '../../src/core/chain';
import { FACTORY_PARAMS } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import type { GridPoint, InputAction } from '../../src/core/types';
import { CREDIT_LOG_HEADER, parseCreditLogCsv } from '../../src/persist/csv';
import { systemWallClock, type BootResult } from '../../src/game/app';
import { RUN_IDLE_END_MS, TUTORIAL_IDLE_MS, TUTORIAL_MAX_PLAYS } from '../../src/game/timing';
import { FILES, MemoryKeyValue, MutableWallClock, makeApp, type AppRig } from './harness';

const SLIDE_MS = 202;

function p(x: number, y: number): GridPoint {
  return { x, y };
}

/** 안전 사슬(대표점 x=12) + 막힌 쌍 — 점수를 낸 뒤 하트를 소진할 수 있다 */
function scoringBoard(n: number): Board {
  return new Board({
    chains: [
      createChain(1, [p(1, 9), p(2, 9)], 1),
      createChain(2, [p(6, 8), p(6, 9), p(6, 10)], 0),
      createChain(3, [p(11, 0), p(12, 0)], 0),
    ],
    boardNumber: n,
    seed: `wu04-scoring-${String(n)}`,
  });
}

interface Rig extends AppRig {
  press(action: InputAction): void;
}

async function boot(
  opts: {
    kv?: MemoryKeyValue;
    wall?: MutableWallClock;
    coinsPerPlay?: number;
    continueCoins?: number;
    coinUnitPrice?: number | null;
  } = {}
): Promise<Rig> {
  const rig = makeApp({
    ...opts,
    boards: scoringBoard,
    params: { initialHearts: 1 },
  });
  await rig.app.ready;
  return {
    ...rig,
    press(action: InputAction): void {
      rig.send(action);
      rig.app.flow.tick();
    },
  };
}

/** 예약 저장·append가 실제로 파일에 닿게 한다 */
async function settle(rig: Rig): Promise<void> {
  await rig.app.credits.flushLog();
  rig.storage.flush();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 코인 → START → (튜토리얼 통과) → RUN */
function toRun(rig: Rig): void {
  rig.send('COIN');
  rig.send('START');
  if (rig.app.flow.screen === 'TUTORIAL') {
    rig.clock.advance(TUTORIAL_IDLE_MS);
    rig.app.flow.tick();
  }
}

/**
 * 랭킹을 만점 기록으로 채워 `qualifies`를 항상 false로 만든다.
 * 결과 화면이 이름 입력으로 새지 않아 **세션 종료 시각을 테스트가 통제**할 수 있다.
 */
function fillRanking(rig: Rig): void {
  for (let i = 0; i < 10; i += 1) {
    rig.app.ranking.submit({
      initials: 'AAA',
      score: 1_000_000,
      board: 99,
      maxComboCentis: 100,
      continues: 0,
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
  }
}

/** 튜토리얼·런을 무입력으로 흘려보내 READY/ATTRACT까지 되돌아온다 (점수 0 → 랭킹 무관) */
function endRunToAttract(rig: Rig): void {
  if (rig.app.flow.screen === 'TUTORIAL') {
    rig.clock.advance(TUTORIAL_IDLE_MS);
    rig.app.flow.tick();
  }
  rig.clock.advance(RUN_IDLE_END_MS);
  rig.app.flow.tick(); // §2.7 다 — 무입력 종료는 CONTINUE를 건너뛴다
  rig.press('BUTTON1');
}

/** 안전 사슬 1개로 점수를 낸 뒤 막힌 사슬을 당겨 하트를 소진한다 → CONTINUE */
function playToDeath(rig: Rig): void {
  toRun(rig);
  rig.send('RIGHT');
  rig.send('RIGHT');
  rig.send('BUTTON1');
  rig.clock.advance(SLIDE_MS);
  rig.app.flow.tick();
  rig.send('LEFT');
  rig.send('BUTTON1');
  rig.app.flow.tick();
}

describe('CRD-601 — 차감 시점 (§10.2)', () => {
  it('런 시작 차감은 START 직후·미니 튜토리얼 진입 **전**이다', async () => {
    const rig = await boot();
    rig.send('COIN');
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.balance().paid).toBe(1);
    rig.send('START');
    // 튜토리얼 화면에 도착한 시점에는 이미 차감이 끝나 있다
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.balance().paid).toBe(0);
  });

  it('컨티뉴 차감은 확정 입력 직후·보드 복귀 **전**이다', async () => {
    const rig = await boot();
    playToDeath(rig);
    expect(rig.app.flow.screen).toBe('CONTINUE');
    rig.send('COIN');
    expect(rig.app.credits.balance().paid).toBe(1); // 코인만으로는 차감되지 않는다
    rig.send('BUTTON1');
    expect(rig.app.flow.screen).toBe('RUN');
    expect(rig.app.credits.balance().paid).toBe(0);
  });

  it('크레딧이 없으면 차감도 진입도 없다', async () => {
    const rig = await boot();
    rig.send('START');
    expect(rig.app.flow.screen).toBe('ATTRACT');
    expect(rig.app.credits.view().paidPlayTotal).toBe(0);
  });
});

describe('CRD-602 — 상한과 거부 표시', () => {
  it('99에서 코인을 더 넣으면 거부음이 나고 잔액이 그대로다', async () => {
    const rig = await boot();
    for (let i = 0; i < 99; i += 1) rig.send('COIN');
    rig.sfx.clear();
    rig.send('COIN');
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.app.credits.balance().paid).toBe(99);
  });
});

describe('CRD-603 — 혼합 결제 금지 (전 경로)', () => {
  it('이벤트로 전액을 낼 수 있으면 유료 잔액이 줄지 않는다', async () => {
    const rig = await boot({ coinsPerPlay: 2 });
    rig.app.credits.grantEvent(3);
    rig.send('COIN');
    rig.send('COIN');
    rig.send('START');
    expect(rig.app.credits.balance()).toEqual({ paid: 2, event: 1 });
    expect(rig.app.credits.view()).toMatchObject({ eventPlayTotal: 1, paidPlayTotal: 0 });
  });

  it('이벤트가 부족하면 PAID 단독으로 결제한다', async () => {
    const rig = await boot({ coinsPerPlay: 3 });
    rig.app.credits.grantEvent(2);
    for (let i = 0; i < 4; i += 1) rig.send('COIN');
    rig.send('START');
    expect(rig.app.credits.balance()).toEqual({ paid: 1, event: 2 });
  });

  it('credit_log의 source 칸은 언제나 단독이다', async () => {
    const rig = await boot({ coinsPerPlay: 2 });
    rig.app.credits.grantEvent(2);
    rig.send('COIN');
    rig.send('COIN');
    rig.send('START');
    await settle(rig);
    const rows = parseCreditLogCsv(rig.storage.kv.dump(FILES.creditLog) ?? '');
    const pay = rows.filter((r) => r.action === 'pay');
    expect(pay).toHaveLength(1);
    expect(['paid', 'event']).toContain(pay[0].source);
  });
});

describe('CRD-604 — 통계 집계 (1런 전 경로)', () => {
  it('유료 플레이 1 · 컨티뉴 1 · 점유 시간 · 도달 보드가 정확히 쌓인다', async () => {
    const rig = await boot();
    fillRanking(rig); // 이름 입력으로 새지 않게 (세션 종료 시각을 테스트가 통제한다)
    rig.clock.set(1000);
    playToDeath(rig); // 결제 → 런 → 하트 소진
    rig.send('COIN');
    rig.send('BUTTON1'); // 컨티뉴
    expect(rig.app.flow.screen).toBe('RUN');
    rig.clock.set(400_000);
    rig.app.flow.tick(); // §2.7 다 — 5분 무입력이면 CONTINUE를 건너뛰고 결과로
    expect(rig.app.flow.screen).toBe('RESULT');
    rig.press('BUTTON1'); // 결과 화면 종료 = 세션 점유 시간의 끝
    expect(['READY', 'ATTRACT']).toContain(rig.app.flow.screen);

    const v = rig.app.credits.view();
    expect(v).toMatchObject({ paidPlayTotal: 1, paidPlayToday: 1, paidContinue: 1 });
    expect(v.occupancyMsTotal).toBe(399_000); // 결제(1000) ~ 결과 종료(400000)
    expect(v.occupancySessions).toBe(1);
    expect(v.boardHistogram).toEqual([{ board: 1, count: 1 }]);
    expect(v.scoreSamples).toBe(1);
  });

  it('영구 코인 미터가 코인 수와 같다 (admin §7.2)', async () => {
    const rig = await boot();
    for (let i = 0; i < 3; i += 1) rig.send('COIN');
    expect(rig.app.credits.view()).toMatchObject({
      coinPulseTotal: 3,
      coinPulseToday: 3,
      paidCreditGranted: 3,
    });
  });

  it('ESTIMATED GROSS는 단가를 주면 계산된다', async () => {
    const rig = await boot({ coinUnitPrice: 1000 });
    for (let i = 0; i < 2; i += 1) rig.send('COIN');
    expect(rig.app.credits.estimatedGross()).toBe(2000);
  });
});

describe('CRD-605 — 날짜 롤오버 (관리자 진입 경로)', () => {
  it('SERVICE 키로 관리자에 들어가면 날짜를 확인한다 (§10.5 4지점 중 3번째)', async () => {
    const wall = new MutableWallClock();
    const rig = await boot({ wall });
    rig.send('COIN');
    rig.send('START');
    expect(rig.app.credits.view().paidPlayToday).toBe(1);

    wall.nextDay('2026-08-17');
    rig.app.flow.handle('SERVICE'); // RUN 중에는 무시된다
    rig.app.credits.noteAdminEntered();
    expect(rig.app.credits.view()).toMatchObject({ paidPlayToday: 0, paidPlayTotal: 1 });
  });

  it('어트랙트에서 SERVICE 키를 누르면 ADMIN으로 가고 롤오버가 돈다', async () => {
    const wall = new MutableWallClock();
    const rig = await boot({ wall });
    rig.send('COIN');
    rig.send('START'); // READY → TUTORIAL (1 차감)
    expect(rig.app.credits.view().paidPlayToday).toBe(1);

    wall.nextDay('2026-08-17');
    rig.send('SERVICE'); // 플레이 중에는 무시된다 (admin §2.2)
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.view().paidPlayToday).toBe(1);

    rig.send('COIN'); // 어트랙트가 아닌 화면에서도 코인은 적립된다
    endRunToAttract(rig);
    rig.send('SERVICE');
    expect(rig.app.flow.screen).toBe('ADMIN');
    expect(rig.app.credits.view()).toMatchObject({ paidPlayToday: 0, paidPlayTotal: 1 });
  });
});

describe('SES-208 · SES-209 — 컨티뉴 (§4.5)', () => {
  it('SES-208 — 결제 후 복귀한 보드가 종료 시점과 같다', async () => {
    const rig = await boot();
    playToDeath(rig);
    const before = rig.app.flow.snapshot().run;
    expect(before).not.toBeNull();

    rig.send('COIN');
    rig.send('BUTTON1');
    expect(rig.app.flow.screen).toBe('RUN');
    const after = rig.app.flow.snapshot().run;
    expect(after?.chainsLeft).toBe(before?.chainsLeft);
    expect(after?.boardNumber).toBe(before?.boardNumber);
    expect(after?.displayScore).toBe(before?.displayScore);
    expect(after?.chains.map((c) => c.state)).toEqual(before?.chains.map((c) => c.state));
  });

  it('SES-209 — 하트·시간이 설정값대로 회복되고 콤보만 1.0으로 초기화된다', async () => {
    const rig = await boot();
    playToDeath(rig);
    rig.send('COIN');
    rig.send('BUTTON1');
    const run = rig.app.flow.snapshot().run;
    expect(run?.hearts).toBe(FACTORY_PARAMS.continueHeartRecover);
    expect(run?.timeRemainingMs).toBe(FACTORY_PARAMS.continueTimeRefillSec * 1000);
    expect(run?.comboCentis).toBe(100); // 1.0 — 끊긴 흐름을 돈으로 되사지 못한다
    expect(run?.continueCount).toBe(1);
  });

  it('컨티뉴 비용이 2면 2가 빠지고 원복도 2다', async () => {
    const rig = await boot({ continueCoins: 2 });
    playToDeath(rig);
    rig.send('COIN');
    rig.send('COIN');
    expect(rig.app.credits.balance().paid).toBe(2);
    rig.send('BUTTON1');
    expect(rig.app.credits.balance().paid).toBe(0);
    expect(rig.app.credits.view().paidContinue).toBe(1);
  });
});

describe('CRD-607 — 관리자 테스트 플레이 무집계 (§9 차단표 6행)', () => {
  async function testPlayRig(): Promise<Rig> {
    const rig = await boot();
    rig.app.setTestPlay(true);
    return rig;
  }

  it('① 크레딧 — 잔액이 변하지 않는다', async () => {
    const rig = await testPlayRig();
    const before = rig.app.credits.balance();
    rig.send('START'); // 크레딧 0에서도 시작한다
    expect(rig.app.flow.screen).toBe('READY');
    rig.send('START');
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.balance()).toEqual(before);
  });

  it('② credit_log — 줄 수가 변하지 않는다', async () => {
    const rig = await testPlayRig();
    await settle(rig);
    const before = rig.storage.kv.dump(FILES.creditLog);
    rig.send('START');
    rig.send('START');
    await settle(rig);
    expect(rig.storage.kv.dump(FILES.creditLog)).toBe(before);
  });

  it('③ 유료·이벤트 통계 — view가 그대로다', async () => {
    const rig = await testPlayRig();
    const before = rig.app.credits.view();
    rig.send('START');
    rig.send('START');
    expect(rig.app.credits.view()).toEqual(before);
  });

  it('④ 세션 점유·히스토그램·점수 분포 — 표본 수가 그대로다', async () => {
    const rig = await testPlayRig();
    rig.send('START');
    rig.send('START');
    playToDeathFromTutorial(rig);
    rig.press('BUTTON2'); // CONTINUE → RESULT
    rig.press('BUTTON1'); // RESULT 종료
    const v = rig.app.credits.view();
    expect(v).toMatchObject({ occupancySessions: 0, scoreSamples: 0 });
    expect(v.boardHistogram).toEqual([]);
  });

  it('⑤ 랭킹 — 등록 후보가 되지 않고 이름 입력에 도달하지 않는다', async () => {
    const rig = await testPlayRig();
    rig.send('START');
    rig.send('START');
    playToDeathFromTutorial(rig);
    rig.press('BUTTON2');
    expect(rig.app.flow.screen).toBe('RESULT');
    expect(rig.app.flow.snapshot().result?.score).toBeGreaterThan(0);
    expect(rig.app.flow.snapshot().result?.qualifies).toBe(false);
    rig.press('BUTTON1');
    expect(['READY', 'ATTRACT']).toContain(rig.app.flow.screen);
    expect(rig.app.ranking.top()).toHaveLength(0);
  });

  it('⑥ 코인 적립 — 테스트 중에도 정상 적립한다 (§10.6 · §11.6)', async () => {
    const rig = await testPlayRig();
    rig.send('COIN');
    expect(rig.app.credits.balance().paid).toBe(1);
    expect(rig.app.credits.view().coinPulseTotal).toBe(1);
  });

  it('플래그를 끄면 다시 정상 집계한다', async () => {
    const rig = await testPlayRig();
    rig.send('START');
    rig.send('START');
    rig.app.setTestPlay(false);
    expect(rig.app.isTestPlay()).toBe(false);
    rig.send('COIN');
    rig.app.flow.handle('BUTTON2'); // 튜토리얼 밖으로 나가기 위한 잡음 입력
    expect(rig.app.credits.view().coinPulseTotal).toBe(1);
  });
});

/** 튜토리얼 화면에서 시작해 하트를 소진한다 (테스트 플레이 경로 전용) */
function playToDeathFromTutorial(rig: Rig): void {
  if (rig.app.flow.screen === 'TUTORIAL') {
    rig.clock.advance(TUTORIAL_IDLE_MS);
    rig.app.flow.tick();
  }
  rig.send('RIGHT');
  rig.send('RIGHT');
  rig.send('BUTTON1');
  rig.clock.advance(SLIDE_MS);
  rig.app.flow.tick();
  rig.send('LEFT');
  rig.send('BUTTON1');
  rig.app.flow.tick();
}

describe('CRD-606 — 프로세스 재기동 크레딧 복구 (§10.6)', () => {
  it('런 중 강제 종료 뒤 부팅에서 서비스 크레딧으로 복구된다', async () => {
    const kv = new MemoryKeyValue();
    const first = await boot({ kv });
    first.send('COIN');
    first.send('COIN');
    first.send('START'); // 여기서 1 차감 + 마커 저장
    await settle(first);
    expect(first.app.credits.balance().paid).toBe(1);
    expect(kv.dump(FILES.stats)).toContain('#run');
    first.app.dispose(); // 크래시 — 정상 종료 경로(RESULT)를 타지 않는다

    const second = await boot({ kv });
    const result = (await second.app.ready).recovery;
    expect(result.recovered).toBe(true);
    expect(result.granted).toBe(1);
    // 잔여 1(복원) + 서비스 1(복구)
    expect(second.app.credits.balance().paid).toBe(2);
    expect(second.app.credits.view().serviceCreditGranted).toBe(1);
    await settle(second);
    expect(kv.dump(FILES.stats)).not.toContain('#run'); // 마커는 1회 소비된다
    expect(kv.dump(FILES.creditLog)).toContain('service_grant');
  });

  it('세 번째 부팅에서는 다시 복구하지 않는다 (이중 복구 방지)', async () => {
    const kv = new MemoryKeyValue();
    const first = await boot({ kv });
    first.send('COIN');
    first.send('START');
    await settle(first);
    first.app.dispose();

    const second = await boot({ kv });
    await second.app.ready;
    await settle(second);
    second.app.dispose();

    const third = await boot({ kv });
    expect((await third.app.ready).recovery.recovered).toBe(false);
    expect(third.app.credits.view().serviceCreditGranted).toBe(1);
  });

  it('정상 종료한 런은 재기동에서 복구하지 않는다', async () => {
    const kv = new MemoryKeyValue();
    const first = await boot({ kv });
    playToDeath(first);
    first.press('BUTTON2'); // CONTINUE → RESULT (= 정상 종료 · 마커 해제)
    expect(first.app.flow.screen).toBe('RESULT');
    await settle(first);
    expect(kv.dump(FILES.stats)).not.toContain('#run');
    first.app.dispose();

    const second = await boot({ kv });
    expect((await second.app.ready).recovery.recovered).toBe(false);
  });

  it('P-9 — 유료 잔액이 credit_log의 마지막 행에서 복원된다', async () => {
    const kv = new MemoryKeyValue();
    const first = await boot({ kv });
    for (let i = 0; i < 5; i += 1) first.send('COIN');
    await settle(first);
    first.app.dispose();

    const second = await boot({ kv });
    expect((await second.app.ready).restoredPaid).toBe(5);
    expect(second.app.credits.balance().paid).toBe(5);
  });

  it('§10.3 — 이벤트 잔액은 재시작 시 0이다', async () => {
    const kv = new MemoryKeyValue();
    const first = await boot({ kv });
    first.app.credits.grantEvent(4);
    await settle(first);
    first.app.dispose();

    const second = await boot({ kv });
    await second.app.ready;
    expect(second.app.credits.balance().event).toBe(0);
    expect(second.app.credits.view().eventGrantedTotal).toBe(4); // 누적 지급은 유지된다
  });

  it('통계가 재기동을 넘어 이어진다', async () => {
    const kv = new MemoryKeyValue();
    const first = await boot({ kv });
    for (let i = 0; i < 3; i += 1) first.send('COIN');
    first.send('START');
    await settle(first);
    first.app.dispose();

    const second = await boot({ kv });
    await second.app.ready;
    expect(second.app.credits.view()).toMatchObject({
      coinPulseTotal: 3,
      paidCreditGranted: 3,
      paidPlayTotal: 1,
      paidCreditUsed: 1,
    });
  });
});

describe('§10.2 — 런 진입 실패 원복 (WU-03 이월 F-3 · 검증 V-1)', () => {
  /** 미니 튜토리얼은 전용 보드를 쓰므로(§4.1 Q-4) 보드 생성 실패는 4번째 런에서 드러난다 */
  async function upToFailingStart(kv?: MemoryKeyValue): Promise<{ rig: Rig; fail: () => void }> {
    let failing = false;
    const base = makeApp({
      kv,
      params: { initialHearts: 1 },
      boards: (n) => {
        if (failing) throw new Error('보드 생성 실패');
        return scoringBoard(n);
      },
    });
    await base.app.ready;
    const rig: Rig = {
      ...base,
      press(a: InputAction): void {
        base.send(a);
        base.app.flow.tick();
      },
    };
    for (let i = 0; i < TUTORIAL_MAX_PLAYS; i += 1) {
      rig.send('COIN');
      rig.send('START');
      endRunToAttract(rig);
    }
    rig.send('COIN');
    return {
      rig,
      fail: () => {
        failing = true;
      },
    };
  }

  it('보드 생성이 실패하면 크레딧이 되돌아오고 사유가 남는다', async () => {
    const { rig, fail } = await upToFailingStart();
    const paidBefore = rig.app.credits.balance().paid;
    const statsBefore = rig.app.credits.view();

    fail();
    rig.sfx.clear();
    rig.send('START');

    expect(rig.app.credits.balance().paid).toBe(paidBefore); // 원복됐다
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.view()).toMatchObject({
      paidPlayTotal: statsBefore.paidPlayTotal,
      paidCreditUsed: statsBefore.paidCreditUsed,
    });
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.app.flow.paidPlays).toBe(TUTORIAL_MAX_PLAYS); // 실패한 런은 세지 않는다

    await rig.app.credits.flushLog();
    const rows = parseCreditLogCsv(rig.storage.kv.dump(FILES.creditLog) ?? '');
    expect(rows[rows.length - 1]).toMatchObject({
      action: 'refund',
      source: 'paid',
      reason: '런 진입 실패',
    });
  });

  // 검증 V-1 — 원복은 `RESULT`를 거치지 않고 `READY`로 돌아간다. 마커 해제를 화면 전이에만
  // 걸어 두면 마커가 살아남아 다음 부팅이 **이미 돌려준 크레딧을 한 번 더** 지급한다
  it('원복 즉시 크래시 마커가 사라진다', async () => {
    const kv = new MemoryKeyValue();
    const { rig, fail } = await upToFailingStart(kv);
    fail();
    rig.send('START');
    await settle(rig);
    expect(rig.app.stats.runMarker).toBeNull();
    expect(kv.dump(FILES.stats)).not.toContain('#run');
  });

  it('원복된 결제는 재기동에서 다시 보상되지 않는다 (CRD-606 "소비" 문언)', async () => {
    const kv = new MemoryKeyValue();
    const { rig, fail } = await upToFailingStart(kv);
    fail();
    rig.send('START');
    const paidAfterRefund = rig.app.credits.balance().paid;
    expect(paidAfterRefund).toBe(1); // 원복으로 돌아온 1
    await settle(rig);
    rig.app.dispose();

    const second = await boot({ kv });
    const bootResult = await second.app.ready;
    expect(bootResult.recovery.recovered).toBe(false);
    expect(bootResult.recovery.granted).toBe(0);
    expect(bootResult.restoredPaid).toBe(paidAfterRefund);
    // 잔액은 원복분 1 그대로 — 서비스 크레딧이 얹히지 않는다
    expect(second.app.credits.balance().paid).toBe(paidAfterRefund);
    expect(second.app.credits.view().serviceCreditGranted).toBe(0);
    await settle(second);
    expect(kv.dump(FILES.creditLog)).not.toContain('service_grant');
  });

  it('컨티뉴 복귀 실패 원복도 마커를 남기지 않는다', async () => {
    const kv = new MemoryKeyValue();
    const base = makeApp({ kv, params: { initialHearts: 1 }, boards: scoringBoard });
    await base.app.ready;
    const rig: Rig = {
      ...base,
      press(a: InputAction): void {
        base.send(a);
        base.app.flow.tick();
      },
    };
    playToDeath(rig);
    expect(rig.app.flow.screen).toBe('CONTINUE');
    // 컨티뉴 결제 → 마커 갱신 → 정상 복귀. 그 뒤 원복 경로만 직접 태워 마커를 확인한다
    rig.send('COIN');
    rig.send('BUTTON1');
    expect(rig.app.stats.runMarker).not.toBeNull();
    rig.app.credits.refund(rig.app.credits.continueCoins, 'paid', '컨티뉴 복귀 실패');
    expect(rig.app.stats.runMarker).toBeNull();
  });
});

describe('부팅 순서 · 실물 벽시계 (§10.5 마 — OS 로컬 날짜)', () => {
  it('부팅 결과가 복원·복구를 함께 알려 준다', async () => {
    const rig = await boot();
    const result: BootResult = await rig.app.ready;
    expect(result).toMatchObject({ restoredPaid: 0 });
    expect(result.recovery.recovered).toBe(false);
  });

  it('실물 벽시계는 OS **로컬** 날짜를 YYYY-MM-DD로 준다 (UTC가 아니다)', () => {
    const wall = systemWallClock();
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    expect(wall.localDate()).toBe(
      `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    );
    expect(wall.localDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Math.abs(wall.nowMs() - Date.now())).toBeLessThan(5000);
    expect(wall.nowIso()).toContain('T');
  });
});

describe('§12 — CSV 증거 (사람 눈과 기계 판정 이중)', () => {
  it('코인 → 시작 → 컨티뉴가 credit_log.csv에 순서대로 남는다', async () => {
    const wall = new MutableWallClock();
    const rig = await boot({ wall });
    rig.send('COIN');
    wall.advance(3000);
    rig.send('START');
    if (rig.app.flow.screen === 'TUTORIAL') {
      rig.clock.advance(TUTORIAL_IDLE_MS);
      rig.app.flow.tick();
    }
    rig.send('RIGHT');
    rig.send('RIGHT');
    rig.send('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.app.flow.tick();
    rig.send('LEFT');
    rig.send('BUTTON1');
    rig.app.flow.tick();
    wall.advance(158_000);
    rig.send('COIN');
    rig.send('BUTTON1');
    await settle(rig);

    expect(rig.storage.kv.dump(FILES.creditLog)).toBe(
      [
        CREDIT_LOG_HEADER,
        '2026-08-16T10:00:00.000Z,coin_insert,coin,1,0,',
        '2026-08-16T10:00:03.000Z,pay,paid,0,0,start',
        '2026-08-16T10:02:41.000Z,coin_insert,coin,1,0,',
        '2026-08-16T10:02:41.000Z,pay,paid,0,0,continue',
      ].join('\n')
    );
  });

  it('stats.csv에 본행 + 섹션이 실린다', async () => {
    const rig = await boot();
    fillRanking(rig);
    rig.clock.set(1000);
    playToDeath(rig);
    rig.press('BUTTON2'); // CONTINUE → RESULT
    rig.clock.set(61_000);
    rig.press('BUTTON1'); // RESULT 종료
    await settle(rig);

    const csv = rig.storage.kv.dump(FILES.stats) ?? '';
    const lines = csv.split('\n');
    expect(lines[0]).toBe(
      'schema,date,paidPlayTotal,paidPlayToday,paidContinue,eventPlayTotal,eventPlayToday,eventContinue,eventGrantedTotal,eventUsedTotal,eventUsedToday'
    );
    expect(lines[1]).toBe('1,2026-08-16,1,1,0,0,0,0,0,0,0');
    expect(csv).toContain('#meters,coinPulseTotal');
    expect(csv).toContain('#session,occupancyMsTotal');
    expect(csv).toContain('#histogram,board,count');
    expect(csv).toContain('#scores,score');
    expect(csv).not.toContain('#run'); // 정상 종료라 마커가 없다
  });

  it('저장은 800ms 디바운스·안전 쓰기 경로를 그대로 탄다 (완료 기준 4)', async () => {
    const rig = await boot();
    rig.send('COIN');
    expect(rig.storage.storage.hasPendingSave).toBe(true); // 아직 파일에 닿지 않았다
    await settle(rig);
    expect(rig.storage.kv.dump(FILES.stats)).toContain('#meters');
    expect(rig.storage.errors).toHaveLength(0);
  });
});
