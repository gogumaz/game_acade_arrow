// electron/safe-write.cjs 타입 선언 (작업 계획 D-3).
// CJS 모듈이라 tsconfig의 include(["src","tests"]) 밖에 있고, 테스트가 import로 끌어올 때
// 이 선언을 통해 타입 검사된다.

/** `fs/promises`에서 안전 쓰기가 실제로 쓰는 부분만 추린 계약 */
export interface SafeWriterFs {
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  appendFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  access(file: string): Promise<void>;
}

export interface SafeWriterOptions {
  fsp: SafeWriterFs;
  /** 저장 디렉터리. 실행 폴더 기준 `./log/` (§9.1 · 부록 E.3) */
  dir: string;
  ensureDir?: () => void | Promise<void>;
}

export interface SafeWriter {
  readonly dir: string;
  filePath(name: string): string;
  enqueue<T>(job: () => Promise<T>): Promise<T>;
  write(name: string, content: string): Promise<void>;
  read(name: string): Promise<string | null>;
  append(name: string, line: string): Promise<void>;
  /** 큐를 거치지 않는 5단계 원형 — 단계별 판정용 */
  safeWriteDirect(name: string, content: string): Promise<void>;
}

export interface CrashRecord {
  count: number;
  serviceRequired: boolean;
}

export interface CrashWindowOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

export interface CrashWindow {
  record(): CrashRecord;
  readonly count: number;
}

export declare const FILE_NAME_PATTERN: RegExp;
export declare const CREDIT_LOG_FILE: string;
export declare const CREDIT_LOG_HEADER: string;
export declare const FATAL_LIMIT: number;
export declare const FATAL_WINDOW_MS: number;
export declare const SYSTEM_ERROR_RESTART_MS: number;

export declare function sanitizeName(name: string): string;
export declare function createSafeWriter(options: SafeWriterOptions): SafeWriter;
export declare function createCrashWindow(options?: CrashWindowOptions): CrashWindow;
