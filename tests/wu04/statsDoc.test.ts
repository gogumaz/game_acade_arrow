// `stats.csv` 다중 섹션 코덱 (§12.1 — 작업 계획 §4)
//
// 가장 중요한 판정: **WU-01 `parseStatsCsv`가 base 행을 그대로 읽는다.** 이것이 성립해야
// "섹션 확장은 WU-01 코덱을 건드리지 않는다"(§4.1 A)가 사실이 된다.

import { describe, it, expect } from 'vitest';
import { StatsModel, type StatsSnapshot } from '../../src/core/stats';
import {
  HISTOGRAM_HEADER,
  METERS_HEADER,
  RUN_HEADER,
  SCORES_HEADER,
  SESSION_HEADER,
  STATS_SECTIONS,
  emptyStatsSnapshot,
  parseStatsDocCsv,
  statsDocToCsv,
  statsSaveDocument,
  type StatsSection,
} from '../../src/game/statsDoc';
import { FILES, STATS_HEADER, STAT_KEYS, parseStatsCsv } from '../../src/persist/csv';
import { MutableWallClock } from './harness';

function loaded(): StatsSnapshot {
  return {
    ...emptyStatsSnapshot(),
    date: '2026-08-16',
    paidPlayTotal: 12,
    paidPlayToday: 3,
    paidContinue: 1,
    eventPlayTotal: 2,
    eventPlayToday: 1,
    eventContinue: 1,
    eventGrantedTotal: 5,
    eventUsedTotal: 2,
    eventUsedToday: 1,
    coinPulseTotal: 14,
    coinPulseToday: 3,
    paidCreditGranted: 13,
    paidCreditUsed: 12,
    serviceCreditGranted: 1,
    occupancyMsTotal: 845_000,
    occupancySessions: 12,
    lastEpochMs: 1_786_000_000_000,
    lastRolloverDate: '2026-08-16',
    rolloverRepeats: 1,
    clockChangedCount: 0,
    histogram: [
      { board: 1, count: 4 },
      { board: 2, count: 7 },
    ],
    scores: [18_400, 12_250],
    marker: { source: 'paid', amount: 1, startedIso: '2026-08-16T10:00:00.000Z' },
  };
}

describe('§4.1 — WU-01 코덱과의 공존', () => {
  it('1·2줄째는 WU-01 `statsToCsv` 출력 그대로다', () => {
    const csv = statsDocToCsv(loaded());
    const lines = csv.split('\n');
    expect(lines[0]).toBe(STATS_HEADER);
    expect(lines[1].split(',')).toHaveLength(2 + STAT_KEYS.length);
  });

  it('WU-01 `parseStatsCsv`가 확장된 파일에서도 9지표를 읽는다', () => {
    const csv = statsDocToCsv(loaded());
    const rec = parseStatsCsv(csv);
    expect(rec).toMatchObject({
      date: '2026-08-16',
      paidPlayTotal: 12,
      paidPlayToday: 3,
      paidContinue: 1,
      eventUsedToday: 1,
    });
  });

  it('개행은 LF만 쓴다', () => {
    expect(statsDocToCsv(loaded())).not.toContain('\r');
  });

  it('섹션 표식 5종이 §4.2 순서와 같다', () => {
    const expected: readonly StatsSection[] = [
      '#meters',
      '#session',
      '#histogram',
      '#scores',
      '#run',
    ];
    expect([...STATS_SECTIONS]).toEqual(expected);
  });

  it('섹션 헤더가 문서 순서대로 나온다', () => {
    const lines = statsDocToCsv(loaded()).split('\n');
    const order = lines.filter((l) => l.startsWith('#'));
    expect(order).toEqual([
      METERS_HEADER,
      SESSION_HEADER,
      HISTOGRAM_HEADER,
      SCORES_HEADER,
      RUN_HEADER,
    ]);
  });

  it('모든 데이터 행의 첫 칸이 스키마 번호다 (WU-01 규약)', () => {
    for (const line of statsDocToCsv(loaded()).split('\n').slice(1)) {
      if (line.startsWith('#')) continue;
      expect(line.split(',')[0]).toBe('1');
    }
  });
});

describe('왕복 무손실', () => {
  it('전 필드가 그대로 돌아온다', () => {
    const snap = loaded();
    expect(parseStatsDocCsv(statsDocToCsv(snap))).toEqual(snap);
  });

  it('빈 스냅샷도 왕복한다', () => {
    const snap = emptyStatsSnapshot();
    expect(parseStatsDocCsv(statsDocToCsv(snap))).toEqual(snap);
  });

  it('링 버퍼 200칸이 순서 그대로 왕복한다', () => {
    const scores = Array.from({ length: 200 }, (_, i) => i * 37);
    const snap = { ...emptyStatsSnapshot(), scores };
    expect(parseStatsDocCsv(statsDocToCsv(snap)).scores).toEqual(scores);
  });

  it('마커가 없으면 `#run` 섹션 자체가 없다', () => {
    const csv = statsDocToCsv({ ...loaded(), marker: null });
    expect(csv).not.toContain('#run');
    expect(parseStatsDocCsv(csv).marker).toBeNull();
  });

  it('히스토그램·점수가 비면 그 섹션을 생략한다', () => {
    const csv = statsDocToCsv({ ...loaded(), histogram: [], scores: [] });
    expect(csv).not.toContain('#histogram');
    expect(csv).not.toContain('#scores');
  });

  it('날짜에 쉼표가 들어와도 칸이 밀리지 않는다', () => {
    const csv = statsDocToCsv({ ...loaded(), lastRolloverDate: '2026,08,16' });
    expect(parseStatsDocCsv(csv).lastRolloverDate).toBe('2026 08 16');
  });
});

describe('손상 관용 — 파서는 절대 throw 하지 않는다', () => {
  it('빈 문자열은 기본 스냅샷이다', () => {
    expect(parseStatsDocCsv('')).toEqual(emptyStatsSnapshot());
  });

  it('본행이 손상돼도 섹션은 읽는다', () => {
    const csv = ['garbage', 'also-garbage', METERS_HEADER, '1,5,2,4,3,1'].join('\n');
    const snap = parseStatsDocCsv(csv);
    expect(snap.paidPlayTotal).toBe(0);
    expect(snap).toMatchObject({ coinPulseTotal: 5, serviceCreditGranted: 1 });
  });

  it('알 수 없는 섹션은 통째로 무시한다', () => {
    const csv = [statsDocToCsv(loaded()), '#future,whatever', '1,999', '1,888'].join('\n');
    expect(parseStatsDocCsv(csv)).toEqual(loaded());
  });

  it('손상된 히스토그램 행은 그 행만 버린다', () => {
    const csv = [
      statsDocToCsv({ ...emptyStatsSnapshot(), histogram: [{ board: 1, count: 2 }] }),
      '1,xx,3',
      '1,4,5',
    ].join('\n');
    expect(parseStatsDocCsv(csv).histogram).toEqual([
      { board: 1, count: 2 },
      { board: 4, count: 5 },
    ]);
  });

  it('손상된 점수 행은 표본 1개만 잃는다', () => {
    const csv = [SCORES_HEADER, '1,100', '1,bad', '1,300'].join('\n');
    expect(parseStatsDocCsv(`x\ny\n${csv}`).scores).toEqual([100, 300]);
  });

  it('마커 소스가 paid/event가 아니면 마커를 버린다', () => {
    const csv = ['x', 'y', RUN_HEADER, '1,service,1,2026-08-16T00:00:00.000Z'].join('\n');
    expect(parseStatsDocCsv(csv).marker).toBeNull();
  });

  it('마커 시각이 비면 마커를 버린다', () => {
    const csv = ['x', 'y', RUN_HEADER, '1,paid,1,'].join('\n');
    expect(parseStatsDocCsv(csv).marker).toBeNull();
  });

  it('칸이 모자란 섹션 행은 0으로 채운다', () => {
    const csv = ['x', 'y', SESSION_HEADER, '1,500'].join('\n');
    expect(parseStatsDocCsv(csv)).toMatchObject({
      occupancyMsTotal: 500,
      occupancySessions: 0,
      lastRolloverDate: '',
    });
  });

  it('CRLF로 저장된 파일도 읽는다', () => {
    const csv = statsDocToCsv(loaded()).replace(/\n/g, '\r\n');
    expect(parseStatsDocCsv(csv)).toEqual(loaded());
  });

  it('섹션 사이에 빈 줄이 섞이거나 파일 끝에 개행이 남아도 읽는다', () => {
    const lines = statsDocToCsv(loaded()).split('\n');
    // 본행 2줄은 WU-01 코덱이 위치로 읽으므로 그대로 두고, 3줄째부터 빈 줄을 끼운다
    const csv = [lines[0], lines[1], ...lines.slice(2).flatMap((l) => [l, '']), ''].join('\n');
    expect(parseStatsDocCsv(csv)).toEqual(loaded());
  });
});

describe('SaveDocument 결선', () => {
  function model(): StatsModel {
    const m = new StatsModel({ wall: new MutableWallClock() });
    m.touch('boot');
    return m;
  }

  it('stats.csv에 등록된다', () => {
    expect(statsSaveDocument(model()).file).toBe(FILES.stats);
  });

  it('serialize → apply가 모델 상태를 그대로 옮긴다', () => {
    const a = model();
    a.noteCoinPulse(1);
    a.notePlayStarted('paid');
    a.noteSessionOpened(0);
    a.noteSessionClosed(9000, { boardReached: 2, score: 777, counted: true });
    a.setRunMarker({ source: 'event', amount: 2, startedIso: '2026-08-16T11:00:00.000Z' });

    const b = model();
    statsSaveDocument(b).apply(statsSaveDocument(a).serialize());
    expect(b.view(null)).toEqual(a.view(null));
    expect(b.runMarker).toEqual(a.runMarker);
  });

  it('저장 파일이 없던 것처럼 손상돼도 apply가 던지지 않는다', () => {
    const b = model();
    expect(() => statsSaveDocument(b).apply('완전히 깨진 내용\n@@@@')).not.toThrow();
  });
});
