// 보드 · 진로 판정 · 의존 깊이 · 보드 측 상태 전이 · 교착 감지 (§3.3~§3.6 · §3.8 · §6.1)
//
// 이 모듈은 **보드 상태만** 다룬다. 시간·점수·하트·콤보는 `session.ts`·`score.ts`가 소유하며,
// §3.7 ①~⑨의 조립은 `session.ts`가 유일하게 담당한다 (작업 계획 P-1). 그래서 여기에는
// `puzzle → session` 역방향 의존이 없다.

import {
  bendCount,
  chainPointKeys,
  chainSegmentKeys,
  headDirection,
  headOf,
  segmentCountOf,
  validateChainPoints,
} from './chain';
import { OccupancyMap, inBounds, pointKey, segmentKey, step } from './grid';
import type { ResolvedParams } from './params';
import type { Chain, ChainId, ChainState, GridPoint, PointKey, SegmentKey } from './types';

export interface BoardInit {
  readonly chains: readonly Chain[];
  readonly boardNumber?: number;
  readonly seed?: string;
}

export type BoardPlacementErrorCode =
  'DUPLICATE_ID' | 'SEGMENT_CONFLICT' | 'POINT_CONFLICT' | 'INVALID_SHAPE';

export interface BoardPlacementError {
  readonly code: BoardPlacementErrorCode;
  readonly chainId: ChainId;
  /** 충돌 상대 사슬 (`*_CONFLICT`·`DUPLICATE_ID`에서만) */
  readonly other?: ChainId;
}

/**
 * §3.1 배치 규칙 검사 — **선분 단위 배타 점유**와 **교차 금지**(격자 점 공유 금지)를 강제한다.
 * WU-08 생성기가 그대로 재사용한다 (PZL-101의 코어분).
 *
 * 검사 순서: `DUPLICATE_ID → INVALID_SHAPE → SEGMENT_CONFLICT → POINT_CONFLICT`.
 * 선분이 겹치면 그 선분의 양 끝 점도 반드시 겹치므로 **선분 충돌을 먼저 보고**한다.
 */
export function validatePlacement(chains: readonly Chain[]): BoardPlacementError | null {
  const seenIds = new Set<ChainId>();
  for (const chain of chains) {
    if (seenIds.has(chain.id)) return { code: 'DUPLICATE_ID', chainId: chain.id, other: chain.id };
    seenIds.add(chain.id);
    if (validateChainPoints(chain.points) !== null) {
      return { code: 'INVALID_SHAPE', chainId: chain.id };
    }
    if (chain.length !== chain.points.length || chain.bends !== bendCount(chain.points)) {
      return { code: 'INVALID_SHAPE', chainId: chain.id };
    }
  }

  const pointOwners = new Map<PointKey, ChainId>();
  const segmentOwners = new Map<SegmentKey, ChainId>();
  for (const chain of chains) {
    for (const k of chainSegmentKeys(chain)) {
      const owner = segmentOwners.get(k);
      if (owner !== undefined) {
        return { code: 'SEGMENT_CONFLICT', chainId: chain.id, other: owner };
      }
      segmentOwners.set(k, chain.id);
    }
  }
  for (const chain of chains) {
    for (const k of chainPointKeys(chain)) {
      const owner = pointOwners.get(k);
      if (owner !== undefined) {
        return { code: 'POINT_CONFLICT', chainId: chain.id, other: owner };
      }
      pointOwners.set(k, chain.id);
    }
  }
  return null;
}

/** §3.3 판정 결과. `blockers`는 항상 오름차순·중복 없음 */
export interface Verdict {
  readonly safe: boolean;
  readonly blockers: readonly ChainId[];
}

/** 진로 `R(S)` — 머리 자신의 **점**은 빠지고, 머리에 붙은 **첫 선분**부터 들어간다 (§3.3) */
export interface Path {
  readonly points: readonly PointKey[];
  readonly segments: readonly SegmentKey[];
}

export interface DependencyResult {
  /** 유한 깊이만 담긴다 */
  readonly depths: ReadonlyMap<ChainId, number>;
  /** 순환에 걸려 깊이가 정의되지 않는 사슬 (§6.1 정의가 순환에서 미정의) */
  readonly cyclic: ReadonlySet<ChainId>;
  /** 전 사슬 최댓값 (§6.1 축 2). 순환이 하나라도 있으면 `-1`, 활성 사슬이 없으면 `0` */
  readonly boardDepth: number;
}

/** §3.3 진로 구성 — 보드 상태와 무관한 **사슬 고유 기하**라 보드 생성 시 1회 계산해 굳힌다 */
function buildPath(chain: Chain): Path {
  const d = headDirection(chain);
  const points: PointKey[] = [];
  const segments: SegmentKey[] = [];
  let cur = headOf(chain);
  for (;;) {
    const next = step(cur, d);
    if (!inBounds(next)) break; // 보드 밖 — 그 지점에서 판정 종료, 블로커 없음
    segments.push(segmentKey(cur, next));
    points.push(pointKey(next));
    cur = next;
  }
  return { points, segments };
}

/**
 * 보드 — 사슬 배치·점유·상태를 소유한다.
 *
 * ⑦ 재계산은 **진로 역인덱스**(`칸 → 그 칸을 진로로 지나는 사슬들`)로 부분 갱신한다.
 * `recomputeAll()`은 전 사슬을 다시 판정하는 참조 구현이며, 두 결과는 항상 같아야 한다
 * (§3.7 "부분 갱신 최적화를 쓰더라도 전체 재계산과 같은 결과").
 */
export class Board {
  readonly boardNumber: number;
  readonly seed: string | undefined;

  private readonly byId = new Map<ChainId, Chain>();
  private readonly order: readonly ChainId[];
  private readonly states = new Map<ChainId, ChainState>();
  private readonly occupancy = new OccupancyMap();
  private readonly paths = new Map<ChainId, Path>();
  private readonly pathPointIndex = new Map<PointKey, ChainId[]>();
  private readonly pathSegmentIndex = new Map<SegmentKey, ChainId[]>();
  private readonly verdictCache = new Map<ChainId, Verdict>();
  private rev = 0;

  constructor(init: BoardInit) {
    const placementError = validatePlacement(init.chains);
    if (placementError !== null) {
      throw new Error(
        `Board: 배치 무효 — ${placementError.code} (사슬 ${placementError.chainId}` +
          `${placementError.other === undefined ? '' : ` ↔ ${placementError.other}`})`
      );
    }
    this.boardNumber = init.boardNumber ?? 1;
    this.seed = init.seed;
    this.order = [...init.chains].sort((a, b) => a.id - b.id).map((c) => c.id);

    for (const chain of init.chains) {
      this.byId.set(chain.id, chain);
      this.states.set(chain.id, 'normal');
      this.occupancy.occupy(chain.id, chainPointKeys(chain), chainSegmentKeys(chain));
      const path = buildPath(chain);
      this.paths.set(chain.id, path);
      for (const k of path.points) {
        const list = this.pathPointIndex.get(k);
        if (list === undefined) this.pathPointIndex.set(k, [chain.id]);
        else list.push(chain.id);
      }
      for (const k of path.segments) {
        const list = this.pathSegmentIndex.get(k);
        if (list === undefined) this.pathSegmentIndex.set(k, [chain.id]);
        else list.push(chain.id);
      }
    }
  }

  /** 점유가 바뀔 때마다 +1 — 반복 실패 보호(§3.5)의 "보드 상태 변화" 기준값 */
  get revision(): number {
    return this.rev;
  }

  /** id 오름차순 */
  chains(): readonly Chain[] {
    return this.order.map((id) => this.require(id));
  }

  /** `removed`를 제외한 사슬 — id 오름차순 */
  activeChains(): readonly Chain[] {
    return this.order
      .filter((id) => this.states.get(id) !== 'removed')
      .map((id) => this.require(id));
  }

  chain(id: ChainId): Chain | undefined {
    return this.byId.get(id);
  }

  stateOf(id: ChainId): ChainState {
    const state = this.states.get(id);
    if (state === undefined) throw new Error(`Board.stateOf: 없는 사슬 ${id}`);
    return state;
  }

  /** §3.3 `R(S)` — 사슬 고유 기하라 보드 상태와 무관하게 항상 같은 값이다 */
  path(id: ChainId): Path {
    const path = this.paths.get(id);
    if (path === undefined) throw new Error(`Board.path: 없는 사슬 ${id}`);
    return path;
  }

  /**
   * §3.3 일괄 판정 — 진로의 **격자 점 또는 격자 선분**을 다른 사슬이 하나라도 점유하면 막힘.
   * 점 인덱스를 빼면 영상 01:10 케이스가 "안전수"로 오판된다 (PZL-103).
   *
   * `removing` 상태의 사슬은 점유를 유지하므로 그대로 블로커다. `removed`가 되는 ⑥에서만 풀린다.
   */
  evaluate(id: ChainId): Verdict {
    const cached = this.verdictCache.get(id);
    if (cached !== undefined) return cached;
    const path = this.path(id);
    const blockers = this.occupancy.conflicts(path.points, path.segments, id);
    const verdict: Verdict = { safe: blockers.length === 0, blockers };
    this.verdictCache.set(id, verdict);
    return verdict;
  }

  /** 안전수 목록 — id 오름차순 (§3.3) */
  safeMoves(): readonly ChainId[] {
    const out: ChainId[] = [];
    for (const chain of this.activeChains()) {
      if (this.evaluate(chain.id).safe) out.push(chain.id);
    }
    return out;
  }

  /**
   * ⑦ 전체 재계산 참조 구현 — 캐시를 전부 버리고 활성 사슬을 다시 판정한다.
   * 부분 갱신(`completeRemoval`의 역인덱스 무효화)과 결과가 어긋나면 등가 테스트가 잡는다.
   */
  recomputeAll(): void {
    this.verdictCache.clear();
    for (const chain of this.activeChains()) this.evaluate(chain.id);
  }

  /** ③B — 빨간 표시만 세운다. 점유·좌표·`revision`은 1비트도 바뀌지 않는다 (§3.5 · PZL-104) */
  markBlocked(id: ChainId): void {
    const state = this.stateOf(id);
    if (state === 'removing' || state === 'removed') {
      throw new Error(`Board.markBlocked: 제거 중이거나 제거된 사슬 ${id}`);
    }
    this.states.set(id, 'blocked');
  }

  /** ③A — `removing`으로 전이. **점유는 유지**된다 (§3.3 부분 이동 중인 사슬은 여전히 블로커) */
  beginRemoval(id: ChainId): void {
    const state = this.stateOf(id);
    if (state === 'removing' || state === 'removed') {
      throw new Error(`Board.beginRemoval: 이미 제거 중이거나 제거된 사슬 ${id}`);
    }
    this.states.set(id, 'removing');
  }

  /**
   * ⑥ — `removed` 전이 + 점유 해제 + `revision++`를 **원자적으로** 처리한다 (§3.4-3).
   * 이어서 해제된 칸을 진로로 지나는 사슬만 캐시에서 무효화한다(⑦ 부분 갱신).
   */
  completeRemoval(id: ChainId): void {
    if (this.stateOf(id) !== 'removing') {
      throw new Error(`Board.completeRemoval: 제거 중이 아닌 사슬 ${id}`);
    }
    const chain = this.require(id);
    const freedPoints = chainPointKeys(chain);
    const freedSegments = chainSegmentKeys(chain);

    this.occupancy.release(id);
    this.states.set(id, 'removed');
    this.rev += 1;

    for (const k of freedPoints) {
      for (const cid of this.pathPointIndex.get(k) ?? []) this.verdictCache.delete(cid);
    }
    for (const k of freedSegments) {
      for (const cid of this.pathSegmentIndex.get(k) ?? []) this.verdictCache.delete(cid);
    }
    this.verdictCache.delete(id);
  }

  /** 활성 사슬 0 = 보드 클리어 (§3.6) */
  isCleared(): boolean {
    return this.activeChains().length === 0;
  }

  /** 머리가 지나갈 격자 점 열 + 보드 밖 첫 점 (WU-07 슬라이드 아웃 연출의 입력) */
  exitPath(id: ChainId): readonly GridPoint[] {
    const chain = this.require(id);
    const d = headDirection(chain);
    const out: GridPoint[] = [];
    let cur = headOf(chain);
    for (;;) {
      const next = step(cur, d);
      out.push(next);
      if (!inBounds(next)) return out;
      cur = next;
    }
  }

  private require(id: ChainId): Chain {
    const chain = this.byId.get(id);
    if (chain === undefined) throw new Error(`Board: 없는 사슬 ${id}`);
    return chain;
  }
}

/**
 * §6.1 축 2 — `D(X)` = 진로를 막는 사슬이 없으면 0, 있으면 `1 + max(막는 사슬들의 깊이)`.
 *
 * 메모이즈 DFS + 3색 표시로 계산하고, 순환에 걸린 사슬(과 그 사슬을 블로커로 가진 사슬)은
 * 깊이를 정의할 수 없으므로 `cyclic`에 넣는다. 순회는 전부 id 오름차순이라 결정적이다.
 *
 * 활성 사슬만 계산한다. `removing`은 점유가 살아 있으므로 포함되고 `removed`는 빠진다.
 * WU-08 생성기가 §6.3 5단계 "각 사슬의 의존 깊이 D를 확정"에서 이 함수를 1회 호출해
 * `Chain.depth`에 굳힌다.
 */
export function dependencyDepths(board: Board): DependencyResult {
  const depths = new Map<ChainId, number>();
  const cyclic = new Set<ChainId>();
  const color = new Map<ChainId, 1 | 2>(); // 1 = gray(방문 중), 2 = black(완료)

  const visit = (id: ChainId): number | null => {
    const mark = color.get(id);
    if (mark === 1) {
      cyclic.add(id);
      return null;
    }
    if (mark === 2) {
      const done = depths.get(id);
      return done === undefined ? null : done;
    }
    color.set(id, 1);
    let best = 0;
    let undefinedDepth = false;
    for (const blocker of board.evaluate(id).blockers) {
      const d = visit(blocker);
      if (d === null) undefinedDepth = true;
      else if (d + 1 > best) best = d + 1;
    }
    color.set(id, 2);
    if (undefinedDepth || cyclic.has(id)) {
      cyclic.add(id);
      return null;
    }
    depths.set(id, best);
    return best;
  };

  const active = board.activeChains();
  for (const chain of active) visit(chain.id);

  let boardDepth = 0;
  if (cyclic.size > 0) {
    boardDepth = -1;
  } else {
    for (const d of depths.values()) if (d > boardDepth) boardDepth = d;
  }
  return { depths, cyclic, boardDepth };
}

/** §6.1 축 3 분기 폭 — 현재 보드 상태의 안전수 개수 (WU-08 생성기 검증 입력) */
export function initialSafeCount(board: Board): number {
  return board.safeMoves().length;
}

/**
 * §3.8 런타임 교착 감지 — 안전수가 0이면 자동 보정 대상 1개를 결정적으로 고른다.
 *
 * 선정 규칙 (작업 계획 Q-3):
 *   ① 실시간 깊이가 유한한 활성 사슬 중 최솟값
 *   ② 없으면(전량 순환) 생성 확정 깊이 `chain.depth` 최솟값 — §5.1 "저장 깊이는 확정값" 원칙
 *   ③ 그래도 동률이면 `chainId` 최솟값 — §7.1 힌트 타이브레이크 문법 차용
 *
 * 안전수가 하나라도 있거나 보드가 비었으면 `null`이다.
 */
export function detectDeadlock(board: Board): ChainId | null {
  const active = board.activeChains();
  if (active.length === 0) return null;
  if (board.safeMoves().length > 0) return null;

  const { depths } = dependencyDepths(board);

  // ① 유한 깊이 최소 — active가 id 오름차순이라 동률은 자동으로 최소 id가 이긴다
  let pick: ChainId | null = null;
  let pickDepth = Number.POSITIVE_INFINITY;
  for (const chain of active) {
    const d = depths.get(chain.id);
    if (d === undefined) continue;
    if (d < pickDepth) {
      pick = chain.id;
      pickDepth = d;
    }
  }
  if (pick !== null) return pick;

  // ② 저장 깊이 최소 → ③ 최소 id
  for (const chain of active) {
    if (chain.depth < pickDepth) {
      pick = chain.id;
      pickDepth = chain.depth;
    }
  }
  return pick;
}

/** §3.4-4 이동 시간 = `min(기본 + 선분 수 × 선분당, 상한)`. 코어는 계산만 하고 대기·연출은 WU-03·07 */
export function slideOutMs(chain: Chain, p: ResolvedParams): number {
  return Math.min(
    p.slideOutBaseMs + segmentCountOf(chain) * p.slideOutPerSegmentMs,
    p.slideOutCapMs
  );
}
