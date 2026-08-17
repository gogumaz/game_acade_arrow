// Electron 메인 프로세스의 순수 로직 — `electron` 모듈에 의존하지 않는다.
//
//   1) 단일 직렬 쓰기 큐 + 5단계 안전 쓰기 + `.bak` 폴백 읽기 (§9.3 · SAV-001 · SAV-002)
//   2) 치명 오류 60초 창 판정 (§9.4)
//   3) 잔존 `.tmp` 복구 · `.bak` 1세대 · 디스크 여유 · `machine.json` 조립 (WU-06 T1)
//
// main.cjs는 `electron`을 require 하므로 통째로는 단위 테스트할 수 없다. 파일 시스템을
// 주입받는 팩토리로 분리해 단계별 크래시 주입까지 자동 판정한다 (작업 계획 D-3).

const path = require('path');

/** 경로 탈출 방지 — 파일명은 이 패턴만 허용하고 `..`를 거부한다 (§9.3) */
const FILE_NAME_PATTERN = /^[\w.-]+$/;

/** §9.1 저장 파일 6종 중 추가 전용 로그의 헤더 */
const CREDIT_LOG_FILE = 'credit_log.csv';
// 6번째 `reason` 컬럼은 §10.2 원복 사유용이다 — 렌더러(src/persist/csv.ts)와 반드시 같아야 한다
const CREDIT_LOG_HEADER = 'timestamp,action,source,paidBalance,eventBalance,reason';

/** §12.1 — 안전 쓰기가 만드는 파생 확장자. `.bak`은 **1세대만** 유지한다 (WU-06 P-3) */
const TMP_SUFFIX = '.tmp';
const BAK_SUFFIX = '.bak';

/** §12.3 STORAGE LOW — 남은 공간이 이 값 미만이면 경고한다 (WU-06 착수 Q3-a) */
const STORAGE_LOW_BYTES = 200 * 1024 * 1024;

/** §12.1 기기 식별 파일 (WU-06 P-11) */
const MACHINE_FILE = 'machine.json';
/** §12.3 치명 오류 60초 창을 재부팅 너머로 잇는 파일 (WU-06 P-9 · ADM-306) */
const CRASH_WINDOW_FILE = 'crash_window.json';

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
    const tmpPath = `${finalPath}${TMP_SUFFIX}`;
    const bakPath = `${finalPath}${BAK_SUFFIX}`;

    // 1
    await fsp.writeFile(tmpPath, content, 'utf8');
    // 2
    const readBack = await fsp.readFile(tmpPath, 'utf8');
    if (readBack !== content) throw new Error(`tmp verify failed: ${name}`);
    // 3 — **`.bak` 회전은 1세대다** (WU-06 P-3). 대상 자체가 `.bak`이면 `.bak.bak`을 만들지
    // 않는다: 2세대가 생기면 복구 판정이 어느 쪽을 마지막 정상값으로 볼지 알 수 없게 된다
    if (!name.endsWith(BAK_SUFFIX)) {
      try {
        await fsp.rename(finalPath, bakPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    // 4
    await fsp.rename(tmpPath, finalPath);
    // 5
    await fsp.access(finalPath);
  }

  /**
   * 부팅 시 잔존 `.tmp` 정리 (§12.2 · ADM-301 — WU-06 P-2).
   *
   * 5단계가 3~4단계 사이에서 차단되면 본 파일이 없고 `.tmp`만 남는다. 그 `.tmp`는 2단계
   * 검증까지 통과한 내용이므로 본 파일로 **승격**한다. 본 파일이 살아 있으면 그 `.tmp`는
   * 1~2단계에서 죽은 미완성 조각이라 **삭제**한다.
   *
   * 승격한 내용이 그래도 손상이면 렌더러 `validate()`가 `.bak`으로 한 번 더 넘긴다 (P-1).
   */
  async function recoverStrays() {
    const promoted = [];
    const removed = [];
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return { promoted, removed };
    }
    for (const entry of names) {
      if (typeof entry !== 'string' || !entry.endsWith(TMP_SUFFIX)) continue;
      const base = entry.slice(0, -TMP_SUFFIX.length);
      if (base === '') continue;
      const tmpPath = path.join(dir, entry);
      const basePath = path.join(dir, base);
      let baseExists = true;
      try {
        await fsp.access(basePath);
      } catch {
        baseExists = false;
      }
      try {
        if (baseExists) {
          await fsp.unlink(tmpPath);
          removed.push(entry);
        } else {
          await fsp.rename(tmpPath, basePath);
          promoted.push(base);
        }
      } catch {
        /* 개별 실패가 부팅을 막지 않는다 */
      }
    }
    promoted.sort();
    removed.sort();
    return { promoted, removed };
  }

  /** §12.3 STORAGE LOW — 남은 바이트. `statfs`가 없거나 실패하면 `null`(판정 보류) */
  async function freeBytes() {
    if (typeof fsp.statfs !== 'function') return null;
    try {
      const s = await fsp.statfs(dir);
      const bytes = Number(s.bsize) * Number(s.bavail);
      return Number.isFinite(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }

  /** 본 파일이 없으면 `.bak`으로 자동 폴백한다 (§9.3 · SAV-002) */
  async function read(name) {
    const finalPath = filePath(name);
    try {
      return await fsp.readFile(finalPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      try {
        return await fsp.readFile(`${finalPath}${BAK_SUFFIX}`, 'utf8');
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
    /** 부팅 정리·디스크 여유도 같은 큐를 통과한다 (§12.2 단일 큐) */
    recoverStrays: () => enqueue(() => recoverStrays()),
    freeBytes: () => enqueue(() => freeBytes()),
    /** 큐를 거치지 않는 원형 — 단계별 판정용 */
    safeWriteDirect: safeWrite,
    recoverStraysDirect: recoverStrays,
  };
}

/**
 * 치명 오류 60초 창 (§9.4 · ADM-306).
 * 60초 안에 3회면 자동 재실행을 중지하고 SERVICE REQUIRED 화면을 유지한다.
 *
 * WU-06 P-9 — 창을 **재부팅 너머로** 잇는다. 메모리에만 두면 프로세스째 죽는 종류의 치명
 * 오류에서 매번 `count = 1`로 되살아나 `SERVICE REQUIRED`에 영원히 닿지 않는다.
 */
function createCrashWindow(options = {}) {
  const limit = options.limit ?? FATAL_LIMIT;
  const windowMs = options.windowMs ?? FATAL_WINDOW_MS;
  const now = options.now ?? Date.now;
  const load = typeof options.load === 'function' ? options.load : () => [];
  const save = typeof options.save === 'function' ? options.save : () => undefined;

  let times = [];
  try {
    const raw = load();
    if (Array.isArray(raw)) {
      times = raw
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    }
  } catch {
    times = [];
  }

  function prune(t) {
    while (times.length > 0 && t - times[0] > windowMs) times.shift();
  }

  function persist() {
    try {
      save([...times]);
    } catch {
      /* 창 저장 실패가 부팅을 막지 않는다 */
    }
  }

  function verdict() {
    return { count: times.length, serviceRequired: times.length >= limit };
  }

  return {
    /** 치명 오류 1건을 기록하고 자동 재실행 가능 여부를 판정한다 */
    record() {
      const t = now();
      times.push(t);
      prune(t);
      persist();
      return verdict();
    },
    /** 부팅 판정 — 저장된 창을 지금 시각으로 정리하고 자동 재실행 가능 여부를 돌려준다 */
    boot() {
      prune(now());
      persist();
      return verdict();
    },
    /** 정비 후 복귀 — 창을 비운다 */
    reset() {
      times = [];
      persist();
    },
    get count() {
      return times.length;
    },
    get recorded() {
      return [...times];
    },
  };
}

/**
 * §12.1 `machine.json` 본문 조립 — **순수 함수**다 (WU-06 P-11).
 * 시각·난수·`process`는 호출자가 넣는다. 그래서 필드 구성을 단위 판정할 수 있다.
 */
function machineInfo(input) {
  const versions = input.versions ?? {};
  return {
    machineId: String(input.machineId),
    appVersion: String(input.appVersion ?? ''),
    electron: String(versions.electron ?? ''),
    chrome: String(versions.chrome ?? ''),
    node: String(versions.node ?? ''),
    platform: String(input.platform ?? ''),
    arch: String(input.arch ?? ''),
    osRelease: String(input.osRelease ?? ''),
    // §17 `[보류]` #1 — Serial 실물이 붙기 전까지 입력 보드는 키보드다
    ioBoard: String(input.ioBoard ?? 'keyboard [보류]'),
    updatedAt: String(input.updatedAt),
  };
}

/** 기기 최초 부팅 1회만 만들어 `machine.json`에 굳는 식별자 */
function newMachineId(randomHex) {
  return `AO-${String(randomHex)
    .replace(/[^0-9a-fA-F]/g, '')
    .slice(0, 12)
    .toUpperCase()}`;
}

/** §12.3 — 남은 공간이 200MB 미만인가. `null`(측정 불가)은 경고하지 않는다 */
function isStorageLow(freeBytes, threshold = STORAGE_LOW_BYTES) {
  return typeof freeBytes === 'number' && Number.isFinite(freeBytes) && freeBytes < threshold;
}

module.exports = {
  FILE_NAME_PATTERN,
  CREDIT_LOG_FILE,
  CREDIT_LOG_HEADER,
  FATAL_LIMIT,
  FATAL_WINDOW_MS,
  SYSTEM_ERROR_RESTART_MS,
  TMP_SUFFIX,
  BAK_SUFFIX,
  STORAGE_LOW_BYTES,
  MACHINE_FILE,
  CRASH_WINDOW_FILE,
  sanitizeName,
  createSafeWriter,
  createCrashWindow,
  machineInfo,
  newMachineId,
  isStorageLow,
};
