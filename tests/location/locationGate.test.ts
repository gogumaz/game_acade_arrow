import { describe, expect, it } from 'vitest';

import {
  evaluateLocationGate,
  LOCATION_GATE_TARGETS,
  type LocationObservation,
} from '../../src/ops/locationGate';

function observation(overrides: Partial<LocationObservation> = {}): LocationObservation {
  return {
    locationId: 'site-a',
    date: '2026-08-18',
    paidPlays: 35,
    reattemptOpportunities: 100,
    reattemptsWithin10Min: 18,
    failedInputs: 200,
    focusDisputes: 3,
    scheduledMinutes: 1000,
    unavailableMinutes: 10,
    ...overrides,
  };
}

describe('§14.4 — 로케이션 4대 KPI 게이트', () => {
  it('경계값 35회·18%·1.5%·99%는 모두 통과한다', () => {
    const report = evaluateLocationGate([observation()]);
    expect(LOCATION_GATE_TARGETS).toEqual({
      paidPlaysPerDay: 35,
      reattemptRatePct: 18,
      focusDisputeRatePct: 1.5,
      uptimePct: 99,
    });
    expect(report.metrics).toMatchObject({
      paidPlaysPerDay: { value: 35, status: 'pass' },
      reattemptRatePct: { value: 18, status: 'pass' },
      focusDisputeRatePct: { value: 1.5, status: 'pass' },
      uptimePct: { value: 99, status: 'pass' },
    });
    expect(report.readyForSecondPhase).toBe(true);
  });

  it('각 기준을 한 번이라도 벗어나면 2차 착수를 허용하지 않는다', () => {
    const report = evaluateLocationGate([
      observation({
        paidPlays: 34,
        reattemptsWithin10Min: 17,
        focusDisputes: 4,
        unavailableMinutes: 11,
      }),
    ]);
    expect(Object.values(report.metrics).map((metric) => metric.status)).toEqual([
      'fail',
      'fail',
      'fail',
      'fail',
    ]);
    expect(report.readyForSecondPhase).toBe(false);
  });

  it('표시 반올림으로 기준 미달 값을 통과시키지 않는다', () => {
    const report = evaluateLocationGate([
      observation({
        reattemptOpportunities: 100_000,
        reattemptsWithin10Min: 17_999,
        failedInputs: 10_000,
        focusDisputes: 150,
        scheduledMinutes: 20_000,
        unavailableMinutes: 201,
      }),
    ]);
    expect(report.metrics.reattemptRatePct).toMatchObject({ value: 18, status: 'fail' });
    expect(report.metrics.uptimePct).toMatchObject({ value: 99, status: 'fail' });
    expect(report.readyForSecondPhase).toBe(false);
  });

  it('매장별 비율의 평균이 아니라 전체 분자·분모로 가중 집계한다', () => {
    const report = evaluateLocationGate([
      observation({
        locationId: 'small',
        reattemptOpportunities: 10,
        reattemptsWithin10Min: 10,
        failedInputs: 10,
        focusDisputes: 0,
      }),
      observation({
        locationId: 'large',
        reattemptOpportunities: 90,
        reattemptsWithin10Min: 8,
        failedInputs: 190,
        focusDisputes: 3,
      }),
    ]);
    expect(report.metrics.reattemptRatePct.value).toBe(18);
    expect(report.metrics.focusDisputeRatePct.value).toBe(1.5);
  });

  it('표본이나 필수 분모가 없으면 합성 PASS 대신 insufficient다', () => {
    const empty = evaluateLocationGate([]);
    expect(Object.values(empty.metrics).every((metric) => metric.status === 'insufficient')).toBe(
      true
    );

    const missing = evaluateLocationGate([
      observation({
        paidPlays: 0,
        reattemptOpportunities: 0,
        reattemptsWithin10Min: 0,
        failedInputs: 0,
        focusDisputes: 0,
        scheduledMinutes: 0,
        unavailableMinutes: 0,
      }),
    ]);
    expect(missing.metrics.reattemptRatePct.status).toBe('insufficient');
    expect(missing.metrics.focusDisputeRatePct.status).toBe('insufficient');
    expect(missing.metrics.uptimePct.status).toBe('insufficient');
    expect(missing.readyForSecondPhase).toBe(false);
  });

  it('유료 플레이가 있었고 실패 입력이 0이면 공정성 이의율은 0%다', () => {
    const report = evaluateLocationGate([observation({ failedInputs: 0, focusDisputes: 0 })]);
    expect(report.metrics.focusDisputeRatePct).toMatchObject({ value: 0, status: 'pass' });
  });

  it('중복 매장·날짜와 모순된 값은 보고서를 무효화한다', () => {
    const report = evaluateLocationGate([
      observation(),
      observation({
        paidPlays: -1,
        reattemptOpportunities: 1,
        reattemptsWithin10Min: 2,
        failedInputs: 1,
        focusDisputes: 2,
        scheduledMinutes: 10,
        unavailableMinutes: 11,
      }),
    ]);
    expect(report.issues).toEqual([
      'row 2: duplicate location/date',
      'row 2: paidPlays must be an integer >= 0',
      'row 2: reattempts exceed opportunities',
      'row 2: focus disputes exceed failed inputs',
      'row 2: unavailable minutes exceed scheduled minutes',
    ]);
    expect(report.readyForSecondPhase).toBe(false);
  });

  it('형식만 맞고 실제로 존재하지 않는 날짜를 거부한다', () => {
    const report = evaluateLocationGate([observation({ date: '2026-02-30' })]);
    expect(report.issues).toContain('row 1: date must be a real YYYY-MM-DD date');
    expect(report.readyForSecondPhase).toBe(false);
  });
});
