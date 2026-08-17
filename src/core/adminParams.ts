// 관리자 파라미터 문서 — §11.3 · §11.4 전 항목 + §11.5 저장 검증 (WU-05 작업 계획 P-2 · P-3)
//
// **`CoreParams`(25항목)를 확장하지 않는다.** `tests/wu02/replay.test.ts`가 `FACTORY_PARAMS`를
// 25키 리터럴로 고정했기 때문이다(실측 제약 F-a). 대신 `AdminParams`가 코어를 **감싸는 상위 문서**로
// §11.4 전량(구간표·등급·힌트 시간·적응 난이도)과 §11.3 기기 설정을 소유하고, `toCoreParams()`
// 투영으로만 코어에 값을 넘긴다. 코어 코드는 한 줄도 바뀌지 않는다.
//
// **항목별 코드를 쓰지 않는다.** `FIELD_SCHEMA` 배열 1개를 화면·편집·CSV·검증·감사가 함께 읽는다.
// 항목 추가는 배열에 1행을 넣는 것으로 끝나야 한다(P-3). 코어 25항목의 범위·라벨·단위는
// `PARAM_RANGES`에서 **읽어 온다** — 숫자를 두 번 적지 않는다.
//
// 이 파일은 순수하다: Phaser·DOM·시계·파일을 모른다. 그래서 8그룹 편집·검증 전량이 Node
// 테스트로 판정된다. 솔버 포트 타입이 여기 있는 이유는 eslint 규칙 ①(`src/core/`는 `../game/*`를
// import 할 수 없다) 때문이다 — 상수·스텁 구현은 계획대로 `src/game/admin/solverGate.ts`에 있다.

import {
  PARAM_RANGES,
  validateCoreParams,
  type CoreParams,
  type NumericParamKey,
  FACTORY_PARAMS,
} from './params';

// ── 난이도 구간 (§6.2) ─────────────────────────────────────────────────────

/**
 * §6.2 구간 5종. `src/game/boardSource.ts`의 `Tier`와 **같은 문자열 집합**이며,
 * 두 목록이 어긋나지 않는지는 `tests/wu05/adminParams.test.ts`가 전수 대조한다.
 * (core는 game을 import 할 수 없어 타입을 공유할 수 없다 — eslint 규칙 ①)
 */
export type ParamTier = 'WARMUP' | 'RHYTHM' | 'PRESSURE' | 'MASTER' | 'ENDLESS';

export const PARAM_TIERS: readonly ParamTier[] = [
  'WARMUP',
  'RHYTHM',
  'PRESSURE',
  'MASTER',
  'ENDLESS',
];

/** §6.2 구간표의 네 축 */
type TierAxis = 'chains' | 'safeMoves' | 'depth' | 'targetSec';

export const TIER_AXES: readonly TierAxis[] = ['chains', 'safeMoves', 'depth', 'targetSec'];

/** §11.5 단조성 검사 대상 — 기획서 문언이 지목한 **사슬 수·의존 깊이** 두 축뿐이다 */
export const MONOTONIC_AXES: readonly TierAxis[] = ['chains', 'depth'];

export const TIER_AXIS_LABEL: Readonly<Record<TierAxis, string>> = {
  chains: '사슬 수',
  safeMoves: '초기 안전수',
  depth: '의존 깊이',
  targetSec: '목표 시간',
};

export const TIER_LABEL: Readonly<Record<ParamTier, string>> = {
  WARMUP: '1~3 워밍업',
  RHYTHM: '4~6 리듬',
  PRESSURE: '7~9 압박',
  MASTER: '10~12 마스터',
  ENDLESS: '13+ 엔드리스',
};

/** §6.2 "조정 범위는 사슬 수 4~60, 안전수 1~10, 의존 깊이 1~30, 목표 시간 5~90초" */
export const TIER_AXIS_RANGE: Readonly<
  Record<TierAxis, { readonly min: number; readonly max: number; readonly unit: string }>
> = {
  chains: { min: 4, max: 60, unit: '개' },
  safeMoves: { min: 1, max: 10, unit: '개' },
  depth: { min: 1, max: 30, unit: '' },
  targetSec: { min: 5, max: 90, unit: '초' },
};

interface MinMax {
  readonly min: number;
  readonly max: number;
}

interface TierSpec {
  readonly chains: MinMax;
  readonly safeMoves: MinMax;
  readonly depth: MinMax;
  readonly targetSec: MinMax;
}

export type DifficultyPreset = 'KIDS' | 'STANDARD' | 'HARD';

export const DIFFICULTY_PRESETS: readonly DifficultyPreset[] = ['KIDS', 'STANDARD', 'HARD'];

// ── 문서 타입 (§11.3 · §11.4) ──────────────────────────────────────────────

/** §11.4 힌트·랭킹 중 **WU-03 소관 시간 3종**. 코어가 아니라 flow가 소비한다 */
interface UiParams {
  /** `HINT SHOW TIME` §7.2 N5c */
  readonly hintShowSec: number;
  /** `HINT COOLDOWN` §7.2 N5d */
  readonly hintCooldownSec: number;
  /** `NAME ENTRY TIME` §5.7 N13c */
  readonly nameEntrySec: number;
}

/** §5.6 N7a~d 고정 임계 + §5.5 분포 전환 표본 수 */
interface GradeParams {
  readonly sPlus: number;
  readonly s: number;
  readonly a: number;
  readonly b: number;
  /** 최근 유료 세션 표본이 이 수 이상이면 백분위로 전환한다 (§5.5) */
  readonly sampleThreshold: number;
}

/** §6.5 적응 난이도 (N9a~c) + §6.2 프리셋 */
interface DifficultyParams {
  readonly preset: DifficultyPreset;
  readonly adaptive: boolean;
  /** 판정 창 보드 수 N9a */
  readonly window: number;
  /** 상향 임계 % N9b */
  readonly upPercent: number;
  /** 하향 임계 % N9c */
  readonly downPercent: number;
  /** 하향 임계 오입력 수 N9c */
  readonly downMistakes: number;
}

/** §11.3 MACHINE SETTINGS 7행 (settings.csv 소유) */
export interface MachineParams {
  readonly soundVolume: number;
  readonly attractVolume: number;
  readonly nightMuteOn: boolean;
  /** `HH:MM` */
  readonly nightMuteStart: string;
  readonly nightMuteEnd: string;
  readonly coinsPerPlay: number;
  readonly continueCoins: number;
  /** §11.3 N11c — 미설정이면 `null` (ESTIMATED GROSS를 숨긴다) */
  readonly coinUnitPrice: number | null;
  readonly motionReduce: boolean;
}

/** §11.4 전량 + §11.3. **불변 값**이므로 컨트롤러가 `live`/`draft` 두 참조를 드는 것이 작업 사본이다 */
export interface AdminParams {
  readonly core: CoreParams;
  readonly ui: UiParams;
  readonly grade: GradeParams;
  readonly difficulty: DifficultyParams;
  readonly tiers: Readonly<Record<ParamTier, TierSpec>>;
  readonly machine: MachineParams;
}

/** §12.1 — 저장 데이터 버전. 공장 버전과 다르면 편집분을 폐기하고 공장값을 쓴다 */
export const PARAM_DATA_VERSION = 1;

export const FACTORY_TIERS: Readonly<Record<ParamTier, TierSpec>> = {
  WARMUP: {
    chains: { min: 6, max: 12 },
    safeMoves: { min: 3, max: 5 },
    depth: { min: 2, max: 4 },
    targetSec: { min: 8, max: 15 },
  },
  RHYTHM: {
    chains: { min: 12, max: 18 },
    safeMoves: { min: 2, max: 4 },
    depth: { min: 4, max: 7 },
    targetSec: { min: 12, max: 20 },
  },
  PRESSURE: {
    chains: { min: 18, max: 25 },
    safeMoves: { min: 2, max: 3 },
    depth: { min: 7, max: 11 },
    targetSec: { min: 18, max: 28 },
  },
  MASTER: {
    chains: { min: 24, max: 34 },
    safeMoves: { min: 1, max: 2 },
    depth: { min: 10, max: 16 },
    targetSec: { min: 25, max: 40 },
  },
  // §6.2는 엔드리스 목표 시간을 "적응형"으로만 적었다. §4.3 세션 예산 검산표가 이 구간을
  // **38.0초**로 계산했으므로 그 값을 공장값으로 고정한다 (계획 Q-4)
  ENDLESS: {
    chains: { min: 28, max: 40 },
    safeMoves: { min: 1, max: 3 },
    depth: { min: 12, max: 20 },
    targetSec: { min: 38, max: 38 },
  },
};

export const FACTORY_ADMIN_PARAMS: Readonly<AdminParams> = {
  core: FACTORY_PARAMS,
  ui: { hintShowSec: 2.5, hintCooldownSec: 5, nameEntrySec: 15 },
  grade: { sPlus: 300000, s: 200000, a: 125000, b: 65000, sampleThreshold: 200 },
  difficulty: {
    preset: 'STANDARD',
    adaptive: true,
    window: 2,
    upPercent: 70,
    downPercent: 150,
    downMistakes: 2,
  },
  tiers: FACTORY_TIERS,
  machine: {
    soundVolume: 80,
    attractVolume: 30,
    nightMuteOn: true,
    nightMuteStart: '22:00',
    nightMuteEnd: '10:00',
    coinsPerPlay: 1,
    continueCoins: 1,
    coinUnitPrice: null,
    motionReduce: false,
  },
};

// ── 필드 스키마 (§4 — 화면·편집·CSV·검증·감사의 단일 근거) ─────────────────

export type FieldKey = string;

export type FieldGroup =
  '세션' | '시간' | '난이도' | '구간표' | '연출' | '힌트' | '점수' | '등급' | '랭킹' | '기기';

type FieldType = 'int' | 'float' | 'percent' | 'seconds' | 'toggle' | 'enum' | 'clock';

/** admin §4.3 반영 시점 표기 */
type ApplyTiming = 'LIVE' | 'NEXT GAME' | 'NEXT CHARGE' | 'RESTART REQUIRED';

/** 값을 실제로 소비하는 곳. `store`는 저장만 되고 아직 소비처가 없다는 뜻이다 */
type FieldBinding = 'core' | 'flow' | 'stats' | 'credits' | 'generator' | 'store';

type PendingUnit = 'WU-07' | 'WU-08';

export type ParamFile = 'params' | 'settings';

type WarnRule = 'HEARTS' | 'TIME_GAIN_CAP';

export type FieldValue = number | boolean | string | null;

/** 편집 셀 1개 = `params.csv` 1행 = 검증 1건 */
export interface FieldCell {
  readonly key: FieldKey;
  readonly type: FieldType;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** `COIN UNIT PRICE`처럼 "미설정(null)"이 유효한 값인가 */
  readonly nullable?: boolean;
  readonly options?: readonly string[];
}

/** 화면 1행. 구간표는 `MIN ~ MAX` 2셀, `NIGHT MUTE`는 3셀이다 */
export interface FieldSpec {
  readonly id: string;
  readonly label: string;
  readonly group: FieldGroup;
  readonly file: ParamFile;
  readonly cells: readonly FieldCell[];
  readonly unit: string;
  readonly applyTiming: ApplyTiming;
  readonly binding: FieldBinding;
  /** 셀 사이 구분자 — 구간표는 `~` */
  readonly separator?: string;
  /** `binding === 'store'`인 행이 화면에 다는 배지 (R6 — 반영 안 되는 값을 반영된 척하지 않는다) */
  readonly pendingUnit?: PendingUnit;
  /** §11.4 "고급 개별 필드는 프리셋 아래 하위 화면" */
  readonly advanced?: boolean;
  readonly warnRule?: WarnRule;
  readonly note?: string;
}

/** `1/60` 같은 나눗셈 잔차를 막고 `0.1 + 0.2` 누적을 끊는다 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** `PARAM_RANGES` 1행 → 편집 행 1개. **숫자를 다시 적지 않는다** (P-2) */
function coreField(
  key: NumericParamKey,
  type: FieldType,
  step: number,
  extra: Partial<FieldSpec> = {}
): FieldSpec {
  const range = PARAM_RANGES[key];
  return {
    id: `core.${key}`,
    label: range.label,
    group: range.group as FieldGroup,
    file: 'params',
    cells: [{ key: `core.${key}`, type, min: range.min, max: range.max, step }],
    unit: range.unit,
    applyTiming: 'NEXT GAME',
    binding: 'core',
    ...extra,
  };
}

function toggleField(
  id: FieldKey,
  label: string,
  group: FieldGroup,
  extra: Partial<FieldSpec> = {}
): FieldSpec {
  return {
    id,
    label,
    group,
    file: 'params',
    cells: [{ key: id, type: 'toggle', min: 0, max: 1, step: 1 }],
    unit: '',
    applyTiming: 'NEXT GAME',
    binding: 'core',
    ...extra,
  };
}

function plainField(
  id: FieldKey,
  label: string,
  group: FieldGroup,
  cell: Omit<FieldCell, 'key'>,
  extra: Partial<FieldSpec> = {}
): FieldSpec {
  return {
    id,
    label,
    group,
    file: 'params',
    cells: [{ key: id, ...cell }],
    unit: '',
    applyTiming: 'NEXT GAME',
    binding: 'store',
    ...extra,
  };
}

/** 구간표 1행 = `MIN ~ MAX` 2셀 (계획 Q-2 — 4필드는 각각 범위 쌍이다) */
function tierField(tier: ParamTier, axis: TierAxis): FieldSpec {
  const range = TIER_AXIS_RANGE[axis];
  const cell = { type: 'int' as FieldType, min: range.min, max: range.max, step: 1 };
  return {
    id: `tiers.${tier}.${axis}`,
    label: `${TIER_LABEL[tier]} ${TIER_AXIS_LABEL[axis]}`,
    group: '구간표',
    file: 'params',
    cells: [
      { key: `tiers.${tier}.${axis}.min`, ...cell },
      { key: `tiers.${tier}.${axis}.max`, ...cell },
    ],
    unit: range.unit,
    applyTiming: 'NEXT GAME',
    binding: 'generator',
    separator: '~',
    advanced: true,
  };
}

function tierRows(): FieldSpec[] {
  const rows: FieldSpec[] = [];
  for (const tier of PARAM_TIERS) for (const axis of TIER_AXES) rows.push(tierField(tier, axis));
  return rows;
}

/**
 * §11.4 GAME PARAMETERS 59행(수치 79) + §11.3 MACHINE SETTINGS 7행(수치 9).
 * 선언 순서가 곧 `params.csv` 행 순서이므로 왕복 비교가 문자열 비교로 끝난다 (P-4).
 */
export const FIELD_SCHEMA: readonly FieldSpec[] = [
  // ── 세션 6 (§11.4) ──
  coreField('sessionTimeSec', 'seconds', 1),
  coreField('initialHearts', 'int', 1, { warnRule: 'HEARTS', note: '권장 2~5 (회전율)' }),
  toggleField('core.continueEnabled', 'CONTINUE', '세션'),
  coreField('continueHeartRecover', 'int', 1, { note: '상한은 INITIAL HEARTS' }),
  coreField('continueTimeRefillSec', 'seconds', 1, { note: '상한은 SESSION TIME' }),
  coreField('continuePromptTimeSec', 'seconds', 1),
  // ── 시간 4 ──
  coreField('timeGainBaseSec', 'float', 0.01),
  coreField('timeGainPerDepthSec', 'float', 0.01),
  coreField('timeGainCapSec', 'float', 0.05, { warnRule: 'TIME_GAIN_CAP' }),
  coreField('failTimePenaltySec', 'float', 0.5),
  // ── 난이도 6 ──
  plainField(
    'difficulty.preset',
    'DIFFICULTY PRESET',
    '난이도',
    {
      type: 'enum',
      min: 0,
      max: DIFFICULTY_PRESETS.length - 1,
      step: 1,
      options: DIFFICULTY_PRESETS,
    },
    { binding: 'generator', note: '구간표 20행을 통째로 갈아 끼운다' }
  ),
  plainField(
    'difficulty.adaptive',
    'ADAPTIVE DIFFICULTY',
    '난이도',
    { type: 'toggle', min: 0, max: 1, step: 1 },
    { binding: 'generator' }
  ),
  plainField(
    'difficulty.window',
    'ADAPTIVE WINDOW',
    '난이도',
    { type: 'int', min: 1, max: 5, step: 1 },
    { unit: '보드', binding: 'generator', advanced: true }
  ),
  plainField(
    'difficulty.upPercent',
    'ADAPTIVE UP THRESHOLD',
    '난이도',
    { type: 'percent', min: 50, max: 90, step: 5 },
    { unit: '%', binding: 'generator', advanced: true }
  ),
  plainField(
    'difficulty.downPercent',
    'ADAPTIVE DOWN THRESHOLD',
    '난이도',
    { type: 'percent', min: 110, max: 200, step: 5 },
    { unit: '%', binding: 'generator', advanced: true }
  ),
  plainField(
    'difficulty.downMistakes',
    'ADAPTIVE DOWN MISTAKES',
    '난이도',
    { type: 'int', min: 1, max: 5, step: 1 },
    { unit: '회', binding: 'generator', advanced: true }
  ),
  // ── 구간표 20 (5구간 × 4축 × MIN/MAX = 수치 40) ──
  ...tierRows(),
  // ── 연출 3 ──
  coreField('slideOutBaseSec', 'float', 0.01),
  coreField('slideOutPerSegmentSec', 'float', 0.001),
  coreField('slideOutCapSec', 'float', 0.05, { note: '콤보 창의 50% 이하 권장' }),
  // ── 힌트 4 ──
  coreField('hintScorePenaltyPercent', 'percent', 5),
  coreField('hintPenaltyCapPercent', 'percent', 5),
  plainField(
    'ui.hintShowSec',
    'HINT SHOW TIME',
    '힌트',
    { type: 'seconds', min: 1, max: 5, step: 0.5 },
    { unit: '초', binding: 'flow' }
  ),
  plainField(
    'ui.hintCooldownSec',
    'HINT COOLDOWN',
    '힌트',
    { type: 'seconds', min: 0, max: 15, step: 0.5 },
    { unit: '초', binding: 'flow' }
  ),
  // ── 점수 10 (§5.6 N6a~i) ──
  coreField('scoreBase', 'int', 5),
  coreField('scoreLengthCoef', 'int', 1),
  coreField('scoreBendCoef', 'int', 5),
  coreField('scoreDepthCoef', 'int', 5),
  coreField('comboWindowSec', 'float', 0.1),
  coreField('comboStep', 'float', 0.05),
  coreField('comboCap', 'float', 0.1),
  coreField('clearTimeCoef', 'int', 5),
  coreField('clearHeartCoef', 'int', 50),
  coreField('perfectBonus', 'int', 100),
  // ── 등급 5 ──
  plainField(
    'grade.sPlus',
    'GRADE S+ THRESHOLD',
    '등급',
    { type: 'int', min: 0, max: 999999, step: 1000 },
    { unit: '점', binding: 'flow' }
  ),
  plainField(
    'grade.s',
    'GRADE S THRESHOLD',
    '등급',
    { type: 'int', min: 0, max: 999999, step: 1000 },
    { unit: '점', binding: 'flow' }
  ),
  plainField(
    'grade.a',
    'GRADE A THRESHOLD',
    '등급',
    { type: 'int', min: 0, max: 999999, step: 1000 },
    { unit: '점', binding: 'flow' }
  ),
  plainField(
    'grade.b',
    'GRADE B THRESHOLD',
    '등급',
    { type: 'int', min: 0, max: 999999, step: 1000 },
    { unit: '점', binding: 'flow' }
  ),
  plainField(
    'grade.sampleThreshold',
    'GRADE SAMPLE THRESHOLD',
    '등급',
    { type: 'int', min: 50, max: 1000, step: 10 },
    { unit: '표본', binding: 'stats', applyTiming: 'RESTART REQUIRED' }
  ),
  // ── 랭킹 1 ──
  plainField(
    'ui.nameEntrySec',
    'NAME ENTRY TIME',
    '랭킹',
    { type: 'seconds', min: 5, max: 60, step: 1 },
    { unit: '초', binding: 'flow' }
  ),
  // ── 기기 7 (§11.3 · settings.csv) ──
  {
    id: 'machine.soundVolume',
    label: 'SOUND VOLUME',
    group: '기기',
    file: 'settings',
    cells: [{ key: 'machine.soundVolume', type: 'int', min: 0, max: 100, step: 5 }],
    unit: '',
    applyTiming: 'LIVE',
    binding: 'store',
  },
  {
    id: 'machine.attractVolume',
    label: 'ATTRACT VOLUME',
    group: '기기',
    file: 'settings',
    cells: [{ key: 'machine.attractVolume', type: 'percent', min: 0, max: 60, step: 5 }],
    unit: '%',
    applyTiming: 'LIVE',
    binding: 'store',
  },
  {
    id: 'machine.nightMute',
    label: 'NIGHT MUTE',
    group: '기기',
    file: 'settings',
    cells: [
      { key: 'machine.nightMuteOn', type: 'toggle', min: 0, max: 1, step: 1 },
      { key: 'machine.nightMuteStart', type: 'clock', min: 0, max: 1410, step: 30 },
      { key: 'machine.nightMuteEnd', type: 'clock', min: 0, max: 1410, step: 30 },
    ],
    unit: '',
    applyTiming: 'LIVE',
    binding: 'store',
    separator: '~',
  },
  {
    id: 'machine.coinsPerPlay',
    label: 'COINS PER PLAY',
    group: '기기',
    file: 'settings',
    cells: [{ key: 'machine.coinsPerPlay', type: 'int', min: 1, max: 9, step: 1 }],
    unit: 'CREDIT',
    applyTiming: 'NEXT CHARGE',
    binding: 'credits',
  },
  {
    id: 'machine.continueCoins',
    label: 'CONTINUE COINS',
    group: '기기',
    file: 'settings',
    cells: [{ key: 'machine.continueCoins', type: 'int', min: 1, max: 9, step: 1 }],
    unit: 'CREDIT',
    applyTiming: 'NEXT CHARGE',
    binding: 'credits',
  },
  {
    id: 'machine.coinUnitPrice',
    label: 'COIN UNIT PRICE',
    group: '기기',
    file: 'settings',
    cells: [
      { key: 'machine.coinUnitPrice', type: 'int', min: 100, max: 5000, step: 100, nullable: true },
    ],
    unit: '원',
    applyTiming: 'LIVE',
    binding: 'credits',
    note: '미설정이면 ESTIMATED GROSS를 숨긴다',
  },
  {
    id: 'machine.motionReduce',
    label: 'MOTION REDUCE',
    group: '기기',
    file: 'settings',
    cells: [{ key: 'machine.motionReduce', type: 'toggle', min: 0, max: 1, step: 1 }],
    unit: '',
    applyTiming: 'NEXT GAME',
    binding: 'store',
  },
];

/** 편집 셀 전량 (선언 순서). CSV 직렬화·범위 검증이 이 순서를 그대로 쓴다 */
export const FIELD_CELLS: readonly FieldCell[] = FIELD_SCHEMA.flatMap((f) => f.cells);

const SPEC_BY_ID = new Map(FIELD_SCHEMA.map((f) => [f.id, f]));
const SPEC_BY_CELL = new Map<FieldKey, FieldSpec>();
const CELL_BY_KEY = new Map<FieldKey, FieldCell>();
for (const spec of FIELD_SCHEMA) {
  for (const cell of spec.cells) {
    SPEC_BY_CELL.set(cell.key, spec);
    CELL_BY_KEY.set(cell.key, cell);
  }
}

export function fieldOf(id: string): FieldSpec {
  const spec = SPEC_BY_ID.get(id);
  if (spec === undefined) throw new Error(`fieldOf: 알 수 없는 필드 ${id}`);
  return spec;
}

/** 셀 키 → 그 셀이 속한 화면 행. 감사 로그가 `라벨=값`을 만들 때 쓴다 */
export function specOfCell(key: FieldKey): FieldSpec | undefined {
  return SPEC_BY_CELL.get(key);
}

export function cellOf(key: FieldKey): FieldCell | undefined {
  return CELL_BY_KEY.get(key);
}

export function fieldsOfGroup(group: FieldGroup): readonly FieldSpec[] {
  return FIELD_SCHEMA.filter((f) => f.group === group);
}

export function fieldsOfFile(file: ParamFile): readonly FieldSpec[] {
  return FIELD_SCHEMA.filter((f) => f.file === file);
}

// ── 필드 읽기·쓰기 (점 표기 경로 1개로 전 항목 처리) ───────────────────────

type Bag = Record<string, unknown>;

function isBag(v: unknown): v is Bag {
  return typeof v === 'object' && v !== null;
}

/** `'tiers.WARMUP.chains.min'` → 값 (키 = TS 경로, Q-3). 경로가 없으면 `undefined` */
export function readField(p: AdminParams, key: FieldKey): FieldValue | undefined {
  let node: unknown = p;
  for (const part of key.split('.')) {
    if (!isBag(node)) return undefined;
    node = node[part];
  }
  if (node === null) return null;
  if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'string')
    return node;
  return undefined;
}

function writePath(node: unknown, path: readonly string[], value: FieldValue): unknown {
  if (path.length === 0) return value;
  if (!isBag(node)) throw new Error(`writeField: 경로가 객체가 아니다 (${path.join('.')})`);
  const [head, ...rest] = path;
  return { ...node, [head]: writePath(node[head], rest, value) };
}

/** 불변 갱신 — 원본은 절대 바뀌지 않는다 (작업 사본이 라이브를 오염시킬 경로가 구조적으로 없다) */
export function writeField(p: AdminParams, key: FieldKey, value: FieldValue): AdminParams {
  return writePath(p, key.split('.'), value) as AdminParams;
}

/** 코어로 가는 **유일한 통로** (P-2) */
export function toCoreParams(p: AdminParams): CoreParams {
  return p.core;
}

// ── 프리셋과 복원 (§11.4) ──────────────────────────────────────────────────

/**
 * §11.4 — `DIFFICULTY PRESET`은 구간표 20행만 통째로 갈아 끼운다.
 * KIDS는 사슬 수·의존 깊이를 §6.2 **하한**으로(안전수·목표 시간은 상한), HARD는 그 반대다.
 * 어떤 프리셋도 §6.2 조정 범위를 벗어나지 않고 단조성을 만족한다 (자동 테스트로 고정).
 */
export function applyPreset(p: AdminParams, preset: DifficultyPreset): AdminParams {
  const tiers: Record<ParamTier, TierSpec> = { ...p.tiers };
  for (const tier of PARAM_TIERS) {
    const base = FACTORY_TIERS[tier];
    tiers[tier] =
      preset === 'STANDARD'
        ? base
        : {
            chains: collapse(base.chains, preset === 'KIDS' ? 'min' : 'max'),
            safeMoves: collapse(base.safeMoves, preset === 'KIDS' ? 'max' : 'min'),
            depth: collapse(base.depth, preset === 'KIDS' ? 'min' : 'max'),
            targetSec: collapse(base.targetSec, preset === 'KIDS' ? 'max' : 'min'),
          };
  }
  return { ...p, difficulty: { ...p.difficulty, preset }, tiers };
}

function collapse(range: MinMax, edge: 'min' | 'max'): MinMax {
  const v = range[edge];
  return { min: v, max: v };
}

/** `RESTORE THIS PRESET` — 그룹 1개만 공장값으로. 작업 사본에만 적용된다 (ADM-205) */
export function restoreGroup(p: AdminParams, group: FieldGroup): AdminParams {
  let next = p;
  for (const spec of fieldsOfGroup(group)) {
    for (const cell of spec.cells) {
      const factory = readField(FACTORY_ADMIN_PARAMS, cell.key);
      if (factory === undefined) continue;
      next = writeField(next, cell.key, factory);
    }
  }
  return next;
}

// ── 세션 예산 검산 (§4.3) ──────────────────────────────────────────────────

/** §6.2 경계 — 1~3 / 4~6 / 7~9 / 10~12 / 13+ */
export function tierOfBoard(boardNumber: number): ParamTier {
  if (boardNumber <= 3) return 'WARMUP';
  if (boardNumber <= 6) return 'RHYTHM';
  if (boardNumber <= 9) return 'PRESSURE';
  if (boardNumber <= 12) return 'MASTER';
  return 'ENDLESS';
}

/** 순 소모가 0 이하라 타이머가 소진되지 않는 설정 — 도달 보드를 이 값으로 절단한다 */
export const SESSION_BUDGET_UNBOUNDED = 999;

interface TierBudget {
  readonly tier: ParamTier;
  readonly chainsMid: number;
  readonly depthMid: number;
  readonly avgLineDepth: number;
  readonly gainPerChain: number;
  readonly boardGain: number;
  readonly targetSec: number;
  readonly netCost: number;
}

function mid(range: MinMax): number {
  return (range.min + range.max) / 2;
}

/** §4.3 검산표를 그대로 코드로 옮긴 것. 평균 라인 깊이는 최대 의존 깊이 중앙값의 절반이다 */
export function tierBudget(p: AdminParams, tier: ParamTier): TierBudget {
  const spec = p.tiers[tier];
  const chainsMid = mid(spec.chains);
  const depthMid = mid(spec.depth);
  const avgLineDepth = depthMid / 2;
  const gainPerChain = Math.min(
    p.core.timeGainBaseSec + p.core.timeGainPerDepthSec * avgLineDepth,
    p.core.timeGainCapSec
  );
  const boardGain = round6(chainsMid * gainPerChain);
  const targetSec = mid(spec.targetSec);
  return {
    tier,
    chainsMid,
    depthMid,
    avgLineDepth,
    gainPerChain: round6(gainPerChain),
    boardGain,
    targetSec,
    netCost: round6(targetSec - boardGain),
  };
}

/** 각 보드까지의 누적 순 소모 — §4.3 표와 대조하기 위한 표면 */
export function sessionBudgetCumulative(p: AdminParams, boards: number): number {
  let acc = 0;
  for (let n = 1; n <= boards; n += 1) acc = round6(acc + tierBudget(p, tierOfBoard(n)).netCost);
  return acc;
}

/**
 * §11.5 경고 3 — 누적 순 소모가 세션 시간을 넘기 **직전까지의 보드 수**.
 * 공장값에서 13이며 §4.3의 "숙련자는 120초에 12~13보드"와 일치한다.
 */
export function sessionBudgetBoards(p: AdminParams): number {
  let acc = 0;
  for (let n = 1; n <= SESSION_BUDGET_UNBOUNDED; n += 1) {
    const cost = tierBudget(p, tierOfBoard(n)).netCost;
    if (cost <= 0) return SESSION_BUDGET_UNBOUNDED;
    acc = round6(acc + cost);
    if (acc > p.core.sessionTimeSec) return n - 1;
  }
  return SESSION_BUDGET_UNBOUNDED;
}

// ── 솔버 게이트 포트 (§11.5 · ADM-402 — 구현은 game/admin/solverGate.ts) ───

/** §11.5 "5구간 × 3시드 = 15보드, 검증 시간 상한 3초" */
export const SOLVER_GATE_SPEC = {
  tiers: 5,
  seedsPerTier: 3,
  boards: 15,
  timeBudgetMs: 3000,
} as const;

/** §11.5 오류 3사유 (§6.4 차단 조건 1·3·6) */
type SolverFailureReason = 'no_solution' | 'deadlock' | 'over_target_time';

interface SolverFailure {
  readonly tier: ParamTier;
  readonly seed: number;
  readonly reason: SolverFailureReason;
}

export interface SolverGateResult {
  readonly ok: boolean;
  readonly failures: readonly SolverFailure[];
  readonly elapsedMs: number;
  readonly boardsChecked: number;
  /** **스텁만** 세우는 필드. 실물 게이트는 절대 세우지 않는다 (WU-08에서 사라진다) */
  readonly pending?: PendingUnit;
}

export interface SolverGate {
  validate(p: AdminParams): SolverGateResult;
}

// ── 저장 검증 (§11.5) ──────────────────────────────────────────────────────

export type IssueCode =
  | 'RANGE'
  | 'TIER_MONOTONIC'
  | 'SOLVER'
  | 'GRADE_ORDER'
  | 'WARN_HEARTS'
  | 'WARN_TIME_GAIN_CAP'
  | 'WARN_SESSION_BUDGET';

export interface ValidationIssue {
  readonly code: IssueCode;
  readonly key?: FieldKey;
  readonly label: string;
  readonly detail: string;
}

export interface ValidationReport {
  /** 하나라도 있으면 저장·테스트 불가 (§11.5) */
  readonly errors: readonly ValidationIssue[];
  /** `H` 2초 홀드로 저장 가능 */
  readonly warnings: readonly ValidationIssue[];
  readonly solver: SolverGateResult;
  /** 세션 예산 검산 결과 (표시용) */
  readonly reachedBoards: number;
}

function labelOfCell(key: FieldKey): string {
  const spec = specOfCell(key);
  if (spec === undefined) return key;
  if (spec.cells.length === 1) return spec.label;
  const tail = key.slice(key.lastIndexOf('.') + 1).toUpperCase();
  return `${spec.label} ${tail}`;
}

function rangeIssues(p: AdminParams): ValidationIssue[] {
  const out: ValidationIssue[] = [];

  // 코어 25항목은 **`validateCoreParams()`를 그대로 부른다** — 의존 상한(1~초기 하트,
  // 45초~세션 시간)이 이미 거기에 있다. 재구현하면 두 곳이 어긋난다
  for (const v of validateCoreParams(p.core)) {
    out.push({
      code: 'RANGE',
      key: `core.${v.key}`,
      label: v.range.label,
      detail: `${String(v.value)}${v.range.unit} — 허용 ${String(v.range.min)}~${String(v.range.max)}${v.range.unit}`,
    });
  }

  for (const spec of FIELD_SCHEMA) {
    if (spec.binding === 'core') continue; // 위에서 이미 봤다
    for (const cell of spec.cells) {
      const value = readField(p, cell.key);
      if (value === null) {
        if (cell.nullable === true) continue;
        out.push({ code: 'RANGE', key: cell.key, label: labelOfCell(cell.key), detail: '값 없음' });
        continue;
      }
      if (value === undefined) {
        out.push({ code: 'RANGE', key: cell.key, label: labelOfCell(cell.key), detail: '값 없음' });
        continue;
      }
      const detail = outOfRange(cell, value);
      if (detail !== null) {
        out.push({ code: 'RANGE', key: cell.key, label: labelOfCell(cell.key), detail });
      }
    }
  }

  // 구간표는 `MIN ≤ MAX`도 함께 본다
  for (const tier of PARAM_TIERS) {
    for (const axis of TIER_AXES) {
      const range = p.tiers[tier][axis];
      if (range.min > range.max) {
        out.push({
          code: 'RANGE',
          key: `tiers.${tier}.${axis}.min`,
          label: `${TIER_LABEL[tier]} ${TIER_AXIS_LABEL[axis]}`,
          detail: `MIN ${String(range.min)} > MAX ${String(range.max)}`,
        });
      }
    }
  }
  return out;
}

/** 범위 밖이면 사유 문구, 아니면 null */
function outOfRange(cell: FieldCell, value: Exclude<FieldValue, null>): string | null {
  if (cell.type === 'toggle') {
    return typeof value === 'boolean' ? null : 'ON/OFF가 아니다';
  }
  if (cell.type === 'enum') {
    const options = cell.options ?? [];
    return options.includes(String(value)) ? null : `${String(value)} — 허용 ${options.join('/')}`;
  }
  if (cell.type === 'clock') {
    const minutes = clockToMinutes(String(value));
    if (minutes === null) return `${String(value)} — HH:MM 형식이 아니다`;
    return minutes >= cell.min && minutes <= cell.max ? null : `${String(value)} — 허용 시각 밖`;
  }
  if (typeof value !== 'number' || !Number.isFinite(value))
    return `${String(value)} — 수치가 아니다`;
  if (value < cell.min || value > cell.max) {
    return `${String(value)} — 허용 ${String(cell.min)}~${String(cell.max)}`;
  }
  return null;
}

/** `'22:00'` → 1320. 형식이 어긋나면 null */
export function clockToMinutes(text: string): number | null {
  const m = /^([0-9]{1,2}):([0-9]{2})$/.exec(text);
  if (m === null) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 1320 → `'22:00'` */
export function minutesToClock(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function monotonicIssues(p: AdminParams): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (let i = 1; i < PARAM_TIERS.length; i += 1) {
    const prev = PARAM_TIERS[i - 1];
    const cur = PARAM_TIERS[i];
    for (const axis of MONOTONIC_AXES) {
      for (const edge of ['min', 'max'] as const) {
        const before = p.tiers[prev][axis][edge];
        const after = p.tiers[cur][axis][edge];
        if (after < before) {
          out.push({
            code: 'TIER_MONOTONIC',
            key: `tiers.${cur}.${axis}.${edge}`,
            label: `${TIER_LABEL[cur]} ${TIER_AXIS_LABEL[axis]} ${edge.toUpperCase()}`,
            detail: `${String(after)} < ${TIER_LABEL[prev]} ${String(before)} — 뒤 구간이 더 쉬우면 안 된다`,
          });
        }
      }
    }
  }
  return out;
}

/** §11.5 — "S+ ≤ S 등"이 위반이므로 **동점도 오류**다 */
function gradeIssues(p: AdminParams): ValidationIssue[] {
  const order: readonly (readonly [string, number, string, number])[] = [
    ['S+', p.grade.sPlus, 'S', p.grade.s],
    ['S', p.grade.s, 'A', p.grade.a],
    ['A', p.grade.a, 'B', p.grade.b],
  ];
  const out: ValidationIssue[] = [];
  for (const [hi, hiValue, lo, loValue] of order) {
    if (hiValue <= loValue) {
      out.push({
        code: 'GRADE_ORDER',
        key: `grade.${hi === 'S+' ? 'sPlus' : hi.toLowerCase()}`,
        label: `GRADE ${hi} THRESHOLD`,
        detail: `${hi} ${String(hiValue)} ≤ ${lo} ${String(loValue)} — 내림차순이어야 한다`,
      });
    }
  }
  return out;
}

function solverIssues(result: SolverGateResult): ValidationIssue[] {
  if (result.elapsedMs > SOLVER_GATE_SPEC.timeBudgetMs) {
    return [
      {
        code: 'SOLVER',
        label: 'SOLVER GATE',
        detail: `검증 ${String(result.elapsedMs)}ms — 상한 ${String(SOLVER_GATE_SPEC.timeBudgetMs)}ms 초과`,
      },
    ];
  }
  if (result.ok) return [];
  if (result.failures.length === 0) {
    return [{ code: 'SOLVER', label: 'SOLVER GATE', detail: '솔버 미통과' }];
  }
  return result.failures.map((f) => ({
    code: 'SOLVER' as const,
    label: 'SOLVER GATE',
    detail: `${TIER_LABEL[f.tier]} 시드 ${String(f.seed)} — ${SOLVER_REASON_TEXT[f.reason]}`,
  }));
}

export const SOLVER_REASON_TEXT: Readonly<Record<SolverFailureReason, string>> = {
  no_solution: '해법 0개',
  deadlock: '순환 교착',
  over_target_time: '목표 시간 1.8배 초과',
};

function warningIssues(p: AdminParams, reachedBoards: number): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const hearts = p.core.initialHearts;
  if (hearts === 1 || (hearts >= 6 && hearts <= 9)) {
    out.push({
      code: 'WARN_HEARTS',
      key: 'core.initialHearts',
      label: PARAM_RANGES.initialHearts.label,
      detail: `${String(hearts)}개 — 회전율에 영향 (권장 2~5)`,
    });
  }
  if (p.core.timeGainCapSec > 1) {
    out.push({
      code: 'WARN_TIME_GAIN_CAP',
      key: 'core.timeGainCapSec',
      label: PARAM_RANGES.timeGainCapSec.label,
      detail: `${String(p.core.timeGainCapSec)}초 — 1.0초 초과, 회전율에 영향`,
    });
  }
  if (reachedBoards < 8 || reachedBoards > 20) {
    out.push({
      code: 'WARN_SESSION_BUDGET',
      label: '세션 예산',
      detail: `숙련자 도달 보드 ${String(reachedBoards)} — 권장 8~20`,
    });
  }
  return out;
}

/**
 * §11.5 저장 검증 — 오류 4종·경고 3종. 오류가 하나라도 있으면 저장·테스트가 불가하며
 * **전체 목록**을 돌려준다 (첫 항목 토스트로 끝내지 않는다 — admin §9.4).
 */
export function validateAdminParams(p: AdminParams, gate: SolverGate): ValidationReport {
  const solver = gate.validate(p);
  const reachedBoards = sessionBudgetBoards(p);
  return {
    errors: [...rangeIssues(p), ...monotonicIssues(p), ...solverIssues(solver), ...gradeIssues(p)],
    warnings: warningIssues(p, reachedBoards),
    solver,
    reachedBoards,
  };
}
