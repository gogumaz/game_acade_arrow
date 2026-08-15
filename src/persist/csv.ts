// CSV 직렬화·역직렬화 (§9.1 저장 파일 · §9.3 손상·버전 정책)
//
// 형식: UTF-8 · ISO 8601 날짜 · 스키마 버전 컬럼 포함 · 값에 쉼표를 쓰지 않는 단순 스키마.
// 개행은 항상 '\n'으로 명시 결합한다 (Windows CRLF 혼입 방지).
//
// **의존 방향**: 이 모듈은 `src/core/`의 어떤 모듈도 import 하지 않는다. 평범한 레코드
// 타입에 대한 인코더/디코더일 뿐이며, 도메인 싱글턴을 읽고 쓰는 일은 호출자가 한다
// (작업 계획 D-5). 덕분에 core 계층이 생기기 전에도 왕복을 단위 판정할 수 있다.

/** CSV 스키마 버전 컬럼 값 (§12.1) */
export const SCHEMA_VERSION = 1;

/**
 * §12.1 저장 파일 이름 상수.
 *
 * `params.csv`·`ranking.csv`는 **파일명만 예약한다.** 컬럼은 `GAME PARAMETERS`(§11.4)와
 * 랭킹 항목(§12.1)이 확정하며 코덱은 WU-05·WU-06이 만든다. `audit_log.csv`·`play_log.csv`도
 * 컬럼 정의가 없어 파일명과 추가 전용 취급만 등록한다. 없는 스키마를 지어내지 않는다.
 *
 * `machine.json`·`error_YYYY-MM-DD.log`는 CSV 저장 문서가 아니므로 여기 두지 않는다 (WU-06).
 */
export const FILES = {
  settings: 'settings.csv',
  params: 'params.csv',
  stats: 'stats.csv',
  ranking: 'ranking.csv',
  creditLog: 'credit_log.csv',
  auditLog: 'audit_log.csv',
  playLog: 'play_log.csv',
} as const;

export type SaveFileName = (typeof FILES)[keyof typeof FILES];

/**
 * 추가 전용(append) 파일 — 전체 덮어쓰기를 하지 않는다 (§12.1).
 * `params`·`ranking`은 전체 덮어쓰기 문서라 여기 넣지 않는다.
 */
export const APPEND_ONLY_FILES: readonly SaveFileName[] = [
  FILES.creditLog,
  FILES.auditLog,
  FILES.playLog,
];

/** 인코더/디코더가 있는 파일 — 컬럼이 문서로 확정된 3종 */
export const CODEC_FILES: readonly SaveFileName[] = [FILES.settings, FILES.stats, FILES.creditLog];

// ── 공통 헬퍼 ─────────────────────────────────────────────────────────────

/** 값에 쉼표·개행을 쓰지 않는다 (§9.1). 들어오면 공백으로 바꾼다 */
export function sanitizeField(value: string): string {
  return value.replace(/[,\r\n]/g, ' ');
}

function splitLines(csv: string): string[] {
  return csv.trim().split(/\r?\n/);
}

function toFiniteNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ── 운영자 설정 (§9.1 settings.csv) ───────────────────────────────────────

/** 사운드 볼륨 · 게임당 코인 C · 초기 하트 (§9.1) */
export interface SettingsRecord {
  /** 0~100 */
  soundVolume: number;
  /** 게임당 코인 C, 1~9 (§7.1) */
  coinsPerPlay: number;
  /** 초기 하트, 1~9 (§3.8) */
  initialHearts: number;
}

export const SETTINGS_HEADER = 'schema,soundVolume,coinsPerPlay,initialHearts';

export function settingsToCsv(rec: SettingsRecord): string {
  return [
    SETTINGS_HEADER,
    `${SCHEMA_VERSION},${rec.soundVolume},${rec.coinsPerPlay},${rec.initialHearts}`,
  ].join('\n');
}

/** 손상되었으면 null. 값은 각 범위로 조인다 */
export function parseSettingsCsv(csv: string): SettingsRecord | null {
  const lines = splitLines(csv);
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  if (cols.length < 4) return null;
  const nums = cols.slice(1, 4).map(toFiniteNumber);
  if (nums.some((n) => n === null)) return null;
  const [volume, coins, hearts] = nums as number[];
  return {
    soundVolume: clamp(volume, 0, 100),
    coinsPerPlay: clamp(coins, 1, 9),
    initialHearts: clamp(hearts, 1, 9),
  };
}

// ── 운영 통계 (§9.1 stats.csv · §7.7 집계 기준) ───────────────────────────

/** 통계 9종의 키 순서 — CSV 컬럼 순서와 같다 (§7.7) */
export const STAT_KEYS = [
  'paidPlayTotal',
  'paidPlayToday',
  'paidContinue',
  'eventPlayTotal',
  'eventPlayToday',
  'eventContinue',
  'eventGrantedTotal',
  'eventUsedTotal',
  'eventUsedToday',
] as const;

export type StatKey = (typeof STAT_KEYS)[number];

/** 통계 9종 + 기준 날짜 (§9.1 · §7.8 날짜 롤오버) */
export type StatsRecord = { [K in StatKey]: number } & {
  /** 기준 날짜 ISO 8601 (YYYY-MM-DD) */
  date: string;
};

export const STATS_HEADER = ['schema', 'date', ...STAT_KEYS].join(',');

export function statsToCsv(rec: StatsRecord): string {
  const row = [SCHEMA_VERSION, sanitizeField(rec.date), ...STAT_KEYS.map((k) => rec[k])].join(',');
  return [STATS_HEADER, row].join('\n');
}

/** 손상되었으면 null. 개별 수치가 손상된 칸은 0으로 둔다 */
export function parseStatsCsv(csv: string): StatsRecord | null {
  const lines = splitLines(csv);
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  if (cols.length < 2 + STAT_KEYS.length) return null;

  const rec = { date: cols[1] } as StatsRecord;
  STAT_KEYS.forEach((key, i) => {
    rec[key] = toFiniteNumber(cols[2 + i]) ?? 0;
  });
  return rec;
}

// ── 크레딧 사용 로그 (§9.1 credit_log.csv · 추가 전용) ────────────────────

/** §9.1 확정 액션 5종 */
export const CREDIT_LOG_ACTIONS = [
  'coin_insert',
  'pay',
  'refund',
  'event_grant',
  'event_clear',
] as const;

export type CreditLogAction = (typeof CREDIT_LOG_ACTIONS)[number];

/** §9.1 확정 컬럼: `timestamp,action,source,paidBalance,eventBalance` */
export const CREDIT_LOG_HEADER = 'timestamp,action,source,paidBalance,eventBalance';

export interface CreditLogRecord {
  /** ISO 8601 */
  timestamp: string;
  action: CreditLogAction;
  /** 결제 소스 — 'paid' | 'event' 등 (§7.5) */
  source: string;
  paidBalance: number;
  eventBalance: number;
}

export function creditLogLine(rec: CreditLogRecord): string {
  return [
    sanitizeField(rec.timestamp),
    sanitizeField(rec.action),
    sanitizeField(rec.source),
    rec.paidBalance,
    rec.eventBalance,
  ].join(',');
}

/** 손상 행이면 null */
export function parseCreditLogLine(line: string): CreditLogRecord | null {
  const c = line.split(',');
  if (c.length < 5) return null;
  if (!(CREDIT_LOG_ACTIONS as readonly string[]).includes(c[1])) return null;
  const paid = toFiniteNumber(c[3]);
  const event = toFiniteNumber(c[4]);
  if (paid === null || event === null) return null;
  return {
    timestamp: c[0],
    action: c[1] as CreditLogAction,
    source: c[2],
    paidBalance: paid,
    eventBalance: event,
  };
}

/** 헤더를 건너뛰고 손상 행은 제외한다 */
export function parseCreditLogCsv(csv: string): CreditLogRecord[] {
  const lines = splitLines(csv);
  const body = lines[0] === CREDIT_LOG_HEADER ? lines.slice(1) : lines;
  const out: CreditLogRecord[] = [];
  for (const line of body) {
    if (line.trim() === '') continue;
    const rec = parseCreditLogLine(line);
    if (rec) out.push(rec);
  }
  return out;
}
