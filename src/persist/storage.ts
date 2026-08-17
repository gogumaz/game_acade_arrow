// 저장 계층 (§12.2 저장 백엔드와 시점 · §12.1 저장 경로 `./log/` · §12.3 손상 복구)
//
// Electron에서는 메인 프로세스의 단일 직렬 쓰기 큐(§12.2)를 IPC로 쓰고, 브라우저 개발
// 모드에서는 localStorage, 저장 불가 샌드박스에서는 세션 메모리로 강등한다.
//
// **의존 방향**: `src/core/`의 도메인 싱글턴을 구독하지 않는다. 저장 대상 문서를
// `register()`로 등록하면 이 계층이 로드·검증·복구·디바운스 저장만 담당한다 (작업 계획 D-5).
//
// WU-06 — 손상 판정은 **문서가** 한다 (P-1). 메인 프로세스도 저장 계층도 CSV 스키마를 모르므로
// `SaveDocument.validate()`가 유일한 판정자다. 본 파일이 무효면 `<파일>.bak`으로 넘기고,
// 둘 다 무효면 메모리 공장값을 그대로 본 파일에 재기록한다.

import { APPEND_ONLY_FILES, CREDIT_LOG_HEADER, FILES, type SaveFileName } from './csv';

/** preload.cjs가 노출하는 파일 API (§12.2 Electron 파일 IPC) */
export interface GameFs {
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string | null>;
  append(name: string, line: string): Promise<void>;
  /** §12.3 — 치명 오류 횟수·디스크 여유·machine.json (WU-06 P-8). 브라우저에는 없다 */
  health?(): Promise<unknown>;
  /** SAV-702 — 저장 실패를 `error_YYYY-MM-DD.log`에 남긴다 (WU-06 P-13) */
  logError?(message: string): Promise<void>;
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

/** localStorage 키 접두사 (§12.1 개발 모드 localStorage) */
export const STORAGE_PREFIX = 'arrowout:';
/**
 * **개발 모드(localStorage·메모리) 전용** 로그 상한 — 헤더 제외 최근 N줄.
 *
 * 실기(Electron)의 보존 규칙은 `src/persist/retention.ts`의 12개월이다 (SAV-706). 브라우저
 * localStorage는 용량 상한(보통 5MB)이 있어 무한 추가가 곧 쓰기 실패이므로, 개발 백엔드에만
 * 남겨 둔 안전판이다. 실기 경로(`electronBackend.append`)에는 이 트림이 없다.
 */
export const LOG_KEEP_LINES = 2000;
/** 변경 후 저장까지의 디바운스 (§12.2 · SAV-003) */
export const SAVE_DEBOUNCE_MS = 800;
/** §12.1 — `.bak`은 1세대만 유지한다 (WU-06 P-3) */
export const BAK_SUFFIX = '.bak';

/** 추가 전용 파일의 첫 줄 헤더. 헤더가 정해진 파일만 붙인다 (§12.1 · 작업 계획 D-4) */
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

// ── 백엔드 3종 (§12.2) ────────────────────────────────────────────────────

/** 실제 기기 — 메인 프로세스의 안전 쓰기 큐를 그대로 쓴다 */
export function electronBackend(fs: GameFs): StorageBackend {
  return {
    kind: 'electron',
    write: (n, c) => fs.write(n, c),
    read: (n) => fs.read(n),
    // 실기 로그는 줄 수로 자르지 않는다 — 보존 규칙은 retention.ts의 12개월이다 (SAV-706)
    append: (n, l) => fs.append(n, l),
  };
}

/** 브라우저 개발 모드 — 접두사 `arrowout:`, 로그는 최근 2000줄 유지 (§12.1) */
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

/** 선택 우선순위: gameFS 존재 → localStorage 사용 가능 → 메모리 (§12.2) */
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
 * 저장 대상 1건. `core/settings` · `core/stats` · `core/params` 등이 자기 상태를 이 형태로
 * 등록한다. 저장 계층은 도메인을 모른다.
 */
export interface SaveDocument {
  /** §12.1 저장 파일명 */
  file: SaveFileName;
  /** 현재 메모리 상태를 CSV 문자열로 만든다 */
  serialize(): string;
  /** 읽어 온 CSV를 메모리에 반영한다 */
  apply(csv: string): void;
  /**
   * WU-06 P-1 — **이 CSV를 신뢰할 수 있는가.** 없으면 항상 유효로 본다(WU-01 동작).
   *
   * 손상 판정을 여기 둔 이유: 메인 프로세스도 저장 계층도 CSV 스키마를 모른다. 파서가
   * 관용적(손상 행을 버리고 계속)이라 "파싱이 끝났다"는 사실만으로는 손상을 알 수 없다.
   */
  validate?(csv: string): boolean;
  /**
   * WU-06 P-12 — `apply()` 뒤에 "스키마 버전이 달라 편집분을 버렸다"면 true.
   * 저장 계층은 그때 `<파일>.<날짜>.bak` 날짜 백업을 남기고 공장값을 재기록한다 (SAV-703).
   */
  needsVersionBackup?(): boolean;
}

/** WU-06 P-1 — 부팅 시 문서 1건이 어떻게 복구됐는가 (§12.3 경고 문구의 유일한 근거) */
export type BootOutcome =
  /** 본 파일이 유효했다 */
  | 'ok'
  /** 저장 파일이 아예 없었다 (최초 부팅) */
  | 'missing'
  /** 본 파일이 무효라 `.bak`을 되살렸다 — BACKUP RESTORED */
  | 'backup_restored'
  /** 본 파일·백업 모두 무효라 공장값으로 시작했다 — FACTORY DATA LOADED */
  | 'factory'
  /** 스키마 버전이 달라 날짜 백업을 남기고 공장값을 적용했다 (SAV-703) */
  | 'version_backup';

export interface BootReportEntry {
  readonly file: SaveFileName;
  readonly outcome: BootOutcome;
  /** 복구 후 본 파일 재기록이 실패했는가 — §12.4 "params 복구 불능"의 두 번째 조건 (가) */
  readonly rewriteFailed: boolean;
  /** 날짜 백업을 남긴 파일명 (`version_backup`일 때만) */
  readonly backupFile?: string;
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
  /** 저장 실패 보고 훅 (§12.3 · G13) */
  onError?: (phase: 'load' | 'save' | 'append', error: unknown) => void;
  /** WU-06 P-12 — 날짜 백업 파일명에 쓰는 로컬 날짜 `YYYY-MM-DD` */
  today?: () => string;
}

export class Storage {
  private readonly documents: SaveDocument[] = [];
  private readonly timers: StorageTimers;
  private readonly onError: (phase: 'load' | 'save' | 'append', error: unknown) => void;
  private readonly today: () => string;
  private readonly env: BackendEnvironment;
  private backendRef: StorageBackend;
  private saveTimer: TimerHandle | null = null;
  /**
   * 쓰기 실패 누적 횟수. `saveAll`·`saveNow`는 `onError`로 실패를 삼키므로 호출자가
   * "이번 저장이 성공했는가"를 알 방법이 없었다 — 관리자 `SAVE FAILED` 화면(ADM-302)에
   * 필요한 유일한 신호다. 호출 전후로 이 값을 비교한다.
   */
  private saveFailures = 0;
  /** §12.4 — **연속** 실패 횟수. 성공 1회로 0이 된다 (WU-06 P-5 ②) */
  private failStreak = 0;
  /** WU-06 P-1 — 부팅 복구 결과 */
  private readonly boot: BootReportEntry[] = [];
  /** WU-06 V-3 — `init()`이 도는 동안 도착한 저장 요청은 보류한다 */
  private initState: 'idle' | 'running' | 'done' = 'idle';
  private deferredSave = false;

  constructor(options: StorageOptions = {}) {
    this.timers = options.timers ?? systemStorageTimers;
    this.onError =
      options.onError ??
      ((phase, error) => {
        console.error(`[storage] ${phase} failed:`, error);
      });
    this.today = options.today ?? ((): string => new Date().toISOString().slice(0, 10));
    this.env = options.env ?? {};
    this.backendRef = options.backend ?? selectBackend(this.env);
  }

  get backend(): StorageBackend {
    return this.backendRef;
  }

  get backendKind(): BackendKind {
    return this.backendRef.kind;
  }

  /** 실제 기기(Electron 파일 IPC) 여부 — §12.4 유료 플레이 차단 판정이 쓴다 */
  get isElectron(): boolean {
    return this.backendRef.kind === 'electron';
  }

  /** preload가 노출한 원본 API — health·logError처럼 백엔드에 없는 채널의 입구 */
  get gameFs(): GameFs | null {
    return this.env.gameFS ?? null;
  }

  /** SAV-702 — 실기 오류 로그. 브라우저 모드에서는 조용히 무시된다 */
  logError(message: string): void {
    const fs = this.env.gameFS;
    if (fs?.logError === undefined) return;
    void fs.logError(message).catch(() => undefined);
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

  /**
   * 부팅 시: 등록된 문서를 읽어 메모리에 반영한다 (§12.2 · §12.3 복구 정책 P-1).
   *
   *   본 파일 유효           → 적용                                   'ok'
   *   본 파일 무효 · bak 유효 → bak 적용 + **본 파일 재기록**          'backup_restored'
   *   둘 다 무효             → 적용 안 함 + 공장값 재기록              'factory'
   *   둘 다 없음             → 아무것도 하지 않는다                    'missing'
   *   버전 불일치            → `<파일>.<날짜>.bak` + 공장값 재기록     'version_backup'
   */
  async init(): Promise<void> {
    this.initState = 'running';
    this.boot.length = 0;
    for (const doc of this.documents) {
      try {
        this.boot.push(await this.loadDocument(doc));
      } catch (err) {
        this.onError('load', err);
        this.boot.push({ file: doc.file, outcome: 'factory', rewriteFailed: true });
      }
    }
    this.initState = 'done';
    // V-3 — 부팅 중 들어온 저장 요청을 여기서 **1회** 처리한다. 로드 전에 써 버리면
    // 공장값이 저장 파일을 덮어써 마지막 정상값이 사라진다
    if (this.deferredSave) {
      this.deferredSave = false;
      await this.saveAll();
    }
  }

  private async loadDocument(doc: SaveDocument): Promise<BootReportEntry> {
    const main = await this.backendRef.read(doc.file);
    if (main !== null && this.isValid(doc, main)) {
      doc.apply(main);
      if (doc.needsVersionBackup?.() === true) return this.versionBackup(doc, main);
      return { file: doc.file, outcome: 'ok', rewriteFailed: false };
    }

    const bak = await this.backendRef.read(`${doc.file}${BAK_SUFFIX}`);
    if (bak !== null && this.isValid(doc, bak)) {
      doc.apply(bak);
      // 되살린 값을 **본 파일에 즉시 굳힌다** — 다음 부팅이 또 손상 파일을 만나지 않도록
      const rewriteFailed = !(await this.tryWrite(doc.file, doc.serialize()));
      if (doc.needsVersionBackup?.() === true) return this.versionBackup(doc, bak);
      return { file: doc.file, outcome: 'backup_restored', rewriteFailed };
    }

    if (main === null && bak === null) {
      return { file: doc.file, outcome: 'missing', rewriteFailed: false };
    }
    // 둘 다 무효 — 메모리 공장값을 그대로 굳힌다 (FACTORY DATA LOADED)
    const rewriteFailed = !(await this.tryWrite(doc.file, doc.serialize()));
    return { file: doc.file, outcome: 'factory', rewriteFailed };
  }

  /** SAV-703 — 버전 불일치 원본을 날짜 백업으로 남기고 공장값을 재기록한다 */
  private async versionBackup(doc: SaveDocument, originalCsv: string): Promise<BootReportEntry> {
    const backupFile = `${doc.file}.${this.today()}${BAK_SUFFIX}`;
    const kept = await this.tryWrite(backupFile, originalCsv);
    const rewriteFailed = !(await this.tryWrite(doc.file, doc.serialize()));
    return {
      file: doc.file,
      outcome: 'version_backup',
      rewriteFailed: rewriteFailed || !kept,
      backupFile,
    };
  }

  private isValid(doc: SaveDocument, csv: string): boolean {
    if (doc.validate === undefined) return true;
    try {
      return doc.validate(csv);
    } catch {
      return false;
    }
  }

  private async tryWrite(name: string, content: string): Promise<boolean> {
    try {
      await this.backendRef.write(name, content);
      this.failStreak = 0;
      return true;
    } catch (err) {
      this.saveFailures += 1;
      this.failStreak += 1;
      this.onError('save', err);
      return false;
    }
  }

  /** WU-06 P-1 — 부팅 복구 결과 전량 */
  get bootReport(): readonly BootReportEntry[] {
    return [...this.boot];
  }

  bootOutcomeOf(file: SaveFileName): BootReportEntry | null {
    return this.boot.find((e) => e.file === file) ?? null;
  }

  /** 800ms 디바운스 — 창 안에 변경이 더 오면 1회만 저장한다 (§12.2 · SAV-003) */
  scheduleSave(): void {
    if (this.saveTimer !== null) this.timers.clearTimeout(this.saveTimer);
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = null;
      void this.saveAll();
    }, SAVE_DEBOUNCE_MS);
  }

  /** 등록 순서대로 순차 저장. 쓰기 순서는 메인 프로세스 큐가 보장한다 (§12.2) */
  async saveAll(): Promise<void> {
    if (this.deferUntilLoaded()) return;
    for (const doc of this.documents) {
      await this.writeDoc(doc);
    }
  }

  /** 지금까지의 쓰기 실패 횟수 — 호출 전후 비교로 "이번 저장 성공" 여부를 얻는다 */
  get saveFailureCount(): number {
    return this.saveFailures;
  }

  /** §12.4 — 연속 저장 실패 횟수. 성공 1회로 0이 된다 (WU-06 P-5 ② · 가정 (다)) */
  get saveFailStreak(): number {
    return this.failStreak;
  }

  /**
   * FIX 사이클 1 (검증 F-3) — `rewriteLog()`가 도는 파일의 append는 여기 쌓였다가
   * 재기록이 끝난 뒤 순서대로 흘려보낸다. Promise는 **실제 append가 끝날 때** 풀리므로
   * `appendLineStrict`의 실패 신호(§12.4)도 그대로 살아 있다.
   */
  private readonly rewriteQueues = new Map<
    SaveFileName,
    { line: string; resolve: () => void; reject: (err: unknown) => void }[]
  >();

  /** append 원형 — 재기록 중이면 버퍼로, 아니면 곧장 백엔드로 */
  private rawAppend(file: SaveFileName, line: string): Promise<void> {
    const queue = this.rewriteQueues.get(file);
    if (queue !== undefined) {
      return new Promise<void>((resolve, reject) => {
        queue.push({ line, resolve, reject });
      });
    }
    return this.backendRef.append(file, line);
  }

  /** 추가 전용 로그 1줄 (§12.1 크레딧 변동 시 즉시 기록) */
  async appendLine(file: SaveFileName, line: string): Promise<void> {
    try {
      await this.rawAppend(file, line);
    } catch (err) {
      this.onError('append', err);
    }
  }

  /**
   * 실패를 **던지는** append (§12.4 "유료 크레딧 차감 로그 기록 실패 반복" 판정용).
   * `appendLine`은 `onError`로 삼키므로 호출자가 실패를 셀 수 없다 (WU-04 §6.2).
   */
  async appendLineStrict(file: SaveFileName, line: string): Promise<void> {
    try {
      await this.rawAppend(file, line);
    } catch (err) {
      this.onError('append', err);
      throw err;
    }
  }

  /**
   * 추가 전용 로그의 읽기-수정-쓰기를 **경합 없이** 수행한다 (검증 F-3 · SAV-706).
   *
   * read와 write 사이에 들어오는 append는 버퍼에 쌓였다가 재기록 뒤 순서대로 반영되므로
   * "정리 도중 적립된 크레딧 로그 행"이 유실되지 않는다 (§12.2 크레딧 손실 0).
   *
   * `transform`이 `null`을 돌려주면 다시 쓰지 않는다(변경 없음). 실패는 `onError`로
   * 삼킨다 — 보존 정리 실패가 부팅을 막지 않는다. 반환값은 "실제로 다시 썼는가"다.
   */
  async rewriteLog(
    file: SaveFileName,
    transform: (csv: string | null) => string | null
  ): Promise<boolean> {
    if (this.rewriteQueues.has(file)) return false; // 같은 파일 중복 재기록 금지
    this.rewriteQueues.set(file, []);
    let changed = false;
    try {
      const csv = await this.backendRef.read(file);
      const next = transform(csv);
      if (next !== null) {
        await this.backendRef.write(file, next);
        changed = true;
      }
    } catch (err) {
      this.onError('save', err);
    } finally {
      const queue = this.rewriteQueues.get(file) ?? [];
      this.rewriteQueues.delete(file);
      for (const item of queue) {
        try {
          await this.backendRef.append(file, item.line);
          item.resolve();
        } catch (err) {
          item.reject(err);
        }
      }
    }
    return changed;
  }

  /**
   * 디바운스를 건너뛰고 문서 1건만 즉시 저장한다 (§10.6 크래시 마커 — 지연되면 복구 창이 열린다).
   * 등록되지 않은 파일이면 아무것도 하지 않는다.
   */
  async saveNow(file: SaveFileName): Promise<void> {
    const doc = this.documents.find((d) => d.file === file);
    if (doc === undefined) return;
    if (this.deferUntilLoaded()) return;
    await this.writeDoc(doc);
  }

  private async writeDoc(doc: SaveDocument): Promise<void> {
    try {
      await this.backendRef.write(doc.file, doc.serialize());
      this.failStreak = 0;
    } catch (err) {
      this.saveFailures += 1;
      this.failStreak += 1;
      this.onError('save', err);
    }
  }

  /**
   * WU-06 V-3 — `init()`이 도는 동안의 저장 요청은 **보류**한다.
   *
   * 부팅 순서(§10.3)는 `storage.init()`을 await 하는 동안에도 크레딧·통계 이벤트를 받는다.
   * 그때 저장이 나가면 아직 파일을 읽지 못한 **공장값**이 마지막 정상값을 덮어쓴다.
   * `init()`을 아직 부르지 않은 호출자(단위 테스트·관리자 단독 리그)는 영향받지 않는다.
   */
  private deferUntilLoaded(): boolean {
    if (this.initState !== 'running') return false;
    this.deferredSave = true;
    return true;
  }

  /** 부팅 중 보류된 저장이 남아 있는가 (판정용) */
  get hasDeferredSave(): boolean {
    return this.deferredSave;
  }

  read(file: SaveFileName): Promise<string | null> {
    return this.backendRef.read(file);
  }

  /**
   * 위험 작업 **직전** 스냅샷 (§11.5 · admin §13 "높음" 등급의 백업 요건).
   * 현재 내용을 그대로 `<파일>.bak`에 옮긴다. 파일이 아직 없으면 남길 것이 없으므로 `false`.
   *
   * Electron 안전 쓰기(§12.2)의 `.bak`과 **중복이 아니다** — 브라우저·메모리 백엔드에는
   * `.tmp/.bak` 절차가 없으므로 백엔드와 무관하게 백업을 보장하는 지점이 필요하다.
   * 메인 프로세스는 이름이 `.bak`으로 끝나는 쓰기에서 `.bak.bak`을 만들지 않는다 (P-3).
   *
   * 반환값은 "**다음 단계로 진행해도 되는가**"다. 아직 파일이 없으면 남길 것이 없으므로
   * `true`이고, 읽기·쓰기가 실패했을 때만 `false`다 (호출자는 그때 저장을 중단한다).
   */
  async backup(file: SaveFileName): Promise<boolean> {
    try {
      const current = await this.backendRef.read(file);
      if (current === null) return true;
      await this.backendRef.write(`${file}${BAK_SUFFIX}`, current);
      return true;
    } catch (err) {
      this.onError('save', err);
      return false;
    }
  }

  /** 대기 중인 디바운스 저장이 있는지 (테스트·종료 처리용) */
  get hasPendingSave(): boolean {
    return this.saveTimer !== null;
  }
}
