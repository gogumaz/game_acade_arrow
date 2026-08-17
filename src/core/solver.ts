// WU-08 전수 솔버 · 런타임 판정 독립 검증 · 릴리스 차단 조건 (§6.3~6.4, GEN-401~410)

import type { Board } from './puzzle';
import type { ChainId } from './types';

export interface SolverModel {
  readonly ids: readonly ChainId[];
  readonly blockerMasks: readonly bigint[];
  readonly allActive: bigint;
}

export interface SolverResult {
  readonly hasSolution: boolean;
  readonly solutionOrder: readonly ChainId[];
  readonly statesVisited: number;
  readonly deadlockStates: number;
  readonly truncated: boolean;
}

export interface SolverOptions {
  readonly maxStates?: number;
}

/** Board의 공간 판정 결과를 작고 불변인 비트 모델로 옮긴다. */
export function buildSolverModel(board: Board): SolverModel {
  const ids = board.chains().map((chain) => chain.id);
  const index = new Map(ids.map((id, at) => [id, at] as const));
  const blockerMasks = ids.map((id) => {
    let mask = 0n;
    for (const blocker of board.evaluate(id).blockers) {
      const at = index.get(blocker);
      if (at !== undefined) mask |= 1n << BigInt(at);
    }
    return mask;
  });
  return {
    ids,
    blockerMasks,
    allActive: ids.length === 0 ? 0n : (1n << BigInt(ids.length)) - 1n,
  };
}

export function safeMovesForMask(model: SolverModel, active: bigint): readonly ChainId[] {
  const safe: ChainId[] = [];
  for (let i = 0; i < model.ids.length; i += 1) {
    const bit = 1n << BigInt(i);
    if ((active & bit) !== 0n && (active & model.blockerMasks[i]) === 0n) safe.push(model.ids[i]);
  }
  return safe;
}

/**
 * 가능한 모든 제거 상태를 순회한다. 한 해답만 찾고 멈추지 않기 때문에 중간 교착도 함께 검출한다.
 * 상태 키는 활성 사슬 비트셋이라 같은 상태로 합류하는 제거 순서는 정확히 한 번만 방문한다.
 */
export function solveBoard(board: Board, options: SolverOptions = {}): SolverResult {
  const model = buildSolverModel(board);
  const maxStates = options.maxStates ?? Number.POSITIVE_INFINITY;
  const seen = new Set<bigint>();
  const parent = new Map<bigint, { readonly previous: bigint; readonly move: ChainId }>();
  const stack: bigint[] = [model.allActive];
  let solved: bigint | null = model.allActive === 0n ? 0n : null;
  let deadlockStates = 0;
  let truncated = false;

  while (stack.length > 0) {
    const active = stack.pop() ?? 0n;
    if (seen.has(active)) continue;
    if (seen.size >= maxStates) {
      truncated = true;
      break;
    }
    seen.add(active);
    if (active === 0n) {
      solved = 0n;
      continue;
    }
    const safe = safeMovesForMask(model, active);
    if (safe.length === 0) {
      deadlockStates += 1;
      continue;
    }
    // 역순 push → id 오름차순을 먼저 방문한다.
    for (let i = safe.length - 1; i >= 0; i -= 1) {
      const move = safe[i];
      const at = model.ids.indexOf(move);
      const next = active & ~(1n << BigInt(at));
      if (!parent.has(next)) parent.set(next, { previous: active, move });
      stack.push(next);
    }
  }

  const solutionOrder: ChainId[] = [];
  if (solved === 0n) {
    let cursor = 0n;
    while (cursor !== model.allActive) {
      const edge = parent.get(cursor);
      if (edge === undefined) break;
      solutionOrder.push(edge.move);
      cursor = edge.previous;
    }
    solutionOrder.reverse();
  }
  return {
    hasSolution: solved === 0n && solutionOrder.length === model.ids.length,
    solutionOrder,
    statesVisited: seen.size,
    deadlockStates,
    truncated,
  };
}

/** 생성 번들 해답과 런타임 공간 판정이 한 수씩 일치하는지 검사한다. */
export function verifySolution(board: Board, order: readonly ChainId[]): boolean {
  const model = buildSolverModel(board);
  let active = model.allActive;
  const index = new Map(model.ids.map((id, at) => [id, at] as const));
  for (const id of order) {
    const at = index.get(id);
    if (at === undefined) return false;
    const bit = 1n << BigInt(at);
    if ((active & bit) === 0n || (active & model.blockerMasks[at]) !== 0n) return false;
    active &= ~bit;
  }
  return active === 0n;
}

/** 지정 해법에서 안전수가 1개뿐인 연속 구간의 최댓값. 5 이상이면 생성 후보를 폐기한다. */
export function singleSafeStreak(board: Board, order: readonly ChainId[]): number {
  const model = buildSolverModel(board);
  const index = new Map(model.ids.map((id, at) => [id, at] as const));
  let active = model.allActive;
  let streak = 0;
  let maximum = 0;
  for (const move of order) {
    const safe = safeMovesForMask(model, active);
    streak = safe.length === 1 ? streak + 1 : 0;
    maximum = Math.max(maximum, streak);
    const at = index.get(move);
    if (at === undefined || !safe.includes(move)) return Number.POSITIVE_INFINITY;
    active &= ~(1n << BigInt(at));
  }
  return active === 0n ? maximum : Number.POSITIVE_INFINITY;
}

export type ReleaseBlockReason =
  | 'NO_SOLUTION'
  | 'SOLVER_RUNTIME_MISMATCH'
  | 'DEADLOCK'
  | 'LOW_CONTRAST'
  | 'FRAME_BUDGET'
  | 'BOT_OVER_TARGET'
  | 'FOCUS_OVER_LIMIT';

export interface ReleaseEvidence {
  readonly hasSolution: boolean;
  readonly runtimeMismatchCount: number;
  readonly deadlockStates: number;
  readonly minimumContrastRatio: number;
  readonly frameP99Ms: number;
  readonly botP95Ms: number;
  readonly targetMs: number;
  readonly focusMoveBound: number;
}

/** §6.4의 일곱 릴리스 차단 조건을 빠짐없이 같은 순서로 반환한다. */
export function releaseBlockReasons(evidence: ReleaseEvidence): readonly ReleaseBlockReason[] {
  const reasons: ReleaseBlockReason[] = [];
  if (!evidence.hasSolution) reasons.push('NO_SOLUTION');
  if (evidence.runtimeMismatchCount > 0) reasons.push('SOLVER_RUNTIME_MISMATCH');
  if (evidence.deadlockStates > 0) reasons.push('DEADLOCK');
  if (evidence.minimumContrastRatio < 4.5) reasons.push('LOW_CONTRAST');
  if (evidence.frameP99Ms > 20) reasons.push('FRAME_BUDGET');
  if (evidence.botP95Ms > evidence.targetMs * 1.8) reasons.push('BOT_OVER_TARGET');
  if (evidence.focusMoveBound > 12) reasons.push('FOCUS_OVER_LIMIT');
  return reasons;
}
