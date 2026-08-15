// 격자 좌표계와 점유 (§3.1)
//
// 사슬은 격자 **선분** 위에만 놓이고, 점유는 선분과 그 선분의 양 끝 **격자 점** 양쪽을 덮는다.
// §3.3 진로 판정이 "점 또는 선분 하나라도 겹치면 막힘"이므로 점유 맵은 **점·선분 이중 인덱스**여야
// 한다. 인덱스 한쪽만 두면 영상 01:10 케이스(수평 진로 위 격자 점을 세로 선분이 점유)를 놓친다.

import type { ChainId, Direction, GridPoint, PointKey, SegmentKey } from './types';

/** 격자 점 x = 0..12 (§3.1) */
export const GRID_WIDTH = 13;

/** 격자 점 y = 0..18 (§3.1) */
export const GRID_HEIGHT = 19;

/** 순회 순서 고정 — 결정성(§3.3)을 위해 이 배열 순서 밖에서 4방향을 나열하지 않는다 */
export const DIRECTIONS: readonly Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/** 화면 좌표계 기준 — y는 아래로 증가한다 (원점 좌상단) */
export const DIRECTION_VECTORS: Readonly<
  Record<Direction, { readonly dx: number; readonly dy: number }>
> = {
  UP: { dx: 0, dy: -1 },
  DOWN: { dx: 0, dy: 1 },
  LEFT: { dx: -1, dy: 0 },
  RIGHT: { dx: 1, dy: 0 },
};

export function inBounds(p: GridPoint): boolean {
  return p.x >= 0 && p.x < GRID_WIDTH && p.y >= 0 && p.y < GRID_HEIGHT;
}

export function samePoint(a: GridPoint, b: GridPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/** 4방향 인접 = 맨해튼 거리 1 (§3.2 — 대각선은 사슬이 될 수 없다) */
export function isAdjacent(a: GridPoint, b: GridPoint): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/** 인접하지 않으면 `null` */
export function directionBetween(from: GridPoint, to: GridPoint): Direction | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dy === 0 && dx === 1) return 'RIGHT';
  if (dy === 0 && dx === -1) return 'LEFT';
  if (dx === 0 && dy === 1) return 'DOWN';
  if (dx === 0 && dy === -1) return 'UP';
  return null;
}

export function step(p: GridPoint, d: Direction): GridPoint {
  const v = DIRECTION_VECTORS[d];
  return { x: p.x + v.dx, y: p.y + v.dy };
}

/** `x·19 + y` — 0..246. 격자 전체에서 충돌이 없다 */
export function pointKey(p: GridPoint): PointKey {
  return p.x * GRID_HEIGHT + p.y;
}

export function decodePointKey(k: PointKey): GridPoint {
  return { x: Math.floor(k / GRID_HEIGHT), y: k % GRID_HEIGHT };
}

/**
 * 정규형 선분 키 — `pointKey(앵커) · 2 + (수평 ? 0 : 1)`, 0..493.
 * 앵커는 두 끝점 중 `(x, y)` 사전순으로 작은 쪽이므로 `segmentKey(a,b) === segmentKey(b,a)`다.
 */
export function segmentKey(a: GridPoint, b: GridPoint): SegmentKey {
  if (!isAdjacent(a, b)) {
    throw new Error(`segmentKey: 인접하지 않은 두 점 (${a.x},${a.y}) (${b.x},${b.y})`);
  }
  const aIsAnchor = a.x < b.x || (a.x === b.x && a.y < b.y);
  const anchor = aIsAnchor ? a : b;
  const other = aIsAnchor ? b : a;
  const horizontal = anchor.y === other.y;
  return pointKey(anchor) * 2 + (horizontal ? 0 : 1);
}

/** `[앵커, 반대쪽]` — 앵커가 항상 사전순으로 작다 */
export function decodeSegmentKey(k: SegmentKey): readonly [GridPoint, GridPoint] {
  const vertical = k % 2 === 1;
  const anchor = decodePointKey((k - (k % 2)) / 2);
  const other = vertical ? { x: anchor.x, y: anchor.y + 1 } : { x: anchor.x + 1, y: anchor.y };
  return [anchor, other];
}

export function pathPointKeys(points: readonly GridPoint[]): PointKey[] {
  return points.map(pointKey);
}

export function pathSegmentKeys(points: readonly GridPoint[]): SegmentKey[] {
  const out: SegmentKey[] = [];
  for (let i = 1; i < points.length; i += 1) out.push(segmentKey(points[i - 1], points[i]));
  return out;
}

/**
 * 점유 맵 (§3.1) — 격자 점과 격자 선분을 각각 인덱싱한다.
 *
 * `선분 단위 배타 점유`와 `교차 금지`(점 공유 금지)를 둘 다 강제하므로 `occupy()`는 충돌 시
 * 예외를 던진다. 잘못된 배치를 조용히 받아들이면 §3.3의 일괄 판정이 성립하지 않는다.
 */
export class OccupancyMap {
  private readonly pointOwners = new Map<PointKey, ChainId>();
  private readonly segmentOwners = new Map<SegmentKey, ChainId>();
  private readonly owned = new Map<ChainId, { points: PointKey[]; segments: SegmentKey[] }>();

  /** 충돌하면 아무것도 반영하지 않고 던진다 (부분 점유 상태를 만들지 않는다) */
  occupy(id: ChainId, pts: readonly PointKey[], segs: readonly SegmentKey[]): void {
    if (this.owned.has(id)) throw new Error(`OccupancyMap.occupy: 이미 점유 중인 사슬 ${id}`);
    for (const k of segs) {
      const owner = this.segmentOwners.get(k);
      if (owner !== undefined) {
        throw new Error(`OccupancyMap.occupy: 선분 ${k}이(가) 사슬 ${owner}와 겹친다`);
      }
    }
    for (const k of pts) {
      const owner = this.pointOwners.get(k);
      if (owner !== undefined) {
        throw new Error(`OccupancyMap.occupy: 격자 점 ${k}이(가) 사슬 ${owner}와 겹친다`);
      }
    }
    for (const k of segs) this.segmentOwners.set(k, id);
    for (const k of pts) this.pointOwners.set(k, id);
    this.owned.set(id, { points: [...pts], segments: [...segs] });
  }

  /** 그 사슬이 점유한 점·선분 전량을 원자적으로 해제한다 (§3.4-3). 없던 사슬이면 무시 */
  release(id: ChainId): void {
    const held = this.owned.get(id);
    if (held === undefined) return;
    for (const k of held.segments) this.segmentOwners.delete(k);
    for (const k of held.points) this.pointOwners.delete(k);
    this.owned.delete(id);
  }

  pointOwner(k: PointKey): ChainId | undefined {
    return this.pointOwners.get(k);
  }

  segmentOwner(k: SegmentKey): ChainId | undefined {
    return this.segmentOwners.get(k);
  }

  /**
   * 주어진 점·선분을 점유 중인 사슬 목록 — **오름차순·중복 제거**.
   * `ignore`(자기 자신)는 제외한다 (§3.3 "자기 몸은 판정 대상이 아니다").
   */
  conflicts(pts: readonly PointKey[], segs: readonly SegmentKey[], ignore?: ChainId): ChainId[] {
    const hits = new Set<ChainId>();
    for (const k of pts) {
      const owner = this.pointOwners.get(k);
      if (owner !== undefined && owner !== ignore) hits.add(owner);
    }
    for (const k of segs) {
      const owner = this.segmentOwners.get(k);
      if (owner !== undefined && owner !== ignore) hits.add(owner);
    }
    return [...hits].sort((a, b) => a - b);
  }

  /** 현재 점유 중인 **사슬 수** (점·선분 칸 수가 아니다) */
  get size(): number {
    return this.owned.size;
  }
}
