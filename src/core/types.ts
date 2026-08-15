// 게임 코어 공용 타입 — Phaser·DOM에 의존하지 않는다 (§1.4 · 부록 E.3)
//
// WU-01은 입력 계층에 필요한 타입만 둔다. 보드·블록·엔진 이벤트 타입(PieceType·BOARD_W·
// PieceState·EngineEvent)은 WU-02 게임 규칙 계층에서 추가한다.

/**
 * 추상 입력 10종 (§2.1).
 * 게임 코어는 물리 장치를 모르고 이 10종만 소비한다. I/O 보드가 정해지면 어댑터만 교체한다.
 */
export const INPUT_ACTIONS = [
  'UP',
  'DOWN',
  'LEFT',
  'RIGHT',
  'ROTATE',
  'PLACE',
  'START',
  'COIN',
  'ADMIN',
  'DAILY',
] as const;

export type InputAction = (typeof INPUT_ACTIONS)[number];

/** 1P / 2P. COIN·ADMIN·DAILY는 공통 입력이지만 player 1로 태깅한다 (§2.2) */
export type PlayerId = 1 | 2;
