// WU-02 T2 — 사슬 데이터 모델 (§3.2)
//
// 노드 수 L·굽힘 수 B는 점수 공식(§5.1)의 입력이라 데이터 모델의 필수 필드다. 여기서 두 값과
// 머리 방향 `d = P(L-1) − P(L-2)`, 유효성 4종을 고정한다.

import { describe, expect, it } from 'vitest';
import {
  CHAIN_STATES,
  bendCount,
  chainPointKeys,
  chainSegmentKeys,
  createChain,
  headDirection,
  headOf,
  segmentCountOf,
  tailOf,
  validateChainPoints,
  type ChainShapeError,
  type ChainShapeErrorCode,
} from '../../src/core/chain';
import { pathPointKeys, pathSegmentKeys, pointKey } from '../../src/core/grid';
import type { ChainState, GridPoint } from '../../src/core/types';
import {
  FIXTURE_0110,
  FIXTURE_DEADLOCK,
  FIXTURE_DEPTH_CHAIN,
  chainsOf,
  pt,
  type PointTuple,
} from './fixtures';

function pts(...coords: readonly PointTuple[]): GridPoint[] {
  return coords.map(([x, y]) => pt(x, y));
}

function codeOf(points: readonly GridPoint[]): ChainShapeErrorCode | null {
  const error: ChainShapeError | null = validateChainPoints(points);
  return error === null ? null : error.code;
}

describe('§3.2 사슬 상태', () => {
  it('상태는 5종이고 순서가 고정돼 있다', () => {
    expect(CHAIN_STATES).toEqual(['normal', 'focused', 'blocked', 'removing', 'removed']);
  });

  it('ChainState 유니온이 CHAIN_STATES와 같은 집합이다', () => {
    const declared: readonly ChainState[] = ['normal', 'focused', 'blocked', 'removing', 'removed'];
    expect([...CHAIN_STATES].sort()).toEqual([...declared].sort());
  });
});

describe('§3.2 유효성 4종', () => {
  it('정상 사슬은 null을 돌려준다', () => {
    expect(validateChainPoints(pts([8, 7], [8, 8], [8, 9], [7, 9], [6, 9]))).toBeNull();
  });

  it('TOO_SHORT — 점 0개', () => {
    expect(validateChainPoints([])).toEqual({ code: 'TOO_SHORT', index: 0 });
  });

  it('TOO_SHORT — 점 1개 (L ≥ 2가 최소 크기)', () => {
    expect(validateChainPoints(pts([3, 3]))).toEqual({ code: 'TOO_SHORT', index: 0 });
  });

  it('L = 2는 유효하다 (선분 1개)', () => {
    expect(validateChainPoints(pts([11, 17], [12, 17]))).toBeNull();
  });

  it('OUT_OF_BOUNDS — 보드 밖 점의 인덱스를 알려준다', () => {
    expect(validateChainPoints(pts([0, 0], [-1, 0]))).toEqual({ code: 'OUT_OF_BOUNDS', index: 1 });
    expect(validateChainPoints(pts([12, 18], [13, 18]))).toEqual({
      code: 'OUT_OF_BOUNDS',
      index: 1,
    });
    expect(codeOf(pts([0, 19], [0, 18]))).toBe('OUT_OF_BOUNDS');
  });

  it('NOT_ADJACENT — 대각선 이동', () => {
    expect(validateChainPoints(pts([5, 5], [6, 6]))).toEqual({ code: 'NOT_ADJACENT', index: 1 });
  });

  it('NOT_ADJACENT — 거리 2 점프', () => {
    expect(validateChainPoints(pts([5, 5], [5, 6], [5, 8]))).toEqual({
      code: 'NOT_ADJACENT',
      index: 2,
    });
  });

  it('SELF_INTERSECT — 같은 격자 점 재방문', () => {
    // ㅁ자 한 바퀴: (1,1)(2,1)(2,2)(1,2)(1,1)
    expect(validateChainPoints(pts([1, 1], [2, 1], [2, 2], [1, 2], [1, 1]))).toEqual({
      code: 'SELF_INTERSECT',
      index: 4,
    });
  });

  it('SELF_INTERSECT — 되돌아가기도 재방문이다', () => {
    expect(validateChainPoints(pts([5, 5], [5, 6], [5, 5]))).toEqual({
      code: 'SELF_INTERSECT',
      index: 2,
    });
  });

  it('검사 우선순위가 TOO_SHORT → OUT_OF_BOUNDS → NOT_ADJACENT → SELF_INTERSECT 로 고정이다', () => {
    // 보드 밖 + 비인접을 동시에 어긴 입력은 항상 OUT_OF_BOUNDS로 거부된다
    expect(codeOf(pts([0, 0], [20, 20]))).toBe('OUT_OF_BOUNDS');
    // 비인접 + 재방문을 동시에 어긴 입력은 항상 NOT_ADJACENT로 거부된다
    expect(codeOf(pts([1, 1], [3, 1], [1, 1]))).toBe('NOT_ADJACENT');
  });
});

describe('§3.2 굽힘 수 B', () => {
  it('직선 사슬은 B = 0이다', () => {
    expect(bendCount(pts([5, 0], [5, 1], [5, 2], [5, 3]))).toBe(0);
    expect(bendCount(pts([1, 1], [2, 1], [3, 1]))).toBe(0);
  });

  it('L = 2 사슬은 내부 점이 없어 B = 0이다', () => {
    expect(bendCount(pts([0, 3], [1, 3]))).toBe(0);
  });

  it('ㄱ자 사슬은 B = 1이다', () => {
    expect(bendCount(pts([8, 7], [8, 8], [8, 9], [7, 9], [6, 9]))).toBe(1);
  });

  it('지그재그는 굽힘이 방향 전환마다 늘어난다', () => {
    // (1,1)→(2,1)→(2,2)→(3,2)→(3,3): RIGHT DOWN RIGHT DOWN → 굽힘 3
    expect(bendCount(pts([1, 1], [2, 1], [2, 2], [3, 2], [3, 3]))).toBe(3);
  });
});

describe('§3.2 createChain', () => {
  it('L·B·depth를 채우고 좌표를 그대로 보존한다', () => {
    const chain = createChain(1, pts([8, 7], [8, 8], [8, 9], [7, 9], [6, 9]), 1);
    expect(chain.id).toBe(1);
    expect(chain.length).toBe(5);
    expect(chain.bends).toBe(1);
    expect(chain.depth).toBe(1);
    expect(chain.points.map((p) => [p.x, p.y])).toEqual([
      [8, 7],
      [8, 8],
      [8, 9],
      [7, 9],
      [6, 9],
    ]);
  });

  it('입력 배열을 복사해 외부 변경에 영향받지 않는다 (Chain은 불변 값)', () => {
    const source = pts([1, 1], [2, 1], [3, 1]);
    const chain = createChain(5, source, 0);
    source[0] = pt(9, 9);
    expect(chain.points[0]).toEqual({ x: 1, y: 1 });
  });

  it('형태가 무효면 코드와 인덱스를 담아 던진다', () => {
    expect(() => createChain(1, pts([0, 0]), 0)).toThrow(/TOO_SHORT/);
    expect(() => createChain(1, pts([0, 0], [2, 0]), 0)).toThrow(/NOT_ADJACENT/);
  });

  it('depth는 0 이상의 정수여야 한다 (픽스처 오기 방어)', () => {
    expect(() => createChain(1, pts([1, 1], [2, 1]), -1)).toThrow(/depth/);
    expect(() => createChain(1, pts([1, 1], [2, 1]), 1.5)).toThrow(/depth/);
    expect(() => createChain(1, pts([1, 1], [2, 1]), 0)).not.toThrow();
  });
});

describe('§3.2 머리·꼬리·선분 수', () => {
  const chain = createChain(1, pts([8, 7], [8, 8], [8, 9], [7, 9], [6, 9]), 1);

  it('머리는 마지막 점 P(L-1)이다', () => {
    expect(headOf(chain)).toEqual({ x: 6, y: 9 });
  });

  it('꼬리는 첫 점 P0이다', () => {
    expect(tailOf(chain)).toEqual({ x: 8, y: 7 });
  });

  it('머리 방향 d = P(L-1) − P(L-2)이다', () => {
    expect(headDirection(chain)).toBe('LEFT');
  });

  it('머리 방향 4종이 모두 나온다', () => {
    expect(headDirection(createChain(1, pts([5, 2], [5, 3]), 0))).toBe('DOWN');
    expect(headDirection(createChain(1, pts([2, 4], [2, 3]), 0))).toBe('UP');
    expect(headDirection(createChain(1, pts([0, 3], [1, 3]), 0))).toBe('RIGHT');
    expect(headDirection(createChain(1, pts([1, 3], [0, 3]), 0))).toBe('LEFT');
  });

  it('선분 수 = L − 1이다', () => {
    expect(segmentCountOf(chain)).toBe(4);
    expect(segmentCountOf(createChain(2, pts([0, 3], [1, 3]), 0))).toBe(1);
  });

  it('chainPointKeys·chainSegmentKeys가 경로 변환과 같다', () => {
    expect(chainPointKeys(chain)).toEqual(pathPointKeys(chain.points));
    expect(chainSegmentKeys(chain)).toEqual(pathSegmentKeys(chain.points));
    expect(chainPointKeys(chain)).toHaveLength(5);
    expect(chainSegmentKeys(chain)).toHaveLength(4);
    expect(chainPointKeys(chain)[0]).toBe(pointKey(pt(8, 7)));
  });
});

describe('픽스처 사슬이 좌표표와 일치한다 (작업 계획 §4.3 · §5)', () => {
  it('FIXTURE_0110 — A는 L=5·B=1·머리 LEFT, B는 L=3·B=0·머리 DOWN', () => {
    const [a, b] = chainsOf(FIXTURE_0110);
    expect([a.id, a.length, a.bends, a.depth, headDirection(a)]).toEqual([1, 5, 1, 1, 'LEFT']);
    expect([b.id, b.length, b.bends, b.depth, headDirection(b)]).toEqual([2, 3, 0, 0, 'DOWN']);
  });

  it('FIXTURE_DEPTH_CHAIN — C0~C3의 L·B·방향·저장 깊이가 표와 같다', () => {
    const [c0, c1, c2, c3] = chainsOf(FIXTURE_DEPTH_CHAIN);
    expect([c0.id, c0.length, c0.bends, c0.depth, headDirection(c0)]).toEqual([
      10,
      4,
      0,
      0,
      'DOWN',
    ]);
    expect([c1.id, c1.length, c1.bends, c1.depth, headDirection(c1)]).toEqual([
      11,
      3,
      0,
      1,
      'RIGHT',
    ]);
    expect([c2.id, c2.length, c2.bends, c2.depth, headDirection(c2)]).toEqual([12, 2, 0, 2, 'UP']);
    expect([c3.id, c3.length, c3.bends, c3.depth, headDirection(c3)]).toEqual([
      13,
      2,
      0,
      3,
      'RIGHT',
    ]);
  });

  it('FIXTURE_DEADLOCK — A는 L=7·B=1·머리 UP, B는 L=3·B=0·머리 DOWN', () => {
    const [a, b] = chainsOf(FIXTURE_DEADLOCK);
    expect([a.id, a.length, a.bends, headDirection(a)]).toEqual([1, 7, 1, 'UP']);
    expect([b.id, b.length, b.bends, headDirection(b)]).toEqual([2, 3, 0, 'DOWN']);
  });
});
