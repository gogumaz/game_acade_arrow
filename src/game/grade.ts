// 등급 (§5.5 · §5.6 N7a~d — 작업 계획 P-12)
//
// §5.5는 "누적 유료 세션 200회 미만이면 **고정 임계 점수표**, 이상이면 최근 200 세션 백분위"로
// 2단 판정을 규정한다. 분포 표본은 `stats.csv`의 점수 200칸 링 버퍼(§12.1)가 소유하며 그 파일은
// **WU-04 소관**이다. 따라서 WU-03은 고정 임계표만 구현하고 SCR-309(분포 전환)는 WU-04로 이월한다.

export type Grade = 'S+' | 'S' | 'A' | 'B' | 'C';

/** §5.6 N7a~d 공장 기본값 — 기준 만점 런(약 375,000점)의 80 / 53 / 33 / 17% */
export const GRADE_THRESHOLDS: Readonly<Record<Exclude<Grade, 'C'>, number>> = {
  'S+': 300000,
  S: 200000,
  A: 125000,
  B: 65000,
};

/** §5.5 — S+는 "퍼펙트 3보드 연속"만으로도 성립한다 (docx §8.2 승계) */
export const PERFECT_STREAK_FOR_S_PLUS = 3;

/** 관리자 `GRADE * THRESHOLD` 4행이 넘겨 주는 형태 (§11.4 등급 그룹 — WU-05) */
export type GradeThresholds = Readonly<Record<Exclude<Grade, 'C'>, number>>;

/**
 * 최종 점수와 퍼펙트 연속 수로 등급을 판정한다.
 * `perfectStreak`는 런 중 **연속으로** 퍼펙트를 낸 보드 수의 최댓값이다.
 *
 * `thresholds`는 관리자가 편집한 값을 그대로 받는 선택 인자다. 기본값이 공장 임계표이므로
 * 넘기지 않는 호출부는 WU-03과 완전히 같이 동작한다.
 */
export function gradeOf(
  score: number,
  perfectStreak = 0,
  thresholds: GradeThresholds = GRADE_THRESHOLDS,
  topPercent: number | null = null
): Grade {
  if (topPercent !== null) {
    if (perfectStreak >= PERFECT_STREAK_FOR_S_PLUS || topPercent <= 3) return 'S+';
    if (topPercent <= 10) return 'S';
    if (topPercent <= 30) return 'A';
    if (topPercent <= 60) return 'B';
    return 'C';
  }
  if (score >= thresholds['S+'] || perfectStreak >= PERFECT_STREAK_FOR_S_PLUS) return 'S+';
  if (score >= thresholds.S) return 'S';
  if (score >= thresholds.A) return 'A';
  if (score >= thresholds.B) return 'B';
  return 'C';
}

/** §4.4 종료 사유 · 오입력 수로 고르는 개선 팁 3종 (§8.4 "팁은 실패 원인에서 자동 선택") */
export type TipReason = 'mistakes' | 'time' | 'hearts';

export const IMPROVEMENT_TIPS: Readonly<Record<TipReason, string>> = {
  mistakes: '막힘 판정을 먼저 읽어 보세요',
  time: '안전수를 먼저 찾으면 시간이 늘어납니다',
  hearts: '확실한 사슬부터 당기세요',
};

export function tipFor(reason: TipReason): string {
  return IMPROVEMENT_TIPS[reason];
}
