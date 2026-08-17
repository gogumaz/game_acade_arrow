// WU-06 T10 — 종합: 손상 파일 부팅 → 경고 → 유료 차단 → 해제 → 저장 회복
//
// 단위 판정이 각각 성립해도 **조립 지점(`createApp`)에서 실제로 결선됐는가**는 별개다.
// 여기서는 `createApp()`을 그대로 돌려 §12.1~§12.4가 한 흐름으로 성립하는지 본다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, writeField } from '../../src/core/adminParams';
import { FACTORY_PARAMS, type CoreParams } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import { createChain } from '../../src/core/chain';
import { TUTORIAL_IDLE_MS } from '../../src/game/timing';
import type { Clock, GridPoint, InputAction, PlayerId } from '../../src/core/types';
import type { WallClock } from '../../src/core/stats';
import { createApp, type AppContext } from '../../src/game/app';
import { paramsToCsv, PARAM_VERSION_KEY } from '../../src/game/admin/paramsDoc';
import type { BoardSource } from '../../src/game/boardSource';
import type { InputAdapter, PlayerAction } from '../../src/game/input';
import { RANKING_HEADER } from '../../src/game/rankingStore';
import { paidBlockedMessage } from '../../src/game/safety';
import { paidBlockedLine, readyPanel } from '../../src/game/render/panels';
import { createSilentSfx } from '../../src/game/sfx';
import { CREDIT_LOG_HEADER, FILES } from '../../src/persist/csv';
import { BAK_SUFFIX } from '../../src/persist/storage';
import { memoryStorage, MemoryKeyValue } from './harness';

const ISO = '2026-08-17T09:00:00.000Z';

const wall: WallClock = {
  nowMs: () => Date.parse(ISO),
  localDate: () => '2026-08-17',
  nowIso: () => ISO,
};

function openBoard(boardNumber = 1): Board {
  return new Board({
    chains: Array.from({ length: 3 }, (_, i) =>
      createChain(
        i + 1,
        [
          { x: 11, y: i * 2 },
          { x: 12, y: i * 2 },
        ],
        0
      )
    ),
    boardNumber,
    seed: `wu06-int-${String(boardNumber)}`,
  });
}

interface FakeInput extends InputAdapter {
  fire(action: InputAction, player?: PlayerId): void;
}

function fakeInput(): FakeInput {
  const actions = new Set<(pa: PlayerAction) => void>();
  return {
    id: 'fake',
    status: 'connected',
    attach: () => undefined,
    detach: () => undefined,
    onAction(fn) {
      actions.add(fn);
      return () => actions.delete(fn);
    },
    onAnyKey: () => () => undefined,
    onStatusChange: () => () => undefined,
    fire(action, player: PlayerId = 1) {
      for (const fn of [...actions]) fn({ action, player });
    },
  };
}

interface Rig {
  readonly app: AppContext;
  readonly input: FakeInput;
  readonly storage: ReturnType<typeof memoryStorage>;
  send(...actions: InputAction[]): void;
  advance(by: number): void;
}

function makeApp(
  opts: {
    kv?: MemoryKeyValue;
    failWrites?: { on: boolean; only?: (name: string) => boolean };
    failAppends?: { on: boolean; only?: (name: string) => boolean };
    interceptRead?: (name: string, call: number) => Promise<void> | null;
    params?: Partial<CoreParams>;
    boards?: (n: number) => Board;
  } = {}
): Rig {
  let ms = 0;
  const clock: Clock = { now: () => ms };
  const storage = memoryStorage({
    ...(opts.kv === undefined ? {} : { kv: opts.kv }),
    ...(opts.failWrites === undefined ? {} : { failWrites: opts.failWrites }),
    ...(opts.failAppends === undefined ? {} : { failAppends: opts.failAppends }),
    ...(opts.interceptRead === undefined ? {} : { interceptRead: opts.interceptRead }),
  });
  const input = fakeInput();
  const makeBoard = opts.boards ?? openBoard;
  const boardSource: BoardSource = { next: (req) => makeBoard(req.boardNumber) };
  const app = createApp({
    input,
    ...(opts.params === undefined ? {} : { params: { ...FACTORY_PARAMS, ...opts.params } }),
    boardSource,
    clock,
    wall,
    storage: storage.storage,
    sfx: createSilentSfx(),
    nowIso: () => ISO,
  });
  return {
    app,
    input,
    storage,
    send(...actions: InputAction[]): void {
      for (const a of actions) {
        input.fire(a);
        app.flow.tick();
      }
    },
    advance(by: number): void {
      ms += by;
    },
  };
}

describe('종합 — 손상 파일로 부팅한다', () => {
  it('랭킹 본 파일이 손상이면 `.bak`으로 부팅하고 OVERVIEW가 경고한다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.ranking, '완전히 망가진 파일');
    kv.put(
      `${FILES.ranking}${BAK_SUFFIX}`,
      [RANKING_HEADER, `1,ZZZ,4200,5,300,0,${ISO},1`].join('\n')
    );
    const rig = makeApp({ kv });
    await rig.app.ready;

    expect(rig.app.ranking.top()[0]?.score).toBe(4200);
    expect(rig.app.storage.bootOutcomeOf(FILES.ranking)?.outcome).toBe('backup_restored');

    rig.send('SERVICE');
    expect(rig.app.flow.screen).toBe('ADMIN');
    rig.app.admin.goTo(['OVERVIEW']);
    const boot = rig.app.admin.view().rows.find((r) => r.id === 'ov.boot');
    expect(boot?.value).toContain('BACKUP RESTORED');
    expect(rig.app.admin.view().status).toBe('▲ CHECK');
  });

  it('params 버전 불일치가 날짜 백업과 경고를 남긴다 (SAV-703)', async () => {
    const kv = new MemoryKeyValue();
    kv.put(
      FILES.params,
      paramsToCsv(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 150)).replace(
        `${PARAM_VERSION_KEY},1`,
        `${PARAM_VERSION_KEY},9`
      )
    );
    const rig = makeApp({ kv });
    await rig.app.ready;

    expect(rig.app.params.live.core.sessionTimeSec).toBe(120);
    expect(kv.keys().some((k) => /^params\.csv\.\d{4}-\d{2}-\d{2}\.bak$/.test(k))).toBe(true);

    rig.send('SERVICE');
    rig.app.admin.goTo(['OVERVIEW']);
    expect(rig.app.admin.view().rows.find((r) => r.id === 'ov.boot')?.value).toContain(
      'PARAM DATA VERSION'
    );
    // 유료 플레이는 막히지 않는다 — 공장값 재기록이 성공했다 (가정 (가))
    expect(rig.app.safety.reason()).toBe(null);
  });

  it('저장 파일이 하나도 없으면 경고 없이 조용히 부팅한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    expect(rig.app.storage.bootReport.every((e) => e.outcome === 'missing')).toBe(true);
    expect(rig.app.safety.peekBootNotices()).toEqual([]);
    expect(rig.app.safety.reason()).toBe(null);
  });
});

describe('종합 — 유료 차단 → 크레딧 유지 → 해제 (SAV-704)', () => {
  it('연속 저장 실패 3회면 START가 거부되고 크레딧은 남는다', async () => {
    const failWrites = { on: false };
    const rig = makeApp({ failWrites });
    await rig.app.ready;

    rig.send('COIN');
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.balance().paid).toBe(1);

    // 저장 경로가 죽고 3회 연속 실패한다
    failWrites.on = true;
    for (let i = 0; i < 3; i += 1) await rig.app.storage.saveNow(FILES.stats);
    expect(rig.app.storage.saveFailStreak).toBe(3);
    expect(rig.app.safety.reason()).toBe('storage_unavailable');

    rig.send('START');
    expect(rig.app.flow.screen).toBe('READY'); // 시작하지 않았다
    expect(rig.app.credits.balance().paid).toBe(1); // 지갑 불변
    expect(rig.app.flow.trace.includes('paid-blocked')).toBe(true);

    // 차단 중에도 코인은 정상 적립된다 (§12.4)
    rig.send('COIN');
    expect(rig.app.credits.balance().paid).toBe(2);

    // 저장 1회 성공으로 해제된다
    failWrites.on = false;
    await rig.app.storage.saveNow(FILES.stats);
    expect(rig.app.safety.reason()).toBe(null);
    rig.send('START');
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.balance().paid).toBe(1);
  });

  it('어트랙트·READY 문구가 차단 사유를 보여 준다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('COIN');
    expect(paidBlockedLine(rig.app.flow.snapshot())).toBe(null);
    expect(readyPanel(1, null).lines[0]).toContain('START');

    rig.app.safety.setIoConnected(false);
    const snap = rig.app.flow.snapshot();
    const line = paidBlockedLine(snap);
    expect(line).toBe(paidBlockedMessage('io_disconnected'));
    expect(readyPanel(1, line).lines).toEqual([line, '크레딧은 그대로 유지됩니다']);

    rig.app.safety.setIoConnected(true);
    expect(paidBlockedLine(rig.app.flow.snapshot())).toBe(null);
  });

  it('관리자 OVERVIEW가 차단 사유를 표시한다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('SERVICE');
    rig.app.admin.goTo(['OVERVIEW']);
    expect(rig.app.admin.view().rows.find((r) => r.id === 'ov.paidblock')?.value).toBe('허용');

    rig.app.safety.setIoConnected(false);
    expect(rig.app.admin.view().rows.find((r) => r.id === 'ov.paidblock')?.value).toContain(
      'io_disconnected'
    );
  });
});

describe('종합 — 로그 보존 정리가 부팅에서 돈다 (SAV-706)', () => {
  it('12개월 초과 행만 사라지고 최근 행은 남는다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(
      FILES.creditLog,
      [
        CREDIT_LOG_HEADER,
        `2020-01-01T00:00:00.000Z,coin_insert,coin,1,0,`,
        `2026-08-01T00:00:00.000Z,coin_insert,coin,5,0,`,
      ].join('\n')
    );
    const rig = makeApp({ kv });
    const boot = await rig.app.ready;

    expect(boot.pruned[FILES.creditLog]).toBe(1);
    const csv = kv.dump(FILES.creditLog) ?? '';
    expect(csv).not.toContain('2020-01-01');
    expect(csv).toContain('2026-08-01');
    expect(csv.split('\n')[0]).toBe(CREDIT_LOG_HEADER);
    // 잔액 복원(WU-04)은 남은 마지막 행을 그대로 읽는다
    expect(boot.restoredPaid).toBe(5);
  });

  it('지울 행이 없으면 파일을 다시 쓰지 않는다', async () => {
    const kv = new MemoryKeyValue();
    const csv = [CREDIT_LOG_HEADER, `2026-08-01T00:00:00.000Z,coin_insert,coin,2,0,`].join('\n');
    kv.put(FILES.creditLog, csv);
    const rig = makeApp({ kv });
    const boot = await rig.app.ready;
    expect(boot.pruned[FILES.creditLog]).toBe(0);
    expect(kv.dump(FILES.creditLog)).toBe(csv);
  });
});

describe('종합 — 부팅 상태 노출', () => {
  it('브라우저 모드에서는 health가 null이다 (§12.3 P-8)', async () => {
    const rig = makeApp();
    const boot = await rig.app.ready;
    // 하네스의 가짜 gameFS에는 `health`가 없다 — 개발 모드와 같은 상태다
    expect(boot.health).toBe(null);
    expect(rig.app.safety.health).toBe(null);
  });

  it('부팅 결과에 복구·보존 요약이 실려 있다', async () => {
    const rig = makeApp();
    const boot = await rig.app.ready;
    expect(boot).toHaveProperty('restoredPaid');
    expect(boot).toHaveProperty('recovery');
    expect(boot).toHaveProperty('health');
    expect(boot).toHaveProperty('pruned');
  });

  it('저장 파일 4종이 부팅 보고에 모두 있다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    expect(rig.app.storage.bootReport.map((e) => e.file).sort()).toEqual(
      [FILES.ranking, FILES.stats, FILES.params, FILES.settings].sort()
    );
  });
});

describe('종합 — 재기동에서 값이 유지된다 (회귀)', () => {
  it('저장 → 재기동 → 같은 값 (복구 경로가 정상 경로를 깨지 않는다)', async () => {
    const kv = new MemoryKeyValue();
    const first = makeApp({ kv });
    await first.app.ready;
    first.send('COIN', 'COIN');
    await first.app.storage.saveAll();
    await first.app.credits.flushLog();
    first.app.dispose();

    const second = makeApp({ kv });
    const boot = await second.app.ready;
    expect(boot.restoredPaid).toBe(2);
    expect(second.app.storage.bootReport.every((e) => e.outcome === 'ok')).toBe(true);
    expect(second.app.safety.peekBootNotices()).toEqual([]);
  });
});

// ── FIX 사이클 1 (03_quality_report.md — F-2 · F-3 · F-5 · QA-1) ──────────

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function gp(x: number, y: number): GridPoint {
  return { x, y };
}

/** 안전 사슬(x=12) + 막힌 쌍 — 점수를 낸 뒤 하트를 소진해 CONTINUE에 도달한다 (WU-04 방식) */
function deathBoard(n: number): Board {
  return new Board({
    chains: [
      createChain(1, [gp(1, 9), gp(2, 9)], 1),
      createChain(2, [gp(6, 8), gp(6, 9), gp(6, 10)], 0),
      createChain(3, [gp(11, 0), gp(12, 0)], 0),
    ],
    boardNumber: n,
    seed: `wu06-fix1-${String(n)}`,
  });
}

const SLIDE_OUT_MS = 202;

/** 코인 2 → START → 튜토리얼 통과 → 안전 사슬 제거 → 막힌 사슬로 하트 소진 → CONTINUE */
function playToContinue(rig: Rig): void {
  rig.send('COIN', 'COIN', 'START');
  if (rig.app.flow.screen === 'TUTORIAL') {
    rig.advance(TUTORIAL_IDLE_MS);
    rig.app.flow.tick();
  }
  rig.send('RIGHT', 'RIGHT', 'BUTTON1');
  rig.advance(SLIDE_OUT_MS);
  rig.app.flow.tick();
  rig.send('LEFT', 'BUTTON1');
  rig.app.flow.tick();
}

/** 커서를 rowId까지 내린다 (wu05 harness focus와 같은 방식) */
function focusRow(admin: AppContext['admin'], rowId: string): boolean {
  for (let i = 0; i <= admin.view().rows.length; i += 1) {
    const view = admin.view();
    if (view.rows[view.cursor]?.id === rowId) return true;
    admin.handle('DOWN');
  }
  return false;
}

describe('FIX 사이클 1 — 부팅 보존 정리와 적립의 경합 (검증 F-3)', () => {
  it('정리 도중 적립된 크레딧 로그 행이 유실되지 않는다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(
      FILES.creditLog,
      [CREDIT_LOG_HEADER, '2025-07-01T00:00:00.000Z,coin_insert,paid,0,0,old'].join('\n')
    );
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const rig = makeApp({
      kv,
      // 보존 정리의 read(파일별 2번째 읽기)가 **낡은 스냅샷을 든 채** 멈춘다 (F-3 재현)
      interceptRead: (name, call) => {
        if (name !== FILES.creditLog || call !== 2) return null;
        reached();
        return gate;
      },
    });
    await reachedPromise; // 정리가 read와 write 사이에 서 있다
    rig.send('COIN'); // 그 사이 코인이 들어온다 — §12.2 "크레딧 손실 0"의 그 행
    await flushAsync(); // append 체인 소진
    release();
    await rig.app.ready;
    await rig.app.credits.flushLog();
    await flushAsync();

    const csv = rig.storage.kv.dump(FILES.creditLog) ?? '';
    expect(csv).toContain(`${ISO},coin_insert`); // 적립 행이 살아 있다
    expect(csv).not.toContain('2025-07-01'); // 12개월 초과 행은 정리됐다
    expect(rig.app.credits.balance().paid).toBe(1);
  });
});

describe('FIX 사이클 1 — 차단 면제 (검증 F-2 · 계획 §5)', () => {
  it('차단 중에도 관리자 테스트 플레이는 시작된다', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.app.safety.setIoConnected(false);
    expect(rig.app.safety.reason()).toBe('io_disconnected');

    rig.send('SERVICE');
    expect(rig.app.flow.screen).toBe('ADMIN');
    rig.app.admin.goTo(['PARAMS', 'P_TESTPLAY']);
    expect(focusRow(rig.app.admin, 'testplay.start')).toBe(true);
    rig.app.admin.handle('BUTTON1');
    rig.app.flow.tick();

    expect(rig.app.isTestPlay()).toBe(true);
    expect(['TUTORIAL', 'RUN']).toContain(rig.app.flow.screen); // 진단 런이 실제로 시작됐다
    expect(rig.app.credits.balance().paid).toBe(0); // 크레딧 무관 (§11.6)
  });
});

describe('FIX 사이클 1 — SAV-704 플로우 레벨 5조건 (검증 F-5)', () => {
  it('io_disconnected — START 거부 · 지갑 불변 · 해제 복귀', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('COIN');
    rig.app.safety.setIoConnected(false);

    rig.send('START');
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.balance().paid).toBe(1);
    expect(rig.app.flow.trace.includes('paid-blocked')).toBe(true);

    rig.app.safety.setIoConnected(true);
    rig.send('START');
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.balance().paid).toBe(0);
  });

  it('fatal_repeat — SERVICE REQUIRED면 START 거부 · 지갑 불변', async () => {
    const rig = makeApp();
    await rig.app.ready;
    rig.send('COIN');
    rig.app.safety.setHealth({
      fatalCount: 3,
      serviceRequired: true,
      freeBytes: null,
      storageLow: false,
      machine: null,
    });
    expect(rig.app.safety.reason()).toBe('fatal_repeat');

    rig.send('START');
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.balance().paid).toBe(1);

    rig.app.safety.setHealth(null); // 재부팅 후 정상 상태
    rig.send('START');
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.balance().paid).toBe(0);
  });

  it('credit_log_write — 연속 3회 실패로 차단, 성공 1회로 해제', async () => {
    const failAppends = { on: false };
    const rig = makeApp({ failAppends });
    await rig.app.ready;

    failAppends.on = true;
    for (let i = 0; i < 3; i += 1) {
      rig.send('COIN');
      await rig.app.credits.flushLog();
    }
    expect(rig.app.credits.blockReason).toBe('credit_log_write');
    expect(rig.app.safety.reason()).toBe('credit_log_write');

    rig.send('START');
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.balance().paid).toBe(3); // 지갑 불변 — 코인은 전부 남아 있다

    failAppends.on = false;
    rig.send('COIN'); // 성공 1회가 스트릭을 지운다 (§12.4 해제)
    await rig.app.credits.flushLog();
    expect(rig.app.credits.blockReason).toBe(null);
    expect(rig.app.safety.reason()).toBe(null);
    rig.send('START');
    expect(rig.app.flow.screen).toBe('TUTORIAL');
    expect(rig.app.credits.balance().paid).toBe(3);
  });

  it('params_unrecoverable — 본·백업·재기록 전부 실패면 차단, 재기록이 살면 해제', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.params, '완전히 망가진 파일');
    kv.put(`${FILES.params}${BAK_SUFFIX}`, '백업도 망가졌다');
    const failWrites = { on: true, only: (n: string) => n === FILES.params };
    const rig = makeApp({ kv, failWrites });
    await rig.app.ready;
    expect(rig.app.safety.reason()).toBe('params_unrecoverable');

    rig.send('COIN');
    rig.send('START');
    expect(rig.app.flow.screen).toBe('READY');
    expect(rig.app.credits.balance().paid).toBe(1); // 크레딧은 유지·우선 저장 (§12.4)
    rig.app.dispose();

    // 저장 경로가 되살아난 재부팅 — 공장값 재기록이 성공하면 차단이 풀린다 (가정 (가))
    const second = makeApp({ kv });
    await second.app.ready;
    expect(second.app.storage.bootOutcomeOf(FILES.params)?.outcome).toBe('factory');
    expect(second.app.safety.reason()).toBe(null);
  });
});

describe('FIX 사이클 1 — 컨티뉴 유료 차단 (QA-1 · 착수 §9 추기)', () => {
  it('차단 중에는 컨티뉴 결제가 거부되고 크레딧은 남는다', async () => {
    const rig = makeApp({ params: { initialHearts: 1 }, boards: deathBoard });
    await rig.app.ready;
    playToContinue(rig);
    expect(rig.app.flow.screen).toBe('CONTINUE');
    expect(rig.app.credits.balance().paid).toBe(1);

    rig.app.safety.setIoConnected(false);
    rig.send('BUTTON1'); // 컨티뉴 확정 시도
    expect(rig.app.flow.screen).toBe('CONTINUE'); // 복귀하지 않았다
    expect(rig.app.credits.balance().paid).toBe(1); // 지갑 불변
    expect(rig.app.flow.trace.includes('paid-blocked')).toBe(true);

    rig.app.safety.setIoConnected(true);
    rig.send('BUTTON1'); // 해제 후 정상 컨티뉴
    expect(rig.app.flow.screen).toBe('RUN');
    expect(rig.app.credits.balance().paid).toBe(0);
  });

  it('차단 중에도 포기(G)는 기존대로 RESULT로 간다', async () => {
    const rig = makeApp({ params: { initialHearts: 1 }, boards: deathBoard });
    await rig.app.ready;
    playToContinue(rig);
    rig.app.safety.setIoConnected(false);

    rig.send('BUTTON2'); // 포기
    expect(['RESULT', 'NAME_ENTRY']).toContain(rig.app.flow.screen);
  });

  it('차단 중 시간 초과도 기존대로 RESULT로 간다', async () => {
    const rig = makeApp({ params: { initialHearts: 1 }, boards: deathBoard });
    await rig.app.ready;
    playToContinue(rig);
    rig.app.safety.setIoConnected(false);

    rig.advance(FACTORY_PARAMS.continuePromptTimeSec * 1000 + 1);
    rig.app.flow.tick();
    expect(['RESULT', 'NAME_ENTRY']).toContain(rig.app.flow.screen);
  });
});
