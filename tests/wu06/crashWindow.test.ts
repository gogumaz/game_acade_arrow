// WU-06 T10 — ADM-306 치명 오류 60초 창 영속 (§12.3 · 계획 P-9)
//
// WU-01은 창을 메모리에만 뒀다. 프로세스째 죽는 종류의 치명 오류에서는 매 재실행마다
// `count = 1`로 되살아나 `SERVICE REQUIRED`에 **영원히 닿지 않는다.** 여기서 영속과
// 부팅 판정을 판정한다.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCrashWindow,
  CRASH_WINDOW_FILE,
  FATAL_LIMIT,
  FATAL_WINDOW_MS,
} from '../../electron/safe-write.cjs';

const ELECTRON_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'electron'
);

/** `log/crash_window.json` 대역 — 재부팅을 사이에 두고 살아남는다 */
function diskStore(initial: number[] = []) {
  let saved: number[] = [...initial];
  let writes = 0;
  return {
    load: (): unknown => [...saved],
    save: (times: number[]): void => {
      writes += 1;
      saved = [...times];
    },
    get times(): number[] {
      return [...saved];
    },
    get writes(): number {
      return writes;
    },
  };
}

describe('ADM-306 — 영속 로드/저장', () => {
  it('기록할 때마다 저장한다', () => {
    const disk = diskStore();
    let t = 1000;
    const cw = createCrashWindow({ now: () => t, ...disk });
    cw.record();
    expect(disk.times).toEqual([1000]);
    t = 2000;
    cw.record();
    expect(disk.times).toEqual([1000, 2000]);
    expect(disk.writes).toBe(2);
  });

  it('재부팅해도 창이 이어진다 — 3번째 오류에서 SERVICE REQUIRED', () => {
    const disk = diskStore();
    let t = 0;

    // 1회차 부팅: 오류 1건 뒤 프로세스가 죽는다
    t = 1000;
    expect(createCrashWindow({ now: () => t, ...disk }).record()).toEqual({
      count: 1,
      serviceRequired: false,
    });

    // 2회차 부팅
    t = 20000;
    expect(createCrashWindow({ now: () => t, ...disk }).record()).toEqual({
      count: 2,
      serviceRequired: false,
    });

    // 3회차 부팅 — 60초 안이므로 자동 재실행이 멈춘다
    t = 40000;
    expect(createCrashWindow({ now: () => t, ...disk }).record()).toEqual({
      count: 3,
      serviceRequired: true,
    });
  });

  it('60초를 넘긴 기록은 창에서 빠진다', () => {
    const disk = diskStore([0, 1000, 2000]);
    const cw = createCrashWindow({ now: () => 2000 + FATAL_WINDOW_MS + 1, ...disk });
    expect(cw.boot()).toEqual({ count: 0, serviceRequired: false });
    expect(disk.times).toEqual([]);
  });

  it('창 안의 기록만 남기고 부팅 판정을 낸다', () => {
    const disk = diskStore([0, 59000, 59500]);
    const cw = createCrashWindow({ now: () => 59600, ...disk });
    const verdict = cw.boot();
    // 0은 59.6초 전이라 아직 창 안이다 (60초 이내)
    expect(verdict).toEqual({ count: 3, serviceRequired: true });
  });

  it('부팅 판정은 저장된 창을 정리하고 그대로 돌려준다', () => {
    const disk = diskStore([100000, 130000]);
    const cw = createCrashWindow({ now: () => 140000, ...disk });
    expect(cw.boot()).toEqual({ count: 2, serviceRequired: false });
    expect(cw.recorded).toEqual([100000, 130000]);
  });

  it('`reset()`이 창을 비운다 (정비 후 복귀)', () => {
    const disk = diskStore([1, 2, 3]);
    const cw = createCrashWindow({ now: () => 3, ...disk });
    expect(cw.count).toBe(3);
    cw.reset();
    expect(cw.count).toBe(0);
    expect(disk.times).toEqual([]);
  });
});

describe('ADM-306 — 손상 내성', () => {
  it('저장 파일이 깨져 있으면 빈 창으로 시작한다', () => {
    for (const bad of [null, 'not-an-array', { times: 'x' }, undefined]) {
      const cw = createCrashWindow({ now: () => 0, load: () => bad });
      expect(cw.count).toBe(0);
    }
  });

  it('숫자가 아닌 항목은 버린다', () => {
    const cw = createCrashWindow({ now: () => 0, load: () => [1, 'x', NaN, 2, undefined] });
    expect(cw.recorded).toEqual([1, 2]);
  });

  it('`load`가 던져도 부팅을 막지 않는다', () => {
    const cw = createCrashWindow({
      now: () => 0,
      load: () => {
        throw new Error('read failed');
      },
    });
    expect(cw.count).toBe(0);
  });

  it('`save`가 던져도 기록이 실패하지 않는다', () => {
    const cw = createCrashWindow({
      now: () => 0,
      save: () => {
        throw new Error('write failed');
      },
    });
    expect(() => cw.record()).not.toThrow();
    expect(cw.count).toBe(1);
  });

  it('`load`/`save`를 안 넘기면 WU-01처럼 메모리로만 돈다', () => {
    let t = 0;
    const cw = createCrashWindow({ now: () => t });
    cw.record();
    t = 1000;
    expect(cw.record()).toEqual({ count: 2, serviceRequired: false });
  });

  it('§9.4 확정 상수는 그대로다', () => {
    expect(FATAL_LIMIT).toBe(3);
    expect(FATAL_WINDOW_MS).toBe(60_000);
  });
});

describe('ADM-306 — main.cjs 부팅 배선', () => {
  const src = readFileSync(path.join(ELECTRON_DIR, 'main.cjs'), 'utf8');

  it('창을 `log/crash_window.json`에 영속한다', () => {
    expect(CRASH_WINDOW_FILE).toBe('crash_window.json');
    expect(src).toContain('CRASH_WINDOW_FILE');
    expect(src).toContain('load: () =>');
    expect(src).toContain('save: (times) =>');
  });

  it('부팅 시 창을 판정하고 SERVICE REQUIRED면 게임을 로드하지 않는다', () => {
    expect(src).toContain('crashWindow.boot()');
    expect(src).toContain('serviceRequiredAtBoot = verdict.serviceRequired');
    expect(src).toContain('if (serviceRequiredAtBoot)');
    expect(src).toContain("win.loadFile(path.join(__dirname, 'service-required.html'))");
  });

  it('부팅 순서가 잔존 `.tmp` 정리 → 크래시 창 → machine.json → 창 생성이다', () => {
    const order = ['storage.recoverStrays()', 'crashWindow.boot()', 'await writeMachineJson()'].map(
      (token) => src.indexOf(token)
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 창 생성은 부팅 순서의 **마지막**이다 (`app.whenReady()` 블록의 끝)
    expect(src.lastIndexOf('createWindow();')).toBeGreaterThan(order[2]);
  });
});
