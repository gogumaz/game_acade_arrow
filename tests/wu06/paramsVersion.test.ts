// WU-06 T10 — SAV-703 `PARAM_DATA_VERSION` 불일치 → 날짜 백업 + 공장값 + 경고 1회 (계획 P-12)
//
// WU-05는 "버전이 다르면 공장값을 쓰고 `versionMismatch` 플래그를 세운다"까지였다. 백업
// **파일 실체**가 없었고, 경고가 몇 번 보이는지도 정해지지 않았다. 여기서 둘 다 확정한다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, writeField } from '../../src/core/adminParams';
import { paramsToCsv, ParamsStore, PARAM_VERSION_KEY } from '../../src/game/admin/paramsDoc';
import { SafetyMonitor } from '../../src/game/safety';
import { FILES } from '../../src/persist/csv';
import { BAK_SUFFIX } from '../../src/persist/storage';
import { fakeHealth, memoryStorage, MemoryKeyValue } from './harness';

const TODAY = '2026-08-17';

function mismatchedCsv(sessionTimeSec = 150): string {
  return paramsToCsv(
    writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', sessionTimeSec)
  ).replace(`${PARAM_VERSION_KEY},1`, `${PARAM_VERSION_KEY},9`);
}

async function bootWithParams(csv: string, kv = new MemoryKeyValue()) {
  kv.put(FILES.params, csv);
  const rig = memoryStorage({ kv, today: () => TODAY });
  const params = new ParamsStore();
  rig.storage.register(params.asSaveDocument());
  await rig.storage.init();
  return { rig, params, kv };
}

describe('SAV-703 — 버전 불일치 날짜 백업 실체', () => {
  it('`params.csv.<날짜>.bak`에 **원본**이 그대로 남는다', async () => {
    const original = mismatchedCsv();
    const { kv, rig } = await bootWithParams(original);
    const backupName = `${FILES.params}.${TODAY}${BAK_SUFFIX}`;
    expect(kv.dump(backupName)).toBe(original);
    expect(rig.storage.bootOutcomeOf(FILES.params)).toMatchObject({
      outcome: 'version_backup',
      backupFile: backupName,
      rewriteFailed: false,
    });
  });

  it('본 파일은 **현재 버전의 공장값**으로 재기록된다', async () => {
    const { kv, params } = await bootWithParams(mismatchedCsv());
    expect(params.live.core.sessionTimeSec).toBe(FACTORY_ADMIN_PARAMS.core.sessionTimeSec);
    expect(kv.dump(FILES.params)).toBe(paramsToCsv(FACTORY_ADMIN_PARAMS));
    expect(kv.dump(FILES.params)).toContain(`${PARAM_VERSION_KEY},1`);
  });

  it('편집분은 적용되지 않는다 (§12.1 — 옛 버전 값을 새 스키마에 섞지 않는다)', async () => {
    const { params } = await bootWithParams(mismatchedCsv(150));
    expect(params.live.core.sessionTimeSec).not.toBe(150);
    expect(params.versionMismatch).toBe(true);
  });

  it('버전이 같으면 날짜 백업을 만들지 않는다', async () => {
    const { kv, rig } = await bootWithParams(
      paramsToCsv(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 95))
    );
    expect(kv.keys().some((k) => k.includes(TODAY))).toBe(false);
    expect(rig.storage.bootOutcomeOf(FILES.params)).toMatchObject({ outcome: 'ok' });
  });

  it('날짜 백업 쓰기가 실패하면 `rewriteFailed`가 선다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.params, mismatchedCsv());
    const rig = memoryStorage({ kv, today: () => TODAY, failWrites: { on: true } });
    rig.storage.register(new ParamsStore().asSaveDocument());
    await rig.storage.init();
    expect(rig.storage.bootOutcomeOf(FILES.params)).toMatchObject({
      outcome: 'version_backup',
      rewriteFailed: true,
    });
  });
});

describe('SAV-703 — OVERVIEW 경고 1회 (P-12)', () => {
  function monitorOf(rig: ReturnType<typeof memoryStorage>): SafetyMonitor {
    return new SafetyMonitor({
      storage: {
        get backendKind() {
          return rig.storage.backendKind;
        },
        get saveFailStreak() {
          return rig.storage.saveFailStreak;
        },
        bootOutcomeOf: (f) => rig.storage.bootOutcomeOf(f),
      },
      credits: { blockReason: null },
    });
  }

  it('첫 조회에서 `PARAM DATA VERSION` 경고가 나온다', async () => {
    const { rig } = await bootWithParams(mismatchedCsv());
    const monitor = monitorOf(rig);
    const first = monitor.consumeBootNotices();
    expect(first.map((n) => n.code)).toEqual(['PARAM DATA VERSION']);
    expect(first[0].text).toContain(FILES.params);
    expect(first[0].text).toContain('날짜 백업');
  });

  it('두 번째 조회는 빈 목록이다 (부팅당 1회)', async () => {
    const { rig } = await bootWithParams(mismatchedCsv());
    const monitor = monitorOf(rig);
    expect(monitor.consumeBootNotices()).toHaveLength(1);
    expect(monitor.consumeBootNotices()).toEqual([]);
    expect(monitor.consumeBootNotices()).toEqual([]);
  });

  it('버전 불일치는 유료 플레이를 차단하지 않는다 (경고일 뿐이다)', async () => {
    const { rig } = await bootWithParams(mismatchedCsv());
    expect(monitorOf(rig).reason()).toBe(null);
  });

  it('`setHealth()`로 상태가 바뀌면 목록을 다시 만든다 (STORAGE LOW 합류)', async () => {
    const { rig } = await bootWithParams(mismatchedCsv());
    const monitor = monitorOf(rig);
    monitor.setHealth(fakeHealth({ storageLow: true }));
    expect(monitor.peekBootNotices().map((n) => n.code)).toEqual([
      'PARAM DATA VERSION',
      'STORAGE LOW',
    ]);
  });

  it('정상 부팅에서는 경고가 하나도 없다', async () => {
    const { rig } = await bootWithParams(paramsToCsv(FACTORY_ADMIN_PARAMS));
    expect(monitorOf(rig).consumeBootNotices()).toEqual([]);
  });
});
