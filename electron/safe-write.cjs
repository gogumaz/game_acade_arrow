// Electron 메인 프로세스의 순수 로직 — `electron` 모듈에 의존하지 않는다.
//
//   1) 단일 직렬 쓰기 큐 + 5단계 안전 쓰기 + `.bak` 폴백 읽기 (§9.3 · SAV-001 · SAV-002)
//   2) 치명 오류 60초 창 판정 (§9.4)
//
// main.cjs는 `electron`을 require 하므로 통째로는 단위 테스트할 수 없다. 파일 시스템을
// 주입받는 팩토리로 분리해 단계별 크래시 주입까지 자동 판정한다 (작업 계획 D-3).

const path = require('path');

/** 경로 탈출 방지 — 파일명은 이 패턴만 허용하고 `..`를 거부한다 (§9.3) */
const FILE_NAME_PATTERN = /^[\w.-]+$/;

/** §9.1 저장 파일 6종 중 추가 전용 로그의 헤더 */
const CREDIT_LOG_FILE = 'credit_log.csv';
const CREDIT_LOG_HEADER = 'timestamp,action,source,paidBalance,eventBalance';

/** §9.4 — 60초 안에 3회 치명 오류면 자동 재실행을 멈춘다 */
const FATAL_LIMIT = 3;
const FATAL_WINDOW_MS = 60_000;
/** §9.4 — SYSTEM ERROR 화면 표시 후 자동 재실행까지의 대기 */
const SYSTEM_ERROR_RESTART_MS = 5000;

function sanitizeName(name) {
  if (typeof name !== 'string' || !FILE_NAME_PATTERN.test(name) || name.includes('..')) {
    throw new Error(`invalid file name: ${String(name)}`);
  }
  return name;
}

/**
 * 안전 쓰기 큐 팩토리.
 *
 * @param {object} options
 * @param {object} options.fsp      `fs/promises` 호환 객체 (테스트는 가짜 FS를 넣는다)
 * @param {string} options.dir      저장 디렉터리. 실행 폴더 기준 `./log/` (§9.1 · 부록 E.3)
 * @param {Function} [options.ensureDir] 쓰기 전 디렉터리 보장 훅
 */
function createSafeWriter({ fsp, dir, ensureDir }) {
  // 모든 쓰기가 통과하는 단일 직렬 큐 (§9.3)
  let chain = Promise.resolve();

  const ensure = typeof ensureDir === 'function' ? ensureDir : () => undefined;

  /** 경로 결합은 전부 path.join으로 한다 (Windows 경로 구분자 대응) */
  function filePath(name) {
    return path.join(dir, sanitizeName(name));
  }

  /**
   * 큐에 작업을 넣는다. 앞선 작업의 성공·실패와 무관하게 순서대로 실행하므로
   * 1건 실패가 후속 요청을 막지 않는다 (§9.3).
   */
  function enqueue(job) {
    const next = chain.then(job, job);
    chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * 5단계 안전 쓰기 (§9.3)
   *   1. 새 내용을 <파일>.tmp 에 기록
   *   2. .tmp를 다시 읽어 내용 일치 검증 (불일치 시 실패)
   *   3. 기존 본 파일을 <파일>.bak 으로 이름 변경 (없으면 건너뜀)
   *   4. .tmp → 본 파일명으로 이름 변경
   *   5. 본 파일 접근 가능 여부 재확인
   */
  async function safeWrite(name, content) {
    await ensure();
    const finalPath = filePath(name);
    const tmpPath = `${finalPath}.tmp`;
    const bakPath = `${finalPath}.bak`;

    // 1
    await fsp.writeFile(tmpPath, content, 'utf8');
    // 2
    const readBack = await fsp.readFile(tmpPath, 'utf8');
    if (readBack !== content) throw new Error(`tmp verify failed: ${name}`);
    // 3
    try {
      await fsp.rename(finalPath, bakPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    // 4
    await fsp.rename(tmpPath, finalPath);
    // 5
    await fsp.access(finalPath);
  }

  /** 본 파일이 없으면 `.bak`으로 자동 폴백한다 (§9.3 · SAV-002) */
  async function read(name) {
    const finalPath = filePath(name);
    try {
      return await fsp.readFile(finalPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      try {
        return await fsp.readFile(`${finalPath}.bak`, 'utf8');
      } catch {
        return null;
      }
    }
  }

  /** 추가 전용 로그 1줄. credit_log.csv는 파일이 없으면 헤더를 먼저 쓴다 (§9.1) */
  async function append(name, line) {
    await ensure();
    const file = filePath(name);
    let exists = true;
    try {
      await fsp.access(file);
    } catch {
      exists = false;
    }
    if (!exists && name === CREDIT_LOG_FILE) {
      await fsp.appendFile(file, `${CREDIT_LOG_HEADER}\n`, 'utf8');
    }
    await fsp.appendFile(file, `${String(line)}\n`, 'utf8');
  }

  return {
    dir,
    filePath,
    enqueue,
    /** 큐를 통과하는 공개 진입점 — 렌더러 IPC는 전부 이 3개만 쓴다 */
    write: (name, content) => enqueue(() => safeWrite(name, String(content))),
    read: (name) => enqueue(() => read(name)),
    append: (name, line) => enqueue(() => append(name, line)),
    /** 큐를 거치지 않는 원형 — 단계별 판정용 */
    safeWriteDirect: safeWrite,
  };
}

/**
 * 치명 오류 60초 창 (§9.4).
 * 60초 안에 3회면 자동 재실행을 중지하고 SERVICE REQUIRED 화면을 유지한다.
 */
function createCrashWindow(options = {}) {
  const limit = options.limit ?? FATAL_LIMIT;
  const windowMs = options.windowMs ?? FATAL_WINDOW_MS;
  const now = options.now ?? Date.now;
  const times = [];

  return {
    /** 치명 오류 1건을 기록하고 자동 재실행 가능 여부를 판정한다 */
    record() {
      const t = now();
      times.push(t);
      while (times.length > 0 && t - times[0] > windowMs) times.shift();
      return { count: times.length, serviceRequired: times.length >= limit };
    },
    get count() {
      return times.length;
    },
  };
}

module.exports = {
  FILE_NAME_PATTERN,
  CREDIT_LOG_FILE,
  CREDIT_LOG_HEADER,
  FATAL_LIMIT,
  FATAL_WINDOW_MS,
  SYSTEM_ERROR_RESTART_MS,
  sanitizeName,
  createSafeWriter,
  createCrashWindow,
};
