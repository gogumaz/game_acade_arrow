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
  STATS_HEADER,
  STAT_KEYS,
  SETTINGS_HEADER,
  type CreditLogRecord,
  type SettingsRecord,
  type StatsRecord,
  creditLogLine,
  parseCreditLogCsv,
  parseCreditLogLine,
  parseSettingsCsv,
  parseStatsCsv,
  sanitizeField,
  settingsToCsv,
  statsToCsv,
} from '../../src/persist/csv';

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

// ── 5-1 · 5-3 ─────────────────────────────────────────────────────────────

describe('5-1 저장 파일명 상수 (§12.1)', () => {
  it('7종이 §12.1 표 순서대로 한곳에 정의된다', () => {
    expect(Object.values(FILES)).toEqual([
      'settings.csv',
      'params.csv',
      'stats.csv',
      'ranking.csv',
      'credit_log.csv',
      'audit_log.csv',
      'play_log.csv',
    ]);
  });

  it('params·ranking 파일명 상수가 예약되어 있다 (§12.1)', () => {
    expect(FILES.params).toBe('params.csv');
    expect(FILES.ranking).toBe('ranking.csv');
  });

  it('params·ranking은 코덱·추가 전용 목록 어디에도 없다 — 스키마는 WU-05·WU-06 소관', () => {
    // 파일명만 예약한 상태를 고정한다. 코덱이 생기면 그 유닛이 이 테스트를 의도적으로 바꾼다.
    for (const file of [FILES.params, FILES.ranking]) {
      expect(CODEC_FILES).not.toContain(file);
      expect(APPEND_ONLY_FILES).not.toContain(file);
    }
  });
});

describe('5-3 컬럼 미확정 파일은 파일명·추가 전용 취급만', () => {
  it('audit_log·play_log는 추가 전용 목록에 있고 코덱 목록에는 없다', () => {
    expect(APPEND_ONLY_FILES).toContain(FILES.auditLog);
    expect(APPEND_ONLY_FILES).toContain(FILES.playLog);
    expect(CODEC_FILES).not.toContain(FILES.auditLog);
    expect(CODEC_FILES).not.toContain(FILES.playLog);
  });

  it('코덱이 있는 파일은 컬럼이 문서로 확정된 3종뿐이다', () => {
    expect([...CODEC_FILES]).toEqual([FILES.settings, FILES.stats, FILES.creditLog]);
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

// ── 5-4 형식 규칙 ─────────────────────────────────────────────────────────

describe('5-4 CSV 형식 규칙 (§9.1)', () => {
  it('값에 쉼표를 쓰지 않는다 — 필드의 쉼표는 공백으로 바뀐다', () => {
    const csv = statsToCsv({ ...STATS, date: '2026,08,15' });
    expect(csv.split('\n')[1].split(',')).toHaveLength(2 + STAT_KEYS.length);
    expect(parseStatsCsv(csv)?.date).toBe('2026 08 15');
  });

  it('sanitizeField가 쉼표·개행을 공백으로 바꾼다', () => {
    expect(sanitizeField('a,b\nc\r\nd')).toBe('a b c  d');
  });

  it('모든 코덱 출력이 스키마 버전 컬럼으로 시작하고 개행은 LF만 쓴다', () => {
    for (const csv of [settingsToCsv(SETTINGS), statsToCsv(STATS)]) {
      expect(csv.split('\n')[0].split(',')[0]).toBe('schema');
      expect(csv.split('\n')[1].split(',')[0]).toBe(String(SCHEMA_VERSION));
      // LF 고정 규칙은 삭제된 stages 왕복 테스트가 유일하게 지키고 있었다 (Windows CRLF 혼입 방지)
      expect(csv).not.toContain('\r');
    }
  });

  it('CRLF로 저장된 CSV도 읽는다', () => {
    const csv = settingsToCsv(SETTINGS).replace(/\n/g, '\r\n');
    expect(parseSettingsCsv(csv)).toEqual(SETTINGS);
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
    reason: '',
  };

  // WU-04 Q-1 — §10.2 "원복 사유를 남긴다"를 지키려고 6번째 `reason` 칸을 더했다
  it('헤더가 §9.1 확정 컬럼과 같다', () => {
    expect(CREDIT_LOG_HEADER).toBe('timestamp,action,source,paidBalance,eventBalance,reason');
  });

  it('액션 6종이 §9.1과 같다', () => {
    expect([...CREDIT_LOG_ACTIONS]).toEqual([
      'coin_insert',
      'pay',
      'refund',
      'event_grant',
      'event_clear',
      'service_grant',
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
