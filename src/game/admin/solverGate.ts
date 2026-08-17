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

import type { AdminParams, ParamTier, SolverGate, SolverGateResult } from '../../core/adminParams';
import { generateBoard } from '../../core/generator';
import { releaseBlockReasons, solveBoard } from '../../core/solver';
import { contrastRatio } from '../fx';
import { PALETTE } from '../render/boardView';

const REPRESENTATIVE_BOARD: Readonly<Record<ParamTier, number>> = {
  WARMUP: 1,
  RHYTHM: 4,
  PRESSURE: 7,
  MASTER: 10,
  ENDLESS: 13,
};

const TIERS: readonly ParamTier[] = ['WARMUP', 'RHYTHM', 'PRESSURE', 'MASTER', 'ENDLESS'];
const MINIMUM_CHAIN_CONTRAST = Math.min(
  ...[PALETTE.chain, PALETTE.focus, PALETTE.blocked, PALETTE.hint].map((color) =>
    contrastRatio(color, PALETTE.background)
  )
);

export interface RealSolverGateOptions {
  readonly now?: () => number;
}

/** §11.5 — 5구간 × 대표 시드 3개를 실제 생성·전수 탐색하고 3초 안에 판정한다. */
export function realSolverGate(options: RealSolverGateOptions = {}): SolverGate {
  const now = options.now ?? (() => performance.now());
  return {
    validate(params: AdminParams): SolverGateResult {
      const started = now();
      const failures: Array<{
        readonly tier: ParamTier;
        readonly seed: number;
        readonly reason: 'no_solution' | 'deadlock' | 'over_target_time';
      }> = [];
      let boardsChecked = 0;

      for (const tier of TIERS) {
        for (let seed = 1; seed <= 3; seed += 1) {
          const generated = generateBoard(
            REPRESENTATIVE_BOARD[tier],
            `admin-${tier}-${String(seed)}`,
            params
          );
          const solved = solveBoard(generated.board);
          const vector = generated.bundle.vector;
          const limits = params.tiers[tier];
          const vectorMismatch =
            !inside(vector.chains, limits.chains) ||
            !inside(vector.safeMoves, limits.safeMoves) ||
            !inside(vector.maxDepth, limits.depth);
          const release = releaseBlockReasons({
            hasSolution: solved.hasSolution,
            runtimeMismatchCount: 0,
            deadlockStates: solved.deadlockStates,
            minimumContrastRatio: MINIMUM_CHAIN_CONTRAST,
            frameP99Ms: generated.bundle.bot.frameP99Ms,
            botP95Ms: generated.bundle.bot.p95Ms,
            targetMs: generated.bundle.vector.targetMs,
            focusMoveBound: generated.bundle.focusMoveBound,
          });
          boardsChecked += 1;
          if (vectorMismatch || release.includes('NO_SOLUTION')) {
            failures.push({ tier, seed, reason: 'no_solution' });
          } else if (release.includes('DEADLOCK')) {
            failures.push({ tier, seed, reason: 'deadlock' });
          } else if (release.includes('BOT_OVER_TARGET')) {
            failures.push({ tier, seed, reason: 'over_target_time' });
          }
        }
      }

      const elapsedMs = Math.max(0, now() - started);
      if (elapsedMs > 3000) {
        failures.push({ tier: 'ENDLESS', seed: 3, reason: 'over_target_time' });
      }
      return {
        ok: failures.length === 0,
        failures,
        elapsedMs,
        boardsChecked,
      };
    },
  };
}

function inside(value: number, range: { readonly min: number; readonly max: number }): boolean {
  return value >= range.min && value <= range.max;
}

/** WU-08 도착 전까지의 자리 — 오류를 만들지 않지만 통과했다고도 하지 않는다 */
export function stubSolverGate(): SolverGate {
  return {
    validate(): SolverGateResult {
      return { ok: true, failures: [], elapsedMs: 0, boardsChecked: 0, pending: 'WU-08' };
    },
  };
}
