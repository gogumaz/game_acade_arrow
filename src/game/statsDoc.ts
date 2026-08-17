// `stats.csv` 코덱 + `SaveDocument` (§12.1 — 작업 계획 §3.3 · §4)
//
// **WU-01 코덱을 건드리지 않는다.** `parseStatsCsv()`는 `lines[0]`(헤더)·`lines[1]`(본행)만
// 읽고 뒤를 무시하고, `statsToCsv()`는 정확히 2줄을 만든다. 그래서 3줄째부터 섹션을 덧붙여도
// WU-01의 인코더·파서·테스트 27건은 그대로 통과한다 (작업 계획 §4.1 A).
//
// 파일 하나에 다 넣는 이유: §12.1이 `stats.csv`의 내용을 "유료·이벤트 통계, 코인 미터,
// 기준 날짜, 도달 보드 히스토그램, 점수 분포 200칸 링 버퍼"로 이미 확정했다. 파일을 새로
// 만들면 `csv.test.ts`가 7종 완전 일치로 고정한 `FILES`가 깨진다.
//
// 형식
//   1줄  WU-01 `STATS_HEADER`            (schema,date,지표 9종)
//   2줄  WU-01 본행
//   #meters      코인·크레딧 영구 미터 5종 (admin §7.2)
//   #session     점유 시간 · 롤오버 상태
//   #histogram   도달 보드 분포 (행 1개 = 보드 1개)
//   #scores      점수 링 버퍼 (행 1개 = 표본 1개, 오래된 것부터 최대 200)
//   #run         크래시 마커 (§10.6). 마커가 없으면 **섹션 자체가 없다**
//
// 손상 관용: 알 수 없는 섹션은 무시하고, 손상된 데이터 행은 **그 행만** 버린다.
// 이 파서는 절대 throw 하지 않는다 (`rankingStore.parseRankingCsv` 선례).

import type { BoardHistogramEntry, RunMarker, StatsModel, StatsSnapshot } from '../core/stats';
import {
  FILES,
  SCHEMA_VERSION,
  STATS_HEADER,
  parseStatsCsv,
  sanitizeField,
  statsToCsv,
  type StatsRecord,
} from '../persist/csv';
import type { SaveDocument } from '../persist/storage';

/** 섹션 표식 — 첫 칸이 `#`로 시작하는 줄. 본행(첫 칸 = 스키마 번호)과 충돌하지 않는다 */
export const STATS_SECTIONS = ['#meters', '#session', '#histogram', '#scores', '#run'] as const;

export type StatsSection = (typeof STATS_SECTIONS)[number];

export const METERS_HEADER =
  '#meters,coinPulseTotal,coinPulseToday,paidCreditGranted,paidCreditUsed,serviceCreditGranted';
export const SESSION_HEADER =
  '#session,occupancyMsTotal,occupancySessions,lastEpochMs,lastRolloverDate,rolloverRepeats,clockChangedCount';
export const HISTOGRAM_HEADER = '#histogram,board,count';
export const SCORES_HEADER = '#scores,score';
export const RUN_HEADER = '#run,source,amount,startedIso';

/** 저장 파일이 하나도 없을 때의 기준값 */
export function emptyStatsSnapshot(): StatsSnapshot {
  return {
    date: '',
    paidPlayTotal: 0,
    paidPlayToday: 0,
    paidContinue: 0,
    eventPlayTotal: 0,
    eventPlayToday: 0,
    eventContinue: 0,
    eventGrantedTotal: 0,
    eventUsedTotal: 0,
    eventUsedToday: 0,
    coinPulseTotal: 0,
    coinPulseToday: 0,
    paidCreditGranted: 0,
    paidCreditUsed: 0,
    serviceCreditGranted: 0,
    occupancyMsTotal: 0,
    occupancySessions: 0,
    lastEpochMs: 0,
    lastRolloverDate: '',
    rolloverRepeats: 0,
    clockChangedCount: 0,
    histogram: [],
    scores: [],
    marker: null,
  };
}

function toNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 칸이 모자라면 빈 문자열 — `c[i] ?? ''`는 no-unnecessary-condition 오류다 (계획 §4.3) */
function col(cols: readonly string[], i: number): string {
  return cols.length > i ? cols[i] : '';
}

function num(cols: readonly string[], i: number): number {
  return toNumber(col(cols, i)) ?? 0;
}

export function statsDocToCsv(s: StatsSnapshot): string {
  const base: StatsRecord = {
    date: s.date,
    paidPlayTotal: s.paidPlayTotal,
    paidPlayToday: s.paidPlayToday,
    paidContinue: s.paidContinue,
    eventPlayTotal: s.eventPlayTotal,
    eventPlayToday: s.eventPlayToday,
    eventContinue: s.eventContinue,
    eventGrantedTotal: s.eventGrantedTotal,
    eventUsedTotal: s.eventUsedTotal,
    eventUsedToday: s.eventUsedToday,
  };
  const lines: string[] = [statsToCsv(base)];

  lines.push(METERS_HEADER);
  lines.push(
    [
      SCHEMA_VERSION,
      s.coinPulseTotal,
      s.coinPulseToday,
      s.paidCreditGranted,
      s.paidCreditUsed,
      s.serviceCreditGranted,
    ].join(',')
  );

  lines.push(SESSION_HEADER);
  lines.push(
    [
      SCHEMA_VERSION,
      s.occupancyMsTotal,
      s.occupancySessions,
      s.lastEpochMs,
      sanitizeField(s.lastRolloverDate),
      s.rolloverRepeats,
      s.clockChangedCount,
    ].join(',')
  );

  if (s.histogram.length > 0) {
    lines.push(HISTOGRAM_HEADER);
    for (const e of s.histogram) lines.push([SCHEMA_VERSION, e.board, e.count].join(','));
  }

  if (s.scores.length > 0) {
    lines.push(SCORES_HEADER);
    for (const score of s.scores) lines.push([SCHEMA_VERSION, score].join(','));
  }

  const marker = s.marker;
  if (marker !== null) {
    lines.push(RUN_HEADER);
    lines.push(
      [
        SCHEMA_VERSION,
        sanitizeField(marker.source),
        marker.amount,
        sanitizeField(marker.startedIso),
      ].join(',')
    );
  }

  return lines.join('\n');
}

export function parseStatsDocCsv(csv: string): StatsSnapshot {
  const snap = { ...emptyStatsSnapshot() } as {
    -readonly [K in keyof StatsSnapshot]: StatsSnapshot[K];
  };

  const base = parseStatsCsv(csv);
  if (base !== null) {
    snap.date = base.date;
    snap.paidPlayTotal = base.paidPlayTotal;
    snap.paidPlayToday = base.paidPlayToday;
    snap.paidContinue = base.paidContinue;
    snap.eventPlayTotal = base.eventPlayTotal;
    snap.eventPlayToday = base.eventPlayToday;
    snap.eventContinue = base.eventContinue;
    snap.eventGrantedTotal = base.eventGrantedTotal;
    snap.eventUsedTotal = base.eventUsedTotal;
    snap.eventUsedToday = base.eventUsedToday;
  }

  const histogram: BoardHistogramEntry[] = [];
  const scores: number[] = [];
  let marker: RunMarker | null = null;
  let section = '';

  const lines = csv.split(/\r?\n/);
  for (let i = 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      section = line.split(',')[0];
      continue;
    }
    const c = line.split(',');
    switch (section) {
      case '#meters':
        snap.coinPulseTotal = num(c, 1);
        snap.coinPulseToday = num(c, 2);
        snap.paidCreditGranted = num(c, 3);
        snap.paidCreditUsed = num(c, 4);
        snap.serviceCreditGranted = num(c, 5);
        break;
      case '#session':
        snap.occupancyMsTotal = num(c, 1);
        snap.occupancySessions = num(c, 2);
        snap.lastEpochMs = num(c, 3);
        snap.lastRolloverDate = col(c, 4);
        snap.rolloverRepeats = num(c, 5);
        snap.clockChangedCount = num(c, 6);
        break;
      case '#histogram': {
        const board = toNumber(col(c, 1));
        const count = toNumber(col(c, 2));
        if (board !== null && count !== null) histogram.push({ board, count });
        break;
      }
      case '#scores': {
        const score = toNumber(col(c, 1));
        if (score !== null) scores.push(score);
        break;
      }
      case '#run': {
        const source = col(c, 1);
        const amount = toNumber(col(c, 2));
        const startedIso = col(c, 3);
        if ((source === 'paid' || source === 'event') && amount !== null && startedIso !== '') {
          marker = { source, amount, startedIso };
        }
        break;
      }
      default:
        // 알 수 없는 섹션(또는 섹션 밖의 잔여 행)은 통째로 무시한다
        break;
    }
  }

  snap.histogram = histogram;
  snap.scores = scores;
  snap.marker = marker;
  return snap;
}

/**
 * WU-06 P-1 · §4 — `stats.csv`를 신뢰할 수 있는가.
 *
 * 기준: **v1 머리행이 읽히고 `#meters`·`#session` 섹션 헤더가 살아 있는가.** 이 파서는
 * 알 수 없는 섹션·손상 행을 통째로 무시하므로(§12.1), 파일이 반쯤 잘려 코인 미터·점유
 * 시간이 통째로 0이 돼도 조용히 "정상"으로 보인다. 매출 카운터가 0으로 되살아나는 것이
 * 이 유닛이 막아야 할 손실이라 두 섹션을 필수로 본다 (SAV-701).
 *
 * `#histogram`·`#scores`·`#run`은 **없는 것이 정상**이다(표본 0 · 마커 없음).
 */
export function isValidStatsCsv(csv: string): boolean {
  if (parseStatsCsv(csv) === null) return false;
  const lines = csv.split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== STATS_HEADER) return false;
  return lines.includes(METERS_HEADER) && lines.includes(SESSION_HEADER);
}

/** WU-01 `Storage.register()`에 그대로 등록한다 */
export function statsSaveDocument(model: StatsModel): SaveDocument {
  return {
    file: FILES.stats,
    serialize: () => statsDocToCsv(model.toSnapshot()),
    apply: (csv) => {
      model.loadSnapshot(parseStatsDocCsv(csv));
    },
    validate: (csv) => isValidStatsCsv(csv),
  };
}
