// 사슬 데이터 모델 (§3.2)
//
// `Chain`은 **불변 값**이다 (작업 계획 P-3). 상태(`ChainState`)와 점유는 `Board`가 소유하므로
// 같은 사슬 값을 여러 보드에 재사용해도 서로 간섭하지 않고, 픽스처·재현성 테스트가 단순해진다.

import {
  inBounds,
  isAdjacent,
  directionBetween,
  pathPointKeys,
  pathSegmentKeys,
  pointKey,
} from './grid';
import type {
  Chain,
  ChainId,
  ChainState,
  Direction,
  GridPoint,
  PointKey,
  SegmentKey,
} from './types';

/** §3.2 상태 5종 — 순서 고정 */
export const CHAIN_STATES: readonly ChainState[] = [
  'normal',
  'focused',
  'blocked',
  'removing',
  'removed',
];

export type ChainShapeErrorCode = 'TOO_SHORT' | 'OUT_OF_BOUNDS' | 'NOT_ADJACENT' | 'SELF_INTERSECT';

export interface ChainShapeError {
  readonly code: ChainShapeErrorCode;
  /** 문제가 발생한 점의 인덱스. `TOO_SHORT`는 0 */
  readonly index: number;
}

/**
 * 유효성 4종 (§3.2) — 검사 순서는 `TOO_SHORT → OUT_OF_BOUNDS → NOT_ADJACENT → SELF_INTERSECT`로
 * 고정한다. 여러 규칙을 동시에 어긴 입력도 항상 같은 코드로 거부된다.
 *
 * 자기 교차 금지는 "같은 격자 점 재방문 금지"다. 되돌아가기(`P(i+1) === P(i−1)`)도 여기에 걸린다.
 */
export function validateChainPoints(points: readonly GridPoint[]): ChainShapeError | null {
  if (points.length < 2) return { code: 'TOO_SHORT', index: 0 };
  for (let i = 0; i < points.length; i += 1) {
    if (!inBounds(points[i])) return { code: 'OUT_OF_BOUNDS', index: i };
  }
  for (let i = 1; i < points.length; i += 1) {
    if (!isAdjacent(points[i - 1], points[i])) return { code: 'NOT_ADJACENT', index: i };
  }
  // 여기까지 왔다면 전 점이 보드 안이므로 pointKey가 단사(injective)다
  const seen = new Set<PointKey>();
  for (let i = 0; i < points.length; i += 1) {
    const key = pointKey(points[i]);
    if (seen.has(key)) return { code: 'SELF_INTERSECT', index: i };
    seen.add(key);
  }
  return null;
}

/** 굽힘 수 B — 진행 방향이 바뀌는 내부 점의 수 (§3.2). 직선 사슬은 0 */
export function bendCount(points: readonly GridPoint[]): number {
  let bends = 0;
  for (let i = 1; i + 1 < points.length; i += 1) {
    const before = directionBetween(points[i - 1], points[i]);
    const after = directionBetween(points[i], points[i + 1]);
    if (before !== after) bends += 1;
  }
  return bends;
}

/**
 * 사슬 1개를 만든다. 형태가 무효이거나 `depth`가 0 이상의 정수가 아니면 던진다.
 *
 * `depth`는 생성 확정 의존 깊이(§6.1 · §5.1)이며 WU-08 생성기가 `dependencyDepths()`로 계산해
 * 넘긴다. WU-02의 수제 픽스처는 같은 값을 손으로 적고, 픽스처 정합 테스트가 어긋남을 잡는다.
 */
export function createChain(id: ChainId, points: readonly GridPoint[], depth: number): Chain {
  const shapeError = validateChainPoints(points);
  if (shapeError !== null) {
    throw new Error(`createChain(${id}): ${shapeError.code} at index ${shapeError.index}`);
  }
  if (!Number.isInteger(depth) || depth < 0) {
    throw new Error(`createChain(${id}): depth는 0 이상의 정수여야 한다 (받은 값 ${depth})`);
  }
  return {
    id,
    points: points.map((p) => ({ x: p.x, y: p.y })),
    length: points.length,
    bends: bendCount(points),
    depth,
  };
}

/** 머리 `P(L-1)` — 화살촉이 있는 마지막 점 (§3.2) */
export function headOf(chain: Chain): GridPoint {
  return chain.points[chain.points.length - 1];
}

/** 꼬리 `P0` (§3.2) */
export function tailOf(chain: Chain): GridPoint {
  return chain.points[0];
}

/** 머리 방향 `d = P(L-1) − P(L-2)` (§3.2) */
export function headDirection(chain: Chain): Direction {
  const pts = chain.points;
  const d = directionBetween(pts[pts.length - 2], pts[pts.length - 1]);
  if (d === null) throw new Error(`headDirection(${chain.id}): 머리 두 점이 인접하지 않는다`);
  return d;
}

/** 선분 수 = L − 1 (§3.2). 슬라이드 아웃 시간의 입력이다 (§3.4) */
export function segmentCountOf(chain: Chain): number {
  return chain.length - 1;
}

export function chainPointKeys(chain: Chain): PointKey[] {
  return pathPointKeys(chain.points);
}

export function chainSegmentKeys(chain: Chain): SegmentKey[] {
  return pathSegmentKeys(chain.points);
}
