// WU-01 T4 — 안전 쓰기 큐·치명 오류 골격 (§9.3 · §9.4 · SAV-001 · SAV-002)
//
// 판정 방법
//   · 주입형 가짜 FS로 단계별 크래시를 주입해 잔존 상태를 판정한다 (4-2 · 4-5)
//   · 실제 임시 디렉터리 왕복 1건으로 실파일 경로와 Windows 경로 구분자를 확인한다 (4-3 · 4-8)
//   · 4-9는 골격(60초 창 계산 + 핸들러 등록)까지만 판정한다. 실동작 판정은 WU-06.

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import * as realFsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDIT_LOG_FILE,
  CREDIT_LOG_HEADER,
  FATAL_LIMIT,
  FATAL_WINDOW_MS,
  FILE_NAME_PATTERN,
  SYSTEM_ERROR_RESTART_MS,
  createCrashWindow,
  createSafeWriter,
  sanitizeName,
  type SafeWriterFs,
} from '../../electron/safe-write.cjs';

const ELECTRON_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'electron'
);

// ── 주입형 가짜 FS ─────────────────────────────────────────────────────────

type FsOp = 'writeFile' | 'readFile' | 'appendFile' | 'rename' | 'access';

function enoent(file: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`ENOENT: ${file}`);
  err.code = 'ENOENT';
  return err;
}

/** 호출 순서를 기록하고 원하는 시점에 예외를 던지는 인메모리 FS */
class FakeFs implements SafeWriterFs {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  /** 2단계 검증 실패 재현 — 되읽기가 다른 내용을 돌려주게 한다 */
  corruptRead = false;
  /** n번째(1-base) 호출에서 예외를 던진다 */
  private failAtCall: number | null = null;
  private failMessage = 'injected crash';

  failOnCall(n: number, message = 'injected crash'): void {
    this.failAtCall = n;
    this.failMessage = message;
  }

  private record(op: FsOp, file: string): void {
    this.calls.push(`${op}:${path.basename(file)}`);
    if (this.failAtCall !== null && this.calls.length === this.failAtCall) {
      throw new Error(this.failMessage);
    }
  }

  writeFile(file: string, data: string): Promise<void> {
    this.record('writeFile', file);
    this.files.set(file, data);
    return Promise.resolve();
  }

  readFile(file: string): Promise<string> {
    this.record('readFile', file);
    if (this.corruptRead) return Promise.resolve('corrupted');
    const v = this.files.get(file);
    if (v === undefined) return Promise.reject(enoent(file));
    return Promise.resolve(v);
  }

  appendFile(file: string, data: string): Promise<void> {
    this.record('appendFile', file);
    this.files.set(file, (this.files.get(file) ?? '') + data);
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    this.record('rename', from);
    const v = this.files.get(from);
    if (v === undefined) return Promise.reject(enoent(from));
    this.files.delete(from);
    this.files.set(to, v);
    return Promise.resolve();
  }

  access(file: string): Promise<void> {
    this.record('access', file);
    if (!this.files.has(file)) return Promise.reject(enoent(file));
    return Promise.resolve();
  }

  names(): string[] {
    return [...this.files.keys()].map((f) => path.basename(f)).sort();
  }
}

const DIR = path.join('C:', 'fake', 'log');
const NAME = 'settings.csv';

function makeWriter(fake = new FakeFs()): {
  fake: FakeFs;
  writer: ReturnType<typeof createSafeWriter>;
} {
  return { fake, writer: createSafeWriter({ fsp: fake, dir: DIR }) };
}

// ── 4-1 · 4-2 · 4-3 ───────────────────────────────────────────────────────

describe('4-1 5단계 순서 (§9.3)', () => {
  it('.tmp 기록 → 재읽기 검증 → 본파일 .bak → .tmp rename → 접근 재확인', async () => {
    const { fake, writer } = makeWriter();
    fake.files.set(path.join(DIR, NAME), 'old');

    await writer.write(NAME, 'new');

    expect(fake.calls).toEqual([
      'writeFile:settings.csv.tmp',
      'readFile:settings.csv.tmp',
      'rename:settings.csv',
      'rename:settings.csv.tmp',
      'access:settings.csv',
    ]);
  });

  it('본 파일이 없으면 3단계(.bak 이름변경)를 건너뛴다', async () => {
    const { fake, writer } = makeWriter();
    await writer.write(NAME, 'first');
    expect(fake.names()).toEqual(['settings.csv']);
    expect(fake.files.get(path.join(DIR, NAME))).toBe('first');
  });
});

describe('4-2 2단계 검증 실패 (§9.3)', () => {
  it('내용 불일치면 예외를 던지고 본 파일이 변경되지 않는다', async () => {
    const { fake, writer } = makeWriter();
    fake.files.set(path.join(DIR, NAME), 'old');
    fake.corruptRead = true; // 되읽기가 다른 내용을 돌려주는 상황

    await expect(writer.write(NAME, 'new')).rejects.toThrow('tmp verify failed');
    expect(fake.files.get(path.join(DIR, NAME))).toBe('old');
    // 3단계 이후는 실행되지 않는다
    expect(fake.calls).toEqual(['writeFile:settings.csv.tmp', 'readFile:settings.csv.tmp']);
  });

  it('1단계 기록 실패도 본 파일을 건드리지 않는다', async () => {
    const { fake, writer } = makeWriter();
    fake.files.set(path.join(DIR, NAME), 'old');
    fake.failOnCall(1, 'disk full');

    await expect(writer.write(NAME, 'new')).rejects.toThrow('disk full');
    expect(fake.files.get(path.join(DIR, NAME))).toBe('old');
  });
});

// ── 4-5 단계별 크래시 주입 ────────────────────────────────────────────────

describe('4-5 단계별 크래시 주입 (SAV-002)', () => {
  it.each([
    [1, '1단계 .tmp 기록'],
    [2, '2단계 재읽기 검증'],
    [3, '3단계 본파일 → .bak'],
    [4, '4단계 .tmp → 본파일'],
    [5, '5단계 접근 재확인'],
  ])('%i번째 FS 호출(%s)에서 중단해도 본 파일 또는 .bak이 온전하다', async (step) => {
    const { fake, writer } = makeWriter();
    const finalPath = path.join(DIR, NAME);
    fake.files.set(finalPath, 'GOOD_OLD');
    fake.failOnCall(step);

    await expect(writer.write(NAME, 'NEW')).rejects.toThrow('injected crash');

    // 재기동 시 읽기 — 본 파일이 없으면 .bak으로 폴백한다
    const recovered = await makeWriter(fake).writer.read(NAME);
    expect(recovered === 'GOOD_OLD' || recovered === 'NEW').toBe(true);
    expect(recovered).not.toBeNull();
  });

  it('3·4단계 사이 중단 — 본 파일은 사라지고 .bak이 남아 폴백된다', async () => {
    const { fake, writer } = makeWriter();
    fake.files.set(path.join(DIR, NAME), 'GOOD_OLD');
    fake.failOnCall(4); // 3단계 완료 후 4단계에서 중단

    await expect(writer.write(NAME, 'NEW')).rejects.toThrow();
    expect(fake.names()).toContain('settings.csv.bak');
    expect(fake.names()).not.toContain('settings.csv');
    await expect(makeWriter(fake).writer.read(NAME)).resolves.toBe('GOOD_OLD');
  });
});

// ── 4-4 .bak 폴백 ─────────────────────────────────────────────────────────

describe('4-4 읽기 시 .bak 자동 폴백 (§9.3 · SAV-002)', () => {
  it('본 파일이 없으면 .bak을 읽는다', async () => {
    const { fake, writer } = makeWriter();
    fake.files.set(path.join(DIR, `${NAME}.bak`), 'from-bak');
    await expect(writer.read(NAME)).resolves.toBe('from-bak');
  });

  it('본 파일이 있으면 .bak을 읽지 않는다', async () => {
    const { fake, writer } = makeWriter();
    fake.files.set(path.join(DIR, NAME), 'from-main');
    fake.files.set(path.join(DIR, `${NAME}.bak`), 'from-bak');
    await expect(writer.read(NAME)).resolves.toBe('from-main');
  });

  it('본 파일도 .bak도 없으면 null이다', async () => {
    const { writer } = makeWriter();
    await expect(writer.read(NAME)).resolves.toBeNull();
  });
});

// ── 4-6 직렬 큐 ───────────────────────────────────────────────────────────

describe('4-6 단일 직렬 큐 (§9.3)', () => {
  it('요청 순서 = 완료 순서', async () => {
    const { writer } = makeWriter();
    const done: number[] = [];
    const jobs = [0, 1, 2, 3, 4].map((i) =>
      writer.enqueue(async () => {
        // 뒤 요청일수록 짧게 기다리게 해도 순서가 유지되어야 한다
        await new Promise((r) => setTimeout(r, 20 - i * 4));
        done.push(i);
      })
    );
    await Promise.all(jobs);
    expect(done).toEqual([0, 1, 2, 3, 4]);
  });

  it('중간 1건이 실패해도 후속 요청이 처리된다', async () => {
    const { fake, writer } = makeWriter();
    const results = await Promise.allSettled([
      writer.write('a.csv', 'A'),
      writer.enqueue(() => Promise.reject(new Error('boom'))),
      writer.write('b.csv', 'B'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(fake.names()).toEqual(['a.csv', 'b.csv']);
  });

  it('쓰기가 겹쳐도 마지막 내용이 남는다', async () => {
    const { fake, writer } = makeWriter();
    await Promise.all([
      writer.write(NAME, 'v1'),
      writer.write(NAME, 'v2'),
      writer.write(NAME, 'v3'),
    ]);
    expect(fake.files.get(path.join(DIR, NAME))).toBe('v3');
    expect(fake.files.get(path.join(DIR, `${NAME}.bak`))).toBe('v2');
  });
});

// ── 4-7 파일명 검증 ───────────────────────────────────────────────────────

describe('4-7 파일명 검증 — 경로 탈출 방지 (§9.3)', () => {
  it.each(['settings.csv', 'params.csv', 'credit_log.csv', 'error_2026-08-15.log', 'a-b_c.1'])(
    '%s는 허용된다',
    (name) => {
      expect(sanitizeName(name)).toBe(name);
      expect(FILE_NAME_PATTERN.test(name)).toBe(true);
    }
  );

  it.each([
    '../secrets.csv',
    '..\\secrets.csv',
    'log/settings.csv',
    'log\\settings.csv',
    'C:/abs.csv',
    'a..b',
    '',
    'has space.csv',
  ])('%s는 거부된다', (name) => {
    expect(() => sanitizeName(name)).toThrow(/invalid file name/);
  });

  it('큐 진입점 3종이 모두 파일명을 검증한다', async () => {
    const { writer } = makeWriter();
    await expect(writer.write('../x.csv', 'v')).rejects.toThrow(/invalid file name/);
    await expect(writer.read('../x.csv')).rejects.toThrow(/invalid file name/);
    await expect(writer.append('../x.csv', 'v')).rejects.toThrow(/invalid file name/);
  });
});

// ── 4-3 · 4-8 실파일 왕복 ─────────────────────────────────────────────────

describe('4-3 · 4-8 실파일 왕복과 저장 경로 (§9.1 · SAV-001)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'arrowout-wu01-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('저장 성공 후 .tmp가 남지 않고 이전 본이 .bak으로 보존된다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.write(NAME, 'first\n');
    await writer.write(NAME, 'second\n');

    const entries = (await readdir(dir)).sort();
    expect(entries).toEqual(['settings.csv', 'settings.csv.bak']);
    expect(entries.some((f) => f.endsWith('.tmp'))).toBe(false);
    await expect(readFile(path.join(dir, NAME), 'utf8')).resolves.toBe('second\n');
    await expect(readFile(path.join(dir, `${NAME}.bak`), 'utf8')).resolves.toBe('first\n');
  });

  it('본 파일을 지우면 .bak으로 복구 읽기가 된다 (SAV-002)', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.write(NAME, 'v1\n');
    await writer.write(NAME, 'v2\n');
    await rm(path.join(dir, NAME));
    await expect(writer.read(NAME)).resolves.toBe('v1\n');
  });

  it('저장 경로가 주어진 디렉터리 안으로 해석된다 (Windows 경로 구분자 포함)', () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    const resolved = writer.filePath(NAME);
    expect(resolved).toBe(path.join(dir, NAME));
    expect(path.dirname(resolved)).toBe(dir);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('메인 프로세스는 저장 경로를 실행 폴더 기준 ./log/로 잡는다 (§9.1 · 부록 E.3)', () => {
    const src = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');
    expect(src).toContain("path.join(process.cwd(), 'log')");
    expect(src).toContain('PORTABLE_EXECUTABLE_DIR');
    expect(src).toContain('createSafeWriter({ fsp, dir: LOG_DIR');
  });

  it('CRLF·UTF-8이 왕복에서 보존된다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    const content = 'a,b\r\n한글,값\r\n';
    await writer.write('stats.csv', content);
    await expect(writer.read('stats.csv')).resolves.toBe(content);
  });
});

// ── 4-11 credit_log 헤더 ──────────────────────────────────────────────────

describe('4-11 credit_log.csv append (§9.1)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'arrowout-wu01-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('파일이 없으면 헤더를 먼저 쓴다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.append(CREDIT_LOG_FILE, '2026-08-15T00:00:00.000Z,coin_insert,paid,1,0');
    const text = await readFile(path.join(dir, CREDIT_LOG_FILE), 'utf8');
    expect(text.split('\n')[0]).toBe(CREDIT_LOG_HEADER);
    expect(text.split('\n')[1]).toBe('2026-08-15T00:00:00.000Z,coin_insert,paid,1,0');
  });

  it('파일이 있으면 헤더를 다시 쓰지 않는다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.append(CREDIT_LOG_FILE, 'line-1');
    await writer.append(CREDIT_LOG_FILE, 'line-2');
    const lines = (await readFile(path.join(dir, CREDIT_LOG_FILE), 'utf8')).trim().split('\n');
    expect(lines).toEqual([CREDIT_LOG_HEADER, 'line-1', 'line-2']);
  });

  it('credit_log 이외 파일에는 헤더를 붙이지 않는다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.append('audit_log.csv', 'anything');
    await expect(readFile(path.join(dir, 'audit_log.csv'), 'utf8')).resolves.toBe('anything\n');
  });

  it('본 파일이 아직 없을 때 append 후 읽기가 성립한다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.append(CREDIT_LOG_FILE, 'row');
    await expect(writer.read(CREDIT_LOG_FILE)).resolves.toContain('row');
  });
});

// ── 4-9 · 4-10 치명 오류 골격 ─────────────────────────────────────────────

describe('4-9 치명 오류 60초 창 (§9.4 · 골격)', () => {
  it('60초 안에 3회면 SERVICE REQUIRED로 전환된다', () => {
    let t = 1_000_000;
    const cw = createCrashWindow({ now: () => t });

    expect(cw.record().serviceRequired).toBe(false);
    t += 10_000;
    expect(cw.record().serviceRequired).toBe(false);
    t += 10_000;
    const third = cw.record();
    expect(third.count).toBe(3);
    expect(third.serviceRequired).toBe(true);
  });

  it('60초를 넘겨 흩어진 오류는 창에서 빠진다', () => {
    let t = 1_000_000;
    const cw = createCrashWindow({ now: () => t });

    cw.record();
    t += FATAL_WINDOW_MS + 1;
    cw.record();
    t += FATAL_WINDOW_MS + 1;
    const third = cw.record();
    expect(third.count).toBe(1);
    expect(third.serviceRequired).toBe(false);
  });

  it('경계값 — 정확히 60초 간격은 창 안이다', () => {
    let t = 0;
    const cw = createCrashWindow({ now: () => t });
    cw.record();
    t += FATAL_WINDOW_MS;
    cw.record();
    expect(cw.count).toBe(2);
  });

  it('§9.4 확정 상수를 쓴다', () => {
    expect(FATAL_LIMIT).toBe(3);
    expect(FATAL_WINDOW_MS).toBe(60_000);
    expect(SYSTEM_ERROR_RESTART_MS).toBe(5000);
  });

  it('메인 프로세스에 치명 오류·자동 재실행 핸들러가 등록되어 있다', () => {
    const src = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');
    expect(src).toContain("win.webContents.on('render-process-gone'");
    expect(src).toContain("win.webContents.on('unresponsive'");
    expect(src).toContain('createCrashWindow()');
    expect(src).toContain("win.loadFile(path.join(__dirname, 'system-error.html'))");
    expect(src).toContain("win.loadFile(path.join(__dirname, 'service-required.html'))");
    expect(src).toContain('SYSTEM_ERROR_RESTART_MS');
  });

  it('오류 화면 2종이 존재한다', () => {
    for (const [file, title] of [
      ['system-error.html', 'SYSTEM ERROR'],
      ['service-required.html', 'SERVICE REQUIRED'],
    ]) {
      const html = readFileSync(path.join(ELECTRON_DIR, file), 'utf8');
      expect(html).toContain(title);
    }
  });
});

describe('4-10 메인 프로세스 예외 로깅 (§9.4)', () => {
  it('uncaughtException을 오류 로그에 기록한다', () => {
    const src = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');
    expect(src).toContain("process.on('uncaughtException'");
    expect(src).toContain('appendErrorLog(`main uncaught:');
  });

  it('IPC 3종이 전부 큐를 통과한다 (§9.3)', () => {
    const src = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');
    expect(src).toContain("ipcMain.handle('gamefs:write', (_e, name, content) => storage.write(");
    expect(src).toContain("ipcMain.handle('gamefs:read', (_e, name) => storage.read(name))");
    expect(src).toContain("ipcMain.handle('gamefs:append', (_e, name, line) => storage.append(");
  });

  it('preload가 §9.2 파일 API 4종을 노출한다', () => {
    const src = readFileSync(path.join(ELECTRON_DIR, 'preload.cjs'), 'utf8');
    expect(src).toContain("contextBridge.exposeInMainWorld('gameFS'");
    for (const api of ['write:', 'read:', 'append:', 'quit:']) {
      expect(src).toContain(api);
    }
  });

  it('Esc 종료 경로를 만들지 않는다 (§13 G8 · D-7)', () => {
    const mainSrc = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');
    const rendererSrc = readFileSync(path.join(ELECTRON_DIR, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSrc).not.toContain('Escape');
    expect(rendererSrc).not.toContain('Escape');
    // 관리자 3초 홀드 종료(WU-06)가 쓸 quit 채널은 남긴다
    expect(mainSrc).toContain("ipcMain.handle('app:quit'");
  });
});
