// 게임 코어 공용 타입 — Phaser·DOM에 의존하지 않는다 (§16.2)
//
// WU-01은 입력 계층에 필요한 타입만 두었고, WU-02가 격자·사슬·퍼즐 상태 타입을 얹는다
// (§16.2 폴더 표 "사슬·보드·파라미터 타입 추가 예정").

/**
 * 게임 명칭 (§16.4 — 이름은 설정 상수 1곳).
 * 코드 안에서 게임 이름 문자열을 쓰는 곳은 여기 하나뿐이다. 씬·HUD·관리자 화면은 이 값을 읽는다.
 * `package.json`·`index.html`은 TS를 import 할 수 없는 빌드 메타데이터라 리터럴을 갖고,
 * `scaffold.test.ts`의 파생 검사가 이 상수와의 어긋남을 잡는다.
 */
export const GAME_TITLE = 'ARROW OUT';

/**
 * 추상 입력 10종 (§2.1).
 * 게임 코어는 물리 장치를 모르고 이 10종만 소비한다. I/O 보드가 정해지면 어댑터만 교체한다.
 */
export const INPUT_ACTIONS = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'BUTTON1',
  'BUTTON2',
  'START',
  'COIN',
  'SERVICE',
  'RESERVED',
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];

/** 1P / 2P. COIN·SERVICE는 공통 입력이지만 player 1로 태깅한다 (§2.1) */
export type PlayerId = 1 | 2;

// ── WU-02 퍼즐 코어 타입 (§3) ──────────────────────────────────────────────

/** 격자 점 — x = 0..12(좌→우), y = 0..18(상→하), 원점 좌상단 (§3.1) */
export interface GridPoint {
  readonly x: number;
  readonly y: number;
}

/** `grid.pointKey()`가 만든 격자 점 키 (0..246). 문자열 키를 쓰지 않아 판정 반복에서 할당이 없다 */
export type PointKey = number;

/** `grid.segmentKey()`가 만든 격자 선분 키 (0..493). 양 끝 순서에 무관한 정규형 */
export type SegmentKey = number;

/** 4방향 (§3.2 — 사슬은 상·하·좌·우로만 이어진다) */
export type Direction = 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';

/** 보드 안에서 사슬을 가리키는 식별자. 판정·정렬은 항상 이 값의 오름차순으로 결정적이다 */
export type ChainId = number;

/**
 * 사슬 상태 5종 (§3.2 — 동시에 하나만 갖는다).
 *
 * 코어(`Board`)가 실제로 쓰는 값은 `normal`·`blocked`·`removing`·`removed` 4종이다.
 * `focused`는 조작 계층(WU-03)의 선택 개념이라 코어가 세팅하지 않지만, §3.2의 5종 정의를
 * 타입에 그대로 남겨 둔다 (작업 계획 §2.4 가).
 */
export type ChainState = 'normal' | 'focused' | 'blocked' | 'removing' | 'removed';

/**
 * 사슬 — 불변 값이다. 상태(`ChainState`)와 점유는 `Board`가 소유한다 (작업 계획 P-3).
 *
 * `depth`는 **보드 생성 시점에 확정해 저장한 의존 깊이**다 (§5.1 "제거 시점에 다시 계산하지
 * 않는다" · §6.3 5단계). 점수 `60×D`·시간 회복 `0.08×D`·힌트 대상 선정이 이 값을 읽는다.
 */
export interface Chain {
  readonly id: ChainId;
  /** `P0 … P(L-1)` — 꼬리에서 머리 순서 */
  readonly points: readonly GridPoint[];
  /** 노드 수 L (§3.2). 선분 수 = L − 1 */
  readonly length: number;
  /** 굽힘 수 B — 진행 방향이 바뀌는 내부 점의 수 (§3.2) */
  readonly bends: number;
  /** 생성 확정 의존 깊이 D (§6.1 축 2 · §5.1) */
  readonly depth: number;
}

/** §3.7 처리 순서 ①~⑨. `pull()`·`tick()`이 실행한 단계를 이 열로 기록한다 (PZL-110) */
export type ProcessStep =
  | 'S1_INPUT_LOCK'
  | 'S2_VERDICT'
  | 'S3A_REMOVAL_BEGIN'
  | 'S3B_FAILURE'
  | 'S4_TIME'
  | 'S5_SCORE'
  | 'S6_REMOVAL_COMPLETE'
  | 'S7_RECOMPUTE'
  | 'S8_END_CHECK'
  | 'S9_UNLOCK';

/**
 * 주입 시계 — 코어의 유일한 시간 입구다 (§6.6 재현성).
 * 코어는 시스템 시각(월클럭·고해상도 타이머)을 직접 호출하지 않고 기본 시계도 export 하지 않는다.
 */
export interface Clock {
  /** 밀리초 단조 시각 */
  now(): number;
}
