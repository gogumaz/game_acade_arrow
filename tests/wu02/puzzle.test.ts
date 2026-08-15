// WU-02 T3·T4 — 보드 · 진로 판정 · 의존 깊이 · 상태 전이 · ⑦ 등가 · 교착 감지
// (§3.1 · §3.3~§3.6 · §3.8 · §6.1)
//
// 인수 항목: PZL-101 · PZL-102 · **PZL-103(완료 기준 2)** · PZL-104 · PZL-105 · PZL-112

import { describe, expect, it } from 'vitest';
import { createChain, headDirection } from '../../src/core/chain';
import { decodePointKey, pathSegmentKeys, pointKey, segmentKey } from '../../src/core/grid';
import { resolveParams } from '../../src/core/params';
import {
  Board,
  dependencyDepths,
  detectDeadlock,
  initialSafeCount,
  slideOutMs,
  validatePlacement,
  type BoardInit,
  type BoardPlacementError,
  type BoardPlacementErrorCode,
  type DependencyResult,
  type Path,
  type Verdict,
} from '../../src/core/puzzle';
import type { Chain, ChainId, GridPoint } from '../../src/core/types';
import {
  ALL_FIXTURES,
  FIXTURE_0110,
  FIXTURE_DEADLOCK,
  FIXTURE_DEPTH_CAP,
  FIXTURE_DEPTH_CHAIN,
  FIXTURE_PERFECT,
  buildBoard,
  chainsOf,
  lcg,
  pt,
  type Fixture,
  type FixtureChain,
  type PointTuple,
} from './fixtures';

const P = resolveParams();

function pts(...coords: readonly PointTuple[]): GridPoint[] {
  return coords.map(([x, y]) => pt(x, y));
}

function codeOf(chains: readonly Chain[]): BoardPlacementErrorCode | undefined {
  return validatePlacement(chains)?.code;
}

function coordsOf(path: Path): string[] {
  return path.points.map((k) => {
    const p = decodePointKey(k);
    return `${p.x},${p.y}`;
  });
}

/**
 * **선분만 검사하는 축소 구현** — 대조 테스트 전용이다 (완료 기준 2).
 *
 * 생산 코드(`Board.evaluate`)는 §3.3대로 격자 점 + 선분 합집합을 본다. 두 구현이 같은 답을
 * 내면 점 인덱스가 빠졌다는 뜻이므로 이 파일의 대조 테스트가 실패한다.
 */
function segmentOnlyVerdict(board: Board, id: ChainId): Verdict {
  const path = board.path(id);
  const blockers = new Set<ChainId>();
  for (const chain of board.activeChains()) {
    if (chain.id === id) continue;
    const owned = new Set(pathSegmentKeys(chain.points));
    for (const k of path.segments) if (owned.has(k)) blockers.add(chain.id);
  }
  const sorted = [...blockers].sort((a, b) => a - b);
  return { safe: sorted.length === 0, blockers: sorted };
}

describe('PZL-101 §3.1 배치 유효성 — 선분 배타 점유·교차 금지', () => {
  it('정상 배치는 null이다 (픽스처 5종 전량)', () => {
    for (const fixture of ALL_FIXTURES) {
      expect(validatePlacement(chainsOf(fixture))).toBeNull();
    }
  });

  it('DUPLICATE_ID — 같은 id를 두 번 배치할 수 없다', () => {
    const chains = [createChain(1, pts([1, 1], [2, 1]), 0), createChain(1, pts([5, 5], [6, 5]), 0)];
    expect(codeOf(chains)).toBe('DUPLICATE_ID');
  });

  it('픽스처 좌표표가 그대로 유효한 사슬이 된다 (표 전사 검증)', () => {
    const spec: readonly FixtureChain[] = FIXTURE_0110.chains;
    expect(spec.map((c) => c.id)).toEqual([1, 2]);
    expect(spec[0].points).toHaveLength(5);
    const init: BoardInit = {
      chains: chainsOf(FIXTURE_0110),
      boardNumber: FIXTURE_0110.boardNumber,
      seed: FIXTURE_0110.seed,
    };
    expect(new Board(init).chains().map((c) => c.id)).toEqual([1, 2]);
  });

  it('boardNumber·seed는 선택 항목이다 (기본 보드 번호 1)', () => {
    const init: BoardInit = { chains: chainsOf(FIXTURE_PERFECT) };
    const board = new Board(init);
    expect(board.boardNumber).toBe(1);
    expect(board.seed).toBeUndefined();
  });

  it('SEGMENT_CONFLICT — 선분 중복 0건 규칙', () => {
    const chains = [
      createChain(1, pts([1, 1], [2, 1], [3, 1]), 0),
      createChain(2, pts([2, 1], [3, 1]), 0),
    ];
    const error: BoardPlacementError | null = validatePlacement(chains);
    expect(error?.code).toBe('SEGMENT_CONFLICT');
    expect(error?.other).toBe(1);
  });

  it('POINT_CONFLICT — 선분을 공유하지 않아도 격자 점 공유는 금지다', () => {
    const chains = [
      createChain(1, pts([3, 7], [3, 8], [3, 9]), 0),
      createChain(2, pts([2, 9], [3, 9]), 0), // 수평 — 점 (3,9)만 공유
    ];
    const error = validatePlacement(chains);
    expect(error?.code).toBe('POINT_CONFLICT');
    expect(error?.other).toBe(1);
  });

  it('INVALID_SHAPE — 형태가 깨진 사슬은 배치 전에 거부된다', () => {
    const broken: Chain = { id: 1, points: pts([0, 0], [2, 0]), length: 2, bends: 0, depth: 0 };
    expect(codeOf([broken])).toBe('INVALID_SHAPE');
  });

  it('INVALID_SHAPE — L·B가 좌표와 어긋난 사슬도 거부된다', () => {
    const wrongLength: Chain = {
      id: 1,
      points: pts([1, 1], [2, 1]),
      length: 5,
      bends: 0,
      depth: 0,
    };
    const wrongBends: Chain = { id: 2, points: pts([1, 5], [2, 5]), length: 2, bends: 3, depth: 0 };
    expect(codeOf([wrongLength])).toBe('INVALID_SHAPE');
    expect(codeOf([wrongBends])).toBe('INVALID_SHAPE');
  });

  it('Board 생성자가 무효 배치를 던진다', () => {
    expect(
      () =>
        new Board({
          chains: [createChain(1, pts([1, 1], [2, 1]), 0), createChain(2, pts([1, 1], [1, 2]), 0)],
        })
    ).toThrow();
  });

  it('오류는 코드·사슬 id·상대 id를 담는다', () => {
    const error = validatePlacement([
      createChain(1, pts([1, 1], [2, 1]), 0),
      createChain(2, pts([1, 1], [1, 2]), 0),
    ]);
    expect(error).toEqual({ code: 'POINT_CONFLICT', chainId: 2, other: 1 });
  });
});

describe('§3.3 진로 R(S) 구성', () => {
  it('머리 자신의 점은 R(S)에 넣지 않고 머리에 붙은 첫 선분부터 넣는다', () => {
    const board = buildBoard(FIXTURE_0110);
    const path = board.path(1);
    expect(coordsOf(path)).toEqual(['5,9', '4,9', '3,9', '2,9', '1,9', '0,9']);
    expect(path.points).not.toContain(pointKey(pt(6, 9)));
    expect(path.segments[0]).toBe(segmentKey(pt(6, 9), pt(5, 9)));
    expect(path.segments).toHaveLength(6);
  });

  it('보드 경계를 만나면 그 지점에서 판정을 끝낸다', () => {
    const board = buildBoard(FIXTURE_0110);
    expect(board.path(2).points).toHaveLength(9); // (3,10)..(3,18)
    expect(coordsOf(board.path(2))[8]).toBe('3,18');
  });

  it('머리가 경계에 있고 방향이 바깥이면 R(S)는 공집합이고 항상 안전수다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CAP);
    expect(board.path(1)).toEqual({ points: [], segments: [] });
    expect(board.evaluate(1).safe).toBe(true);
  });

  it('R(S)는 보드 상태와 무관한 사슬 고유 기하다 (제거 후에도 같다)', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    const before = board.path(13);
    board.beginRemoval(10);
    board.completeRemoval(10);
    expect(board.path(13)).toEqual(before);
  });

  it('없는 사슬의 진로를 물으면 던진다', () => {
    const board = buildBoard(FIXTURE_0110);
    expect(() => board.path(99)).toThrow();
  });
});

describe('PZL-102 §3.3 막힘 조건 — 점 또는 선분 하나라도 겹치면 막힘', () => {
  it('선분 단독 겹침 → 막힘', () => {
    // 같은 행의 두 수평 사슬: 뒤 사슬의 진로가 앞 사슬의 수평 선분을 그대로 지난다
    const board = new Board({
      chains: [
        createChain(1, pts([0, 5], [1, 5]), 0),
        createChain(2, pts([5, 5], [4, 5], [3, 5]), 1),
      ],
    });
    const path = board.path(2);
    expect(path.segments).toContain(segmentKey(pt(0, 5), pt(1, 5)));
    expect(board.evaluate(2)).toEqual({ safe: false, blockers: [1] });
  });

  it('격자 점 단독 겹침 → 막힘 (공유 선분 0개)', () => {
    const board = buildBoard(FIXTURE_0110);
    const path = board.path(1);
    const blockerSegments = new Set(pathSegmentKeys(chainsOf(FIXTURE_0110)[1].points));
    expect(path.segments.some((k) => blockerSegments.has(k))).toBe(false);
    expect(path.points).toContain(pointKey(pt(3, 9)));
    expect(board.evaluate(1)).toEqual({ safe: false, blockers: [2] });
  });

  it('점·선분 둘 다 겹침 → 막힘 (블로커 1회만 보고)', () => {
    const board = buildBoard(FIXTURE_DEADLOCK);
    const path = board.path(1);
    const blockerSegments = new Set(pathSegmentKeys(chainsOf(FIXTURE_DEADLOCK)[1].points));
    expect(path.segments.some((k) => blockerSegments.has(k))).toBe(true);
    expect(path.points).toContain(pointKey(pt(6, 2)));
    expect(board.evaluate(1)).toEqual({ safe: false, blockers: [2] });
  });

  it('겹침이 없으면 안전수다', () => {
    const board = buildBoard(FIXTURE_0110);
    expect(board.evaluate(2)).toEqual({ safe: true, blockers: [] });
  });

  it('자기 몸은 판정 대상이 아니다 — 자기 진로에 자기 점이 있어도 안전수다', () => {
    // 나선형: 머리 (2,3)이 UP을 향하고 진로 첫 점 (2,2)가 자기 꼬리 P0다
    const board = new Board({
      chains: [
        createChain(1, pts([2, 2], [3, 2], [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [2, 3]), 0),
      ],
    });
    expect(headDirection(board.chains()[0])).toBe('UP');
    expect(board.path(1).points).toContain(pointKey(pt(2, 2)));
    expect(board.evaluate(1)).toEqual({ safe: true, blockers: [] });
  });

  it('blockers는 오름차순이다 (블로커 2개)', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    expect(board.evaluate(13).blockers).toEqual([10, 12]);
  });

  it('판정은 난수·시간·호출 순서에 의존하지 않는다 (100회 반복 동일)', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    const first = board.chains().map((c) => board.evaluate(c.id));
    for (let i = 0; i < 100; i += 1) {
      expect(board.chains().map((c) => board.evaluate(c.id))).toEqual(first);
    }
  });

  it('없는 사슬을 판정하면 던진다', () => {
    expect(() => buildBoard(FIXTURE_0110).evaluate(99)).toThrow();
  });
});

describe('PZL-103 영상 01:10 케이스 (완료 기준 2)', () => {
  it('수평 진로 위 격자 점을 세로 선분이 점유하면 막힘이다 — 블로커 [2]', () => {
    const board = buildBoard(FIXTURE_0110);
    const verdict = board.evaluate(1);
    expect(verdict.safe).toBe(false);
    expect(verdict.blockers).toEqual([2]);
    expect(headDirection(board.chains()[0])).toBe('LEFT');
  });

  it('대조 — "선분만 검사"는 안전수로 오판하고 "점+선분"은 막힘으로 판정한다', () => {
    const board = buildBoard(FIXTURE_0110);
    const segmentOnly = segmentOnlyVerdict(board, 1);
    const production = board.evaluate(1);

    // 두 판정이 같아지면(= 점 인덱스가 빠지면) 이 테스트가 실패한다
    expect(segmentOnly.safe).toBe(true);
    expect(production.safe).toBe(false);
    expect(segmentOnly.safe).not.toBe(production.safe);
    expect(segmentOnly.blockers).toEqual([]);
    expect(production.blockers).toEqual([2]);
  });

  it('대조 — FIXTURE_DEPTH_CHAIN의 블로킹 4건도 전부 격자 점 단독이다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    for (const id of [11, 12, 13] as const) {
      expect(segmentOnlyVerdict(board, id).safe).toBe(true);
      expect(board.evaluate(id).safe).toBe(false);
    }
    // C3은 블로커 2개 — 둘 다 점 단독이다
    expect(board.evaluate(13).blockers).toEqual([10, 12]);
    expect(segmentOnlyVerdict(board, 13).blockers).toEqual([]);
  });

  it('블로커 B를 빼면 A의 진로가 열린다 (재선택 가능 — PZL-108의 보드분)', () => {
    const board = buildBoard(FIXTURE_0110);
    expect(board.evaluate(1).safe).toBe(false);
    board.beginRemoval(2);
    expect(board.evaluate(1).safe).toBe(false); // 제거 중에는 아직 블로커 (PZL-106)
    board.completeRemoval(2);
    expect(board.evaluate(1).safe).toBe(true);
  });
});

describe('§3.3 안전수 목록', () => {
  it('safeMoves는 id 오름차순이다', () => {
    const board = buildBoard(FIXTURE_PERFECT);
    expect(board.safeMoves()).toEqual([1, 2]);
  });

  it('막힌 보드는 안전수가 1개뿐이다 (FIXTURE_DEPTH_CHAIN)', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    expect(board.safeMoves()).toEqual([10]);
    expect(initialSafeCount(board)).toBe(1);
  });

  it('교착 보드의 안전수는 0개다', () => {
    const board = buildBoard(FIXTURE_DEADLOCK);
    expect(board.safeMoves()).toEqual([]);
    expect(initialSafeCount(board)).toBe(0);
  });

  it('제거된 사슬은 안전수 목록에서 빠진다', () => {
    const board = buildBoard(FIXTURE_PERFECT);
    board.beginRemoval(1);
    board.completeRemoval(1);
    expect(board.safeMoves()).toEqual([2]);
  });
});

describe('PZL-104 · PZL-105 · PZL-106 보드 상태 전이', () => {
  it('PZL-104 — markBlocked는 표시만 세우고 점유·revision을 바꾸지 않는다', () => {
    const board = buildBoard(FIXTURE_0110);
    const beforeRevision = board.revision;
    const beforePath = board.path(1);
    board.markBlocked(1);
    expect(board.stateOf(1)).toBe('blocked');
    expect(board.revision).toBe(beforeRevision);
    expect(board.path(1)).toEqual(beforePath);
    expect(board.evaluate(1)).toEqual({ safe: false, blockers: [2] });
    expect(board.evaluate(2).safe).toBe(true);
  });

  it('PZL-108 — 빨간 표시는 자동으로 사라지지 않고 제거될 때 사라진다', () => {
    const board = buildBoard(FIXTURE_0110);
    board.markBlocked(1);
    board.beginRemoval(2);
    board.completeRemoval(2);
    expect(board.stateOf(1)).toBe('blocked'); // 진로가 열려도 표시는 잔존
    board.beginRemoval(1);
    board.completeRemoval(1);
    expect(board.stateOf(1)).toBe('removed');
  });

  it('PZL-106 — beginRemoval은 removing으로 바꾸고 점유를 유지한다', () => {
    const board = buildBoard(FIXTURE_0110);
    board.beginRemoval(2);
    expect(board.stateOf(2)).toBe('removing');
    expect(board.revision).toBe(0);
    expect(board.evaluate(1)).toEqual({ safe: false, blockers: [2] });
    expect(board.activeChains().map((c) => c.id)).toEqual([1, 2]);
  });

  it('completeRemoval이 removed 전이·점유 해제·revision++를 원자적으로 처리한다', () => {
    const board = buildBoard(FIXTURE_0110);
    board.beginRemoval(2);
    board.completeRemoval(2);
    expect(board.stateOf(2)).toBe('removed');
    expect(board.revision).toBe(1);
    expect(board.activeChains().map((c) => c.id)).toEqual([1]);
    expect(board.evaluate(1)).toEqual({ safe: true, blockers: [] });
  });

  it('제거 중이 아닌 사슬을 completeRemoval 하면 던진다', () => {
    const board = buildBoard(FIXTURE_0110);
    expect(() => board.completeRemoval(1)).toThrow();
  });

  it('이미 제거 중·제거된 사슬은 다시 개시하거나 막힘 표시할 수 없다', () => {
    const board = buildBoard(FIXTURE_0110);
    board.beginRemoval(2);
    expect(() => board.beginRemoval(2)).toThrow();
    expect(() => board.markBlocked(2)).toThrow();
    board.completeRemoval(2);
    expect(() => board.beginRemoval(2)).toThrow();
  });

  it('PZL-105 — exitPath가 머리가 지나갈 격자 점 열 + 보드 밖 첫 점을 준다', () => {
    const board = buildBoard(FIXTURE_0110);
    expect(board.exitPath(1)).toEqual([
      { x: 5, y: 9 },
      { x: 4, y: 9 },
      { x: 3, y: 9 },
      { x: 2, y: 9 },
      { x: 1, y: 9 },
      { x: 0, y: 9 },
      { x: -1, y: 9 },
    ]);
  });

  it('PZL-105 — 경계에 붙은 머리의 exitPath는 보드 밖 1점뿐이다', () => {
    expect(buildBoard(FIXTURE_DEPTH_CAP).exitPath(1)).toEqual([{ x: 13, y: 17 }]);
  });

  it('PZL-105 — 제거가 끝나면 그 사슬의 점·선분이 전부 자유 공간이 된다 (§3.4-5)', () => {
    const board = buildBoard(FIXTURE_0110);
    board.beginRemoval(2);
    board.completeRemoval(2);
    // 세로 사슬이 있던 자리를 가로지르는 배치가 이제 유효하다
    const survivor = board.chains().filter((c) => board.stateOf(c.id) !== 'removed');
    expect(survivor.map((c) => c.id)).toEqual([1]);
    expect(board.evaluate(1).blockers).toEqual([]);
  });

  it('isCleared는 활성 사슬이 0일 때만 참이다 (§3.6)', () => {
    const board = buildBoard(FIXTURE_PERFECT);
    expect(board.isCleared()).toBe(false);
    board.beginRemoval(1);
    board.completeRemoval(1);
    expect(board.isCleared()).toBe(false);
    board.beginRemoval(2);
    board.completeRemoval(2);
    expect(board.isCleared()).toBe(true);
  });

  it('boardNumber·seed·chains 순서가 보존된다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    expect(board.boardNumber).toBe(4);
    expect(board.seed).toBe('wu02-depth');
    expect(board.chains().map((c) => c.id)).toEqual([10, 11, 12, 13]);
    expect(board.chain(11)?.depth).toBe(1);
    expect(board.chain(99)).toBeUndefined();
    expect(() => board.stateOf(99)).toThrow();
  });
});

describe('⑦ 부분 갱신 === 전체 재계산 (§3.7 · 완료 기준 4)', () => {
  it('한 번의 제거 후 두 결과가 같다', () => {
    const partial = buildBoard(FIXTURE_DEPTH_CHAIN);
    partial.beginRemoval(10);
    partial.completeRemoval(10);
    const afterPartial = [...partial.safeMoves()];
    partial.recomputeAll();
    expect([...partial.safeMoves()]).toEqual(afterPartial);
    expect(afterPartial).toEqual([11]);
  });

  it('무작위 제거 순서 200회 전 구간에서 두 결과가 한 번도 어긋나지 않는다', () => {
    const random = lcg(20260815);
    let steps = 0;
    for (let round = 0; round < 200; round += 1) {
      const board = buildBoard(FIXTURE_DEPTH_CHAIN);
      while (!board.isCleared()) {
        const safe = board.safeMoves();
        expect(safe.length).toBeGreaterThan(0);
        const pick = safe[Math.floor(random() * safe.length)];
        board.beginRemoval(pick);
        board.completeRemoval(pick);

        const partialSafe = [...board.safeMoves()];
        const partialVerdicts = board.activeChains().map((c) => board.evaluate(c.id));
        board.recomputeAll();
        expect([...board.safeMoves()]).toEqual(partialSafe);
        expect(board.activeChains().map((c) => board.evaluate(c.id))).toEqual(partialVerdicts);
        steps += 1;
      }
    }
    expect(steps).toBe(800); // 4사슬 × 200회
  });

  it('막힘 표시만으로는 판정이 달라지지 않는다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    const before = board.activeChains().map((c) => board.evaluate(c.id));
    board.markBlocked(13);
    board.recomputeAll();
    expect(board.activeChains().map((c) => board.evaluate(c.id))).toEqual(before);
  });
});

describe('§6.1 의존 깊이', () => {
  it('깊이 0·1·2·3과 "블로커 2개 중 최댓값" 분기가 모두 성립한다', () => {
    const result: DependencyResult = dependencyDepths(buildBoard(FIXTURE_DEPTH_CHAIN));
    expect(result.depths.get(10)).toBe(0);
    expect(result.depths.get(11)).toBe(1);
    expect(result.depths.get(12)).toBe(2);
    expect(result.depths.get(13)).toBe(3); // 1 + max(2, 0)
    expect(result.cyclic.size).toBe(0);
    expect(result.boardDepth).toBe(3);
  });

  it('막는 사슬이 없으면 깊이 0이다', () => {
    const result = dependencyDepths(buildBoard(FIXTURE_PERFECT));
    expect([...result.depths.values()]).toEqual([0, 0]);
    expect(result.boardDepth).toBe(0);
  });

  it('순환에 걸린 사슬은 depths가 아니라 cyclic에 들어가고 boardDepth는 −1이다', () => {
    const result = dependencyDepths(buildBoard(FIXTURE_DEADLOCK));
    expect(result.depths.size).toBe(0);
    expect([...result.cyclic].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(result.boardDepth).toBe(-1);
  });

  it('순환 사슬을 블로커로 가진 사슬도 함께 cyclic에 들어간다', () => {
    // 1↔2 순환에 3이 매달린 배치: 3의 진로가 1의 몸을 지난다
    const board = new Board({
      chains: [
        createChain(1, pts([2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [6, 7], [6, 6]), 2),
        createChain(2, pts([6, 1], [6, 2], [6, 3]), 1),
        createChain(3, pts([0, 8], [1, 8]), 3), // RIGHT — 진로가 (2,8)에서 사슬 1과 만난다
      ],
    });
    const result = dependencyDepths(board);
    expect(result.depths.size).toBe(0);
    expect([...result.cyclic].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(result.boardDepth).toBe(-1);
  });

  it('제거된 사슬은 계산에서 빠지고 남은 사슬의 깊이가 줄어든다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    board.beginRemoval(10);
    board.completeRemoval(10);
    const result = dependencyDepths(board);
    expect(result.depths.get(11)).toBe(0);
    expect(result.depths.get(12)).toBe(1);
    expect(result.depths.get(13)).toBe(2);
    expect(result.boardDepth).toBe(2);
  });

  it('removing 상태 사슬은 점유가 살아 있어 계산에 포함된다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    board.beginRemoval(10);
    expect(dependencyDepths(board).depths.get(11)).toBe(1);
  });

  it('빈 보드의 boardDepth는 0이다', () => {
    const board = buildBoard(FIXTURE_PERFECT);
    for (const id of [1, 2] as const) {
      board.beginRemoval(id);
      board.completeRemoval(id);
    }
    const result = dependencyDepths(board);
    expect(result.depths.size).toBe(0);
    expect(result.boardDepth).toBe(0);
  });

  it('같은 보드에서 100회 반복 호출이 같은 결과를 낸다 (결정성)', () => {
    const board = buildBoard(FIXTURE_DEPTH_CHAIN);
    const first = [...dependencyDepths(board).depths.entries()];
    for (let i = 0; i < 100; i += 1) {
      expect([...dependencyDepths(board).depths.entries()]).toEqual(first);
    }
  });

  it('픽스처 정합 — 저장 depth가 초기 보드의 계산 depth와 일치한다 (R11)', () => {
    for (const fixture of ALL_FIXTURES.filter((f: Fixture) => f.depthConsistent)) {
      const board = buildBoard(fixture);
      const { depths } = dependencyDepths(board);
      for (const chain of board.chains()) {
        expect(`${fixture.name}#${chain.id}=${String(depths.get(chain.id))}`).toBe(
          `${fixture.name}#${chain.id}=${chain.depth}`
        );
      }
    }
  });
});

describe('PZL-112 §3.8 교착 감지', () => {
  it('안전수가 있으면 보정 대상이 없다', () => {
    expect(detectDeadlock(buildBoard(FIXTURE_DEPTH_CHAIN))).toBeNull();
    expect(detectDeadlock(buildBoard(FIXTURE_PERFECT))).toBeNull();
  });

  it('빈 보드는 보정 대상이 없다', () => {
    const board = buildBoard(FIXTURE_DEPTH_CAP);
    board.beginRemoval(1);
    board.completeRemoval(1);
    expect(detectDeadlock(board)).toBeNull();
  });

  it('전량 순환이면 저장 깊이가 가장 얕은 사슬을 고른다 (규칙 ②)', () => {
    // A(저장 깊이 2) ↔ B(저장 깊이 1) → B(id 2)
    expect(detectDeadlock(buildBoard(FIXTURE_DEADLOCK))).toBe(2);
  });

  it('저장 깊이가 동률이면 id가 작은 사슬을 고른다 (규칙 ③)', () => {
    const board = new Board({
      chains: [
        createChain(5, pts([2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [6, 7], [6, 6]), 4),
        createChain(3, pts([6, 1], [6, 2], [6, 3]), 4),
      ],
    });
    expect(board.safeMoves()).toEqual([]);
    expect(detectDeadlock(board)).toBe(3);
  });

  it('보정 후 남은 사슬이 안전수가 되어 보드가 진행된다', () => {
    const board = buildBoard(FIXTURE_DEADLOCK);
    const target = detectDeadlock(board);
    expect(target).toBe(2);
    board.beginRemoval(2);
    board.completeRemoval(2);
    expect(board.safeMoves()).toEqual([1]);
    expect(detectDeadlock(board)).toBeNull();
  });
});

describe('§3.4 슬라이드 아웃 시간 (EFX-810 수치분)', () => {
  it('min(180 + 22 × 선분 수, 750)ms 로 계산한다', () => {
    const [a, b] = chainsOf(FIXTURE_0110);
    expect(slideOutMs(a, P)).toBe(268); // 180 + 22 × 4
    expect(slideOutMs(b, P)).toBe(224); // 180 + 22 × 2
  });

  it('FIXTURE_DEPTH_CHAIN의 네 사슬은 246 / 224 / 202 / 202 ms 다', () => {
    const chains = chainsOf(FIXTURE_DEPTH_CHAIN);
    expect(chains.map((c) => slideOutMs(c, P))).toEqual([246, 224, 202, 202]);
  });

  it('상한 750ms 를 넘지 않는다', () => {
    const long = createChain(
      1,
      Array.from({ length: 19 }, (_, y) => pt(0, y)),
      0
    );
    expect(180 + 22 * 18).toBe(576);
    expect(slideOutMs(long, P)).toBe(576);
    expect(slideOutMs(long, { ...P, slideOutCapMs: 300 })).toBe(300);
  });

  it('상한은 콤보 창(2.2초)의 50% 이하다 (§11.4 N16 제약)', () => {
    expect(P.slideOutCapMs).toBeLessThanOrEqual(P.comboWindowMs / 2);
  });
});
