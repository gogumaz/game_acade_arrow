// WU-06 T10 — SAV-707 손상 복구 · §12.3 BACKUP RESTORED / FACTORY DATA LOADED (계획 P-1 · §4)
//
// 판정 대상은 `Storage.init()`의 복구 4분기다.
//   본 파일 유효 → 'ok' · 본 무효 + bak 유효 → 'backup_restored'(+ 본 파일 재기록)
//   둘 다 무효 → 'factory'(공장값 재기록) · 둘 다 없음 → 'missing'(아무것도 쓰지 않는다)
//
// 문서 4종(settings·params·stats·ranking)의 `validate()` 실체도 여기서 판정한다 — 손상을
// **문서가** 판정하지 못하면 관용적 파서가 반쯤 깨진 파일을 조용히 "정상"으로 만든다.

import { describe, expect, it } from 'vitest';
import { FACTORY_ADMIN_PARAMS, writeField } from '../../src/core/adminParams';
import { StatsModel, type WallClock } from '../../src/core/stats';
import { isValidParamsCsv, paramsToCsv, ParamsStore } from '../../src/game/admin/paramsDoc';
import {
  isValidRankingCsv,
  rankingToCsv,
  RankingStore,
  RANKING_HEADER,
} from '../../src/game/rankingStore';
import { SettingsStore } from '../../src/game/settingsDoc';
import { isValidStatsCsv, statsDocToCsv, statsSaveDocument } from '../../src/game/statsDoc';
import { FILES } from '../../src/persist/csv';
import { BAK_SUFFIX } from '../../src/persist/storage';
import { CounterDoc, memoryStorage, MemoryKeyValue } from './harness';

const wall: WallClock = {
  nowMs: () => Date.parse('2026-08-17T00:00:00.000Z'),
  localDate: () => '2026-08-17',
  nowIso: () => '2026-08-17T00:00:00.000Z',
};

function goodRanking(score = 5000): string {
  return rankingToCsv([
    {
      initials: 'ABC',
      score,
      board: 3,
      maxComboCentis: 210,
      continues: 0,
      registeredAt: '2026-08-17T00:00:00.000Z',
      seq: 1,
    },
  ]);
}

describe('SAV-707 — 복구 4분기 (CounterDoc 최소 문서)', () => {
  it('본 파일이 유효하면 그대로 적용한다 (ok)', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, CounterDoc.csv(7));
    const doc = new CounterDoc();
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.init();
    expect(doc.value).toBe(7);
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({ outcome: 'ok' });
  });

  it('본 파일이 손상이면 `.bak`을 되살리고 **본 파일을 다시 쓴다** (backup_restored)', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, '깨진 내용');
    rig.kv.put(`${FILES.settings}${BAK_SUFFIX}`, CounterDoc.csv(42));
    const doc = new CounterDoc();
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.init();
    expect(doc.value).toBe(42);
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({
      outcome: 'backup_restored',
      rewriteFailed: false,
    });
    // 다음 부팅이 또 손상 파일을 만나지 않도록 본 파일이 갱신됐다
    expect(rig.kv.dump(FILES.settings)).toBe(CounterDoc.csv(42));
  });

  it('둘 다 손상이면 공장값으로 시작하고 본 파일을 재기록한다 (factory)', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, '깨짐');
    rig.kv.put(`${FILES.settings}${BAK_SUFFIX}`, '이것도 깨짐');
    const doc = new CounterDoc();
    doc.value = 3; // 메모리 공장값
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.init();
    expect(doc.applied).toEqual([]); // 손상 CSV는 **적용되지 않는다**
    expect(doc.value).toBe(3);
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({
      outcome: 'factory',
      rewriteFailed: false,
    });
    expect(rig.kv.dump(FILES.settings)).toBe(CounterDoc.csv(3));
  });

  it('둘 다 없으면 아무것도 쓰지 않는다 (missing — 최초 부팅)', async () => {
    const rig = memoryStorage();
    const doc = new CounterDoc();
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.init();
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({ outcome: 'missing' });
    expect(rig.kv.keys()).toEqual([]);
  });

  it('공장값 재기록까지 실패하면 `rewriteFailed`가 선다 (§12.4 ⑤ 조건)', async () => {
    const rig = memoryStorage({ failWrites: { on: false } });
    rig.kv.put(FILES.settings, '깨짐');
    const doc = new CounterDoc();
    rig.storage.register(doc.asSaveDocument());
    // 읽기는 되고 쓰기만 죽은 상태를 만든다
    const failing = memoryStorage({ kv: rig.kv, failWrites: { on: true } });
    const doc2 = new CounterDoc();
    failing.storage.register(doc2.asSaveDocument());
    await failing.storage.init();
    expect(failing.storage.bootOutcomeOf(FILES.settings)).toMatchObject({
      outcome: 'factory',
      rewriteFailed: true,
    });
  });

  it('`validate()`가 없는 문서는 WU-01처럼 항상 적용된다 (하위 호환)', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, '아무 문자열');
    const seen: string[] = [];
    rig.storage.register({
      file: FILES.settings,
      serialize: () => 'x',
      apply: (csv) => seen.push(csv),
    });
    await rig.storage.init();
    expect(seen).toEqual(['아무 문자열']);
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({ outcome: 'ok' });
  });

  it('`validate()`가 던져도 손상으로 본다 (부팅이 멈추지 않는다)', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, 'x');
    rig.storage.register({
      file: FILES.settings,
      serialize: () => CounterDoc.csv(1),
      apply: () => undefined,
      validate: () => {
        throw new Error('validate boom');
      },
    });
    await rig.storage.init();
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({ outcome: 'factory' });
  });
});

describe('SAV-707 — 문서 4종의 `validate()` 실체', () => {
  it('settings — v1 머리행이 없으면 무효다', () => {
    expect(SettingsStore.validate(new SettingsStore().serialize())).toBe(true);
    expect(SettingsStore.validate('schema,foo\n1,2')).toBe(false);
    expect(SettingsStore.validate('')).toBe(false);
  });

  it('params — 헤더·버전 행·손상 행 0을 모두 본다', () => {
    expect(isValidParamsCsv(paramsToCsv(FACTORY_ADMIN_PARAMS))).toBe(true);
    // 헤더 없음
    expect(isValidParamsCsv('1,PARAM_DATA_VERSION,1')).toBe(false);
    // 버전 행 없음
    expect(isValidParamsCsv('schema,key,value\n1,core.sessionTimeSec,120')).toBe(false);
    // 손상 행 1개 (칸 부족)
    expect(isValidParamsCsv(`${paramsToCsv(FACTORY_ADMIN_PARAMS)}\n1,broken`)).toBe(false);
    expect(isValidParamsCsv('!!!,,,\n@@@')).toBe(false);
  });

  it('params — 버전 불일치는 **손상이 아니다** (날짜 백업 경로로 간다)', () => {
    const csv = paramsToCsv(FACTORY_ADMIN_PARAMS).replace(
      'PARAM_DATA_VERSION,1',
      'PARAM_DATA_VERSION,9'
    );
    expect(isValidParamsCsv(csv)).toBe(true);
  });

  it('stats — 머리행 + `#meters` + `#session`이 있어야 유효하다', () => {
    const model = new StatsModel({ wall });
    const good = statsDocToCsv(model.toSnapshot());
    expect(isValidStatsCsv(good)).toBe(true);
    expect(isValidStatsCsv('schema,date\n1,2026-08-17')).toBe(false);
    expect(isValidStatsCsv(good.split('#session')[0])).toBe(false);
  });

  it('ranking — 헤더 일치 + 파싱 실패 행 0. 빈 랭킹은 유효하다', () => {
    expect(isValidRankingCsv(goodRanking())).toBe(true);
    expect(isValidRankingCsv(RANKING_HEADER)).toBe(true);
    expect(isValidRankingCsv('schema,initials\n1,AAA')).toBe(false);
    expect(isValidRankingCsv(`${goodRanking()}\n1,XYZ,망가짐`)).toBe(false);
  });
});

describe('SAV-707 — 4문서 × 손상 시나리오 (실제 문서 클래스)', () => {
  async function boot(kv: MemoryKeyValue) {
    const rig = memoryStorage({ kv });
    const ranking = new RankingStore();
    const stats = new StatsModel({ wall });
    const params = new ParamsStore();
    const settings = new SettingsStore();
    rig.storage.register(ranking.asSaveDocument());
    rig.storage.register(statsSaveDocument(stats));
    rig.storage.register(params.asSaveDocument());
    rig.storage.register(settings.asSaveDocument());
    await rig.storage.init();
    return { rig, ranking, stats, params, settings };
  }

  it('랭킹 본 파일이 손상이면 `.bak`의 TOP 10이 되살아난다 (SAV-707)', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.ranking, `${RANKING_HEADER}\n1,ABC,깨진점수,3,210,0,2026-08-17,1`);
    kv.put(`${FILES.ranking}${BAK_SUFFIX}`, goodRanking(7777));
    const { rig, ranking } = await boot(kv);
    expect(ranking.top()).toHaveLength(1);
    expect(ranking.top()[0].score).toBe(7777);
    expect(rig.storage.bootOutcomeOf(FILES.ranking)).toMatchObject({
      outcome: 'backup_restored',
    });
  });

  it('랭킹 둘 다 손상이면 **빈 랭킹**으로 시작한다 (SAV-707)', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.ranking, '망가짐');
    kv.put(`${FILES.ranking}${BAK_SUFFIX}`, '이것도');
    const { rig, ranking } = await boot(kv);
    expect(ranking.top()).toEqual([]);
    expect(rig.storage.bootOutcomeOf(FILES.ranking)).toMatchObject({ outcome: 'factory' });
    expect(kv.dump(FILES.ranking)).toBe(RANKING_HEADER);
  });

  it('params 본 파일이 손상이면 `.bak`의 편집값이 되살아난다', async () => {
    const kv = new MemoryKeyValue();
    kv.put(FILES.params, 'schema,key,value\n1,망가진행');
    kv.put(
      `${FILES.params}${BAK_SUFFIX}`,
      paramsToCsv(writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 95))
    );
    const { rig, params } = await boot(kv);
    expect(params.live.core.sessionTimeSec).toBe(95);
    expect(rig.storage.bootOutcomeOf(FILES.params)).toMatchObject({ outcome: 'backup_restored' });
  });

  it('stats 본 파일이 손상이면 `.bak`의 매출 카운터가 되살아난다', async () => {
    const kv = new MemoryKeyValue();
    const model = new StatsModel({ wall });
    for (let i = 0; i < 9; i += 1) model.noteCoinPulse(1);
    kv.put(FILES.stats, 'schema,date\n1,2026-08-17'); // 섹션이 통째로 잘린 파일
    kv.put(`${FILES.stats}${BAK_SUFFIX}`, statsDocToCsv(model.toSnapshot()));
    const { rig, stats } = await boot(kv);
    expect(stats.toSnapshot().coinPulseTotal).toBe(9);
    expect(rig.storage.bootOutcomeOf(FILES.stats)).toMatchObject({ outcome: 'backup_restored' });
  });

  it('settings 본 파일이 손상이면 `.bak`의 기기 설정이 되살아난다', async () => {
    const kv = new MemoryKeyValue();
    const store = new SettingsStore();
    store.set({ ...FACTORY_ADMIN_PARAMS.machine, coinsPerPlay: 4 });
    kv.put(FILES.settings, 'schema,foo\n1,2');
    kv.put(`${FILES.settings}${BAK_SUFFIX}`, store.serialize());
    const { rig, settings } = await boot(kv);
    expect(settings.machine.coinsPerPlay).toBe(4);
    expect(rig.storage.bootOutcomeOf(FILES.settings)).toMatchObject({
      outcome: 'backup_restored',
    });
  });

  it('4문서 전부 정상이면 경고가 하나도 없다', async () => {
    const kv = new MemoryKeyValue();
    const { rig } = await boot(new MemoryKeyValue());
    await rig.storage.saveAll();
    const second = await boot(rig.kv);
    expect(second.rig.storage.bootReport.map((e) => e.outcome)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(kv.keys()).toEqual([]);
  });
});

describe('§12.3 — localStorage 백엔드도 같은 규칙을 쓴다 (P-15)', () => {
  it('`<파일>.bak` 키를 같은 절차로 읽는다', async () => {
    const rig = memoryStorage();
    rig.kv.put(FILES.settings, '깨짐');
    rig.kv.put(`${FILES.settings}${BAK_SUFFIX}`, CounterDoc.csv(11));
    const doc = new CounterDoc();
    rig.storage.register(doc.asSaveDocument());
    await rig.storage.init();
    expect(rig.storage.backendKind).toBe('localStorage');
    expect(doc.value).toBe(11);
    expect(rig.kv.keys()).toEqual([FILES.settings, `${FILES.settings}${BAK_SUFFIX}`].sort());
  });
});
