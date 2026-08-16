// 날짜 롤오버와 시간 역행 (§10.5 · admin §11.5 — 인수 CRD-605)
//
// 판정 대상 3가지
//   ① 롤오버 확인 4지점 — 프로그램 실행 · 런 시작 · 관리자 진입 · 통계 초기화
//   ② 오늘 지표 **4종만** 0이 되고 누적·영구 미터는 그대로
//   ③ CLOCK CHANGED 3형태 — 24시간 역행 · 과거 방향 롤오버 · 같은 날짜로 2회 롤오버 (Q-3)

import { describe, it, expect } from 'vitest';
import {
  CLOCK_BACKSTEP_MS,
  StatsModel,
  type AuditEvent,
  type RolloverReason,
  type RolloverResult,
  type StatsView,
} from '../../src/core/stats';
import { MutableWallClock } from './harness';

const D1 = '2026-08-16';
const D2 = '2026-08-17';

interface Rig {
  readonly stats: StatsModel;
  readonly wall: MutableWallClock;
  readonly audits: AuditEvent[];
  view(): StatsView;
  clockChanges(): AuditEvent[];
}

function makeRig(): Rig {
  const wall = new MutableWallClock(D1, Date.parse(`${D1}T10:00:00.000Z`));
  const audits: AuditEvent[] = [];
  const stats = new StatsModel({ wall, audit: (e) => audits.push(e) });
  stats.touch('boot');
  return {
    stats,
    wall,
    audits,
    view: () => stats.view(null),
    clockChanges: () => audits.filter((e) => e.kind === 'CLOCK_CHANGED'),
  };
}

/** 오늘 지표 4종 + 누적·영구 미터를 모두 채운다 */
function fill(rig: Rig): void {
  rig.stats.noteCoinPulse(1);
  rig.stats.noteCoinPulse(1);
  rig.stats.notePlayStarted('paid');
  rig.stats.notePlayStarted('event');
  rig.stats.noteContinue('paid');
  rig.stats.noteCreditUsed('paid', 1);
  rig.stats.noteCreditUsed('event', 1);
  rig.stats.noteEventGranted(2);
  rig.stats.noteServiceGranted(1);
  rig.stats.noteSessionOpened(0);
  rig.stats.noteSessionClosed(30_000, { boardReached: 3, score: 4000, counted: true });
}

describe('§10.5 — 롤오버 확인 4지점', () => {
  it.each<RolloverReason>(['boot', 'run_start', 'admin_enter', 'stats_reset'])(
    '%s 지점에서 날짜를 확인한다',
    (reason) => {
      const rig = makeRig();
      fill(rig);
      rig.wall.nextDay(D2);
      const r: RolloverResult = rig.stats.touch(reason);
      expect(r).toMatchObject({ rolled: true, from: D1, to: D2 });
      expect(rig.view().paidPlayToday).toBe(0);
    }
  );

  it('날짜가 그대로면 롤오버하지 않는다', () => {
    const rig = makeRig();
    fill(rig);
    const r = rig.stats.touch('run_start');
    expect(r).toMatchObject({ rolled: false, from: D1, to: D1, clockChanged: false });
    expect(rig.view().paidPlayToday).toBe(1);
  });

  it('첫 부팅은 기준 날짜를 오늘로 세운다', () => {
    const wall = new MutableWallClock(D1);
    const stats = new StatsModel({ wall });
    expect(stats.today).toBe('');
    stats.touch('boot');
    expect(stats.today).toBe(D1);
  });
});

describe('CRD-605 — 롤오버가 0으로 만드는 것은 4종뿐이다', () => {
  it('오늘 유료 플레이 · 오늘 이벤트 플레이 · 오늘 이벤트 사용 · 오늘 코인 펄스만 0이 된다', () => {
    const rig = makeRig();
    fill(rig);
    rig.wall.nextDay(D2);
    rig.stats.touch('boot');
    expect(rig.view()).toMatchObject({
      paidPlayToday: 0,
      eventPlayToday: 0,
      eventUsedToday: 0,
      coinPulseToday: 0,
    });
  });

  it('누적 지표 6종은 유지된다', () => {
    const rig = makeRig();
    fill(rig);
    rig.wall.nextDay(D2);
    rig.stats.touch('boot');
    expect(rig.view()).toMatchObject({
      paidPlayTotal: 1,
      paidContinue: 1,
      eventPlayTotal: 1,
      eventGrantedTotal: 2,
      eventUsedTotal: 1,
    });
  });

  it('영구 코인 미터는 롤오버로 지워지지 않는다 (admin §7.2)', () => {
    const rig = makeRig();
    fill(rig);
    rig.wall.nextDay(D2);
    rig.stats.touch('boot');
    expect(rig.view()).toMatchObject({
      coinPulseTotal: 2,
      paidCreditGranted: 2,
      paidCreditUsed: 1,
      serviceCreditGranted: 1,
    });
  });

  it('이벤트 잔액·히스토그램·점수 표본·점유 시간도 유지된다', () => {
    const rig = makeRig();
    fill(rig);
    rig.stats.setEventBalance(3);
    rig.wall.nextDay(D2);
    rig.stats.touch('boot');
    const v = rig.view();
    expect(v.eventCreditBalance).toBe(3);
    expect(v.boardHistogram).toEqual([{ board: 3, count: 1 }]);
    expect(v.scoreSamples).toBe(1);
    expect(v.occupancyMsTotal).toBe(30_000);
  });

  it('롤오버 뒤에 다시 쌓으면 오늘 지표가 새로 센다', () => {
    const rig = makeRig();
    fill(rig);
    rig.wall.nextDay(D2);
    rig.stats.touch('boot');
    rig.stats.notePlayStarted('paid');
    expect(rig.view()).toMatchObject({ paidPlayTotal: 2, paidPlayToday: 1 });
  });
});

describe('admin §11.5 — CLOCK CHANGED 3형태 (Q-3)', () => {
  it('① 24시간 이상 과거로 이동하면 날짜가 그대로여도 감지한다', () => {
    const rig = makeRig();
    rig.wall.setMs(rig.wall.nowMs() - CLOCK_BACKSTEP_MS - 1000);
    const r = rig.stats.touch('run_start');
    expect(r.clockChanged).toBe(true);
    expect(rig.view().clockChangedCount).toBe(1);
    expect(rig.clockChanges()).toHaveLength(1);
  });

  it('24시간에 못 미치는 역행은 경고하지 않는다', () => {
    const rig = makeRig();
    rig.wall.setMs(rig.wall.nowMs() - 3_600_000);
    expect(rig.stats.touch('run_start').clockChanged).toBe(false);
    expect(rig.view().clockChangedCount).toBe(0);
  });

  it('② 과거 방향 롤오버는 감지한다', () => {
    const rig = makeRig();
    rig.wall.setDate('2026-08-15');
    const r = rig.stats.touch('boot');
    expect(r).toMatchObject({ rolled: true, clockChanged: true, from: D1, to: '2026-08-15' });
  });

  it('③ 같은 날짜로 2회 롤오버하면 감지한다', () => {
    const rig = makeRig();
    rig.wall.nextDay(D2); // D1 → D2 (정상)
    expect(rig.stats.touch('boot').clockChanged).toBe(false);
    rig.wall.setDate(D1); // D2 → D1 (과거 방향 — 여기서 이미 1건)
    expect(rig.stats.touch('boot').clockChanged).toBe(true);
    rig.wall.setDate(D2); // D1 → D2 **두 번째** — 같은 날짜 재롤오버
    const third = rig.stats.touch('boot');
    expect(third).toMatchObject({ rolled: true, clockChanged: true });
    expect(rig.view().clockChangedCount).toBe(2);
  });

  it('정상적인 자정 넘김은 경고하지 않는다', () => {
    const rig = makeRig();
    rig.wall.nextDay(D2);
    expect(rig.stats.touch('boot').clockChanged).toBe(false);
    rig.wall.nextDay('2026-08-18');
    expect(rig.stats.touch('boot').clockChanged).toBe(false);
    expect(rig.clockChanges()).toHaveLength(0);
  });

  it('감사 이벤트에 지점과 날짜 변화가 담긴다', () => {
    const rig = makeRig();
    rig.wall.setDate('2026-08-01');
    rig.stats.touch('admin_enter');
    const e = rig.clockChanges()[0];
    expect(e.kind).toBe('CLOCK_CHANGED');
    expect(e.detail).toContain('admin_enter');
    expect(e.detail).toContain(D1);
    expect(e.detail).toContain('2026-08-01');
  });

  it('시간이 역행해도 오늘 지표는 정상 초기화한다 (경고는 집계 중단이 아니다)', () => {
    const rig = makeRig();
    fill(rig);
    rig.wall.setDate('2026-08-15');
    rig.stats.touch('boot');
    expect(rig.view()).toMatchObject({
      paidPlayToday: 0,
      coinPulseToday: 0,
      paidPlayTotal: 1, // 누적은 그대로
      clockChangedCount: 1,
    });
  });

  it('lastEpochMs는 뒤로 가지 않는다 (역행 뒤 재확인이 매번 경고를 내지 않게)', () => {
    const rig = makeRig();
    const before = rig.wall.nowMs();
    rig.wall.setMs(before - CLOCK_BACKSTEP_MS - 1000);
    rig.stats.touch('boot');
    rig.stats.touch('boot');
    expect(rig.view().clockChangedCount).toBe(2); // 매 확인마다 1건 — 상태는 계속 이상하다
    rig.wall.setMs(before);
    rig.stats.touch('boot');
    expect(rig.view().clockChangedCount).toBe(2);
  });
});

describe('저장 왕복 뒤에도 롤오버 상태가 이어진다', () => {
  it('기준 날짜와 CLOCK CHANGED 횟수가 스냅샷에 실린다', () => {
    const rig = makeRig();
    rig.wall.setDate('2026-08-15');
    rig.stats.touch('boot');
    const snap = rig.stats.toSnapshot();
    expect(snap.date).toBe('2026-08-15');
    expect(snap.clockChangedCount).toBe(1);

    const other = makeRig();
    other.stats.loadSnapshot(snap);
    expect(other.stats.today).toBe('2026-08-15');
    expect(other.view().clockChangedCount).toBe(1);
  });

  it('재기동 뒤 같은 날짜로 다시 롤오버해도 감지한다', () => {
    const rig = makeRig();
    rig.wall.nextDay(D2);
    rig.stats.touch('boot'); // D1 → D2
    const snap = rig.stats.toSnapshot();

    const restarted = makeRig();
    restarted.stats.loadSnapshot(snap); // lastRolloverDate = D2
    restarted.wall.setDate(D1);
    restarted.stats.touch('boot'); // D2 → D1 (과거)
    restarted.wall.setDate(D2);
    expect(restarted.stats.touch('boot').clockChanged).toBe(true); // D2 재롤오버
  });
});
