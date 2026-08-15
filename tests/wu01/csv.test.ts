// WU-01 T5 — CSV 스키마 (§9.1 · §9.3 · §7.7 · SAV-005 · SAV-006)
// csv.ts는 core 싱글턴을 모르는 레코드 코덱이므로 도메인 모듈 없이 왕복을 판정한다.

import { describe, expect, it } from 'vitest';
import {
  APPEND_ONLY_FILES,
  CODEC_FILES,
  CREDIT_LOG_ACTIONS,
  CREDIT_LOG_HEADER,
  FILES,
  SCHEMA_VERSION,
  STAGES_HEADER,
  STATS_HEADER,
  STAT_KEYS,
  SETTINGS_HEADER,
  type CreditLogRecord,
  type SettingsRecord,
  type StageRecord,
  type StatsRecord,
  creditLogLine,
  parseCreditLogCsv,
  parseCreditLogLine,
  parseSettingsCsv,
  parseStagesCsv,
  parseStatsCsv,
  sanitizeField,
  settingsToCsv,
  stagesToCsv,
  statsToCsv,
} from '../../src/persist/csv';

const DATA_VERSION = 4; // §6.1 — 현재 공장 데이터 버전 v4

const SETTINGS: SettingsRecord = { soundVolume: 80, coinsPerPlay: 1, initialHearts: 3 };

const STATS: StatsRecord = {
  date: '2026-08-15',
  paidPlayTotal: 12,
  paidPlayToday: 3,
  paidContinue: 5,
  eventPlayTotal: 7,
  eventPlayToday: 2,
  eventContinue: 1,
  eventGrantedTotal: 9,
  eventUsedTotal: 4,
  eventUsedToday: 2,
};

function stage(overrides: Partial<StageRecord> = {}): StageRecord {
  return {
    name: 'STAGE 1',
    soloGoal: 8,
    coopGoal: 15,
    timeSec: 20,
    startCamera: 0,
    scoreMultiplier: 1,
    clearBonus: 1000,
    hurryEvery: 0,
    initialMap: [],
    ...overrides,
  };
}

// ── 5-1 · 5-3 ─────────────────────────────────────────────────────────────

describe('5-1 저장 파일명 상수 (§9.1)', () => {
  it('6종이 한곳에 정의된다', () => {
    expect(Object.values(FILES)).toEqual([
      'settings.csv',
      'stages.csv',
      'stats.csv',
      'credit_log.csv',
      'audit_log.csv',
      'play_log.csv',
    ]);
  });
});

describe('5-3 컬럼 미확정 2종은 파일명·추가 전용 취급만 (작업 계획 D-4)', () => {
  it('audit_log·play_log는 추가 전용 목록에 있고 코덱 목록에는 없다', () => {
    expect(APPEND_ONLY_FILES).toContain(FILES.auditLog);
    expect(APPEND_ONLY_FILES).toContain(FILES.playLog);
    expect(CODEC_FILES).not.toContain(FILES.auditLog);
    expect(CODEC_FILES).not.toContain(FILES.playLog);
  });

  it('코덱이 있는 파일은 컬럼이 문서로 확정된 4종뿐이다', () => {
    expect([...CODEC_FILES]).toEqual([FILES.settings, FILES.stats, FILES.stages, FILES.creditLog]);
  });
});

// ── 5-2 왕복 무손실 ───────────────────────────────────────────────────────

describe('5-2 settings 왕복 (§9.1)', () => {
  it('왕복이 무손실이다', () => {
    expect(parseSettingsCsv(settingsToCsv(SETTINGS))).toEqual(SETTINGS);
  });

  it('헤더와 스키마 버전 컬럼을 포함한다', () => {
    const csv = settingsToCsv(SETTINGS);
    expect(csv.split('\n')[0]).toBe(SETTINGS_HEADER);
    expect(csv.split('\n')[1].split(',')[0]).toBe(String(SCHEMA_VERSION));
  });

  it('범위를 벗어난 값은 조인다', () => {
    const csv = settingsToCsv({ soundVolume: 500, coinsPerPlay: 0, initialHearts: 99 });
    expect(parseSettingsCsv(csv)).toEqual({
      soundVolume: 100,
      coinsPerPlay: 1,
      initialHearts: 9,
    });
  });

  it.each(['', 'schema,soundVolume,coinsPerPlay,initialHearts', '1,80,1', '1,x,y,z'])(
    '손상된 입력 %o은 null이다',
    (csv) => {
      expect(parseSettingsCsv(csv)).toBeNull();
    }
  );
});

describe('5-2 stats 왕복 (§9.1 · §7.7)', () => {
  it('9종 + 기준 날짜 왕복이 무손실이다', () => {
    expect(parseStatsCsv(statsToCsv(STATS))).toEqual(STATS);
  });

  it('통계 키가 §7.7 지표 9종이다', () => {
    expect(STAT_KEYS).toHaveLength(9);
    expect(STATS_HEADER).toBe(`schema,date,${STAT_KEYS.join(',')}`);
  });

  it('ISO 8601 날짜를 그대로 보존한다', () => {
    const parsed = parseStatsCsv(statsToCsv(STATS));
    expect(parsed?.date).toBe('2026-08-15');
  });

  it('컬럼 수가 모자라면 null이다', () => {
    expect(parseStatsCsv('schema,date\n1,2026-08-15')).toBeNull();
  });

  it('손상된 수치 칸은 0으로 채운다', () => {
    const csv = `${STATS_HEADER}\n1,2026-08-15,xx,3,5,7,2,1,9,4,2`;
    expect(parseStatsCsv(csv)?.paidPlayTotal).toBe(0);
    expect(parseStatsCsv(csv)?.paidPlayToday).toBe(3);
  });
});

describe('5-2 stages 왕복 (§9.1 · §6.1 · §8.5)', () => {
  const stages: StageRecord[] = [
    stage(),
    stage({ name: 'STAGE 2', soloGoal: 10, scoreMultiplier: 1.1, initialMap: ['.#*..##.'] }),
    stage({
      name: 'STAGE 6',
      soloGoal: 18,
      hurryEvery: 6,
      startCamera: 4,
      initialMap: ['####..##', '##..####'],
    }),
  ];

  it('수치·초기 맵·잠식 주기 왕복이 무손실이다', () => {
    const csv = stagesToCsv(stages, DATA_VERSION);
    const result = parseStagesCsv(csv, { dataVersion: DATA_VERSION, stageCount: stages.length });
    expect(result.discarded).toBe(false);
    expect(result.skipped).toBe(0);
    expect(result.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(result.entries.map((e) => e.stage)).toEqual(stages);
  });

  it('헤더에 dataVersion 컬럼이 있다', () => {
    const csv = stagesToCsv(stages, DATA_VERSION);
    expect(csv.split('\n')[0]).toBe(STAGES_HEADER);
    expect(STAGES_HEADER).toContain('dataVersion');
    expect(csv.split('\n')[1].split(',')[1]).toBe(String(DATA_VERSION));
  });

  it('개행은 항상 LF로 만든다', () => {
    expect(stagesToCsv(stages, DATA_VERSION)).not.toContain('\r');
  });
});

// ── 5-4 형식 규칙 ─────────────────────────────────────────────────────────

describe('5-4 CSV 형식 규칙 (§9.1)', () => {
  it('값에 쉼표를 쓰지 않는다 — 이름의 쉼표는 공백으로 바뀐다', () => {
    const csv = stagesToCsv([stage({ name: 'A,B,C' })], DATA_VERSION);
    expect(csv.split('\n')[1].split(',')).toHaveLength(12);
    const result = parseStagesCsv(csv, { dataVersion: DATA_VERSION });
    expect(result.entries[0].stage.name).toBe('A B C');
  });

  it('sanitizeField가 쉼표·개행을 공백으로 바꾼다', () => {
    expect(sanitizeField('a,b\nc\r\nd')).toBe('a b c  d');
  });

  it('모든 코덱 출력이 스키마 버전 컬럼으로 시작한다', () => {
    for (const csv of [
      settingsToCsv(SETTINGS),
      statsToCsv(STATS),
      stagesToCsv([stage()], DATA_VERSION),
    ]) {
      expect(csv.split('\n')[0].split(',')[0]).toBe('schema');
      expect(csv.split('\n')[1].split(',')[0]).toBe(String(SCHEMA_VERSION));
    }
  });

  it('CRLF로 저장된 CSV도 읽는다', () => {
    const csv = settingsToCsv(SETTINGS).replace(/\n/g, '\r\n');
    expect(parseSettingsCsv(csv)).toEqual(SETTINGS);
  });
});

// ── 5-5 손상 행 skip ──────────────────────────────────────────────────────

describe('5-5 손상된 스테이지 행 건너뛰기 (SAV-005)', () => {
  const good = stagesToCsv([stage({ name: 'OK-0' }), stage({ name: 'OK-1' })], DATA_VERSION);

  it.each([
    ['컬럼 부족', `1,${DATA_VERSION},2,BAD`],
    ['인덱스 비수치', `1,${DATA_VERSION},x,BAD,8,15,20,0,1,1000,0,`],
    ['음수 인덱스', `1,${DATA_VERSION},-1,BAD,8,15,20,0,1,1000,0,`],
    ['수치 손상', `1,${DATA_VERSION},2,BAD,eight,15,20,0,1,1000,0,`],
    ['카메라 허용값 밖', `1,${DATA_VERSION},2,BAD,8,15,20,7,1,1000,0,`],
    ['맵 문자 오류', `1,${DATA_VERSION},2,BAD,8,15,20,0,1,1000,0,XYZQ`],
    ['맵 폭 초과', `1,${DATA_VERSION},2,BAD,8,15,20,0,1,1000,0,#########`],
  ])('%s 행은 건너뛰고 나머지가 반영된다', (_label, badRow) => {
    const result = parseStagesCsv(`${good}\n${badRow}`, { dataVersion: DATA_VERSION });
    expect(result.discarded).toBe(false);
    expect(result.skipped).toBe(1);
    expect(result.entries.map((e) => e.stage.name)).toEqual(['OK-0', 'OK-1']);
  });

  it('stageCount를 넘는 인덱스는 건너뛴다', () => {
    const csv = `${good}\n1,${DATA_VERSION},99,OVER,8,15,20,0,1,1000,0,`;
    const result = parseStagesCsv(csv, { dataVersion: DATA_VERSION, stageCount: 2 });
    expect(result.skipped).toBe(1);
    expect(result.entries).toHaveLength(2);
  });

  it('빈 줄은 손상 행으로 세지 않는다', () => {
    const result = parseStagesCsv(`${good}\n\n`, { dataVersion: DATA_VERSION });
    expect(result.skipped).toBe(0);
    expect(result.entries).toHaveLength(2);
  });
});

// ── 5-6 dataVersion 폐기 ──────────────────────────────────────────────────

describe('5-6 dataVersion 불일치 시 전량 폐기 (§9.3 · SAV-006)', () => {
  it('저장분 버전이 공장 버전과 다르면 전부 버린다', () => {
    const csv = stagesToCsv([stage(), stage({ name: 'S2' })], 3);
    const result = parseStagesCsv(csv, { dataVersion: DATA_VERSION });
    expect(result.discarded).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it('버전이 같으면 폐기하지 않는다', () => {
    const csv = stagesToCsv([stage()], DATA_VERSION);
    expect(parseStagesCsv(csv, { dataVersion: DATA_VERSION }).discarded).toBe(false);
  });

  it('한 행이라도 다른 버전이면 전량 폐기한다', () => {
    const csv = `${stagesToCsv([stage()], DATA_VERSION)}\n1,99,1,OLD,8,15,20,0,1,1000,0,`;
    const result = parseStagesCsv(csv, { dataVersion: DATA_VERSION });
    expect(result.discarded).toBe(true);
    expect(result.entries).toEqual([]);
  });
});

// ── 5-7 의존 방향 ─────────────────────────────────────────────────────────

describe('5-7 csv.ts는 core를 import 하지 않는다 (작업 계획 D-5)', () => {
  it('core 모듈 import 구문이 없다', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const nodePath = await import('node:path');
    const src = await readFile(
      nodePath.resolve(
        nodePath.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'src',
        'persist',
        'csv.ts'
      ),
      'utf8'
    );
    expect(src).not.toMatch(/from\s+'[^']*\/core\//);
    expect(src).not.toMatch(/from\s+'\.\.\/core/);
    expect(src).not.toContain("from 'phaser'");
  });
});

// ── credit_log ────────────────────────────────────────────────────────────

describe('credit_log 코덱 (§9.1 확정 컬럼)', () => {
  const rec: CreditLogRecord = {
    timestamp: '2026-08-15T09:30:00.000Z',
    action: 'coin_insert',
    source: 'paid',
    paidBalance: 3,
    eventBalance: 1,
  };

  it('헤더가 §9.1 확정 컬럼과 같다', () => {
    expect(CREDIT_LOG_HEADER).toBe('timestamp,action,source,paidBalance,eventBalance');
  });

  it('액션 5종이 §9.1과 같다', () => {
    expect([...CREDIT_LOG_ACTIONS]).toEqual([
      'coin_insert',
      'pay',
      'refund',
      'event_grant',
      'event_clear',
    ]);
  });

  it('1줄 왕복이 무손실이다', () => {
    expect(parseCreditLogLine(creditLogLine(rec))).toEqual(rec);
  });

  it('헤더 포함 CSV를 파싱하고 손상 행은 건너뛴다', () => {
    const csv = [
      CREDIT_LOG_HEADER,
      creditLogLine(rec),
      'garbage',
      creditLogLine({ ...rec, action: 'pay', paidBalance: 2 }),
      '2026-08-15T00:00:00.000Z,unknown_action,paid,1,0',
    ].join('\n');
    const rows = parseCreditLogCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.action)).toEqual(['coin_insert', 'pay']);
  });

  it('ISO 8601 타임스탬프를 보존한다', () => {
    const iso = new Date(Date.UTC(2026, 7, 15, 1, 2, 3)).toISOString();
    expect(parseCreditLogLine(creditLogLine({ ...rec, timestamp: iso }))?.timestamp).toBe(iso);
  });
});
