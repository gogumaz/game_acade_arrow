// WU-06 FIX 사이클 1 — SAV-706 로그 재기록 중 strict append 실패 전파 검증

import { describe, expect, it } from 'vitest';
import { FILES } from '../../src/persist/csv';
import { Storage, type StorageBackend } from '../../src/persist/storage';

describe('SAV-706 — rewriteLog 버퍼가 실패를 삼키지 않는다', () => {
  it('버퍼링된 appendLineStrict의 실패가 호출자에게 던져진다', async () => {
    let gate!: () => void;
    const opened = new Promise<void>((resolve) => {
      gate = resolve;
    });
    let readSeen!: () => void;
    const reached = new Promise<void>((resolve) => {
      readSeen = resolve;
    });
    const backend: StorageBackend = {
      kind: 'electron',
      write: () => Promise.resolve(),
      read: async () => {
        readSeen();
        await opened;
        return 'header\n';
      },
      append: () => Promise.reject(new Error('disk full')),
    };
    const storage = new Storage({ backend, onError: () => undefined });
    const rewrite = storage.rewriteLog(FILES.creditLog, () => 'header\n');
    await reached;

    const buffered = storage.appendLineStrict(FILES.creditLog, 'x');
    const settled = buffered.then(
      () => 'resolved',
      () => 'rejected'
    );
    gate();
    await rewrite;

    expect(await settled).toBe('rejected');
  });

  it('버퍼링되지 않은 경로도 그대로 던진다', async () => {
    const backend: StorageBackend = {
      kind: 'electron',
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      append: () => Promise.reject(new Error('disk full')),
    };
    const storage = new Storage({ backend, onError: () => undefined });

    await expect(storage.appendLineStrict(FILES.creditLog, 'x')).rejects.toThrow('disk full');
  });
});
