// WU-02 T2 — 격자 좌표계와 점유 (§3.1)
//
// 키 정규형과 점·선분 이중 인덱스가 §3.3 진로 판정의 전제다. 점 인덱스가 빠지면 영상 01:10
// 케이스를 놓치므로 여기서 두 인덱스가 독립적으로 동작함을 먼저 못 박는다.

import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  DIRECTION_VECTORS,
  GRID_HEIGHT,
  GRID_WIDTH,
  OccupancyMap,
  decodePointKey,
  decodeSegmentKey,
  directionBetween,
  inBounds,
  isAdjacent,
  pathPointKeys,
  pathSegmentKeys,
  pointKey,
  samePoint,
  segmentKey,
  step,
} from '../../src/core/grid';
import type { Direction, GridPoint, PointKey, SegmentKey } from '../../src/core/types';
import { pt } from './fixtures';

/** 격자 전체 열거 — 13 × 19 = 247점 */
function allPoints(): GridPoint[] {
  const out: GridPoint[] = [];
  for (let x = 0; x < GRID_WIDTH; x += 1) {
    for (let y = 0; y < GRID_HEIGHT; y += 1) out.push(pt(x, y));
  }
  return out;
}

/** 격자 전체 선분 열거 — 수평 228 + 수직 234 = 462개 */
function allSegments(): (readonly [GridPoint, GridPoint])[] {
  const out: (readonly [GridPoint, GridPoint])[] = [];
  for (let x = 0; x < GRID_WIDTH; x += 1) {
    for (let y = 0; y < GRID_HEIGHT; y += 1) {
      if (x + 1 < GRID_WIDTH) out.push([pt(x, y), pt(x + 1, y)]);
      if (y + 1 < GRID_HEIGHT) out.push([pt(x, y), pt(x, y + 1)]);
    }
  }
  return out;
}

describe('§3.1 격자 좌표계', () => {
  it('보드 격자는 13 × 19 격자 점이다', () => {
    expect(GRID_WIDTH).toBe(13);
    expect(GRID_HEIGHT).toBe(19);
  });

  it('DIRECTIONS는 결정적 순서 4종이다', () => {
    expect(DIRECTIONS).toEqual(['UP', 'DOWN', 'LEFT', 'RIGHT']);
  });

  it('DIRECTION_VECTORS는 원점 좌상단 기준이다 (y는 아래로 증가)', () => {
    expect(DIRECTION_VECTORS.UP).toEqual({ dx: 0, dy: -1 });
    expect(DIRECTION_VECTORS.DOWN).toEqual({ dx: 0, dy: 1 });
    expect(DIRECTION_VECTORS.LEFT).toEqual({ dx: -1, dy: 0 });
    expect(DIRECTION_VECTORS.RIGHT).toEqual({ dx: 1, dy: 0 });
  });

  it('inBounds가 네 경계를 정확히 자른다', () => {
    expect(inBounds(pt(0, 0))).toBe(true);
    expect(inBounds(pt(12, 18))).toBe(true);
    expect(inBounds(pt(-1, 0))).toBe(false);
    expect(inBounds(pt(0, -1))).toBe(false);
    expect(inBounds(pt(13, 0))).toBe(false);
    expect(inBounds(pt(0, 19))).toBe(false);
  });

  it('samePoint는 좌표 동치만 본다', () => {
    expect(samePoint(pt(3, 9), pt(3, 9))).toBe(true);
    expect(samePoint(pt(3, 9), pt(9, 3))).toBe(false);
  });

  it('isAdjacent는 4방향 거리 1만 참이다 (대각선·자기 자신 제외)', () => {
    expect(isAdjacent(pt(5, 5), pt(5, 6))).toBe(true);
    expect(isAdjacent(pt(5, 5), pt(4, 5))).toBe(true);
    expect(isAdjacent(pt(5, 5), pt(6, 6))).toBe(false);
    expect(isAdjacent(pt(5, 5), pt(5, 5))).toBe(false);
    expect(isAdjacent(pt(5, 5), pt(5, 7))).toBe(false);
  });

  it('directionBetween이 4방향을 돌려주고 비인접이면 null이다', () => {
    expect(directionBetween(pt(5, 5), pt(5, 4))).toBe('UP');
    expect(directionBetween(pt(5, 5), pt(5, 6))).toBe('DOWN');
    expect(directionBetween(pt(5, 5), pt(4, 5))).toBe('LEFT');
    expect(directionBetween(pt(5, 5), pt(6, 5))).toBe('RIGHT');
    expect(directionBetween(pt(5, 5), pt(7, 5))).toBeNull();
    expect(directionBetween(pt(5, 5), pt(6, 6))).toBeNull();
  });

  it('step은 directionBetween의 역연산이다 (4방향 전수)', () => {
    for (const d of DIRECTIONS) {
      const from = pt(6, 9);
      const to = step(from, d);
      expect(directionBetween(from, to)).toBe(d);
    }
  });

  it('step은 보드 밖으로도 나간다 (경계 판정은 inBounds 몫)', () => {
    expect(step(pt(0, 9), 'LEFT')).toEqual({ x: -1, y: 9 });
    expect(step(pt(12, 17), 'RIGHT')).toEqual({ x: 13, y: 17 });
  });
});

describe('§3.1 격자 점 키', () => {
  it('pointKey = x·19 + y 이고 0..246 범위다', () => {
    expect(pointKey(pt(0, 0))).toBe(0);
    expect(pointKey(pt(0, 18))).toBe(18);
    expect(pointKey(pt(1, 0))).toBe(19);
    expect(pointKey(pt(12, 18))).toBe(246);
  });

  it('격자 전체에서 점 키 충돌이 0건이다 (247점 완전 열거)', () => {
    const points = allPoints();
    expect(points).toHaveLength(247);
    const keys = new Set<PointKey>(points.map(pointKey));
    expect(keys.size).toBe(247);
    for (const k of keys) {
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(246);
    }
  });

  it('decodePointKey가 전 격자에서 왕복한다', () => {
    for (const p of allPoints()) {
      expect(decodePointKey(pointKey(p))).toEqual(p);
    }
  });
});

describe('§3.1 격자 선분 키 (정규형)', () => {
  it('segmentKey(a,b) === segmentKey(b,a) — 양 끝 순서에 무관하다', () => {
    for (const [a, b] of allSegments()) {
      expect(segmentKey(a, b)).toBe(segmentKey(b, a));
    }
  });

  it('격자 전체에서 선분 키 충돌이 0건이다 (462선분 완전 열거)', () => {
    const segments = allSegments();
    expect(segments).toHaveLength(462);
    const keys = new Set<SegmentKey>(segments.map(([a, b]) => segmentKey(a, b)));
    expect(keys.size).toBe(462);
  });

  it('선분 키는 0..493 범위에 든다', () => {
    for (const [a, b] of allSegments()) {
      const k = segmentKey(a, b);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThanOrEqual(493);
    }
  });

  it('수평 선분은 짝수 키, 수직 선분은 홀수 키다', () => {
    expect(segmentKey(pt(3, 9), pt(4, 9)) % 2).toBe(0);
    expect(segmentKey(pt(3, 8), pt(3, 9)) % 2).toBe(1);
  });

  it('점 키와 선분 키는 서로 다른 인덱스다 — 같은 숫자가 다른 대상을 가리킨다', () => {
    // 수평 선분 (0,0)-(1,0)의 키는 0이고 격자 점 (0,0)의 키도 0이다.
    // 두 인덱스를 한 Map에 합치면 점·선분 판정이 서로를 오염시킨다.
    expect(segmentKey(pt(0, 0), pt(1, 0))).toBe(0);
    expect(pointKey(pt(0, 0))).toBe(0);
  });

  it('인접하지 않은 두 점으로 선분 키를 만들면 던진다', () => {
    expect(() => segmentKey(pt(0, 0), pt(2, 0))).toThrow();
    expect(() => segmentKey(pt(0, 0), pt(1, 1))).toThrow();
  });

  it('decodeSegmentKey가 전 격자에서 왕복한다 (앵커가 항상 사전순 작은 쪽)', () => {
    for (const [a, b] of allSegments()) {
      const [anchor, other] = decodeSegmentKey(segmentKey(a, b));
      expect(new Set([pointKey(anchor), pointKey(other)])).toEqual(
        new Set([pointKey(a), pointKey(b)])
      );
      expect(anchor.x < other.x || (anchor.x === other.x && anchor.y < other.y)).toBe(true);
    }
  });
});

describe('§3.1 경로 키 변환', () => {
  it('pathPointKeys는 점 순서를 그대로 옮긴다', () => {
    const path = [pt(3, 7), pt(3, 8), pt(3, 9)];
    expect(pathPointKeys(path)).toEqual([
      pointKey(pt(3, 7)),
      pointKey(pt(3, 8)),
      pointKey(pt(3, 9)),
    ]);
  });

  it('pathSegmentKeys는 선분 L−1개를 만든다', () => {
    const path = [pt(8, 7), pt(8, 8), pt(8, 9), pt(7, 9)];
    const segs = pathSegmentKeys(path);
    expect(segs).toHaveLength(3);
    expect(segs).toEqual([
      segmentKey(pt(8, 7), pt(8, 8)),
      segmentKey(pt(8, 8), pt(8, 9)),
      segmentKey(pt(8, 9), pt(7, 9)),
    ]);
  });

  it('점 1개짜리 경로는 선분이 없다', () => {
    expect(pathSegmentKeys([pt(0, 0)])).toEqual([]);
  });
});

describe('§3.1 OccupancyMap — 점·선분 이중 인덱스', () => {
  /** 세로 사슬 (3,7)-(3,8)-(3,9) 를 사슬 2로 점유한 맵 */
  function verticalMap(): OccupancyMap {
    const map = new OccupancyMap();
    const points = [pt(3, 7), pt(3, 8), pt(3, 9)];
    map.occupy(2, pathPointKeys(points), pathSegmentKeys(points));
    return map;
  }

  it('점유한 격자 점과 선분을 각각 소유자로 되돌려준다', () => {
    const map = verticalMap();
    expect(map.pointOwner(pointKey(pt(3, 9)))).toBe(2);
    expect(map.segmentOwner(segmentKey(pt(3, 8), pt(3, 9)))).toBe(2);
    expect(map.pointOwner(pointKey(pt(4, 9)))).toBeUndefined();
    expect(map.segmentOwner(segmentKey(pt(3, 9), pt(4, 9)))).toBeUndefined();
  });

  it('선분 단위 배타 점유 — 같은 선분을 두 사슬이 가질 수 없다', () => {
    const map = verticalMap();
    const other = [pt(3, 8), pt(3, 9)];
    expect(() => map.occupy(3, pathPointKeys(other), pathSegmentKeys(other))).toThrow();
  });

  it('교차 금지 — 선분을 공유하지 않아도 같은 격자 점을 가질 수 없다', () => {
    const map = verticalMap();
    // (2,9)-(3,9) 수평 선분: 세로 사슬과 선분은 겹치지 않지만 점 (3,9)를 공유한다
    const crossing = [pt(2, 9), pt(3, 9)];
    expect(() => map.occupy(3, pathPointKeys(crossing), pathSegmentKeys(crossing))).toThrow();
  });

  it('충돌하면 아무것도 반영하지 않는다 (부분 점유 금지)', () => {
    const map = verticalMap();
    const crossing = [pt(2, 9), pt(3, 9)];
    expect(() => map.occupy(3, pathPointKeys(crossing), pathSegmentKeys(crossing))).toThrow();
    expect(map.pointOwner(pointKey(pt(2, 9)))).toBeUndefined();
    expect(map.size).toBe(1);
  });

  it('같은 사슬 id를 두 번 점유하면 던진다', () => {
    const map = verticalMap();
    const points = [pt(9, 9), pt(10, 9)];
    expect(() => map.occupy(2, pathPointKeys(points), pathSegmentKeys(points))).toThrow();
  });

  it('release가 그 사슬의 점·선분을 전량 해제한다', () => {
    const map = verticalMap();
    map.release(2);
    expect(map.pointOwner(pointKey(pt(3, 7)))).toBeUndefined();
    expect(map.pointOwner(pointKey(pt(3, 8)))).toBeUndefined();
    expect(map.pointOwner(pointKey(pt(3, 9)))).toBeUndefined();
    expect(map.segmentOwner(segmentKey(pt(3, 7), pt(3, 8)))).toBeUndefined();
    expect(map.segmentOwner(segmentKey(pt(3, 8), pt(3, 9)))).toBeUndefined();
    expect(map.size).toBe(0);
  });

  it('점유한 적 없는 사슬의 release는 아무 일도 하지 않는다', () => {
    const map = verticalMap();
    map.release(99);
    expect(map.size).toBe(1);
  });

  it('해제 후 같은 자리를 다른 사슬이 점유할 수 있다 (§3.4-5 자유 공간)', () => {
    const map = verticalMap();
    map.release(2);
    const crossing = [pt(2, 9), pt(3, 9)];
    expect(() => map.occupy(3, pathPointKeys(crossing), pathSegmentKeys(crossing))).not.toThrow();
    expect(map.pointOwner(pointKey(pt(3, 9)))).toBe(3);
  });

  it('conflicts는 점 단독 겹침을 잡는다 — 01:10 케이스의 핵심 기전', () => {
    const map = verticalMap();
    // 행 9의 수평 진로: 선분은 전부 수평이라 세로 사슬과 공유 선분이 0개다
    const lane = [pt(6, 9), pt(5, 9), pt(4, 9), pt(3, 9), pt(2, 9)];
    const segs = pathSegmentKeys(lane);
    const points = pathPointKeys(lane);
    expect(segs.every((k) => map.segmentOwner(k) === undefined)).toBe(true);
    expect(map.conflicts(points, segs)).toEqual([2]);
  });

  it('conflicts는 오름차순·중복 제거 결과를 돌려준다', () => {
    const map = new OccupancyMap();
    const a = [pt(1, 1), pt(1, 2)];
    const b = [pt(3, 1), pt(3, 2)];
    map.occupy(7, pathPointKeys(a), pathSegmentKeys(a));
    map.occupy(4, pathPointKeys(b), pathSegmentKeys(b));
    const probe = [pointKey(pt(1, 1)), pointKey(pt(1, 2)), pointKey(pt(3, 1)), pointKey(pt(3, 2))];
    expect(map.conflicts(probe, [])).toEqual([4, 7]);
  });

  it('conflicts의 ignore가 자기 몸을 판정에서 뺀다 (§3.3)', () => {
    const map = verticalMap();
    const own = pathPointKeys([pt(3, 7), pt(3, 8), pt(3, 9)]);
    expect(map.conflicts(own, [])).toEqual([2]);
    expect(map.conflicts(own, [], 2)).toEqual([]);
  });

  it('size는 점유 중인 사슬 수다', () => {
    const map = new OccupancyMap();
    expect(map.size).toBe(0);
    const a = [pt(1, 1), pt(1, 2)];
    map.occupy(1, pathPointKeys(a), pathSegmentKeys(a));
    expect(map.size).toBe(1);
    const b = [pt(5, 1), pt(5, 2)];
    map.occupy(2, pathPointKeys(b), pathSegmentKeys(b));
    expect(map.size).toBe(2);
    map.release(1);
    expect(map.size).toBe(1);
  });

  it('같은 입력에 대해 conflicts가 100회 반복 동일하다 (결정성)', () => {
    const map = verticalMap();
    const lane = [pt(6, 9), pt(5, 9), pt(4, 9), pt(3, 9)];
    const expected: readonly number[] = [2];
    for (let i = 0; i < 100; i += 1) {
      expect(map.conflicts(pathPointKeys(lane), pathSegmentKeys(lane))).toEqual(expected);
    }
  });
});

describe('격자 타입 계약', () => {
  it('Direction 유니온이 DIRECTIONS와 같은 4종이다', () => {
    const all: readonly Direction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
    expect([...DIRECTIONS].sort()).toEqual([...all].sort());
  });
});
