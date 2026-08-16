// WU-05 테스트 하네스 — 조작 가능한 시계 · 재기동 가능한 저장소 · 가짜 솔버 게이트 3종 ·
// 누름/뗌을 직접 만드는 입력 어댑터.
//
// 이 파일은 `*.test.ts`가 아니므로 Vitest가 수집하지 않는다(테스트 0건).
//
// 세 가지가 이 유닛의 판정을 가능하게 한다.
//   ① `fakeSolverGate` 3종(ok/fail/slow) — 솔버 실체 없이 **차단 배선**을 지금 증명한다
//   ② `FakePhaseInput` — 뗌 이벤트를 만들어 `H` 2초/3초 홀드를 실제로 판정한다
//   ③ `MemoryKeyValue` — `createApp()`을 두 번 불러 **재기동 후 값 유지**를 판정한다

import type { AdminParams, SolverGate, SolverGateResult } from '../../src/core/adminParams';
import { StatsModel, type AuditEvent, type WallClock } from '../../src/core/stats';
import type { Clock, InputAction, PlayerId } from '../../src/core/types';
import { createApp, type AppContext, type AppOptions } from '../../src/game/app';
import type { AdminControllerDeps, AdminCreditsPort } from '../../src/game/admin/controller';
import { AdminController } from '../../src/game/admin/controller';
import { ParamsStore } from '../../src/game/admin/paramsDoc';
import { createChain } from '../../src/core/chain';
import { Board } from '../../src/core/puzzle';
import type { BoardRequest, BoardSource } from '../../src/game/boardSource';
import type { CreditBalance } from '../../src/game/creditsService';
import type { InputAdapter, PhaseEvent, PhaseListener, PlayerAction } from '../../src/game/input';
import { SettingsStore } from '../../src/game/settingsDoc';
import { createSilentSfx, type SilentSfx } from '../../src/game/sfx';
import {
  Storage,
  localStorageBackend,
  STORAGE_PREFIX,
  type KeyValueStore,
  type StorageTimers,
} from '../../src/persist/storage';

// ── ① 가짜 솔버 게이트 3종 (P-7 · ADM-402 배선 증명) ───────────────────────

export function okSolverGate(boards = 15, elapsedMs = 1842): SolverGate {
  return {
    validate(): SolverGateResult {
      return { ok: true, failures: [], elapsedMs, boardsChecked: boards };
    },
  };
}

export function failingSolverGate(): SolverGate {
  return {
    validate(): SolverGateResult {
      return {
        ok: false,
        failures: [
          { tier: 'PRESSURE', seed: 2, reason: 'no_solution' },
          { tier: 'MASTER', seed: 1, reason: 'deadlock' },
        ],
        elapsedMs: 900,
        boardsChecked: 15,
      };
    },
  };
}

/** 3초 상한을 넘긴 게이트 — 실물 계약상 저장이 막혀야 한다 */
export function slowSolverGate(elapsedMs = 3200): SolverGate {
  return {
    validate(): SolverGateResult {
      return { ok: true, failures: [], elapsedMs, boardsChecked: 15 };
    },
  };
}

/**
 * 대기 중인 마이크로태스크를 전부 흘려보낸다.
 * 위험 작업 실행은 `backup → 갱신 → saveNow → 감사 로그` 순의 async 사슬이라
 * `await Promise.resolve()` 몇 번으로는 끝을 보장할 수 없다.
 */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── ② 조작 가능한 시계 ─────────────────────────────────────────────────────

interface TestClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

function testClock(start = 0): TestClock {
  let ms = start;
  return {
    now: () => ms,
    set: (v) => {
      ms = v;
    },
    advance: (v) => {
      ms += v;
    },
  };
}

class FixedWallClock implements WallClock {
  private ms: number;

  constructor(
    private date = '2026-08-17',
    ms = Date.parse('2026-08-17T09:12:03.114Z')
  ) {
    this.ms = ms;
  }

  nowMs(): number {
    return this.ms;
  }

  localDate(): string {
    return this.date;
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  setDate(date: string): void {
    this.date = date;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

// ── ③ 재기동에서 살아남는 저장소 ───────────────────────────────────────────

export class MemoryKeyValue implements KeyValueStore {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  dump(file: string): string | null {
    return this.getItem(`${STORAGE_PREFIX}${file}`);
  }

  put(file: string, csv: string): void {
    this.setItem(`${STORAGE_PREFIX}${file}`, csv);
  }

  keys(): string[] {
    return [...this.map.keys()].map((k) => k.slice(STORAGE_PREFIX.length));
  }
}

interface StorageRig {
  readonly storage: Storage;
  readonly kv: MemoryKeyValue;
  flush(): void;
  readonly errors: { phase: string; error: unknown }[];
}

export function memoryStorage(kv = new MemoryKeyValue(), failWrites = { on: false }): StorageRig {
  let pending: (() => void) | null = null;
  const errors: { phase: string; error: unknown }[] = [];
  const timers: StorageTimers = {
    setTimeout: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  const base = localStorageBackend(kv);
  const storage = new Storage({
    backend: {
      kind: base.kind,
      read: (n) => base.read(n),
      append: (n, l) => base.append(n, l),
      write: (n, c) =>
        failWrites.on ? Promise.reject(new Error('write failed')) : base.write(n, c),
    },
    timers,
    onError: (phase, error) => {
      errors.push({ phase, error });
    },
  });
  return {
    storage,
    kv,
    errors,
    flush(): void {
      const fn = pending;
      pending = null;
      if (fn !== null) fn();
    },
  };
}

// ── ④ 누름/뗌을 직접 만드는 입력 어댑터 ────────────────────────────────────

interface FakePhaseInput extends InputAdapter {
  fire(action: InputAction, player?: PlayerId): void;
  down(action: InputAction, player?: PlayerId): void;
  up(action: InputAction, player?: PlayerId): void;
  onPhase(fn: PhaseListener): () => void;
  setStatus(status: 'connected' | 'disconnected' | 'stuck'): void;
}

function fakePhaseInput(): FakePhaseInput {
  const actions = new Set<(pa: PlayerAction) => void>();
  const phases = new Set<PhaseListener>();
  let status: 'connected' | 'disconnected' | 'stuck' = 'connected';
  const emit = (e: PhaseEvent): void => {
    for (const fn of [...phases]) fn(e);
  };
  return {
    id: 'fake',
    get status() {
      return status;
    },
    attach: () => undefined,
    detach: () => undefined,
    onAction(fn) {
      actions.add(fn);
      return () => actions.delete(fn);
    },
    onAnyKey: () => () => undefined,
    onStatusChange: () => () => undefined,
    onPhase(fn) {
      phases.add(fn);
      return () => phases.delete(fn);
    },
    setStatus(next) {
      status = next;
    },
    fire(action, player: PlayerId = 1) {
      for (const fn of [...actions]) fn({ action, player });
    },
    down(action, player: PlayerId = 1) {
      emit({ action, player, phase: 'down', sourceId: `k:${action}` });
      for (const fn of [...actions]) fn({ action, player });
    },
    up(action, player: PlayerId = 1) {
      emit({ action, player, phase: 'up', sourceId: `k:${action}` });
    },
  };
}

// ── ⑤ 컨트롤러 단독 리그 ───────────────────────────────────────────────────

interface FakeCredits extends AdminCreditsPort {
  readonly resets: string[];
  readonly grants: number[];
  balanceRef: CreditBalance;
}

function fakeCredits(stats: StatsModel): FakeCredits {
  const resets: string[] = [];
  const grants: number[] = [];
  let coinsPerPlay = 1;
  let continueCoins = 1;
  let price: number | null = null;
  let balance: CreditBalance = { paid: 0, event: 0 };
  return {
    resets,
    grants,
    get balanceRef() {
      return balance;
    },
    set balanceRef(next: CreditBalance) {
      balance = next;
    },
    view: () => stats.view(price),
    balance: () => balance,
    grantEvent(n) {
      grants.push(n);
      const room = Math.max(0, 5 - balance.event);
      const applied = Math.min(n, room);
      balance = { ...balance, event: balance.event + applied };
      stats.noteEventGranted(applied);
      return applied;
    },
    resetPaidStatistics() {
      resets.push('paid');
      stats.resetPaid();
    },
    resetEventStatistics() {
      resets.push('event');
      stats.resetEvent();
      balance = { ...balance, event: 0 };
    },
    setCoinUnitPrice(next) {
      price = next;
    },
    setCoinsPerPlay(n) {
      coinsPerPlay = n;
    },
    setContinueCoins(n) {
      continueCoins = n;
    },
    get coinsPerPlay() {
      return coinsPerPlay;
    },
    get continueCoins() {
      return continueCoins;
    },
    get coinUnitPrice() {
      return price;
    },
  };
}

interface AdminRig {
  readonly admin: AdminController;
  readonly clock: TestClock;
  readonly wall: FixedWallClock;
  readonly params: ParamsStore;
  readonly settings: SettingsStore;
  readonly storage: StorageRig;
  readonly credits: FakeCredits;
  readonly stats: StatsModel;
  readonly audits: AuditEvent[];
  readonly sfx: SilentSfx;
  readonly ranking: { size: number; clear(): void; cleared: number };
  readonly applied: AdminParams[];
  readonly exits: { count: number };
  readonly testPlayCalls: { started: number; stopped: number };
  press(action: InputAction): void;
  /** 레버 아래로만 움직여 그 행에 커서를 세운다 (마우스·직접 지정 없이) */
  focus(rowId: string): boolean;
  /** `H`를 `ms`만큼 누르고 뗀다 — 위험 작업 홀드 판정의 유일한 경로 */
  holdConfirm(ms: number): void;
}

interface AdminRigOptions {
  solverGate?: SolverGate;
  kv?: MemoryKeyValue;
  failWrites?: { on: boolean };
  live?: AdminParams;
  /** `ranking.clear()`가 던지게 한다 — 위험 작업 실패 경로 판정용 (D-3) */
  throwOnRankingClear?: boolean;
}

export function makeAdmin(opts: AdminRigOptions = {}): AdminRig {
  const clock = testClock();
  const wall = new FixedWallClock();
  const storage = memoryStorage(opts.kv ?? new MemoryKeyValue(), opts.failWrites ?? { on: false });
  const audits: AuditEvent[] = [];
  const stats = new StatsModel({ wall, audit: (e) => audits.push(e) });
  const credits = fakeCredits(stats);
  const params = new ParamsStore();
  const settings = new SettingsStore();
  const sfx = createSilentSfx();
  const applied: AdminParams[] = [];
  const exits = { count: 0 };
  const testPlayCalls = { started: 0, stopped: 0 };
  const rankingState = { size: 0, cleared: 0 };

  if (opts.live !== undefined) {
    params.set(opts.live);
    settings.set(opts.live.machine);
  }
  storage.storage.register(params.asSaveDocument());
  storage.storage.register(settings.asSaveDocument());

  const ranking = {
    get size(): number {
      return rankingState.size;
    },
    set size(n: number) {
      rankingState.size = n;
    },
    get cleared(): number {
      return rankingState.cleared;
    },
    clear(): void {
      // 파일 잠김·저장소 오류로 포트가 던지는 상황 — 위험 작업이 고착하면 안 된다 (D-3)
      if (opts.throwOnRankingClear === true) throw new Error('ranking port failed');
      rankingState.cleared += 1;
      rankingState.size = 0;
    },
  };

  const deps: AdminControllerDeps = {
    clock,
    nowIso: () => wall.nowIso(),
    params,
    settings,
    storage: storage.storage,
    solverGate: opts.solverGate ?? okSolverGate(),
    credits,
    ranking,
    audit: (e) => audits.push(e),
    sfx,
    applyParams: (p) => applied.push(p),
    leaveAdmin: () => {
      exits.count += 1;
    },
    system: {
      restart: () => Promise.resolve('ok'),
      reboot: () => Promise.resolve('[보류]'),
      shutdown: () => Promise.resolve('[보류]'),
    },
    testPlay: {
      start: () => {
        testPlayCalls.started += 1;
      },
      stop: () => {
        testPlayCalls.stopped += 1;
      },
    },
  };

  const admin = new AdminController(deps);
  admin.enter();

  return {
    admin,
    clock,
    wall,
    params,
    settings,
    storage,
    credits,
    stats,
    audits,
    sfx,
    ranking,
    applied,
    exits,
    testPlayCalls,
    press(action: InputAction): void {
      admin.handle(action);
    },
    focus(rowId: string): boolean {
      const rows = admin.view().rows;
      for (let i = 0; i <= rows.length; i += 1) {
        const view = admin.view();
        if (view.rows[view.cursor]?.id === rowId) return true;
        admin.handle('DOWN');
      }
      return false;
    },
    holdConfirm(ms: number): void {
      admin.handle('BUTTON1');
      clock.advance(ms);
      admin.tick();
      admin.phase({ player: 1, action: 'BUTTON1', phase: 'up', sourceId: 'k:H' });
    },
  };
}

// ── ⑥ 앱 전체 리그 (통합) ──────────────────────────────────────────────────

/** 진로가 공집합인 사슬만 있는 보드 — 조작 시나리오가 흔들리지 않는다 */
export function openBoard(count: number, boardNumber = 1): Board {
  return new Board({
    chains: Array.from({ length: count }, (_, i) =>
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
    seed: `wu05-open-${String(boardNumber)}`,
  });
}

interface AppRig {
  readonly app: AppContext;
  readonly input: FakePhaseInput;
  readonly clock: TestClock;
  readonly wall: FixedWallClock;
  readonly storage: StorageRig;
  readonly sfx: SilentSfx;
  readonly audits: AuditEvent[];
  readonly boardNumbers: number[];
  send(...actions: InputAction[]): void;
  /**
   * 입력 1건 + 프레임 마감. `BUTTON2`는 §2.4 동시 입력 판정 때문에 프레임이 끝날 때까지
   * 붙잡혀 있으므로, 실제 씬처럼 `tick()`을 불러 줘야 화면에 도달한다.
   */
  press(...actions: InputAction[]): void;
  holdConfirm(ms: number): void;
}

interface AppRigOptions {
  kv?: MemoryKeyValue;
  solverGate?: SolverGate;
  coinsPerPlay?: number;
  boards?: (n: number) => Board;
}

export function makeApp(opts: AppRigOptions = {}): AppRig {
  const clock = testClock();
  const wall = new FixedWallClock();
  const storage = memoryStorage(opts.kv ?? new MemoryKeyValue());
  const input = fakePhaseInput();
  const sfx = createSilentSfx();
  const audits: AuditEvent[] = [];
  const boardNumbers: number[] = [];
  const make = opts.boards ?? ((n: number): Board => openBoard(3, n));
  const boardSource: BoardSource = {
    next: (req: BoardRequest) => {
      boardNumbers.push(req.boardNumber);
      return make(req.boardNumber);
    },
  };

  const options: AppOptions = {
    input,
    boardSource,
    clock,
    wall,
    storage: storage.storage,
    sfx,
    nowIso: () => wall.nowIso(),
    ...(opts.solverGate === undefined ? {} : { solverGate: opts.solverGate }),
    ...(opts.coinsPerPlay === undefined ? {} : { coinsPerPlay: opts.coinsPerPlay }),
  };
  const app = createApp(options);
  app.onAudit((e) => audits.push(e));

  return {
    app,
    input,
    clock,
    wall,
    storage,
    sfx,
    audits,
    boardNumbers,
    send(...actions: InputAction[]): void {
      for (const a of actions) input.fire(a);
    },
    press(...actions: InputAction[]): void {
      for (const a of actions) {
        input.fire(a);
        app.flow.tick();
      }
    },
    holdConfirm(ms: number): void {
      input.down('BUTTON1');
      clock.advance(ms);
      app.admin.tick();
      input.up('BUTTON1');
    },
  };
}
