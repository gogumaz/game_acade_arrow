// WU-01 스모크 — 이후 모든 유닛의 Phase 4에서 회귀로 재실행한다 (work_process §4-3).
//
// 검사 대상은 WU-01이 확정한 **공개 표면 4개**다. 세부 판정은 각 태스크의 전용 테스트가
// 하고, 여기서는 표면이 살아 있는지만 빠르게 확인한다.
//   ① 입력 어댑터 3상태 (§2.1 · §18.5)
//   ② 안전 쓰기 왕복 + .bak 폴백 (§9.3 · SAV-001 · SAV-002)
//   ③ 저장 백엔드 3종 (§9.2)
//   ④ CSV 왕복 (§9.1)
//
// 10초 이내로 유지한다. 실파일 I/O는 임시 디렉터리 1회로 제한한다.

import { mkdtemp, rm } from 'node:fs/promises';
import * as realFsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GAME_TITLE, INPUT_ACTIONS } from '../../src/core/types';
import {
  KEYMAP,
  KeyboardInputAdapter,
  STUCK_HOLD_MS,
  type InputAdapter,
  type InputStatus,
  type KeyEventLike,
  type KeyEventTarget,
  type PlayerAction,
  keyboard,
  lookup,
  systemTimers,
} from '../../src/game/input';
import { createSafeWriter } from '../../electron/safe-write.cjs';
import {
  APPEND_ONLY_FILES,
  CODEC_FILES,
  CREDIT_LOG_HEADER,
  FILES,
  type CreditLogRecord,
  type SettingsRecord,
  type StatsRecord,
  creditLogLine,
  parseCreditLogLine,
  parseSettingsCsv,
  parseStatsCsv,
  settingsToCsv,
  statsToCsv,
} from '../../src/persist/csv';
import {
  LOG_KEEP_LINES,
  SAVE_DEBOUNCE_MS,
  STORAGE_PREFIX,
  Storage,
  type GameFs,
  type KeyValueStore,
  browserEnvironment,
  electronBackend,
  localStorageBackend,
  memoryBackend,
  selectBackend,
} from '../../src/persist/storage';

// ── ① 입력 어댑터 3상태 ───────────────────────────────────────────────────

class SmokeKeyTarget implements KeyEventTarget {
  private readonly listeners = new Map<string, ((e: KeyEventLike) => void)[]>();

  addEventListener(type: string, listener: (event: KeyEventLike) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: KeyEventLike) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((f) => f !== listener)
    );
  }

  emit(type: string, event: KeyEventLike = { key: '' }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

describe('WU-01 스모크 ① 입력 어댑터 (§2.1 · §18.5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('추상 입력 10종과 §2.1 키맵이 살아 있다', () => {
    expect(INPUT_ACTIONS).toHaveLength(10);
    expect(Object.keys(KEYMAP)).toHaveLength(16); // P1·P2 7행 ×2 + 공통 2 (RESERVED는 키 없음)
    expect(lookup({ code: 'KeyW', key: '' })).toEqual({ player: 1, action: 'UP' });
    expect(lookup({ code: 'KeyH', key: '' })).toEqual({ player: 1, action: 'BUTTON1' });
    expect(lookup({ code: '', key: 'l' })).toEqual({ player: 2, action: 'BUTTON1' });
    expect(lookup({ code: 'Escape', key: 'Escape' })).toBeUndefined(); // 키오스크 탈출 경로 제거
  });

  it('disconnected → connected → stuck → connected → disconnected 전이가 된다', () => {
    const target = new SmokeKeyTarget();
    const adapter: InputAdapter = new KeyboardInputAdapter({ target, timers: systemTimers });
    const seen: InputStatus[] = [];
    adapter.onStatusChange((s) => seen.push(s));
    const actions: PlayerAction[] = [];
    adapter.onAction((pa) => actions.push(pa));

    expect(adapter.status).toBe('disconnected');
    adapter.attach();
    // 코인 키는 반복 대상이 아니므로(§2.3) 홀드해도 발화가 1회로 유지된다
    target.emit('keydown', { code: 'F10', key: '' });
    vi.advanceTimersByTime(STUCK_HOLD_MS);
    target.emit('keyup', { code: 'F10', key: '' });
    adapter.detach();

    expect(seen).toEqual(['connected', 'stuck', 'connected', 'disconnected']);
    expect(actions).toEqual([{ player: 1, action: 'COIN' }]);
  });

  it('방향 홀드는 250ms 후 100ms 간격으로 반복한다 (§2.3)', () => {
    const target = new SmokeKeyTarget();
    const adapter = new KeyboardInputAdapter({ target });
    adapter.attach();
    const actions: PlayerAction[] = [];
    adapter.onAction((pa) => actions.push(pa));

    target.emit('keydown', { code: 'KeyA', key: '' });
    expect(actions).toHaveLength(1);
    vi.advanceTimersByTime(250 + 100 * 3);
    expect(actions).toHaveLength(4);

    target.emit('blur'); // 포커스 상실에서 즉시 해제
    vi.advanceTimersByTime(100 * 20);
    expect(actions).toHaveLength(4);
  });

  it('기본 키보드 어댑터 싱글턴이 존재하고 초기 상태가 disconnected다', () => {
    expect(keyboard.id).toBe('keyboard');
    expect(keyboard.status).toBe('disconnected');
  });
});

// ── ② 안전 쓰기 왕복 + .bak 폴백 ─────────────────────────────────────────

describe('WU-01 스모크 ② 안전 쓰기 (§9.3 · SAV-001 · SAV-002)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'arrowout-smoke-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('write → read 왕복 후 본 파일을 지우면 .bak으로 복구된다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.write(FILES.settings, 'v1');
    await writer.write(FILES.settings, 'v2');
    await expect(writer.read(FILES.settings)).resolves.toBe('v2');

    await rm(path.join(dir, FILES.settings));
    await expect(writer.read(FILES.settings)).resolves.toBe('v1');
  });

  it('credit_log append가 헤더를 먼저 쓴다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await writer.append(FILES.creditLog, 'row');
    const text = (await writer.read(FILES.creditLog)) ?? '';
    expect(text.split('\n')[0]).toBe(CREDIT_LOG_HEADER);
  });

  it('경로 탈출 파일명을 거부한다', async () => {
    const writer = createSafeWriter({ fsp: realFsp, dir });
    await expect(writer.write('../escape.csv', 'x')).rejects.toThrow(/invalid file name/);
  });
});

// ── ③ 저장 백엔드 3종 ────────────────────────────────────────────────────

describe('WU-01 스모크 ③ 저장 백엔드 3종 (§9.2)', () => {
  function fakeGameFs(): GameFs {
    const files = new Map<string, string>();
    return {
      write: (n, c) => {
        files.set(n, c);
        return Promise.resolve();
      },
      read: (n) => Promise.resolve(files.get(n) ?? null),
      append: (n, l) => {
        files.set(n, `${files.get(n) ?? ''}${l}\n`);
        return Promise.resolve();
      },
    };
  }

  function fakeStore(): KeyValueStore {
    const map = new Map<string, string>();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => {
        map.set(k, v);
      },
      removeItem: (k) => {
        map.delete(k);
      },
    };
  }

  it('3종 모두 write → read 왕복이 된다', async () => {
    for (const backend of [
      electronBackend(fakeGameFs()),
      localStorageBackend(fakeStore()),
      memoryBackend(),
    ]) {
      await backend.write(FILES.stats, 'value');
      await expect(backend.read(FILES.stats)).resolves.toBe('value');
    }
  });

  it('선택 우선순위가 gameFS → localStorage → 메모리다', () => {
    expect(selectBackend({ gameFS: fakeGameFs(), localStorage: fakeStore() }).kind).toBe(
      'electron'
    );
    expect(selectBackend({ localStorage: fakeStore() }).kind).toBe('localStorage');
    expect(selectBackend({}).kind).toBe('memory');
    // Node 환경에는 gameFS·localStorage가 없으므로 메모리로 강등된다
    expect(selectBackend(browserEnvironment()).kind).toBe('memory');
  });

  it('문서 등록 → init → saveAll이 이어진다', async () => {
    const state = { csv: 'factory' };
    const fs = fakeGameFs();
    await fs.write(FILES.settings, 'saved');

    const storage = new Storage({ env: { gameFS: fs } });
    storage.register({
      file: FILES.settings,
      serialize: () => state.csv,
      apply: (csv) => {
        state.csv = csv;
      },
    });

    await storage.init();
    expect(state.csv).toBe('saved');
    expect(storage.backendKind).toBe('electron');

    state.csv = 'changed';
    await storage.saveAll();
    await expect(storage.read(FILES.settings)).resolves.toBe('changed');
  });
});

// ── ④ CSV 왕복 ───────────────────────────────────────────────────────────

describe('WU-01 스모크 ④ CSV 왕복 (§9.1)', () => {
  it('확정 3종 코덱이 왕복한다', () => {
    const settings: SettingsRecord = { soundVolume: 80, coinsPerPlay: 1, initialHearts: 3 };
    expect(parseSettingsCsv(settingsToCsv(settings))).toEqual(settings);

    const stats: StatsRecord = {
      date: '2026-08-15',
      paidPlayTotal: 1,
      paidPlayToday: 1,
      paidContinue: 0,
      eventPlayTotal: 0,
      eventPlayToday: 0,
      eventContinue: 0,
      eventGrantedTotal: 0,
      eventUsedTotal: 0,
      eventUsedToday: 0,
    };
    expect(parseStatsCsv(statsToCsv(stats))).toEqual(stats);

    const credit: CreditLogRecord = {
      timestamp: '2026-08-15T09:00:00.000Z',
      action: 'coin_insert',
      source: 'paid',
      paidBalance: 1,
      eventBalance: 0,
      reason: '', // WU-04 Q-1 — §10.2 원복 사유 칸
    };
    expect(parseCreditLogLine(creditLogLine(credit))).toEqual(credit);
  });

  it('사양이 수치로 확정한 상수는 리터럴로 고정된다', () => {
    // 전용 테스트들이 상수 기준 상대 계산을 쓰므로, 사양값 자체는 여기서 고정한다.
    expect(STUCK_HOLD_MS).toBe(5000); // §2.5 "5초 이상" 고착 판정
    expect(SAVE_DEBOUNCE_MS).toBe(800); // 변경 시 800ms 디바운스
    expect(LOG_KEEP_LINES).toBe(2000); // localStorage 로그 최근 2000줄
    expect(STORAGE_PREFIX).toBe('arrowout:'); // §12.1 브라우저 저장 접두사
    expect(GAME_TITLE).toBe('ARROW OUT'); // §16.4 이름은 설정 상수 1곳
  });

  it('params·ranking 파일명 상수가 예약돼 있다 (§12.1)', () => {
    // 스키마는 WU-05·WU-06 소관이다. 이 스모크는 "파일명만 예약된 상태"를 회귀로 지킨다.
    expect(FILES.params).toBe('params.csv');
    expect(FILES.ranking).toBe('ranking.csv');
    for (const file of [FILES.params, FILES.ranking]) {
      expect(CODEC_FILES).not.toContain(file);
      expect(APPEND_ONLY_FILES).not.toContain(file);
    }
  });
});
