// 로케이션 운영 게이트 (§1.5 · §14.4)
//
// 2차 착수에 필요한 4개 KPI를 **실제 현장 관찰값**으로만 판정한다. 런타임 테스트나 합성
// 세션은 이 모델의 입력이 아니다. 한 행은 한 매장·한 영업일의 마감 집계이며, 중복 행은
// 분모를 부풀릴 수 있으므로 보고서 자체를 무효로 만든다.

export const LOCATION_GATE_TARGETS = {
  paidPlaysPerDay: 35,
  reattemptRatePct: 18,
  focusDisputeRatePct: 1.5,
  uptimePct: 99,
} as const;

export interface LocationObservation {
  /** 개인 정보가 아닌 매장 식별자 */
  readonly locationId: string;
  /** 매장 현지 날짜 YYYY-MM-DD */
  readonly date: string;
  /** stats.csv TODAY PAID PLAY COUNT 마감값 */
  readonly paidPlays: number;
  /** 첫 유료 플레이 뒤 10분을 온전히 관찰한 이용 세션 수 */
  readonly reattemptOpportunities: number;
  /** 위 세션 중 10분 안에 추가 결제한 수 */
  readonly reattemptsWithin10Min: number;
  /** 실패 판정 입력 수 */
  readonly failedInputs: number;
  /** 현장 확인에서 포커스 대상 오인·판정 이의로 분류된 실패 수 */
  readonly focusDisputes: number;
  /** 해당 영업일의 계획 가동 시간(분) */
  readonly scheduledMinutes: number;
  /** 계획 시간 중 유료 플레이가 불가능했던 시간(분) */
  readonly unavailableMinutes: number;
}

type GateMetricStatus = 'pass' | 'fail' | 'insufficient';

interface GateMetric {
  readonly value: number | null;
  readonly target: string;
  readonly status: GateMetricStatus;
  readonly numerator: number;
  readonly denominator: number;
}

interface LocationGateReport {
  readonly observedLocationDays: number;
  readonly totals: {
    readonly paidPlays: number;
    readonly reattemptOpportunities: number;
    readonly reattemptsWithin10Min: number;
    readonly failedInputs: number;
    readonly focusDisputes: number;
    readonly scheduledMinutes: number;
    readonly unavailableMinutes: number;
  };
  readonly metrics: {
    readonly paidPlaysPerDay: GateMetric;
    readonly reattemptRatePct: GateMetric;
    readonly focusDisputeRatePct: GateMetric;
    readonly uptimePct: GateMetric;
  };
  /** 네 지표 PASS + 입력 무결성 오류 0일 때만 true */
  readonly readyForSecondPhase: boolean;
  readonly issues: readonly string[];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function finiteNonNegativeInteger(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function validLocalDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function metric(
  numerator: number,
  denominator: number,
  target: string,
  passes: (value: number) => boolean,
  zeroValue: number | null = null
): GateMetric {
  const rawValue = denominator > 0 ? (numerator / denominator) * 100 : zeroValue;
  return {
    value: rawValue === null ? null : rounded(rawValue),
    target,
    status: rawValue === null ? 'insufficient' : passes(rawValue) ? 'pass' : 'fail',
    numerator,
    denominator,
  };
}

function emptyTotals(): LocationGateReport['totals'] {
  return {
    paidPlays: 0,
    reattemptOpportunities: 0,
    reattemptsWithin10Min: 0,
    failedInputs: 0,
    focusDisputes: 0,
    scheduledMinutes: 0,
    unavailableMinutes: 0,
  };
}

/** §14.4가 명시한 수익·재도전·공정성·가동률 네 지표만 판정한다. */
export function evaluateLocationGate(
  observations: readonly LocationObservation[]
): LocationGateReport {
  const issues: string[] = [];
  const seen = new Set<string>();
  const totals = { ...emptyTotals() };

  for (let index = 0; index < observations.length; index += 1) {
    const row = observations[index];
    const label = `row ${String(index + 1)}`;
    const location = row.locationId.trim();
    if (location === '') issues.push(`${label}: locationId is required`);
    if (!validLocalDate(row.date)) issues.push(`${label}: date must be a real YYYY-MM-DD date`);

    const key = `${location}\u0000${row.date}`;
    if (seen.has(key)) issues.push(`${label}: duplicate location/date`);
    seen.add(key);

    const fields = [
      ['paidPlays', row.paidPlays],
      ['reattemptOpportunities', row.reattemptOpportunities],
      ['reattemptsWithin10Min', row.reattemptsWithin10Min],
      ['failedInputs', row.failedInputs],
      ['focusDisputes', row.focusDisputes],
      ['scheduledMinutes', row.scheduledMinutes],
      ['unavailableMinutes', row.unavailableMinutes],
    ] as const;
    for (const [name, value] of fields) {
      if (!finiteNonNegativeInteger(value))
        issues.push(`${label}: ${name} must be an integer >= 0`);
    }

    if (row.reattemptsWithin10Min > row.reattemptOpportunities) {
      issues.push(`${label}: reattempts exceed opportunities`);
    }
    if (row.focusDisputes > row.failedInputs) {
      issues.push(`${label}: focus disputes exceed failed inputs`);
    }
    if (row.unavailableMinutes > row.scheduledMinutes) {
      issues.push(`${label}: unavailable minutes exceed scheduled minutes`);
    }

    if (fields.every(([, value]) => finiteNonNegativeInteger(value))) {
      totals.paidPlays += row.paidPlays;
      totals.reattemptOpportunities += row.reattemptOpportunities;
      totals.reattemptsWithin10Min += row.reattemptsWithin10Min;
      totals.failedInputs += row.failedInputs;
      totals.focusDisputes += row.focusDisputes;
      totals.scheduledMinutes += row.scheduledMinutes;
      totals.unavailableMinutes += row.unavailableMinutes;
    }
  }

  const observedLocationDays = seen.size;
  const paidPlaysPerDay: GateMetric = {
    value: observedLocationDays === 0 ? null : rounded(totals.paidPlays / observedLocationDays),
    target: `>= ${String(LOCATION_GATE_TARGETS.paidPlaysPerDay)}`,
    status:
      observedLocationDays === 0
        ? 'insufficient'
        : totals.paidPlays / observedLocationDays >= LOCATION_GATE_TARGETS.paidPlaysPerDay
          ? 'pass'
          : 'fail',
    numerator: totals.paidPlays,
    denominator: observedLocationDays,
  };
  const reattemptRatePct = metric(
    totals.reattemptsWithin10Min,
    totals.reattemptOpportunities,
    `>= ${String(LOCATION_GATE_TARGETS.reattemptRatePct)}%`,
    (value) => value >= LOCATION_GATE_TARGETS.reattemptRatePct
  );
  // 실패 입력이 하나도 없고 실제 유료 플레이가 있었다면 이의 비율은 0%다.
  const focusDisputeRatePct = metric(
    totals.focusDisputes,
    totals.failedInputs,
    `<= ${String(LOCATION_GATE_TARGETS.focusDisputeRatePct)}%`,
    (value) => value <= LOCATION_GATE_TARGETS.focusDisputeRatePct,
    totals.paidPlays > 0 && totals.focusDisputes === 0 ? 0 : null
  );
  const availableMinutes = Math.max(0, totals.scheduledMinutes - totals.unavailableMinutes);
  const uptimePct = metric(
    availableMinutes,
    totals.scheduledMinutes,
    `>= ${String(LOCATION_GATE_TARGETS.uptimePct)}%`,
    (value) => value >= LOCATION_GATE_TARGETS.uptimePct
  );
  const metrics = { paidPlaysPerDay, reattemptRatePct, focusDisputeRatePct, uptimePct };
  const readyForSecondPhase =
    issues.length === 0 && Object.values(metrics).every((entry) => entry.status === 'pass');

  return { observedLocationDays, totals, metrics, readyForSecondPhase, issues };
}
