// 픽스처 보드 세트 정합 (작업 계획 §9.3 8항목 × 7보드) · §6.2 구간표 · CTL-004 계측
//
// 이 파일이 하는 일은 "패턴 P가 진짜로 성립하는가"를 **닫힌 형태 공식 · 코어 실측 · 계획 표**
// 3중으로 대조하는 것이다. 하나라도 어긋나면 보드가 아니라 근거가 틀린 것이다.

import { describe, it, expect } from 'vitest';
import {
  Board,
  dependencyDepths,
  initialSafeCount,
  validatePlacement,
} from '../../src/core/puzzle';
import type { ChainId } from '../../src/core/types';
import { focusColumns, structuralMoveBound, worstCaseMoves } from '../../src/game/focus';
import {
  B0_TUTORIAL,
  B1_WARMUP,
  B2_WARMUP,
  B3_RHYTHM,
  B4_RHYTHM,
  B5_PRESSURE,
  B6_DENSE,
  ROTATION,
  TIER_RANGES,
  TUTORIAL_CHAIN_BLOCKED,
  TUTORIAL_CHAIN_SAFE,
  WU03_FIXTURES,
  buildFixtureBoard,
  chainsOfSpec,
  connectorChainId,
  connectorDepth,
  fixtureBoardSource,
  ladderChainId,
  ladderDepth,
  ladderRowY,
  seedFor,
  tierLabel,
  tierOf,
  tutorialBoard,
  buildLadderChains,
  type FixtureBoardSpec,
  type LadderSpec,
  type TierRange,
} from '../../src/game/boardSource';
import { lcg } from './harness';

/** 작업 계획 §9.2 사양표 — **예측값**이다. 실측이 다르면 표가 아니라 근거를 다시 본다 */
interface Expectation {
  readonly spec: FixtureBoardSpec;
  readonly chains: number;
  readonly safeMoves: number;
  readonly maxDepth: number;
  readonly columns: number;
  readonly maxColumnSize: number;
  readonly moveBound: number;
}

const EXPECTED: readonly Expectation[] = [
  {
    spec: B0_TUTORIAL,
    chains: 2,
    safeMoves: 1,
    maxDepth: 1,
    columns: 2,
    maxColumnSize: 1,
    moveBound: 1,
  },
  {
    spec: B1_WARMUP,
    chains: 9,
    safeMoves: 3,
    maxDepth: 2,
    columns: 3,
    maxColumnSize: 3,
    moveBound: 2,
  },
  {
    spec: B2_WARMUP,
    chains: 12,
    safeMoves: 3,
    maxDepth: 3,
    columns: 4,
    maxColumnSize: 3,
    moveBound: 3,
  },
  {
    spec: B3_RHYTHM,
    chains: 15,
    safeMoves: 3,
    maxDepth: 4,
    columns: 5,
    maxColumnSize: 3,
    moveBound: 3,
  },
  {
    spec: B4_RHYTHM,
    chains: 18,
    safeMoves: 3,
    maxDepth: 5,
    columns: 5,
    maxColumnSize: 4,
    moveBound: 4,
  },
  {
    spec: B5_PRESSURE,
    chains: 23,
    safeMoves: 2,
    maxDepth: 7,
    columns: 6,
    maxColumnSize: 4,
    moveBound: 5,
  },
  {
    spec: B6_DENSE,
    chains: 40,
    safeMoves: 3,
    maxDepth: 9,
    columns: 7,
    maxColumnSize: 6,
    moveBound: 6,
  },
];

/** §6.4 #7 · §2.2 — 최악 조작 수 출시 차단선 */
const MOVE_LIMIT = 12;
/** §6.3 3단계 — 한 열의 대표점 상한 */
const COLUMN_CAP = 8;

function boardOf(spec: FixtureBoardSpec): Board {
  return buildFixtureBoard(spec, 1, `test-${spec.name}`);
}

/** 안전수를 하나씩 골라 끝까지 비운다. 매 단계 안전수가 최소 1개여야 한다 */
function clearBoard(board: Board, pick: (safe: readonly ChainId[]) => ChainId): number {
  let steps = 0;
  while (!board.isCleared()) {
    const safe = board.safeMoves();
    expect(safe.length).toBeGreaterThanOrEqual(1);
    const target = pick(safe);
    board.beginRemoval(target);
    board.completeRemoval(target);
    steps += 1;
    expect(steps).toBeLessThanOrEqual(64); // 무한 루프 방지
  }
  return steps;
}

describe.each(EXPECTED)('픽스처 정합 — $spec.name', (exp) => {
  it('① 배치가 유효하다 (배타 점유·교차 금지)', () => {
    expect(validatePlacement(chainsOfSpec(exp.spec))).toBeNull();
  });

  it('② 저장 depth = dependencyDepths 실측 = 사다리 공식 (3중 대조)', () => {
    const board = boardOf(exp.spec);
    const { depths, cyclic, boardDepth } = dependencyDepths(board);
    expect(cyclic.size).toBe(0);
    for (const chain of board.chains()) {
      expect(depths.get(chain.id)).toBe(chain.depth);
    }
    expect(boardDepth).toBe(exp.maxDepth);

    const ladder = exp.spec.ladder;
    if (ladder === undefined) return; // 튜토리얼 수제 보드는 2중 대조까지
    for (let row = 0; row < ladder.rows; row += 1) {
      for (let col = 0; col < ladder.perRow; col += 1) {
        expect(depths.get(ladderChainId(row, col))).toBe(ladderDepth(ladder, row, col));
      }
    }
    for (const row of ladder.connectorRows) {
      expect(depths.get(connectorChainId(row))).toBe(connectorDepth(ladder, row));
    }
  });

  it('③ 깊이 오름차순 제거로 전 사슬이 비워진다 (해법 존재)', () => {
    const board = boardOf(exp.spec);
    const depthOf = new Map(board.chains().map((c) => [c.id, c.depth]));
    const steps = clearBoard(
      board,
      (safe) =>
        [...safe].sort((a, b) => {
          const da = depthOf.get(a) ?? 0;
          const db = depthOf.get(b) ?? 0;
          return da === db ? a - b : da - db;
        })[0]
    );
    expect(steps).toBe(exp.chains);
    expect(board.isCleared()).toBe(true);
  });

  it('④ 초기 안전수가 예측값과 같다', () => {
    expect(initialSafeCount(boardOf(exp.spec))).toBe(exp.safeMoves);
  });

  it('⑤ worstCaseMoves ≤ structuralMoveBound ≤ 12 (CTL-004)', () => {
    const board = boardOf(exp.spec);
    const bound = structuralMoveBound(board);
    const worst = worstCaseMoves(board);
    expect(bound).toBe(exp.moveBound);
    expect(worst).toBeLessThanOrEqual(bound);
    expect(bound).toBeLessThanOrEqual(MOVE_LIMIT);
  });

  it('⑥ 한 열의 대표점이 8개를 넘지 않는다 (§6.3 3단계)', () => {
    const columns = focusColumns(boardOf(exp.spec));
    expect(columns.length).toBe(exp.columns);
    const sizes = columns.map((c) => c.ids.length);
    expect(Math.max(...sizes)).toBe(exp.maxColumnSize);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(COLUMN_CAP);
  });

  it('⑦ 사슬 수·안전수·최대 깊이가 지정 구간의 §6.2 범위 안이다', () => {
    const board = boardOf(exp.spec);
    expect(board.chains().length).toBe(exp.chains);
    if (exp.spec.tier === null) {
      // 계측 전용 보드는 구간 대조 대상이 아니다 — 대신 순환 공급에서 빠져야 한다
      expect(exp.spec.rotates).toBe(false);
      return;
    }
    const range = TIER_RANGES[exp.spec.tier];
    expect(exp.chains).toBeGreaterThanOrEqual(range.chains[0]);
    expect(exp.chains).toBeLessThanOrEqual(range.chains[1]);
    expect(exp.safeMoves).toBeGreaterThanOrEqual(range.safeMoves[0]);
    expect(exp.safeMoves).toBeLessThanOrEqual(range.safeMoves[1]);
    expect(exp.maxDepth).toBeGreaterThanOrEqual(range.depth[0]);
    expect(exp.maxDepth).toBeLessThanOrEqual(range.depth[1]);
  });

  it('⑧ 무작위 제거 경로 20개의 전 중간 상태에서도 조작 수 ≤ 12 (CTL-004)', () => {
    let worstSeen = 0;
    for (let path = 0; path < 20; path += 1) {
      const rand = lcg(0x5eed + path);
      const board = boardOf(exp.spec);
      for (;;) {
        const worst = worstCaseMoves(board);
        if (worst > worstSeen) worstSeen = worst;
        expect(worst).toBeLessThanOrEqual(structuralMoveBound(board));
        expect(worst).toBeLessThanOrEqual(MOVE_LIMIT);
        if (board.isCleared()) break;
        const safe = board.safeMoves();
        const pool = safe.length > 0 ? safe : board.activeChains().map((c) => c.id);
        const target = pool[Math.floor(rand() * pool.length) % pool.length];
        board.beginRemoval(target);
        board.completeRemoval(target);
      }
    }
    expect(worstSeen).toBeLessThanOrEqual(exp.moveBound);
  });
});

describe('B0 미니 튜토리얼 보드 (§4.7)', () => {
  it('안전수는 정확히 1개이고 그것이 지정 사슬이다', () => {
    expect(tutorialBoard().safeMoves()).toEqual([TUTORIAL_CHAIN_SAFE]);
  });

  it('나머지 1개는 막힌 사슬이라 "빛나는 사슬"과 대비된다', () => {
    const board = tutorialBoard();
    expect(board.evaluate(TUTORIAL_CHAIN_BLOCKED).safe).toBe(false);
    expect(board.evaluate(TUTORIAL_CHAIN_BLOCKED).blockers).toEqual([TUTORIAL_CHAIN_SAFE]);
  });

  it('보드 번호 0으로 순환 공급과 분리된다', () => {
    expect(tutorialBoard().boardNumber).toBe(0);
  });
});

describe('tierOf · tierLabel (§6.2)', () => {
  it.each([
    [1, 'WARMUP'],
    [3, 'WARMUP'],
    [4, 'RHYTHM'],
    [6, 'RHYTHM'],
    [7, 'PRESSURE'],
    [9, 'PRESSURE'],
    [10, 'MASTER'],
    [12, 'MASTER'],
    [13, 'ENDLESS'],
    [99, 'ENDLESS'],
  ])('보드 %i은 %s 구간이다', (boardNumber, tier) => {
    expect(tierOf(boardNumber)).toBe(tier);
  });

  it('구간 라벨 5종이 한국어로 나온다 (§8.1 우 HUD)', () => {
    expect(TIER_RANGES).toHaveProperty('WARMUP');
    expect([1, 4, 7, 10, 13].map((n) => tierLabel(tierOf(n)))).toEqual([
      '워밍업',
      '리듬',
      '압박',
      '마스터',
      '엔드리스',
    ]);
  });
});

describe('fixtureBoardSource — 순환 공급 (WU-08 인계면)', () => {
  it('보드 번호와 시드가 그대로 실린다', () => {
    const board = fixtureBoardSource().next({ boardNumber: 4, seed: seedFor(4) });
    expect(board.boardNumber).toBe(4);
    expect(board.seed).toBe('wu03-b4');
  });

  it('순환 대상은 계측 전용 보드를 뺀 5종이다', () => {
    expect(ROTATION.map((f) => f.name)).toEqual([
      'B1_WARMUP',
      'B2_WARMUP',
      'B3_RHYTHM',
      'B4_RHYTHM',
      'B5_PRESSURE',
    ]);
    expect(WU03_FIXTURES.length).toBe(7);
  });

  it('픽스처 수를 넘으면 처음으로 순환한다', () => {
    const source = fixtureBoardSource();
    const first = source.next({ boardNumber: 1, seed: seedFor(1) });
    const sixth = source.next({ boardNumber: 6, seed: seedFor(6) });
    expect(sixth.chains().length).toBe(first.chains().length);
    expect(sixth.boardNumber).toBe(6);
  });

  it('매번 새 Board를 만든다 — 앞 보드의 제거가 다음 보드에 새지 않는다 (R9)', () => {
    const source = fixtureBoardSource();
    const first = source.next({ boardNumber: 1, seed: seedFor(1) });
    const target = first.safeMoves()[0];
    first.beginRemoval(target);
    first.completeRemoval(target);
    const again = source.next({ boardNumber: 1, seed: seedFor(1) });
    expect(again.stateOf(target)).toBe('normal');
    expect(again).not.toBe(first);
  });

  it('사다리 행 y는 firstY + rowGap·i다', () => {
    const ladder: LadderSpec | undefined = B5_PRESSURE.ladder;
    expect(ladder).toBeDefined();
    if (ladder === undefined) return;
    expect([0, 1, 2, 3].map((i) => ladderRowY(ladder, i))).toEqual([2, 5, 8, 11]);
  });

  it('패턴 P가 가로 R×k개 + 연결자를 만든다', () => {
    const spec: LadderSpec = {
      rows: 4,
      perRow: 5,
      firstY: 2,
      rowGap: 3,
      connectorRows: [0, 1, 2],
      connectorX: 11,
    };
    expect(buildLadderChains(spec).length).toBe(4 * 5 + 3);
  });

  it('구간 범위표가 5구간을 모두 덮는다 (§6.2)', () => {
    const warmup: TierRange = TIER_RANGES.WARMUP;
    expect(warmup.chains).toEqual([6, 12]);
    expect(Object.keys(TIER_RANGES).length).toBe(5);
  });

  it('연결자가 없는 행에 connectorDepth를 물으면 던진다', () => {
    const ladder = B1_WARMUP.ladder;
    expect(ladder).toBeDefined();
    if (ladder === undefined) return;
    expect(() => connectorDepth(ladder, 0)).toThrow();
  });

  it('ladder도 chains도 없는 사양은 거부된다', () => {
    expect(() => chainsOfSpec({ name: 'X', tier: null, rotates: false })).toThrow();
  });
});
