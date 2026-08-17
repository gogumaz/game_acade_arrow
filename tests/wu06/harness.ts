// WU-06 테스트 하네스 — 폴트 주입 가짜 FS · 결정적 난수 · 저장소 리그 · 가짜 health.
//
// 이 파일은 `*.test.ts`가 아니므로 Vitest가 수집하지 않는다(테스트 0건).
//
// 세 가지가 이 유닛의 판정을 가능하게 한다.
//   ① `InjectableFs` — "N번째 fs 호출에서 차단"을 넣어 5단계 안전 쓰기를 임의 지점에서 끊는다.
//      부분 기록(찢어진 `.tmp`)도 재현하므로 SAV-701의 "손실 0"이 시뮬레이션으로 성립한다.
//   ② `mulberry32` — 고정 시드 결정적 난수. 500회 폴트-인젝션이 매 실행 같은 순서를 밟는다.
//   ③ `FakeHealth` — 메인 프로세스 없이 STORAGE LOW·SERVICE REQUIRED를 만든다.

import path from 'node:path';
import { createSafeWriter, type SafeWriterFs } from '../../electron/safe-write.cjs';
import type { HealthReport } from '../../src/game/health';
import {
  Storage,
  localStorageBackend,
  STORAGE_PREFIX,
  type KeyValueStore,
  type SaveDocument,
  type StorageBackend,
  type StorageTimers,
} from '../../src/persist/storage';

// ── ① 폴트 주입 가짜 FS ────────────────────────────────────────────────────

/** 안전 쓰기가 쓰는 fs 연산 전량 (`readdir`·`unlink`·`statfs`는 WU-06이 더한 것) */
export type FsOp = 'writeFile' | 'readFile' | 'appendFile' | 'rename' | 'access' | 'unlink';

export interface InjectionPlan {
  /** 1-base 호출 번호. 이 호출에서 차단한다 */
  readonly atCall: number;
  /**
   * `throw`  = 호출 직전에 예외 (아무 흔적도 남지 않는다)
   * `torn`   = `writeFile`이 내용의 앞 절반만 쓴 뒤 예외 (찢어진 `.tmp`)
   * `silent` = 호출이 아무 일도 하지 않고 성공한 척 (rename 유실 재현)
   */
  readonly kind: 'throw' | 'torn' | 'silent';
}

function enoent(file: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${file}`);
  err.code = 'ENOENT';
  return err;
}

/**
 * 인메모리 FS. 파일 내용을 그대로 들고 있고, 호출 순서를 세어 지정한 지점에서 차단한다.
 * **전원 차단과 같은 의미**를 만들기 위해 예외 이후 `halted`가 서고, 그 뒤 모든 호출이
 * 즉시 실패한다 — 실기에서 전원이 끊기면 남은 단계가 실행될 리 없기 때문이다.
 */
export class InjectableFs implements SafeWriterFs {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  private plan: InjectionPlan | null = null;
  private halted = false;
  /** `statfs`가 돌려줄 남은 바이트 (null이면 `statfs` 자체가 없다) */
  freeBytes: number | null = 10 * 1024 * 1024 * 1024;

  inject(plan: InjectionPlan | null): void {
    this.plan = plan;
    this.halted = false;
    this.calls.length = 0;
  }

  /** 전원 차단 이후를 흉내 낸다 — 이 시점의 파일 상태가 곧 재부팅 직후 디스크다 */
  get powerCut(): boolean {
    return this.halted;
  }

  /** 재부팅 — 주입 계획을 지우고 fs를 다시 살린다. 파일 상태는 그대로다 */
  reboot(): void {
    this.halted = false;
    this.plan = null;
    this.calls.length = 0;
  }

  snapshot(): Map<string, string> {
    return new Map(this.files);
  }

  restore(snapshot: Map<string, string>): void {
    this.files.clear();
    for (const [k, v] of snapshot) this.files.set(k, v);
  }

  names(): string[] {
    return [...this.files.keys()].map((f) => path.basename(f)).sort();
  }

  private gate(op: FsOp, file: string): InjectionPlan['kind'] | null {
    if (this.halted) throw new Error('power cut');
    this.calls.push(`${op}:${path.basename(file)}`);
    const plan = this.plan;
    if (plan === null || this.calls.length !== plan.atCall) return null;
    this.halted = true;
    if (plan.kind === 'throw') throw new Error(`injected fault at ${op}:${path.basename(file)}`);
    return plan.kind;
  }

  writeFile(file: string, data: string): Promise<void> {
    const kind = this.gate('writeFile', file);
    if (kind === 'silent') return Promise.reject(new Error('power cut during writeFile'));
    if (kind === 'torn') {
      // 찢어진 기록 — 절반만 디스크에 닿았다. 5단계 2번(재읽기 검증)이 잡아야 한다
      this.files.set(file, data.slice(0, Math.floor(data.length / 2)));
      return Promise.reject(new Error('power cut during writeFile (torn)'));
    }
    this.files.set(file, data);
    return Promise.resolve();
  }

  readFile(file: string): Promise<string> {
    // `throw` 외의 주입 종류도 읽기에서는 결국 "이 호출이 끝나지 못했다"와 같다
    if (this.gate('readFile', file) !== null) return Promise.reject(new Error('power cut'));
    const v = this.files.get(file);
    if (v === undefined) return Promise.reject(enoent(file));
    return Promise.resolve(v);
  }

  appendFile(file: string, data: string): Promise<void> {
    if (this.gate('appendFile', file) !== null) return Promise.reject(new Error('power cut'));
    this.files.set(file, (this.files.get(file) ?? '') + data);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    const kind = this.gate('rename', from);
    if (kind === 'silent') return Promise.reject(new Error('power cut before rename'));
    const v = this.files.get(from);
    if (v === undefined) return Promise.reject(enoent(from));
    this.files.delete(from);
    this.files.set(to, v);
    return Promise.resolve();
  }

  access(file: string): Promise<void> {
    if (this.gate('access', file) !== null) return Promise.reject(new Error('power cut'));
    if (!this.files.has(file)) return Promise.reject(enoent(file));
    return Promise.resolve();
  }

  readdir(dir: string): Promise<string[]> {
    if (this.halted) return Promise.reject(new Error('power cut'));
    const prefix = `${dir}${path.sep}`;
    return Promise.resolve(
      [...this.files.keys()].filter((f) => f.startsWith(prefix)).map((f) => path.basename(f))
    );
  }

  unlink(file: string): Promise<void> {
    if (this.gate('unlink', file) !== null) return Promise.reject(new Error('power cut'));
    if (!this.files.has(file)) return Promise.reject(enoent(file));
    this.files.delete(file);
    return Promise.resolve();
  }

  statfs(): Promise<{ bsize: number; bavail: number }> {
    if (this.freeBytes === null) return Promise.reject(new Error('statfs unsupported'));
    return Promise.resolve({ bsize: 4096, bavail: this.freeBytes / 4096 });
  }
}

export const FAKE_DIR = path.join('C:', 'fake', 'log');

export function makeWriter(fs = new InjectableFs()): {
  fs: InjectableFs;
  writer: ReturnType<typeof createSafeWriter>;
} {
  return { fs, writer: createSafeWriter({ fsp: fs, dir: FAKE_DIR }) };
}

// ── ② 결정적 난수 (SAV-701 500회) ─────────────────────────────────────────

/** mulberry32 — 32비트 시드 1개로 완전히 결정적이다 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 작업 계획 P-4가 고정한 시드 */
export const FAULT_SEED = 0x57055;

// ── ③ 저장소 리그 ──────────────────────────────────────────────────────────

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
    return [...this.map.keys()].map((k) => k.slice(STORAGE_PREFIX.length)).sort();
  }
}

export interface StorageRig {
  readonly storage: Storage;
  readonly kv: MemoryKeyValue;
  readonly errors: { phase: string; error: unknown }[];
  readonly logged: string[];
  flush(): void;
}

export interface StorageRigOptions {
  kv?: MemoryKeyValue;
  /** 쓰기를 실패시킨다 — 이름별로도 끌 수 있다 */
  failWrites?: { on: boolean; only?: (name: string) => boolean };
  /** append를 실패시킨다 — §12.4 크레딧 로그 실패 연속 3회 판정용 (FIX 사이클 1) */
  failAppends?: { on: boolean; only?: (name: string) => boolean };
  /**
   * 읽기 직전 훅 — 파일명과 그 파일의 누적 읽기 횟수(1-base)를 받아 Promise를 돌려주면
   * 그 Promise가 풀릴 때까지 읽기가 멈춘다. F-3 부팅 경합을 결정적으로 재현한다.
   */
  interceptRead?: (name: string, call: number) => Promise<void> | null;
  today?: () => string;
}

export function memoryStorage(opts: StorageRigOptions = {}): StorageRig {
  const kv = opts.kv ?? new MemoryKeyValue();
  const failWrites = opts.failWrites ?? { on: false };
  const failAppends = opts.failAppends ?? { on: false };
  const readCalls = new Map<string, number>();
  const errors: { phase: string; error: unknown }[] = [];
  const logged: string[] = [];
  let pending: (() => void) | null = null;
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
  const backend: StorageBackend = {
    kind: base.kind,
    read: async (n) => {
      const call = (readCalls.get(n) ?? 0) + 1;
      readCalls.set(n, call);
      // **값을 이미 읽은 뒤** 반환만 지연한다 — 호출자는 낡은 스냅샷을 들고 있게 되고,
      // 게이트가 열리기 전의 append는 그 스냅샷에 없다 (F-3 read-modify-write 경합 재현)
      const value = await base.read(n);
      const gate = opts.interceptRead?.(n, call) ?? null;
      if (gate !== null) await gate;
      return value;
    },
    append: (n, l) => {
      const blocked = failAppends.on && (failAppends.only === undefined || failAppends.only(n));
      return blocked ? Promise.reject(new Error(`append failed: ${n}`)) : base.append(n, l);
    },
    write: (n, c) => {
      const blocked = failWrites.on && (failWrites.only === undefined || failWrites.only(n));
      return blocked ? Promise.reject(new Error(`write failed: ${n}`)) : base.write(n, c);
    },
  };
  const storage = new Storage({
    backend,
    timers,
    onError: (phase, error) => errors.push({ phase, error }),
    env: {
      gameFS: {
        write: (n, c) => backend.write(n, c),
        read: (n) => backend.read(n),
        append: (n, l) => backend.append(n, l),
        logError: (m) => {
          logged.push(m);
          return Promise.resolve();
        },
      },
    },
    ...(opts.today === undefined ? {} : { today: opts.today }),
  });
  return {
    storage,
    kv,
    errors,
    logged,
    flush(): void {
      const fn = pending;
      pending = null;
      if (fn !== null) fn();
    },
  };
}

// ── ④ 가짜 저장 문서 ───────────────────────────────────────────────────────

export const DOC_HEADER = 'schema,value';

/** `value`가 정수 1개인 최소 문서 — 복구 판정에 필요한 것만 갖는다 */
export class CounterDoc {
  value = 0;
  applied: string[] = [];
  versionMismatch = false;

  constructor(
    readonly file: 'settings.csv' | 'params.csv' | 'stats.csv' | 'ranking.csv' = 'settings.csv'
  ) {}

  static csv(value: number): string {
    return `${DOC_HEADER}\n1,${String(value)}`;
  }

  serialize(): string {
    return CounterDoc.csv(this.value);
  }

  asSaveDocument(): SaveDocument {
    return {
      file: this.file,
      serialize: () => this.serialize(),
      apply: (csv) => {
        this.applied.push(csv);
        this.value = Number(csv.split('\n')[1].split(',')[1]);
      },
      validate: (csv) => {
        const lines = csv.split('\n');
        if (lines[0] !== DOC_HEADER || lines.length < 2) return false;
        return Number.isFinite(Number(lines[1].split(',')[1]));
      },
      needsVersionBackup: () => this.versionMismatch,
    };
  }
}

// ── ⑤ 가짜 health ──────────────────────────────────────────────────────────

export function fakeHealth(over: Partial<HealthReport> = {}): HealthReport {
  return {
    fatalCount: 0,
    serviceRequired: false,
    freeBytes: 8 * 1024 * 1024 * 1024,
    storageLow: false,
    machine: null,
    ...over,
  };
}

/** 대기 중인 마이크로태스크를 전부 흘려보낸다 */
export function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
