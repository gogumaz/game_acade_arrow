// WU-03 소관 시간 상수 1곳 (작업 계획 P-3)
//
// 코어 파라미터(`CoreParams`)가 소유한 값은 여기 두지 않는다. 특히 **CONTINUE 카운트다운**은
// `resolveParams().continuePromptTimeMs`(N4d)에서 읽는다 — `core/params.ts` 머리말이
// "힌트 표시 시간·쿨다운·이름 입력 시간은 WU-03 소관"이라고 소유를 갈라 두었기 때문이다.
//
// 화면 타이머는 전부 **데드라인 비교**(`now >= deadlineMs`)로 쓴다. 프레임 누적(`elapsed += dt`)은
// 프레임 드랍이 카운트다운을 늘려 SES-211을 흔들므로 쓰지 않는다 (작업 계획 §7.4).

// §2.3 포커스 이동 상한 60ms는 상수로 두지 않는다 — WU-03은 **보간을 아예 하지 않아**
// 상태 전환이 같은 프레임에 끝나므로 지킬 시간이 없다. 보간을 얹는 WU-07이 상수를 도입한다.

/** §7.2 N5c — 힌트 표시 시간 */
export const HINT_DISPLAY_MS = 2500;

/** §7.2 N5d — 힌트 쿨다운. **소비 시점 기준**(표시 2.5초 + 자력 판단 2.5초) */
export const HINT_COOLDOWN_MS = 5000;

/** §7.1 — 호흡형 외곽선 밝기 진동 주기 */
export const HINT_BREATH_MS = 1200;

/** §4.7 — 어트랙트 루프 1바퀴 (패널 3장 × 5000ms) */
export const ATTRACT_LOOP_MS = 15000;

/** 어트랙트 패널 수 (P-9: 조작·가격 / 오늘의 1위 / TOP 10) */
export const ATTRACT_PANELS = 3;

/** 패널 1장 노출 시간 */
export const ATTRACT_PANEL_MS = ATTRACT_LOOP_MS / ATTRACT_PANELS;

/** §4.7 — 미니 튜토리얼 무입력 자동 진행 */
export const TUTORIAL_IDLE_MS = 10000;

/** §4.1 · §4.6 — 미니 튜토리얼을 보여 주는 유료 런 횟수 */
export const TUTORIAL_MAX_PLAYS = 3;

/** §4.7 — 결과 화면 자동 종료 */
export const RESULT_AUTO_MS = 8000;

/** §5.7 N13c — 이름 입력 제한 시간 */
export const NAME_ENTRY_MS = 15000;

/** §4.2 — 보드 전환 연출. 이 동안에도 런 타이머는 진행한다 */
export const BOARD_TRANSITION_MS = 800;

/** §2.7 — 인게임 5분 무입력이면 런을 종료하고 결과로 보낸다 */
export const RUN_IDLE_END_MS = 300000;

/** §9.2 — 실패 진동(100~500ms 구간)의 WU-03 최소 연출 값 */
export const BLOCK_SHAKE_MS = 300;

/** §8.2 · §9.4 — 남은 시간 박동은 1Hz(3Hz 초과 점멸 금지) */
export const TIME_PULSE_MS = 1000;

/** §8.2 — 남은 시간 박동이 시작되는 잔여 시간 */
export const TIME_PULSE_THRESHOLD_MS = 10000;
