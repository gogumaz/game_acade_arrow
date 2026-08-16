// `StatsModel` — admin §7.1 10지표 · §7.2 6미터 · §10.5 고유 집계 · admin §7.4 초기화
//
// 인수: CRD-604(통계 집계) · CRD-605(초기화 대상)의 순수 계층분.
// 날짜 롤오버·시간 역행은 `rollover.test.ts`가 따로 갖는다.

import { describe, it, expect } from 'vitest';
import {
  SCORE_RING_CAPACITY,
  StatsModel,
  type AuditEvent,
  type AuditKind,
  type RunMarker,
  type RunOutcome,
  type StatsModelDeps,
  type StatsView,
} from '../../src/core/stats';
import { MutableWallClock } from './harness';

interface Rig {
  readonly stats: StatsModel;
  readonly wall: MutableWallClock;
  readonly audits: AuditEvent[];
  view(): StatsView;
}

function makeStats(ringCapacity?: number): Rig {
  const wall = new MutableWallClock();
  const audits: AuditEvent[] = [];
  const deps: StatsModelDeps = { wall, audit: (e) => audits.push(e), ringCapacity };
  const stats = new StatsModel(deps);
  stats.touch('boot');
  return { stats, wall, audits, view: () => stats.view(null) };
}

function outcome(board: number, score: number, counted = true): RunOutcome {
  return { boardReached: board, score, counted };
}

describe('admin §7.1 — 유료·이벤트 지표 10종', () => {
  it('유료 플레이는 누적과 오늘이 함께 오른다', () => {
    const rig = makeStats();
    rig.stats.notePlayStarted('paid');
    rig.stats.notePlayStarted('paid');
    expect(rig.view()).toMatchObject({ paidPlayTotal: 2, paidPlayToday: 2 });
  });

  it('이벤트 플레이는 유료 지표를 건드리지 않는다', () => {
    const rig = makeStats();
    rig.stats.notePlayStarted('event');
    expect(rig.view()).toMatchObject({
      eventPlayTotal: 1,
      eventPlayToday: 1,
      paidPlayTotal: 0,
      paidPlayToday: 0,
    });
  });

  it('컨티뉴는 소스별로 1회당 +1이다 (§4.5)', () => {
    const rig = makeStats();
    rig.stats.noteContinue('paid');
    rig.stats.noteContinue('paid');
    rig.stats.noteContinue('event');
    expect(rig.view()).toMatchObject({ paidContinue: 2, eventContinue: 1 });
  });

  it('이벤트 지급은 누적 지급 미터만 올린다', () => {
    const rig = makeStats();
    rig.stats.noteEventGranted(3);
    expect(rig.view()).toMatchObject({ eventGrantedTotal: 3, eventUsedTotal: 0 });
  });

  it('이벤트 사용은 누적·오늘이 함께 오른다', () => {
    const rig = makeStats();
    rig.stats.noteCreditUsed('event', 2);
    expect(rig.view()).toMatchObject({ eventUsedTotal: 2, eventUsedToday: 2 });
  });

  it('EVENT CREDIT BALANCE는 지갑을 그대로 비추는 파생값이다 (2.3 라)', () => {
    const rig = makeStats();
    rig.stats.setEventBalance(4);
    expect(rig.view().eventCreditBalance).toBe(4);
    rig.stats.setEventBalance(0);
    expect(rig.view().eventCreditBalance).toBe(0);
  });

  it('지표 10종이 모두 view에 있다', () => {
    const v = makeStats().view();
    for (const key of [
      'paidPlayTotal',
      'paidPlayToday',
      'paidContinue',
      'eventPlayTotal',
      'eventPlayToday',
      'eventContinue',
      'eventCreditBalance',
      'eventGrantedTotal',
      'eventUsedTotal',
      'eventUsedToday',
    ] as const) {
      expect(v[key]).toBe(0);
    }
  });
});

describe('admin §7.2 — 매출성 미터 6종', () => {
  it('P-7 — 코인 펄스는 상한 거부와 무관하게 +1, 지급 미터는 들어간 양만', () => {
    const rig = makeStats();
    rig.stats.noteCoinPulse(1);
    rig.stats.noteCoinPulse(1);
    rig.stats.noteCoinPulse(0); // 상한에서 삼킨 코인
    expect(rig.view()).toMatchObject({
      coinPulseTotal: 3,
      coinPulseToday: 3,
      paidCreditGranted: 2,
    });
  });

  it('두 미터의 차가 상한에서 삼킨 코인 수다', () => {
    const rig = makeStats();
    for (let i = 0; i < 5; i += 1) rig.stats.noteCoinPulse(i < 3 ? 1 : 0);
    const v = rig.view();
    expect(v.coinPulseTotal - v.paidCreditGranted).toBe(2);
  });

  it('PAID CREDIT USED는 결제 소스가 paid일 때만 오른다', () => {
    const rig = makeStats();
    rig.stats.noteCreditUsed('paid', 2);
    rig.stats.noteCreditUsed('event', 3);
    expect(rig.view()).toMatchObject({ paidCreditUsed: 2, eventUsedTotal: 3 });
  });

  it('P-8 — 서비스 크레딧은 전용 미터만 올리고 코인 펄스·유료 지급을 건드리지 않는다', () => {
    const rig = makeStats();
    rig.stats.noteServiceGranted(1);
    expect(rig.view()).toMatchObject({
      serviceCreditGranted: 1,
      coinPulseTotal: 0,
      paidCreditGranted: 0,
    });
  });

  it('ESTIMATED GROSS는 코인 펄스 × 단가다', () => {
    const rig = makeStats();
    for (let i = 0; i < 7; i += 1) rig.stats.noteCoinPulse(1);
    expect(rig.stats.view(1000).estimatedGross).toBe(7000);
  });

  it('단가 미설정이면 ESTIMATED GROSS는 null이다 (§10.1 N11c)', () => {
    expect(makeStats().view().estimatedGross).toBeNull();
  });
});

describe('§10.5 — 세션 점유 시간 (P-11)', () => {
  it('결제 시점 ~ 결과 화면 종료가 점유 시간이다', () => {
    const rig = makeStats();
    rig.stats.noteSessionOpened(1000);
    rig.stats.noteSessionClosed(91_000, outcome(4, 12_000));
    expect(rig.view()).toMatchObject({
      occupancyMsTotal: 90_000,
      occupancySessions: 1,
      avgOccupancyMs: 90_000,
    });
  });

  it('컨티뉴 결제로는 세션을 다시 열지 않는다', () => {
    const rig = makeStats();
    rig.stats.noteSessionOpened(1000);
    rig.stats.noteSessionOpened(50_000); // 컨티뉴 — 무시된다
    rig.stats.noteSessionClosed(101_000, outcome(6, 30_000));
    expect(rig.view().occupancyMsTotal).toBe(100_000);
  });

  it('평균 점유 시간은 세션 수로 나눈 값이다 (§1.5 KPI)', () => {
    const rig = makeStats();
    rig.stats.noteSessionOpened(0);
    rig.stats.noteSessionClosed(100_000, outcome(3, 1));
    rig.stats.noteSessionOpened(200_000);
    rig.stats.noteSessionClosed(260_000, outcome(3, 1));
    expect(rig.view()).toMatchObject({ occupancySessions: 2, avgOccupancyMs: 80_000 });
  });

  it('세션이 열리지 않았으면 점유 시간을 세지 않는다', () => {
    const rig = makeStats();
    rig.stats.noteSessionClosed(5000, outcome(2, 100));
    expect(rig.view()).toMatchObject({ occupancyMsTotal: 0, occupancySessions: 0 });
    expect(rig.view().boardHistogram).toEqual([{ board: 2, count: 1 }]); // 히스토그램은 남는다
  });

  it('진입 실패 원복은 열린 세션을 집계 없이 닫는다 (§5.3)', () => {
    const rig = makeStats();
    rig.stats.notePlayStarted('paid');
    rig.stats.noteSessionOpened(1000);
    rig.stats.notePlayReverted('paid');
    rig.stats.noteSessionOpened(10_000); // 다음 런은 정상적으로 다시 열린다
    rig.stats.noteSessionClosed(40_000, outcome(1, 500));
    expect(rig.view()).toMatchObject({ occupancyMsTotal: 30_000, occupancySessions: 1 });
  });
});

describe('§10.5 — 도달 보드 히스토그램 (§11.7 밸런스 지표)', () => {
  it('런 종료 시 도달 보드가 누적된다', () => {
    const rig = makeStats();
    for (const b of [1, 2, 2, 5]) rig.stats.noteSessionClosed(0, outcome(b, 10));
    expect(rig.view().boardHistogram).toEqual([
      { board: 1, count: 1 },
      { board: 2, count: 2 },
      { board: 5, count: 1 },
    ]);
  });

  it('보드 번호 오름차순으로 돌려준다', () => {
    const rig = makeStats();
    for (const b of [9, 3, 7]) rig.stats.noteSessionClosed(0, outcome(b, 10));
    expect(rig.view().boardHistogram.map((e) => e.board)).toEqual([3, 7, 9]);
  });

  it('보드 0(도달 전)은 히스토그램에 넣지 않는다', () => {
    const rig = makeStats();
    rig.stats.noteSessionClosed(0, outcome(0, 0));
    expect(rig.view().boardHistogram).toEqual([]);
  });
});

describe('§5.5 — 점수 200칸 링 버퍼', () => {
  it('용량은 200이다 (§12.1)', () => {
    expect(SCORE_RING_CAPACITY).toBe(200);
  });

  it('오래된 표본부터 밀려난다', () => {
    const rig = makeStats(3);
    for (const s of [10, 20, 30, 40]) rig.stats.noteSessionClosed(0, outcome(1, s));
    expect(rig.stats.scoreRing()).toEqual([20, 30, 40]);
  });

  it('표본이 용량 미만이면 백분위는 null이다 (고정 임계표를 쓴다)', () => {
    const rig = makeStats(4);
    for (const s of [10, 20, 30]) rig.stats.noteSessionClosed(0, outcome(1, s));
    expect(rig.stats.topPercentOf(25)).toBeNull();
  });

  it('표본이 차면 "상위 N%"를 돌려준다', () => {
    const rig = makeStats(4);
    for (const s of [10, 20, 30, 40]) rig.stats.noteSessionClosed(0, outcome(1, s));
    expect(rig.stats.topPercentOf(40)).toBe(0); // 최고점은 상위 0%
    expect(rig.stats.topPercentOf(30)).toBe(25);
    expect(rig.stats.topPercentOf(5)).toBe(100);
  });

  it('scoreSamples가 표본 수를 알려 준다', () => {
    const rig = makeStats(10);
    for (let i = 0; i < 6; i += 1) rig.stats.noteSessionClosed(0, outcome(1, i));
    expect(rig.view().scoreSamples).toBe(6);
  });
});

describe('CRD-607 — 테스트 플레이는 아무것도 남기지 않는다', () => {
  it('counted:false면 점유·히스토그램·점수 표본이 모두 그대로다', () => {
    const rig = makeStats();
    rig.stats.noteSessionOpened(0);
    rig.stats.noteSessionClosed(60_000, outcome(4, 5000, false));
    expect(rig.view()).toMatchObject({
      occupancyMsTotal: 0,
      occupancySessions: 0,
      scoreSamples: 0,
    });
    expect(rig.view().boardHistogram).toEqual([]);
  });
});

describe('admin §7.4 — 통계 초기화 (CRD-605)', () => {
  function loaded(): Rig {
    const rig = makeStats();
    rig.stats.noteCoinPulse(1);
    rig.stats.noteCoinPulse(1);
    rig.stats.noteServiceGranted(1);
    rig.stats.notePlayStarted('paid');
    rig.stats.noteContinue('paid');
    rig.stats.noteCreditUsed('paid', 1);
    rig.stats.notePlayStarted('event');
    rig.stats.noteContinue('event');
    rig.stats.noteEventGranted(3);
    rig.stats.noteCreditUsed('event', 1);
    rig.stats.setEventBalance(2);
    rig.stats.noteSessionOpened(0);
    rig.stats.noteSessionClosed(10_000, outcome(3, 8000));
    return rig;
  }

  it('RESET PAID — 누적/오늘 유료 플레이와 유료 컨티뉴만 0이 된다', () => {
    const rig = loaded();
    rig.stats.resetPaid();
    expect(rig.view()).toMatchObject({
      paidPlayTotal: 0,
      paidPlayToday: 0,
      paidContinue: 0,
      eventPlayTotal: 1,
      eventContinue: 1,
      eventGrantedTotal: 3,
    });
  });

  it('RESET PAID — 영구 코인 미터는 유지된다 (admin §7.2)', () => {
    const rig = loaded();
    rig.stats.resetPaid();
    expect(rig.view()).toMatchObject({
      coinPulseTotal: 2,
      coinPulseToday: 2,
      paidCreditGranted: 2,
      paidCreditUsed: 1,
      serviceCreditGranted: 1,
    });
  });

  it('RESET PAID — 점수 링 버퍼는 비고 도달 보드 히스토그램은 남는다 (Q-4)', () => {
    const rig = loaded();
    rig.stats.resetPaid();
    expect(rig.view().scoreSamples).toBe(0);
    expect(rig.view().boardHistogram).toEqual([{ board: 3, count: 1 }]);
  });

  it('RESET EVENT — 이벤트 전량과 잔액이 0이 된다', () => {
    const rig = loaded();
    rig.stats.resetEvent();
    expect(rig.view()).toMatchObject({
      eventPlayTotal: 0,
      eventPlayToday: 0,
      eventContinue: 0,
      eventGrantedTotal: 0,
      eventUsedTotal: 0,
      eventUsedToday: 0,
      eventCreditBalance: 0,
    });
  });

  it('RESET EVENT — 유료 데이터와 영구 미터는 유지된다', () => {
    const rig = loaded();
    rig.stats.resetEvent();
    expect(rig.view()).toMatchObject({
      paidPlayTotal: 1,
      paidContinue: 1,
      coinPulseTotal: 2,
      serviceCreditGranted: 1,
    });
  });

  it('초기화는 STATS_RESET 감사 이벤트를 남긴다', () => {
    const rig = loaded();
    const kind: AuditKind = 'STATS_RESET';
    rig.stats.resetPaid();
    rig.stats.resetEvent();
    expect(rig.audits.filter((e) => e.kind === kind).map((e) => e.detail)).toEqual([
      'paid',
      'event',
    ]);
  });
});

describe('§10.2 원복의 통계 상쇄 (§5.3)', () => {
  it('플레이 카운트가 되돌아온다', () => {
    const rig = makeStats();
    rig.stats.notePlayStarted('paid');
    rig.stats.notePlayReverted('paid');
    expect(rig.view()).toMatchObject({ paidPlayTotal: 0, paidPlayToday: 0 });
  });

  it('컨티뉴 카운트가 되돌아온다', () => {
    const rig = makeStats();
    rig.stats.noteContinue('event');
    rig.stats.noteContinueReverted('event');
    expect(rig.view().eventContinue).toBe(0);
  });

  it('사용 미터가 되돌아온다', () => {
    const rig = makeStats();
    rig.stats.noteCreditUsed('paid', 2);
    rig.stats.noteCreditUsed('event', 2);
    rig.stats.noteRefund('paid', 2);
    rig.stats.noteRefund('event', 2);
    expect(rig.view()).toMatchObject({ paidCreditUsed: 0, eventUsedTotal: 0, eventUsedToday: 0 });
  });

  it('코인 펄스와 유료 지급 미터는 되돌아오지 않는다 (코인은 실제로 들어왔다)', () => {
    const rig = makeStats();
    rig.stats.noteCoinPulse(1);
    rig.stats.notePlayStarted('paid');
    rig.stats.noteCreditUsed('paid', 1);
    rig.stats.notePlayReverted('paid');
    rig.stats.noteRefund('paid', 1);
    expect(rig.view()).toMatchObject({ coinPulseTotal: 1, paidCreditGranted: 1 });
  });

  it('카운터는 0 아래로 내려가지 않는다', () => {
    const rig = makeStats();
    rig.stats.notePlayReverted('paid');
    rig.stats.noteContinueReverted('paid');
    rig.stats.noteRefund('paid', 5);
    expect(rig.view()).toMatchObject({ paidPlayTotal: 0, paidContinue: 0, paidCreditUsed: 0 });
  });
});

describe('§10.6 크래시 마커 보관', () => {
  it('마커를 넣고 뺄 수 있다', () => {
    const rig = makeStats();
    const m: RunMarker = { source: 'paid', amount: 1, startedIso: '2026-08-16T10:00:00.000Z' };
    expect(rig.stats.runMarker).toBeNull();
    rig.stats.setRunMarker(m);
    expect(rig.stats.runMarker).toEqual(m);
    rig.stats.setRunMarker(null);
    expect(rig.stats.runMarker).toBeNull();
  });
});

describe('직렬화 왕복', () => {
  it('스냅샷을 다른 모델에 실으면 view가 같다', () => {
    const a = makeStats();
    a.stats.noteCoinPulse(1);
    a.stats.notePlayStarted('paid');
    a.stats.noteSessionOpened(0);
    a.stats.noteSessionClosed(5000, outcome(3, 900));
    a.stats.setRunMarker({ source: 'paid', amount: 2, startedIso: 'X' });

    const b = makeStats();
    b.stats.loadSnapshot(a.stats.toSnapshot());
    expect(b.view()).toEqual(a.view());
    expect(b.stats.runMarker).toEqual(a.stats.runMarker);
  });

  it('손상된 음수 값은 0으로 실린다', () => {
    const rig = makeStats();
    rig.stats.loadSnapshot({
      ...rig.stats.toSnapshot(),
      paidPlayTotal: -5,
      coinPulseTotal: Number.NaN,
    });
    expect(rig.view()).toMatchObject({ paidPlayTotal: 0, coinPulseTotal: 0 });
  });

  it('링 버퍼는 실을 때도 용량을 넘지 않는다', () => {
    const rig = makeStats(3);
    rig.stats.loadSnapshot({ ...rig.stats.toSnapshot(), scores: [1, 2, 3, 4, 5] });
    expect(rig.stats.scoreRing()).toEqual([3, 4, 5]);
  });
});
