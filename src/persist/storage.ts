// 저장 계층 (§9.2 저장 백엔드와 시점 · §9.1 저장 경로 `./log/`)
//
// Electron에서는 메인 프로세스의 단일 직렬 쓰기 큐(§9.3)를 IPC로 쓰고, 브라우저 개발
// 모드에서는 localStorage, 저장 불가 샌드박스에서는 세션 메모리로 강등한다.
//
// **의존 방향**: `src/core/`의 도메인 싱글턴을 구독하지 않는다. 나중 유닛이 저장 대상
// 문서를 `register()`로 등록하면 이 계층이 로드·디바운스 저장만 담당한다 (작업 계획 D-5).

import { APPEND_ONLY_FILES, CREDIT_LOG_HEADER, FILES, type SaveFileName } from './csv';

/** preload.cjs가 노출하는 파일 API (§9.2 Electron 파일 IPC) */
export interface GameFs {
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string | null>;
  append(name: string, line: string): Promise<void>;
}

/** localStorage 대체 가능한 최소 키-값 저장소 (jsdom 없이 테스트하기 위한 주입 지점) */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type BackendKind = 'electron' | 'localStorage' | 'memory';

export interface StorageBackend {
  readonly kind: BackendKind;
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string | null>;
  append(name: string, line: string): Promise<void>;
}

/** localStorage 키 접두사 (§9.2) */
export const STORAGE_PREFIX = 'neongrid:';
/** localStorage 로그 보존 줄 수 — 헤더 제외 최근 N줄 (§9.2) */
export const LOG_KEEP_LINES = 2000;
/** 변경 후 저장까지의 디바운스 (§9.2 · SAV-003) */
export const SAVE_DEBOUNCE_MS = 800;

/** 추가 전용 파일의 첫 줄 헤더. 헤더가 정해진 파일만 붙인다 (§9.1 · 작업 계획 D-4) */
function headerFor(name: string): string | null {
  return name === FILES.creditLog ? CREDIT_LOG_HEADER : null;
}

/** 로그 파일에 1줄을 덧붙이고 최근 LOG_KEEP_LINES줄만 남긴다 (헤더는 보존) */
function appendTrimmed(current: string | null, line: string, name: string): string {
  const header = headerFor(name);
  const base = current ?? header ?? '';
  const joined = base === '' ? line : `${base}\n${line}`;
  const lines = joined.split('\n');
  if (header === null) {
    return lines.length > LOG_KEEP_LINES
      ? lines.slice(lines.length - LOG_KEEP_LINES).join('\n')
      : joined;
  }
  if (lines.length > LOG_KEEP_LINES + 1) {
    return [lines[0], ...lines.slice(lines.length - LOG_KEEP_LINES)].join('\n');
  }
  return joined;
}

// ── 백엔드 3종 (§9.2) ─────────────────────────────────────────────────────

/** 실제 기기 — 메인 프로세스의 안전 쓰기 큐를 그대로 쓴다 */
export function electronBackend(fs: GameFs): StorageBackend {
  return {
    kind: 'electron',
    write: (n, c) => fs.write(n, c),
    read: (n) => fs.read(n),
    append: (n, l) => fs.append(n, l),
  };
}

/** 브라우저 개발 모드 — 접두사 `neongrid:`, 로그는 최근 2000줄 유지 */
export function localStorageBackend(store: KeyValueStore): StorageBackend {
  const key = (n: string): string => `${STORAGE_PREFIX}${n}`;
  return {
    kind: 'localStorage',
    write: (n, c) => {
      store.setItem(key(n), c);
      return Promise.resolve();
    },
    read: (n) => Promise.resolve(store.getItem(key(n))),
    append: (n, l) => {
      store.setItem(key(n), appendTrimmed(store.getItem(key(n)), l, n));
      return Promise.resolve();
    },
  };
}

/** 저장 불가 샌드박스 — 세션 메모리 */
export function memoryBackend(): StorageBackend {
  const mem = new Map<string, string>();
  return {
    kind: 'memory',
    write: (n, c) => {
      mem.set(n, c);
      return Promise.resolve();
    },
    read: (n) => Promise.resolve(mem.get(n) ?? null),
    append: (n, l) => {
      mem.set(n, appendTrimmed(mem.get(n) ?? null, l, n));
      return Promise.resolve();
    },
  };
}

export interface BackendEnvironment {
  /** Electron preload가 노출한 파일 API */
  gameFS?: GameFs;
  /** 브라우저 localStorage (또는 그 대역) */
  localStorage?: KeyValueStore;
}

function isUsable(store: KeyValueStore): boolean {
  try {
    const probe = `${STORAGE_PREFIX}__probe`;
    store.setItem(probe, '1');
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/** 선택 우선순위: gameFS 존재 → localStorage 사용 가능 → 메모리 (§9.2) */
export function selectBackend(env: BackendEnvironment): StorageBackend {
  if (env.gameFS) return electronBackend(env.gameFS);
  if (env.localStorage && isUsable(env.localStorage)) return localStorageBackend(env.localStorage);
  return memoryBackend();
}

/** 브라우저 전역에서 환경을 읽는다 (유일한 DOM 접점) */
export function browserEnvironment(): BackendEnvironment {
  const w = globalThis as unknown as { gameFS?: GameFs; localStorage?: KeyValueStore };
  return { gameFS: w.gameFS, localStorage: w.localStorage };
}

// ── 저장 대상 문서 등록 + 디바운스 저장 ───────────────────────────────────

/**
 * 저장 대상 1건. 나중 유닛(`core/settings` · `core/stats` · `core/stages`)이
 * 자기 상태를 이 형태로 등록한다. 저장 계층은 도메인을 모른다.
 */
export interface SaveDocument {
  /** §9.1 저장 파일명 */
  file: SaveFileName;
  /** 현재 메모리 상태를 CSV 문자열로 만든다 */
  serialize(): string;
  /** 읽어 온 CSV를 메모리에 반영한다 */
  apply(csv: string): void;
}

type TimerHandle = unknown;

export interface StorageTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemStorageTimers: StorageTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

export interface StorageOptions {
  backend?: StorageBackend;
  env?: BackendEnvironment;
  timers?: StorageTimers;
  /** 저장 실패 보고 훅. 화면 오류 연결은 WU-06 (§9.6 · G13) */
  onError?: (phase: 'load' | 'save' | 'append', error: unknown) => void;
}

export class Storage {
  private readonly documents: SaveDocument[] = [];
  private readonly timers: StorageTimers;
  private readonly onError: (phase: 'load' | 'save' | 'append', error: unknown) => void;
  private backendRef: StorageBackend;
  private saveTimer: TimerHandle | null = null;

  constructor(options: StorageOptions = {}) {
    this.timers = options.timers ?? systemStorageTimers;
    this.onError =
      options.onError ??
      ((phase, error) => {
        console.error(`[storage] ${phase} failed:`, error);
      });
    this.backendRef = options.backend ?? selectBackend(options.env ?? {});
  }

  get backend(): StorageBackend {
    return this.backendRef;
  }

  get backendKind(): BackendKind {
    return this.backendRef.kind;
  }

  /** 실제 기기(Electron 파일 IPC) 여부 — §9.5 유료 플레이 차단 판정이 WU-06에서 쓴다 */
  get isElectron(): boolean {
    return this.backendRef.kind === 'electron';
  }

  /** 저장 대상 문서 등록. 추가 전용 파일은 문서로 등록할 수 없다 */
  register(doc: SaveDocument): void {
    if (APPEND_ONLY_FILES.includes(doc.file)) {
      throw new Error(`append-only file cannot be registered as a document: ${doc.file}`);
    }
    if (this.documents.some((d) => d.file === doc.file)) {
      throw new Error(`duplicate save document: ${doc.file}`);
    }
    this.documents.push(doc);
  }

  /** 부팅 시: 등록된 문서를 읽어 메모리에 반영한다 (§9.2) */
  async init(): Promise<void> {
    for (const doc of this.documents) {
      try {
        const csv = await this.backendRef.read(doc.file);
        if (csv !== null) doc.apply(csv);
      } catch (err) {
        this.onError('load', err);
      }
    }
  }

  /** 800ms 디바운스 — 창 안에 변경이 더 오면 1회만 저장한다 (§9.2 · SAV-003) */
  scheduleSave(): void {
    if (this.saveTimer !== null) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = null;
      void this.saveAll();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 등록 순서대로 순차 저장. 쓰기 순서는 메인 프로세스 큐가 보장한다 (§9.3) */
  async saveAll(): Promise<void> {
    for (const doc of this.documents) {
      try {
        await this.backendRef.write(doc.file, doc.serialize());
      } catch (err) {
        this.onError('save', err);
      }
    }
  }

  /** 추가 전용 로그 1줄 (§9.1 크레딧 변동 시 즉시 기록) */
  async appendLine(file: SaveFileName, line: string): Promise<void> {
    try {
      await this.backendRef.append(file, line);
    } catch (err) {
      this.onError('append', err);
    }
  }

  read(file: SaveFileName): Promise<string | null> {
    return this.backendRef.read(file);
  }

  /** 대기 중인 디바운스 저장이 있는지 (테스트·종료 처리용) */
  get hasPendingSave(): boolean {
    return this.saveTimer !== null;
  }
}
