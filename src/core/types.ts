// 게임 코어 공용 타입 — Phaser·DOM에 의존하지 않는다 (§16.2)
//
// WU-01은 입력 계층에 필요한 타입만 둔다. 격자·사슬·퍼즐 상태 타입은 WU-02 퍼즐 코어에서
// 추가한다 (§16.2 폴더 표).

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
