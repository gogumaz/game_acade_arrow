// WU-06 T10 — ADM-307 저장 완료 후 종료 · P-3 `.bak` 1세대 · P-8 health · P-11 machine.json
//
// `main.cjs`는 `electron`을 require 하므로 통째로 import 할 수 없다. 순수 함수(`machineInfo`·
// `isStorageLow`)는 직접 판정하고, 배선(quit 드레인 · IPC 채널)은 소스 정적 검사로 본다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAK_SUFFIX,
  isStorageLow,
  MACHINE_FILE,
  machineInfo,
  newMachineId,
  STORAGE_LOW_BYTES,
  TMP_SUFFIX,
} from '../../electron/safe-write.cjs';
import { toHealthReport } from '../../src/game/health';
import { InjectableFs, makeWriter, FAKE_DIR } from './harness';

const ELECTRON_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'electron'
);
const mainSrc = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');
const preloadSrc = readFileSync(path.join(ELECTRON_DIR, 'preload.cjs'), 'utf8');

describe('P-3 — `.bak` 1세대 (`.bak.bak` 금지)', () => {
  it('일반 파일은 기존 본 파일을 `.bak`으로 회전한다', async () => {
    const { fs, writer } = makeWriter();
    await writer.safeWriteDirect('settings.csv', 'v1');
    await writer.safeWriteDirect('settings.csv', 'v2');
    expect(fs.files.get(path.join(FAKE_DIR, 'settings.csv'))).toBe('v2');
    expect(fs.files.get(path.join(FAKE_DIR, `settings.csv${BAK_SUFFIX}`))).toBe('v1');
  });

  it('이름이 `.bak`으로 끝나면 `.bak.bak`을 만들지 않는다', async () => {
    const { fs, writer } = makeWriter();
    await writer.safeWriteDirect(`settings.csv${BAK_SUFFIX}`, 'gen1');
    await writer.safeWriteDirect(`settings.csv${BAK_SUFFIX}`, 'gen2');
    expect(fs.files.get(path.join(FAKE_DIR, `settings.csv${BAK_SUFFIX}`))).toBe('gen2');
    expect(fs.names()).toEqual([`settings.csv${BAK_SUFFIX}`]);
    expect(fs.names().some((n) => n.endsWith('.bak.bak'))).toBe(false);
  });

  it('날짜 백업(`params.csv.<날짜>.bak`)도 2세대를 만들지 않는다', async () => {
    const { fs, writer } = makeWriter();
    await writer.safeWriteDirect(`params.csv.2026-08-17${BAK_SUFFIX}`, 'snapshot');
    expect(fs.names()).toEqual([`params.csv.2026-08-17${BAK_SUFFIX}`]);
  });

  it('`.tmp`는 항상 정리된다 (성공 경로)', async () => {
    const { fs, writer } = makeWriter();
    await writer.safeWriteDirect('stats.csv', 'x');
    expect(fs.names().some((n) => n.endsWith(TMP_SUFFIX))).toBe(false);
  });
});

describe('P-8 — 디스크 여유·STORAGE LOW', () => {
  it('200MB 미만이면 STORAGE LOW다', () => {
    expect(STORAGE_LOW_BYTES).toBe(200 * 1024 * 1024);
    expect(isStorageLow(STORAGE_LOW_BYTES - 1)).toBe(true);
    expect(isStorageLow(STORAGE_LOW_BYTES)).toBe(false);
    expect(isStorageLow(10 * 1024 * 1024 * 1024)).toBe(false);
  });

  it('측정 불가(null)는 경고하지 않는다', () => {
    expect(isStorageLow(null)).toBe(false);
    expect(isStorageLow(Number.NaN)).toBe(false);
  });

  it('`freeBytes()`가 `statfs`를 바이트로 환산한다', async () => {
    const fs = new InjectableFs();
    fs.freeBytes = 512 * 1024 * 1024;
    const { writer } = makeWriter(fs);
    expect(await writer.freeBytes()).toBe(512 * 1024 * 1024);
  });

  it('`statfs`가 실패하면 null이다 (판정 보류)', async () => {
    const fs = new InjectableFs();
    fs.freeBytes = null;
    const { writer } = makeWriter(fs);
    expect(await writer.freeBytes()).toBe(null);
  });
});

describe('P-8 — health 응답 좁히기 (렌더러 쪽)', () => {
  it('필드가 갖춰지면 그대로 읽는다', () => {
    expect(
      toHealthReport({
        fatalCount: 2,
        serviceRequired: true,
        freeBytes: 1234,
        storageLow: true,
        machine: { machineId: 'AO-ABC', appVersion: '0.1.0' },
      })
    ).toMatchObject({
      fatalCount: 2,
      serviceRequired: true,
      freeBytes: 1234,
      storageLow: true,
    });
  });

  it('객체가 아니면 null이다 (브라우저 모드)', () => {
    expect(toHealthReport(null)).toBe(null);
    expect(toHealthReport('nope')).toBe(null);
    expect(toHealthReport(undefined)).toBe(null);
  });

  it('machineId가 없으면 machine은 null이다', () => {
    expect(toHealthReport({ machine: { appVersion: '1' } })?.machine).toBe(null);
    expect(toHealthReport({})?.machine).toBe(null);
  });

  it('freeBytes가 숫자가 아니면 null로 좁힌다', () => {
    expect(toHealthReport({ freeBytes: 'many' })?.freeBytes).toBe(null);
    expect(toHealthReport({ freeBytes: Number.POSITIVE_INFINITY })?.freeBytes).toBe(null);
  });
});

describe('P-11 — machine.json 필드', () => {
  it('§12.1이 요구하는 필드를 전부 담는다', () => {
    const info = machineInfo({
      machineId: 'AO-0123456789AB',
      appVersion: '0.1.0',
      versions: { electron: '43.3.0', chrome: '140', node: '24.0.0' },
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.26200',
      updatedAt: '2026-08-17T09:00:00.000Z',
    });
    expect(Object.keys(info).sort()).toEqual(
      [
        'appVersion',
        'arch',
        'chrome',
        'electron',
        'ioBoard',
        'machineId',
        'node',
        'osRelease',
        'platform',
        'updatedAt',
      ].sort()
    );
    expect(info.ioBoard).toBe('keyboard [보류]'); // §17 Serial 실물 대기
    expect(info.electron).toBe('43.3.0');
  });

  it('빠진 값은 빈 문자열이다 (조립이 절대 던지지 않는다)', () => {
    const info = machineInfo({ machineId: 'AO-1', updatedAt: 'now' });
    expect(info.appVersion).toBe('');
    expect(info.electron).toBe('');
    expect(info.platform).toBe('');
  });

  it('식별자는 `AO-` + 16진 12자리다', () => {
    expect(newMachineId('0123456789abcdef')).toBe('AO-0123456789AB');
    expect(newMachineId('zz-12-34')).toBe('AO-1234');
  });

  it('파일명이 `machine.json`이다', () => {
    expect(MACHINE_FILE).toBe('machine.json');
    expect(mainSrc).toContain('MACHINE_FILE');
    expect(mainSrc).toContain('await writeMachineJson()');
  });

  it('최초 부팅에만 식별자를 만들고 이후 유지한다', () => {
    expect(mainSrc).toContain('function loadOrCreateMachineId()');
    expect(mainSrc).toContain("if (typeof parsed.machineId === 'string'");
  });
});

describe('ADM-307 — 저장 큐 드레인 후 종료', () => {
  it('빈 작업을 큐 뒤에 붙이면 앞선 모든 쓰기가 끝난 뒤 resolve 한다', async () => {
    const { fs, writer } = makeWriter();
    const order: string[] = [];
    void writer.write('settings.csv', 'a').then(() => order.push('write-a'));
    void writer.write('stats.csv', 'b').then(() => order.push('write-b'));
    await writer.enqueue(() => Promise.resolve()).then(() => order.push('drain'));
    expect(order).toEqual(['write-a', 'write-b', 'drain']);
    expect(fs.files.get(path.join(FAKE_DIR, 'settings.csv'))).toBe('a');
  });

  it('앞선 쓰기가 실패해도 드레인이 매달리지 않는다', async () => {
    const fs = new InjectableFs();
    const { writer } = makeWriter(fs);
    fs.inject({ atCall: 1, kind: 'throw' });
    const failing = writer.write('settings.csv', 'a');
    await expect(failing).rejects.toThrow();
    fs.reboot();
    await expect(writer.enqueue(() => Promise.resolve())).resolves.toBeUndefined();
  });

  it('`app:quit`·`app:restart`가 드레인을 기다린다', () => {
    expect(mainSrc).toContain('function drainQueue()');
    expect(mainSrc).toContain("ipcMain.handle('app:quit', async () => {\n  await drainQueue();");
    expect(mainSrc).toContain("ipcMain.handle('app:restart', async () => {\n  await drainQueue();");
    // 드레인 뒤에 종료가 온다
    expect(mainSrc.indexOf('await drainQueue();\n  app.quit();')).toBeGreaterThan(0);
    expect(mainSrc.indexOf('await drainQueue();\n  app.relaunch();')).toBeGreaterThan(0);
  });
});

describe('P-8 · P-13 — IPC 채널', () => {
  it('메인이 `gamefs:health`·`app:logError`를 제공한다', () => {
    expect(mainSrc).toContain("ipcMain.handle('gamefs:health'");
    expect(mainSrc).toContain("ipcMain.handle('app:logError'");
    expect(mainSrc).toContain('storageLow: isStorageLow(freeBytes)');
  });

  it('preload가 `health`·`logError`를 노출한다', () => {
    expect(preloadSrc).toContain("health: () => ipcRenderer.invoke('gamefs:health')");
    expect(preloadSrc).toContain(
      "logError: (message) => ipcRenderer.invoke('app:logError', message)"
    );
  });

  it('WU-01 파일 API 4종이 그대로 남아 있다 (회귀 0)', () => {
    for (const api of ['write:', 'read:', 'append:', 'quit:', 'restart:']) {
      expect(preloadSrc).toContain(api);
    }
  });

  it('90일 오류 로그 정리가 그대로다 (§12.1)', () => {
    expect(mainSrc).toContain('ERROR_LOG_RETENTION_DAYS = 90');
    expect(mainSrc).toContain('void pruneOldErrorLogs()');
  });
});
