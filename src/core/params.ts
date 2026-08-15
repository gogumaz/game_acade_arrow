// 게임 파라미터 — §11.4 GAME PARAMETERS 중 **퍼즐 코어가 실제로 소비하는 25항목**만 담는다.
//
// 관리자 화면·`params.csv` 스키마·§11.5 저장 검증(단조성·솔버 게이트·등급 내림차순)은 WU-05 소관이며,
// 난이도 구간표·적응 난이도는 WU-08, 힌트 표시 시간·쿨다운·이름 입력 시간은 WU-03 소관이다
// (작업 계획 P-2). 여기 없는 §11.4 행을 넣으면 미사용 export 경고가 늘고 CSV 스키마 소유가 흐려진다.
//
// WU-05가 `params.csv`를 읽어 `Partial<CoreParams>`를 만들어 `resolveParams()`에 넘기면
// 코어 코드는 한 줄도 바뀌지 않는다.

/**
 * 운영자가 조정하는 원시 값 — 단위는 기획서 표기 그대로(초·배·%)다.
 * 코어 내부 계산은 전부 정수(ms·centis·percent)이며 변환은 `resolveParams()`가 진입 시 1회만 한다.
 */
export interface CoreParams {
  /** `SESSION TIME` — 세션 시간(초) §4.2 N1 */
  readonly sessionTimeSec: number;
  /** `INITIAL HEARTS` — 초기 하트 §4.2 N10 */
  readonly initialHearts: number;
  /** `CONTINUE` — 컨티뉴 허용 여부 §4.5 */
  readonly continueEnabled: boolean;
  /** `CONTINUE HEART RECOVER` — 컨티뉴 시 회복할 하트 §4.5 N4a */
  readonly continueHeartRecover: number;
  /** `CONTINUE TIME REFILL` — 컨티뉴 시 재충전할 시간(초) §4.5 N4b */
  readonly continueTimeRefillSec: number;
  /** `CONTINUE PROMPT TIME` — 컨티뉴 제안 카운트다운(초) §4.5 N4d. 코어는 보관만 하고 WU-03이 쓴다 */
  readonly continuePromptTimeSec: number;
  /** `TIME GAIN BASE` — 성공 시 기본 회복(초) §4.3 N2 */
  readonly timeGainBaseSec: number;
  /** `TIME GAIN PER DEPTH` — 의존 깊이 1당 추가 회복(초) §4.3 N2 */
  readonly timeGainPerDepthSec: number;
  /** `TIME GAIN CAP` — 1회 회복 상한(초) §4.3 N2b */
  readonly timeGainCapSec: number;
  /** `FAIL TIME PENALTY` — 실패 시 시간 페널티(초, 음수) §4.3 N3 */
  readonly failTimePenaltySec: number;
  /** 기본점 상수 §5.6 N6a */
  readonly scoreBase: number;
  /** 길이 계수 — `20 × max(L−3, 0)` §5.6 N6b */
  readonly scoreLengthCoef: number;
  /** 굽힘 계수 — `40 × B` §5.6 N6c */
  readonly scoreBendCoef: number;
  /** 의존 깊이 계수 — `60 × D` §5.6 N6d */
  readonly scoreDepthCoef: number;
  /** 콤보 창(초) §5.6 N6e */
  readonly comboWindowSec: number;
  /** 콤보 증분(배) §5.6 N6e */
  readonly comboStep: number;
  /** 콤보 상한(배) §5.6 N6f */
  readonly comboCap: number;
  /** 클리어 시간 계수 — `남은 시간(초, 버림) × 100` §5.6 N6g */
  readonly clearTimeCoef: number;
  /** 클리어 하트 계수 — `남은 하트 × 1,500` §5.6 N6h */
  readonly clearHeartCoef: number;
  /** 퍼펙트 보너스 §5.6 N6i */
  readonly perfectBonus: number;
  /** `HINT SCORE PENALTY` — 힌트 1회당 감점(%, 음수, 누적) §7.2 N5a */
  readonly hintScorePenaltyPercent: number;
  /** `HINT PENALTY CAP` — 보드당 누적 감점 상한(%, 음수) §7.2 N5a′ */
  readonly hintPenaltyCapPercent: number;
  /** `SLIDE OUT BASE` — 슬라이드 아웃 기본 시간(초) §3.4 · §11.4 N16 */
  readonly slideOutBaseSec: number;
  /** `SLIDE OUT PER SEGMENT` — 선분 1개당 추가 시간(초) §3.4 · N16 */
  readonly slideOutPerSegmentSec: number;
  /** `SLIDE OUT CAP` — 슬라이드 아웃 상한(초) §3.4 · N16 */
  readonly slideOutCapSec: number;
}

/**
 * 공장 기본값 — 기획서가 확정한 N 값 그대로다.
 * 이 25개 리터럴은 `tests/wu02/replay.test.ts`가 문자 단위로 고정한다.
 */
export const FACTORY_PARAMS: Readonly<CoreParams> = {
  sessionTimeSec: 120,
  initialHearts: 3,
  continueEnabled: true,
  continueHeartRecover: 3,
  continueTimeRefillSec: 120,
  continuePromptTimeSec: 10,
  timeGainBaseSec: 0.25,
  timeGainPerDepthSec: 0.08,
  timeGainCapSec: 0.9,
  failTimePenaltySec: -3,
  scoreBase: 100,
  scoreLengthCoef: 20,
  scoreBendCoef: 40,
  scoreDepthCoef: 60,
  comboWindowSec: 2.2,
  comboStep: 0.15,
  comboCap: 2.5,
  clearTimeCoef: 100,
  clearHeartCoef: 1500,
  perfectBonus: 5000,
  hintScorePenaltyPercent: -20,
  hintPenaltyCapPercent: -60,
  slideOutBaseSec: 0.18,
  slideOutPerSegmentSec: 0.022,
  slideOutCapSec: 0.75,
};

/** `continueEnabled`(ON/OFF)를 제외한 수치 파라미터 24종 */
export type NumericParamKey = Exclude<keyof CoreParams, 'continueEnabled'>;

/** §11.4 조정 범위 1행 */
export interface ParamRange {
  /** §11.4 항목명 그대로. WU-05가 이 이름으로 `params.csv`를 만든다 */
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly group: string;
}

/**
 * §11.4 조정 범위 표.
 *
 * `CONTINUE HEART RECOVER`(1 ~ 초기 하트)와 `CONTINUE TIME REFILL`(45초 ~ 세션 시간)은
 * 상한이 다른 파라미터에 의존한다. 여기에는 **절대 상한**(각각 `INITIAL HEARTS` 최댓값 9,
 * `SESSION TIME` 최댓값 150)을 적고, 의존 상한은 `validateCoreParams()`가 함께 검사한다.
 */
export const PARAM_RANGES: Readonly<Record<NumericParamKey, ParamRange>> = {
  sessionTimeSec: { label: 'SESSION TIME', min: 90, max: 150, unit: '초', group: '세션' },
  initialHearts: { label: 'INITIAL HEARTS', min: 1, max: 9, unit: '개', group: '세션' },
  continueHeartRecover: {
    label: 'CONTINUE HEART RECOVER',
    min: 1,
    max: 9,
    unit: '개',
    group: '세션',
  },
  continueTimeRefillSec: {
    label: 'CONTINUE TIME REFILL',
    min: 45,
    max: 150,
    unit: '초',
    group: '세션',
  },
  continuePromptTimeSec: {
    label: 'CONTINUE PROMPT TIME',
    min: 5,
    max: 20,
    unit: '초',
    group: '세션',
  },
  timeGainBaseSec: { label: 'TIME GAIN BASE', min: 0, max: 0.5, unit: '초', group: '시간' },
  timeGainPerDepthSec: {
    label: 'TIME GAIN PER DEPTH',
    min: 0,
    max: 0.2,
    unit: '초',
    group: '시간',
  },
  timeGainCapSec: { label: 'TIME GAIN CAP', min: 0, max: 1.2, unit: '초', group: '시간' },
  failTimePenaltySec: { label: 'FAIL TIME PENALTY', min: -5, max: 0, unit: '초', group: '시간' },
  scoreBase: { label: '기본점 상수', min: 50, max: 200, unit: '점', group: '점수' },
  scoreLengthCoef: { label: '길이 계수', min: 0, max: 50, unit: '점', group: '점수' },
  scoreBendCoef: { label: '굽힘 계수', min: 0, max: 100, unit: '점', group: '점수' },
  scoreDepthCoef: { label: '의존 깊이 계수', min: 0, max: 150, unit: '점', group: '점수' },
  comboWindowSec: { label: '콤보 창', min: 1, max: 4, unit: '초', group: '점수' },
  comboStep: { label: '콤보 증분', min: 0.05, max: 0.5, unit: '배', group: '점수' },
  comboCap: { label: '콤보 상한', min: 1.5, max: 5, unit: '배', group: '점수' },
  clearTimeCoef: { label: '클리어 시간 계수', min: 0, max: 300, unit: '점', group: '점수' },
  clearHeartCoef: { label: '클리어 하트 계수', min: 0, max: 5000, unit: '점', group: '점수' },
  perfectBonus: { label: '퍼펙트 보너스', min: 0, max: 20000, unit: '점', group: '점수' },
  hintScorePenaltyPercent: {
    label: 'HINT SCORE PENALTY',
    min: -50,
    max: 0,
    unit: '%',
    group: '힌트',
  },
  hintPenaltyCapPercent: {
    label: 'HINT PENALTY CAP',
    min: -100,
    max: -40,
    unit: '%',
    group: '힌트',
  },
  slideOutBaseSec: { label: 'SLIDE OUT BASE', min: 0.1, max: 0.3, unit: '초', group: '연출' },
  slideOutPerSegmentSec: {
    label: 'SLIDE OUT PER SEGMENT',
    min: 0.01,
    max: 0.04,
    unit: '초',
    group: '연출',
  },
  slideOutCapSec: { label: 'SLIDE OUT CAP', min: 0.5, max: 1, unit: '초', group: '연출' },
};

/** 범위를 벗어난 파라미터 1건 */
export interface ParamViolation {
  readonly key: NumericParamKey;
  readonly value: number;
  /** 실제로 적용된 범위. 의존 상한이 걸린 항목은 해소된 상한이 들어 있다 */
  readonly range: ParamRange;
}

/** 검사 순서 고정 — 위반 목록이 항상 같은 순서로 나온다 */
const NUMERIC_PARAM_KEYS = Object.keys(PARAM_RANGES) as NumericParamKey[];

/** §11.4의 의존 상한(1 ~ 초기 하트 / 45초 ~ 세션 시간)을 해소한 범위 */
function effectiveRange(key: NumericParamKey, p: CoreParams): ParamRange {
  const base = PARAM_RANGES[key];
  if (key === 'continueHeartRecover') return { ...base, max: p.initialHearts };
  if (key === 'continueTimeRefillSec') return { ...base, max: p.sessionTimeSec };
  return base;
}

/**
 * §11.4 **범위 검사만** 한다. §11.5의 단조성·솔버 게이트·등급 내림차순은 WU-05 소관이다.
 * 반환은 `PARAM_RANGES` 선언 순서를 따르는 결정적 목록이다.
 */
export function validateCoreParams(p: CoreParams): readonly ParamViolation[] {
  const out: ParamViolation[] = [];
  for (const key of NUMERIC_PARAM_KEYS) {
    const value = p[key];
    const range = effectiveRange(key, p);
    if (value < range.min || value > range.max) out.push({ key, value, range });
  }
  return out;
}

/**
 * 코어 내부 단위 — **전부 정수**다 (작업 계획 P-4).
 * 시간은 ms, 콤보는 1/100 단위(centis, 100 = ×1.00), 힌트 계수는 정수 퍼센트.
 * 부동소수 누적으로 점수가 1점 흔들리는 경로를 원천 차단한다.
 */
export interface ResolvedParams {
  readonly sessionTimeMs: number;
  readonly initialHearts: number;
  readonly continueEnabled: boolean;
  readonly continueHeartRecover: number;
  readonly continueTimeRefillMs: number;
  readonly continuePromptTimeMs: number;
  readonly timeGainBaseMs: number;
  readonly timeGainPerDepthMs: number;
  readonly timeGainCapMs: number;
  /** 음수 (공장값 −3000) */
  readonly failTimePenaltyMs: number;
  readonly scoreBase: number;
  readonly scoreLengthCoef: number;
  readonly scoreBendCoef: number;
  readonly scoreDepthCoef: number;
  readonly comboWindowMs: number;
  /** 공장값 15 = +0.15배 */
  readonly comboStepCentis: number;
  /** 공장값 250 = ×2.50 */
  readonly comboCapCentis: number;
  readonly clearTimeCoef: number;
  readonly clearHeartCoef: number;
  readonly perfectBonus: number;
  /** 음수 (공장값 −20) */
  readonly hintScorePenaltyPercent: number;
  /** 음수 (공장값 −60) */
  readonly hintPenaltyCapPercent: number;
  readonly slideOutBaseMs: number;
  readonly slideOutPerSegmentMs: number;
  readonly slideOutCapMs: number;
}

/** 초 → ms. `0.022 × 1000 = 22.000000000000004` 같은 부동소수 잔차를 여기서 끊는다 */
function toMs(sec: number): number {
  return Math.round(sec * 1000);
}

/** 배율 → centis(1/100). `0.15 → 15` */
function toCentis(ratio: number): number {
  return Math.round(ratio * 100);
}

/** `FACTORY_PARAMS`에 `overrides`를 얹고 정수 내부 단위로 변환한다 */
export function resolveParams(overrides?: Partial<CoreParams>): ResolvedParams {
  const p: CoreParams = { ...FACTORY_PARAMS, ...overrides };
  return {
    sessionTimeMs: toMs(p.sessionTimeSec),
    initialHearts: Math.round(p.initialHearts),
    continueEnabled: p.continueEnabled,
    continueHeartRecover: Math.round(p.continueHeartRecover),
    continueTimeRefillMs: toMs(p.continueTimeRefillSec),
    continuePromptTimeMs: toMs(p.continuePromptTimeSec),
    timeGainBaseMs: toMs(p.timeGainBaseSec),
    timeGainPerDepthMs: toMs(p.timeGainPerDepthSec),
    timeGainCapMs: toMs(p.timeGainCapSec),
    failTimePenaltyMs: toMs(p.failTimePenaltySec),
    scoreBase: Math.round(p.scoreBase),
    scoreLengthCoef: Math.round(p.scoreLengthCoef),
    scoreBendCoef: Math.round(p.scoreBendCoef),
    scoreDepthCoef: Math.round(p.scoreDepthCoef),
    comboWindowMs: toMs(p.comboWindowSec),
    comboStepCentis: toCentis(p.comboStep),
    comboCapCentis: toCentis(p.comboCap),
    clearTimeCoef: Math.round(p.clearTimeCoef),
    clearHeartCoef: Math.round(p.clearHeartCoef),
    perfectBonus: Math.round(p.perfectBonus),
    hintScorePenaltyPercent: Math.round(p.hintScorePenaltyPercent),
    hintPenaltyCapPercent: Math.round(p.hintPenaltyCapPercent),
    slideOutBaseMs: toMs(p.slideOutBaseSec),
    slideOutPerSegmentMs: toMs(p.slideOutPerSegmentSec),
    slideOutCapMs: toMs(p.slideOutCapSec),
  };
}
