// `settings.csv` 확장 (§11.3 · §12.1 — 계획 T4 · 실측 제약 F-d)
//
// WU-01 v1 **두 줄을 그대로 두고** 3줄째부터 `#machine` 섹션을 덧붙였다는 사실을 고정한다.
// WU-01 파서가 그 파일을 여전히 정상으로 읽어야 27건 회귀가 성립한다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, type MachineParams } from '../../src/core/adminParams';
import {
  MACHINE_HEADER,
  MACHINE_SECTION,
  SettingsStore,
  parseSettingsDocCsv,
  settingsDocToCsv,
} from '../../src/game/settingsDoc';
import { FILES, SETTINGS_HEADER, parseSettingsCsv } from '../../src/persist/csv';
import { MemoryKeyValue, memoryStorage } from './harness';

const FACTORY = FACTORY_ADMIN_PARAMS.machine;

function doc(machine: Partial<MachineParams> = {}, hearts = 3): string {
  return settingsDocToCsv({ machine: { ...FACTORY, ...machine }, initialHearts: hearts });
}

describe('6-1 v1 두 줄 보존 (F-d)', () => {
  const csv = doc();
  const lines = csv.split('\n');

  it('첫 줄이 WU-01 헤더 그대로다', () => {
    expect(lines[0]).toBe(SETTINGS_HEADER);
  });

  it('둘째 줄이 WU-01 v1 본행이다', () => {
    expect(lines[1]).toBe('1,80,1,3');
  });

  it('WU-01 파서가 그대로 읽는다', () => {
    expect(parseSettingsCsv(csv)).toEqual({ soundVolume: 80, coinsPerPlay: 1, initialHearts: 3 });
  });

  it('WU-01 파서는 3줄째부터를 무시한다', () => {
    const long = `${csv}\n#unknown,x\n1,2,3`;
    expect(parseSettingsCsv(long)).toEqual(parseSettingsCsv(csv));
  });

  it('`initialHearts`는 거울값이다 (권위는 params.csv)', () => {
    expect(doc({}, 7).split('\n')[1]).toBe('1,80,1,7');
  });
});

describe('6-2 `#machine` 섹션', () => {
  const csv = doc();
  const lines = csv.split('\n');

  it('3줄째가 섹션 헤더다', () => {
    expect(lines[2]).toBe(MACHINE_HEADER);
    expect(lines[2].startsWith(MACHINE_SECTION)).toBe(true);
  });

  it('4줄째가 값 행이다', () => {
    expect(lines[3]).toBe('1,30,22:00,10:00,1,1,,0');
  });

  it('전체가 4줄이다', () => {
    expect(lines).toHaveLength(4);
  });

  it('미설정 단가는 빈 칸이다', () => {
    expect(lines[3].split(',')[6]).toBe('');
  });

  it('단가를 넣으면 숫자가 실린다', () => {
    expect(doc({ coinUnitPrice: 1500 }).split('\n')[3].split(',')[6]).toBe('1500');
  });

  it('불리언은 1/0으로 적힌다', () => {
    const off = doc({ nightMuteOn: false, motionReduce: true }).split('\n')[3].split(',');
    expect(off[4]).toBe('0');
    expect(off[7]).toBe('1');
  });
});

describe('6-3 왕복', () => {
  it('공장값이 왕복에서 그대로다', () => {
    expect(parseSettingsDocCsv(doc())).toEqual(FACTORY);
  });

  it('9수치를 전부 바꿔도 왕복에서 같다', () => {
    const changed: MachineParams = {
      soundVolume: 55,
      attractVolume: 15,
      nightMuteOn: false,
      nightMuteStart: '23:30',
      nightMuteEnd: '09:00',
      coinsPerPlay: 3,
      continueCoins: 2,
      coinUnitPrice: 2000,
      motionReduce: true,
    };
    expect(parseSettingsDocCsv(doc(changed))).toEqual(changed);
  });

  it('미설정 단가가 왕복에서 null로 남는다', () => {
    expect(parseSettingsDocCsv(doc({ coinUnitPrice: null })).coinUnitPrice).toBe(null);
  });

  it('왕복 문자열이 같다', () => {
    const csv = doc({ coinUnitPrice: 1500 });
    expect(settingsDocToCsv({ machine: parseSettingsDocCsv(csv), initialHearts: 3 })).toBe(csv);
  });
});

describe('6-4 손상 관용', () => {
  it('v1 두 줄만 있는 옛 파일도 읽는다', () => {
    const old = `${SETTINGS_HEADER}\n1,55,4,5`;
    const m = parseSettingsDocCsv(old);
    expect(m.soundVolume).toBe(55);
    expect(m.coinsPerPlay).toBe(4);
    expect(m.attractVolume).toBe(FACTORY.attractVolume);
  });

  it('섹션이 손상되면 공장값을 유지한다', () => {
    const broken = `${SETTINGS_HEADER}\n1,80,1,3\n${MACHINE_HEADER}\n깨진행`;
    expect(parseSettingsDocCsv(broken)).toEqual(FACTORY);
  });

  it('빈 문자열도 공장값이다', () => {
    expect(parseSettingsDocCsv('')).toEqual(FACTORY);
  });

  it('throw 하지 않는다', () => {
    expect(() => parseSettingsDocCsv('!!!,,,\n\n@@@')).not.toThrow();
  });

  it('숫자 칸이 문자면 공장값을 쓴다', () => {
    const csv = `${SETTINGS_HEADER}\n1,80,1,3\n${MACHINE_HEADER}\n1,없음,22:00,10:00,1,1,,0`;
    expect(parseSettingsDocCsv(csv).attractVolume).toBe(FACTORY.attractVolume);
  });

  it('단가 칸이 문자면 미설정으로 본다', () => {
    const csv = `${SETTINGS_HEADER}\n1,80,1,3\n${MACHINE_HEADER}\n1,30,22:00,10:00,1,1,없음,0`;
    expect(parseSettingsDocCsv(csv).coinUnitPrice).toBe(null);
  });

  it('v1 본행의 볼륨·코인은 범위로 조인다 (WU-01 파서 규칙)', () => {
    const csv = `${SETTINGS_HEADER}\n1,500,0,3\n${MACHINE_HEADER}\n1,30,22:00,10:00,1,1,,0`;
    const m = parseSettingsDocCsv(csv);
    expect(m.soundVolume).toBe(100);
    expect(m.coinsPerPlay).toBe(1);
  });
});

describe('6-5 SettingsStore 결선', () => {
  it('`Storage.register()`로 저장된다', async () => {
    const rig = memoryStorage();
    const store = new SettingsStore();
    rig.storage.register(store.asSaveDocument());
    store.set({ ...FACTORY, coinsPerPlay: 3 });
    store.mirrorInitialHearts(5);
    await rig.storage.saveNow(FILES.settings);
    const csv = rig.kv.dump(FILES.settings) ?? '';
    expect(csv.split('\n')[1]).toBe('1,80,3,5');
  });

  it('재기동해도 기기 설정이 유지된다', async () => {
    const kv = new MemoryKeyValue();
    const first = memoryStorage(kv);
    const a = new SettingsStore();
    first.storage.register(a.asSaveDocument());
    a.set({ ...FACTORY, coinUnitPrice: 1500, motionReduce: true });
    await first.storage.saveNow(FILES.settings);

    const second = memoryStorage(kv);
    const b = new SettingsStore();
    second.storage.register(b.asSaveDocument());
    await second.storage.init();
    expect(b.machine.coinUnitPrice).toBe(1500);
    expect(b.machine.motionReduce).toBe(true);
  });

  it('저장된 파일을 WU-01 파서가 여전히 읽는다', async () => {
    const rig = memoryStorage();
    const store = new SettingsStore();
    rig.storage.register(store.asSaveDocument());
    store.set({ ...FACTORY, soundVolume: 40, coinsPerPlay: 2 });
    await rig.storage.saveNow(FILES.settings);
    const csv = rig.kv.dump(FILES.settings) ?? '';
    expect(parseSettingsCsv(csv)).toEqual({
      soundVolume: 40,
      coinsPerPlay: 2,
      initialHearts: 3,
    });
  });

  it('초기 상태는 공장값이다', () => {
    expect(new SettingsStore().machine).toEqual(FACTORY);
  });
});
