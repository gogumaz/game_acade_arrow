// WU-01 T5 — 저장 백엔드 3종과 디바운스 (§9.2 · SAV-003)
// 가짜 gameFS·가짜 localStorage(Map 기반)를 주입해 jsdom 없이 3종을 모두 왕복한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CREDIT_LOG_HEADER, FILES } from '../../src/persist/csv';
import {
  LOG_KEEP_LINES,
  SAVE_DEBOUNCE_MS,
  STORAGE_PREFIX,
  Storage,
  type GameFs,
  type KeyValueStore,
  type SaveDocument,
  type StorageBackend,
  electronBackend,
  localStorageBackend,
  memoryBackend,
  selectBackend,
} from '../../src/persist/storage';

/** preload가 노출하는 gameFS의 인메모리 대역 */
function fakeGameFs(): GameFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    write: (n, c) => {
      files.set(n, c);
      return Promise.resolve();
    },
    read: (n) => Promise.resolve(files.get(n) ?? null),
    // electron/safe-write.cjs의 append와 같은 의미:
    // 파일이 없고 credit_log.csv면 헤더 1줄을 먼저 쓰고, 매 호출마다 `줄\n`을 덧붙인다.
    append: (n, l) => {
      let cur = files.get(n);
      if (cur === undefined && n === FILES.creditLog) cur = `${CREDIT_LOG_HEADER}\n`;
      files.set(n, `${cur ?? ''}${l}\n`);
      return Promise.resolve();
    },
  };
}

/** Map 기반 localStorage 대역 */
class FakeLocalStorage implements KeyValueStore {
  readonly map = new Map<string, string>();
  throwOnSet = false;

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

// ── 5-8 백엔드 3종 왕복 ───────────────────────────────────────────────────

describe('5-8 백엔드 3종 왕복 (§9.2)', () => {
  const cases: [string, () => StorageBackend][] = [
    ['Electron IPC', () => electronBackend(fakeGameFs())],
    ['localStorage', () => localStorageBackend(new FakeLocalStorage())],
    ['세션 메모리', () => memoryBackend()],
  ];

  it.each(cases)('%s — write → read 왕복', async (_label, make) => {
    const backend = make();
    await backend.write(FILES.settings, 'schema,soundVolume\n1,80');
    await expect(backend.read(FILES.settings)).resolves.toBe('schema,soundVolume\n1,80');
  });

  it.each(cases)('%s — append → read 왕복', async (_label, make) => {
    const backend = make();
    await backend.append(FILES.creditLog, 'row-1');
    await backend.append(FILES.creditLog, 'row-2');
    const text = await backend.read(FILES.creditLog);
    expect(text).not.toBeNull();
    const lines = (text ?? '').trim().split('\n');
    expect(lines[0]).toBe(CREDIT_LOG_HEADER);
    expect(lines.slice(1)).toEqual(['row-1', 'row-2']);
  });

  it.each(cases)('%s — 없는 파일 읽기는 null', async (_label, make) => {
    await expect(make().read(FILES.stats)).resolves.toBeNull();
  });

  it('localStorage 백엔드는 neongrid: 접두사를 쓴다', async () => {
    const store = new FakeLocalStorage();
    await localStorageBackend(store).write(FILES.stats, 'v');
    expect([...store.map.keys()]).toEqual([`${STORAGE_PREFIX}${FILES.stats}`]);
  });

  it('credit_log 이외 추가 전용 파일에는 헤더를 붙이지 않는다', async () => {
    const backend = memoryBackend();
    await backend.append(FILES.auditLog, 'admin_enter');
    await expect(backend.read(FILES.auditLog)).resolves.toBe('admin_enter');
  });
});

// ── 5-9 선택 우선순위 ─────────────────────────────────────────────────────

describe('5-9 백엔드 선택 우선순위 (§9.2)', () => {
  it('gameFS가 있으면 Electron', () => {
    const backend = selectBackend({ gameFS: fakeGameFs(), localStorage: new FakeLocalStorage() });
    expect(backend.kind).toBe('electron');
  });

  it('gameFS가 없고 localStorage가 쓸 수 있으면 localStorage', () => {
    expect(selectBackend({ localStorage: new FakeLocalStorage() }).kind).toBe('localStorage');
  });

  it('localStorage가 예외를 던지면 메모리로 강등한다', () => {
    const store = new FakeLocalStorage();
    store.throwOnSet = true;
    expect(selectBackend({ localStorage: store }).kind).toBe('memory');
  });

  it('아무것도 없으면 메모리', () => {
    expect(selectBackend({}).kind).toBe('memory');
  });

  it('Storage.isElectron이 백엔드 종류를 따른다', () => {
    expect(new Storage({ env: { gameFS: fakeGameFs() } }).isElectron).toBe(true);
    expect(new Storage({ env: {} }).isElectron).toBe(false);
  });
});

// ── 5-10 로그 2000줄 유지 ─────────────────────────────────────────────────

describe('5-10 localStorage 로그 최근 2000줄 유지 (§9.2)', () => {
  it('헤더를 보존하고 최근 2000줄만 남긴다', async () => {
    const store = new FakeLocalStorage();
    const backend = localStorageBackend(store);
    for (let i = 0; i < LOG_KEEP_LINES + 50; i++) {
      await backend.append(FILES.creditLog, `row-${i}`);
    }
    const lines = (store.getItem(`${STORAGE_PREFIX}${FILES.creditLog}`) ?? '').split('\n');
    expect(lines).toHaveLength(LOG_KEEP_LINES + 1);
    expect(lines[0]).toBe(CREDIT_LOG_HEADER);
    expect(lines[1]).toBe('row-50');
    expect(lines[lines.length - 1]).toBe(`row-${LOG_KEEP_LINES + 49}`);
  });

  it('2000줄 이하에서는 그대로 둔다', async () => {
    const store = new FakeLocalStorage();
    const backend = localStorageBackend(store);
    for (let i = 0; i < 5; i++) await backend.append(FILES.creditLog, `row-${i}`);
    const lines = (store.getItem(`${STORAGE_PREFIX}${FILES.creditLog}`) ?? '').split('\n');
    expect(lines).toHaveLength(6);
  });

  it('메모리 백엔드도 같은 정책을 쓴다', async () => {
    const backend = memoryBackend();
    for (let i = 0; i < LOG_KEEP_LINES + 10; i++) {
      await backend.append(FILES.creditLog, `row-${i}`);
    }
    const lines = ((await backend.read(FILES.creditLog)) ?? '').split('\n');
    expect(lines).toHaveLength(LOG_KEEP_LINES + 1);
    expect(lines[0]).toBe(CREDIT_LOG_HEADER);
  });
});

// ── 5-11 800ms 디바운스 ───────────────────────────────────────────────────

describe('5-11 800ms 디바운스 (§9.2 · SAV-003)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeStorage(): { storage: Storage; writes: string[] } {
    const writes: string[] = [];
    const backend: StorageBackend = {
      kind: 'memory',
      write: (n, c) => {
        writes.push(`${n}=${c}`);
        return Promise.resolve();
      },
      read: () => Promise.resolve(null),
      append: () => Promise.resolve(),
    };
    const storage = new Storage({ backend });
    let value = 0;
    storage.register({
      file: FILES.settings,
      serialize: () => String(value++),
      apply: () => undefined,
    });
    return { storage, writes };
  }

  it('800ms 안에 변경이 여러 번이면 1회만 저장한다', async () => {
    const { storage, writes } = makeStorage();
    storage.scheduleSave();
    vi.advanceTimersByTime(300);
    storage.scheduleSave();
    vi.advanceTimersByTime(300);
    storage.scheduleSave();
    expect(writes).toHaveLength(0);

    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(1);
  });

  it('800ms 전에는 저장하지 않는다', async () => {
    const { storage, writes } = makeStorage();
    storage.scheduleSave();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes).toHaveLength(0);
    expect(storage.hasPendingSave).toBe(true);

    vi.advanceTimersByTime(1);
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(1);
    expect(storage.hasPendingSave).toBe(false);
  });

  it('창이 지나고 다시 변경하면 또 저장한다', async () => {
    const { storage, writes } = makeStorage();
    storage.scheduleSave();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    storage.scheduleSave();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    expect(writes).toHaveLength(2);
  });
});

// ── 문서 등록 API (작업 계획 D-5) ─────────────────────────────────────────

describe('저장 대상 문서 등록 API (§9.2 부팅 시 로드 → 저장)', () => {
  function docFor(state: { value: string }): SaveDocument {
    return {
      file: FILES.settings,
      serialize: () => state.value,
      apply: (csv) => {
        state.value = csv;
      },
    };
  }

  it('init이 등록된 문서를 읽어 반영한다', async () => {
    const fs = fakeGameFs();
    fs.files.set(FILES.settings, 'loaded');
    const state = { value: 'initial' };
    const storage = new Storage({ env: { gameFS: fs } });
    storage.register(docFor(state));

    await storage.init();
    expect(state.value).toBe('loaded');
  });

  it('저장된 파일이 없으면 apply를 호출하지 않는다', async () => {
    const state = { value: 'factory' };
    const storage = new Storage({ env: { gameFS: fakeGameFs() } });
    storage.register(docFor(state));

    await storage.init();
    expect(state.value).toBe('factory');
  });

  it('saveAll이 등록 순서대로 직렬화 결과를 쓴다', async () => {
    const fs = fakeGameFs();
    const storage = new Storage({ env: { gameFS: fs } });
    storage.register({
      file: FILES.settings,
      serialize: () => 'S',
      apply: () => undefined,
    });
    storage.register({
      file: FILES.stats,
      serialize: () => 'T',
      apply: () => undefined,
    });

    await storage.saveAll();
    expect(fs.files.get(FILES.settings)).toBe('S');
    expect(fs.files.get(FILES.stats)).toBe('T');
  });

  it('추가 전용 파일은 문서로 등록할 수 없다', () => {
    const storage = new Storage({ env: {} });
    expect(() =>
      storage.register({
        file: FILES.creditLog,
        serialize: () => '',
        apply: () => undefined,
      })
    ).toThrow(/append-only/);
  });

  it('같은 파일을 두 번 등록할 수 없다', () => {
    const storage = new Storage({ env: {} });
    const doc: SaveDocument = {
      file: FILES.stages,
      serialize: () => '',
      apply: () => undefined,
    };
    storage.register(doc);
    expect(() => storage.register({ ...doc })).toThrow(/duplicate/);
  });

  it('로드 실패를 onError로 보고하고 부팅을 계속한다', async () => {
    const errors: string[] = [];
    const backend: StorageBackend = {
      kind: 'memory',
      write: () => Promise.resolve(),
      read: () => Promise.reject(new Error('io')),
      append: () => Promise.resolve(),
    };
    const storage = new Storage({ backend, onError: (phase) => errors.push(phase) });
    storage.register({ file: FILES.settings, serialize: () => '', apply: () => undefined });

    await expect(storage.init()).resolves.toBeUndefined();
    expect(errors).toEqual(['load']);
  });

  it('저장 실패를 onError로 보고한다', async () => {
    const errors: string[] = [];
    const backend: StorageBackend = {
      kind: 'memory',
      write: () => Promise.reject(new Error('io')),
      read: () => Promise.resolve(null),
      append: () => Promise.reject(new Error('io')),
    };
    const storage = new Storage({ backend, onError: (phase) => errors.push(phase) });
    storage.register({ file: FILES.settings, serialize: () => '', apply: () => undefined });

    await storage.saveAll();
    await storage.appendLine(FILES.creditLog, 'row');
    expect(errors).toEqual(['save', 'append']);
  });

  it('appendLine이 백엔드 append로 이어진다', async () => {
    const fs = fakeGameFs();
    const storage = new Storage({ env: { gameFS: fs } });
    await storage.appendLine(FILES.creditLog, 'row-1');
    await expect(storage.read(FILES.creditLog)).resolves.toContain('row-1');
  });
});
