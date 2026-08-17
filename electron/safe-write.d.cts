// electron/safe-write.cjs 타입 선언 (작업 계획 D-3 · WU-06 T1).
// CJS 모듈이라 tsconfig의 include(["src","tests"]) 밖에 있고, 테스트가 import로 끌어올 때
// 이 선언을 통해 타입 검사된다.

/** `fs/promises`에서 안전 쓰기가 실제로 쓰는 부분만 추린 계약 */
export interface SafeWriterFs {
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  appendFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  access(file: string): Promise<void>;
  /** WU-06 P-2 잔존 `.tmp` 정리 — 없으면 정리를 건너뛴다 */
  readdir?(dir: string): Promise<string[]>;
  unlink?(file: string): Promise<void>;
  /** WU-06 P-8 STORAGE LOW — Node 18.15+ / 24. 없으면 `freeBytes()`가 null */
  statfs?(dir: string): Promise<{ bsize: number; bavail: number }>;
}

export interface SafeWriterOptions {
  fsp: SafeWriterFs;
  /** 저장 디렉터리. 실행 폴더 기준 `./log/` (§9.1 · 부록 E.3) */
  dir: string;
  ensureDir?: () => void | Promise<void>;
}

/** 부팅 시 잔존 `.tmp` 처리 결과 (ADM-301) */
export interface StrayRecoveryReport {
  /** 본 파일이 없어 `.tmp`를 승격한 파일명 */
  promoted: string[];
  /** 본 파일이 살아 있어 지운 `.tmp` 이름 */
  removed: string[];
}

export interface SafeWriter {
  readonly dir: string;
  filePath(name: string): string;
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string | null>;
  append(name: string, line: string): Promise<void>;
  /** WU-06 P-2 — 부팅 시 잔존 `.tmp` 승격·삭제 */
  recoverStrays(): Promise<StrayRecoveryReport>;
  /** WU-06 P-8 — 남은 디스크 바이트. 측정 불가면 null */
  freeBytes(): Promise<number | null>;
  /** 큐를 거치지 않는 5단계 원형 — 단계별 판정용 */
  safeWriteDirect(name: string, content: string): Promise<void>;
  recoverStraysDirect(): Promise<StrayRecoveryReport>;
}

export interface CrashRecord {
  count: number;
  serviceRequired: boolean;
}

export interface CrashWindowOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
  /** WU-06 P-9 — `log/crash_window.json`에서 읽어 온 기록 시각 배열 */
  load?: () => unknown;
  save?: (times: number[]) => void;
}

export interface CrashWindow {
  record(): CrashRecord;
  /** 부팅 판정 — 저장된 창을 정리하고 자동 재실행 가능 여부를 돌려준다 */
  boot(): CrashRecord;
  reset(): void;
  readonly count: number;
  readonly recorded: number[];
}

/** §12.1 `machine.json` 본문 (WU-06 P-11) */
export interface MachineInfo {
  machineId: string;
  appVersion: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
  ioBoard: string;
  updatedAt: string;
}

export interface MachineInfoInput {
  machineId: string;
  appVersion?: string;
  versions?: { electron?: string; chrome?: string; node?: string };
  platform?: string;
  arch?: string;
  osRelease?: string;
  ioBoard?: string;
  updatedAt: string;
}

export declare const FILE_NAME_PATTERN: RegExp;
export declare const CREDIT_LOG_FILE: string;
export declare const CREDIT_LOG_HEADER: string;
export declare const FATAL_LIMIT: number;
export declare const FATAL_WINDOW_MS: number;
export declare const SYSTEM_ERROR_RESTART_MS: number;
export declare const TMP_SUFFIX: string;
export declare const BAK_SUFFIX: string;
export declare const STORAGE_LOW_BYTES: number;
export declare const MACHINE_FILE: string;
export declare const CRASH_WINDOW_FILE: string;

export declare function sanitizeName(name: string): string;
export declare function createSafeWriter(options: SafeWriterOptions): SafeWriter;
export declare function createCrashWindow(options?: CrashWindowOptions): CrashWindow;
export declare function machineInfo(input: MachineInfoInput): MachineInfo;
export declare function newMachineId(randomHex: string): string;
export declare function isStorageLow(freeBytes: number | null, threshold?: number): boolean;
