// 솔버 게이트 — §11.5 오류 3 · ADM-402 (작업 계획 P-7)
//
// **WU-08(생성기·솔버)이 없으므로 판정은 이월한다.** 대신 포트를 지금 고정하고 차단 배선을
// 테스트로 증명한다: `ok:false`를 돌려주는 게이트를 끼우면 저장이 실제로 막히고, 3초 상한을
// 넘긴 게이트도 막힌다. WU-08은 `createApp({ solverGate: realSolverGate(...) })` **1곳**만
// 바꾸면 ADM-402가 성립한다.
//
// 스텁은 `ok: true`를 돌려주지만 `pending: 'WU-08'`을 함께 세운다. 화면은 그 필드를 보고
// `[WU-08 대기] SKIPPED` 배지를 그린다 — **통과했다고 쓰지 않는다**.
//
// 포트 타입(`SolverGate`·`SolverGateResult`·`SOLVER_GATE_SPEC`)은 `src/core/adminParams.ts`에
// 있다. `validateAdminParams()`가 그 타입을 쓰는데 eslint 규칙 ①이 `src/core/` → `src/game/`
// import를 금지하기 때문이다. 여기에는 **구현**만 둔다.

import type { SolverGate, SolverGateResult } from '../../core/adminParams';

/** WU-08 도착 전까지의 자리 — 오류를 만들지 않지만 통과했다고도 하지 않는다 */
export function stubSolverGate(): SolverGate {
  return {
    validate(): SolverGateResult {
      return { ok: true, failures: [], elapsedMs: 0, boardsChecked: 0, pending: 'WU-08' };
    },
  };
}
