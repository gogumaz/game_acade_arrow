// WU-04 테스트 하네스 — 조작 가능한 벽시계 · 재기동 가능한 저장소 · 서비스/앱 결선 도구.
//
// 이 파일은 `*.test.ts`가 아니므로 Vitest가 수집하지 않는다(테스트 0건).
//
// 두 가지가 이 유닛의 판정을 가능하게 한다.
//   ① `MutableWallClock` — 날짜와 epoch를 따로 조작해 롤오버·24시간 역행을 만든다
//   ② `MemoryKeyValue` — `createApp()`을 두 번 불러도 살아남는 저장소. **프로세스 재기동**을
//      그대로 흉내 내므로 CRD-606을 자동 판정할 수 있다

import { createChain } from '../../src/core/chain';
import { CreditWallet } from '../../src/core/credits';
import { FACTORY_PARAMS, type CoreParams } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import { StatsModel, type AuditEvent, type RunMarker, type WallClock } from '../../src/core/stats';
import type { Chain, Clock, InputAction, PlayerId } from '../../src/core/types';
import type { BoardRequest, BoardSource } from '../../src/game/boardSource';
import { createApp, type AppContext, type AppOptions } from '../../src/game/app';
import { CrashRecovery, type CrashRecoveryDeps } from '../../src/game/crashRecovery';
import { CreditsService, type CreditsServiceDeps } from '../../src/game/creditsService';
import type { InputAdapter, PlayerAction } from '../../src/game/input';
import { createSilentSfx, type SilentSfx } from '../../src/game/sfx';
import { FILES, type SaveFileName } from '../../src/persist/csv';
import {
  localStorageBackend,
  STORAGE_PREFIX,
  Storage,
  type KeyValueStore,
  type StorageTimers,
} from '../../src/persist/storage';

const DAY_MS = 86_400_000;

// ── ① 조작 가능한 벽시계 ───────────────────────────────────────────────────

/**
 * 날짜와 epoch를 **따로** 움직일 수 있는 벽시계.
 *
 * 둘을 묶어 두면 "날짜는 그대로인데 시각만 24시간 뒤로" 같은 admin §11.5 사례를 만들 수 없다.
 */
export class MutableWallClock implements WallClock {
  private date: string;
  private ms: number;

  constructor(date = '2026-08-16', ms = Date.parse('2026-08-16T10:00:00.000Z')) {
    this.date = date;
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

  /** 날짜와 epoch를 함께 하루 뒤로 — 정상적인 자정 넘김 */
  nextDay(date: string): void {
    this.date = date;
    this.ms += DAY_MS;
  }

  /** 날짜만 바꾼다 (epoch는 그대로) */
  setDate(date: string): void {
    this.date = date;
  }

  setMs(ms: number): void {
    this.ms = ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

// ── ② 재기동에서 살아남는 저장소 ───────────────────────────────────────────

/**
 * `localStorage` 대역. `localStorageBackend`를 그대로 태우므로 헤더 부착·2000줄 절단 같은
 * WU-01 규칙이 테스트에서도 실제와 같이 동작한다.
 */
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

  /** 저장된 파일 내용을 그대로 본다 (증거 덤프) */
  dump(file: SaveFileName): string | null {
    return this.getItem(`${STORAGE_PREFIX}${file}`);
  }

  put(file: SaveFileName, csv: string): void {
    this.setItem(`${STORAGE_PREFIX}${file}`, csv);
  }
}

interface StorageRig {
  readonly storage: Storage;
  readonly kv: MemoryKeyValue;
  /** 예약된 디바운스 저장을 즉시 실행한다 */
  flush(): void;
  readonly errors: { phase: string; error: unknown }[];
}

function memoryStorage(kv = new MemoryKeyValue()): StorageRig {
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
  const storage = new Storage({
    backend: localStorageBackend(kv),
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

// ── 순수 계층 결선 ─────────────────────────────────────────────────────────

export interface ServiceRig {
  readonly wall: MutableWallClock;
  readonly clock: { now(): number; set(ms: number): void; advance(ms: number): void };
  readonly stats: StatsModel;
  readonly wallet: CreditWallet;
  readonly credits: CreditsService;
  readonly audits: AuditEvent[];
  readonly markers: RunMarker[];
  /** `onRunReverted` 통지 횟수 — 검증 V-1 (마커 해제 요구) */
  readonly reverts: { count: number };
  /** 기록된 `credit_log.csv` 행 (헤더 없음) */
  readonly lines: string[];
  /** append 실패 주입 — §12.4 판정용 */
  setLogFailing(on: boolean): void;
  logCsv(): string;
  flush(): Promise<void>;
  readonly changes: { count: number };
}

interface ServiceOptions {
  coinsPerPlay?: number;
  continueCoins?: number;
  coinUnitPrice?: number | null;
  isTestPlay?: () => boolean;
  wall?: MutableWallClock;
  wallet?: CreditWallet;
  stats?: StatsModel;
  ringCapacity?: number;
}

/** 시계·로그를 전부 통제하는 `CreditsService` 1벌 */
export function makeService(opts: ServiceOptions = {}): ServiceRig {
  const wall = opts.wall ?? new MutableWallClock();
  const audits: AuditEvent[] = [];
  const markers: RunMarker[] = [];
  const reverts = { count: 0 };
  const lines: string[] = [];
  const changes = { count: 0 };
  let failing = false;
  let ms = 0;

  const clock = {
    now: () => ms,
    set: (v: number) => {
      ms = v;
    },
    advance: (v: number) => {
      ms += v;
    },
  };

  const stats =
    opts.stats ??
    new StatsModel({
      wall,
      audit: (e) => audits.push(e),
      ringCapacity: opts.ringCapacity,
    });
  const wallet = opts.wallet ?? new CreditWallet();

  const deps: CreditsServiceDeps = {
    stats,
    wallet,
    clock,
    nowIso: () => wall.nowIso(),
    appendCreditLog: (line) => {
      if (failing) return Promise.reject(new Error('append failed'));
      lines.push(line);
      return Promise.resolve();
    },
    audit: (e) => audits.push(e),
    coinsPerPlay: opts.coinsPerPlay,
    continueCoins: opts.continueCoins,
    coinUnitPrice: opts.coinUnitPrice,
    isTestPlay: opts.isTestPlay,
    onRunCharged: (m) => markers.push(m),
    onRunReverted: () => {
      reverts.count += 1;
    },
    onStatsChanged: () => {
      changes.count += 1;
    },
  };

  const credits = new CreditsService(deps);
  // 실제 부팅 순서와 맞춘다 — `app.ts`가 조립 직후 `noteBoot()`으로 기준 날짜를 세운다
  credits.noteBoot();

  return {
    wall,
    clock,
    stats,
    wallet,
    credits,
    audits,
    markers,
    reverts,
    lines,
    changes,
    setLogFailing(on: boolean): void {
      failing = on;
    },
    logCsv(): string {
      return lines.join('\n');
    },
    flush(): Promise<void> {
      return credits.flushLog();
    },
  };
}

/** `CrashRecovery` 1벌 — 저장은 호출 횟수만 센다 */
export interface RecoveryRig extends ServiceRig {
  readonly recovery: CrashRecovery;
  readonly saves: { count: number };
}

export function makeRecovery(opts: ServiceOptions = {}): RecoveryRig {
  const rig = makeService(opts);
  const saves = { count: 0 };
  const deps: CrashRecoveryDeps = {
    stats: rig.stats,
    credits: rig.credits,
    nowIso: () => rig.wall.nowIso(),
    audit: (e) => rig.audits.push(e),
    saveNow: () => {
      saves.count += 1;
    },
  };
  return { ...rig, recovery: new CrashRecovery(deps), saves };
}

// ── 앱 전체 결선 (통합) ────────────────────────────────────────────────────

/** DOM을 건드리지 않는 입력 어댑터 — `createApp()`이 `attach()`를 부르기 때문에 필요하다 */
function nullInput(): InputAdapter & { fire(action: InputAction, player?: PlayerId): void } {
  const listeners = new Set<(pa: PlayerAction) => void>();
  return {
    id: 'null',
    status: 'connected',
    attach: () => undefined,
    detach: () => undefined,
    onAction(fn: (pa: PlayerAction) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAnyKey: () => () => undefined,
    onStatusChange: () => () => undefined,
    fire(action: InputAction, player: PlayerId = 1): void {
      for (const fn of [...listeners]) fn({ action, player });
    },
  };
}

/** 진로가 공집합인 사슬만 있는 보드 — 전부 안전수라 조작 시나리오가 흔들리지 않는다 */
function openBoard(count: number, boardNumber = 1): Board {
  const chains: Chain[] = [];
  for (let i = 0; i < count; i += 1) {
    chains.push(
      createChain(
        i + 1,
        [
          { x: 11, y: i * 2 },
          { x: 12, y: i * 2 },
        ],
        0
      )
    );
  }
  return new Board({ chains, boardNumber, seed: `wu04-open-${String(count)}` });
}

export interface AppRig {
  readonly app: AppContext;
  readonly input: ReturnType<typeof nullInput>;
  readonly clock: { now(): number; set(ms: number): void; advance(ms: number): void };
  readonly wall: MutableWallClock;
  readonly storage: StorageRig;
  readonly sfx: SilentSfx;
  readonly audits: AuditEvent[];
  send(...actions: InputAction[]): void;
}

interface AppRigOptions {
  kv?: MemoryKeyValue;
  wall?: MutableWallClock;
  boards?: (n: number) => Board;
  params?: Partial<CoreParams>;
  coinsPerPlay?: number;
  continueCoins?: number;
  coinUnitPrice?: number | null;
}

/**
 * `createApp()`을 실제 조립 그대로 만든다. `kv`를 물려주면 **프로세스 재기동**이 된다
 * (같은 파일 내용 위에서 새 앱이 부팅한다 — CRD-606 판정의 핵심).
 */
export function makeApp(opts: AppRigOptions = {}): AppRig {
  const wall = opts.wall ?? new MutableWallClock();
  const storage = memoryStorage(opts.kv ?? new MemoryKeyValue());
  const input = nullInput();
  const sfx = createSilentSfx();
  const audits: AuditEvent[] = [];
  let ms = 0;
  const clock = {
    now: () => ms,
    set: (v: number) => {
      ms = v;
    },
    advance: (v: number) => {
      ms += v;
    },
  };
  const make = opts.boards ?? ((n: number): Board => openBoard(2, n));
  const boardSource: BoardSource = { next: (req: BoardRequest) => make(req.boardNumber) };

  const options: AppOptions = {
    params: { ...FACTORY_PARAMS, ...opts.params },
    input,
    boardSource,
    clock: clock as Clock,
    wall,
    storage: storage.storage,
    sfx,
    nowIso: () => wall.nowIso(),
    coinsPerPlay: opts.coinsPerPlay,
    continueCoins: opts.continueCoins,
    coinUnitPrice: opts.coinUnitPrice,
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
    send(...actions: InputAction[]): void {
      for (const a of actions) input.fire(a);
    },
  };
}

/** 저장 파일명 재수출 — 테스트가 문자열을 다시 적지 않게 한다 */
export { FILES };
