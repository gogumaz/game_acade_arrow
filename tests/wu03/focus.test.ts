// §2.2 순환 선택 — CTL-002 결정성 · CTL-003 순환·타이브레이크 · CTL-004 최악 조작 수 ·
// CTL-005 초기·제거 후 포커스 (작업 계획 §4)

import { describe, it, expect } from 'vitest';
import { DIRECTIONS } from '../../src/core/grid';
import { Board } from '../../src/core/puzzle';
import type { ChainId, Direction } from '../../src/core/types';
import type { FocusColumn } from '../../src/game/focus';
import {
  focusAfterRemoval,
  focusColumns,
  focusDistance,
  focusableChains,
  initialFocus,
  moveFocus,
  structuralMoveBound,
  worstCaseMoves,
} from '../../src/game/focus';
import {
  FB_BOTTOM,
  FB_RIGHT,
  FB_TOP,
  FC2_LEFT,
  FC2_RIGHT,
  FC_ONLY,
  FD_A,
  FD_B,
  FD_C,
  FD_D,
  focusBoardA,
  focusBoardB,
  focusBoardC,
  focusBoardC2,
  focusBoardD,
} from './harness';

/** F-A 대표점 색인 — 열 x=1 / 3 / 5, 행 y=2 / 5 / 8 */
const A = {
  x1y2: 10,
  x3y2: 11,
  x5y2: 12,
  x1y5: 20,
  x3y5: 21,
  x5y5: 22,
  x1y8: 30,
  x3y8: 31,
  x5y8: 32,
} as const;

describe('focusableChains — 포커스 대상 집합 (작업 계획 P-2)', () => {
  it('전 사슬이 normal이면 id 오름차순 전량이다', () => {
    expect(focusableChains(focusBoardA())).toEqual([10, 11, 12, 20, 21, 22, 30, 31, 32]);
  });

  it('blocked는 포커스 대상에 남는다 — 빨간 표시는 재선택 가능해야 한다 (§3.5 · PZL-108)', () => {
    const board = focusBoardA();
    board.markBlocked(A.x1y2);
    expect(focusableChains(board)).toContain(A.x1y2);
  });

  it('removing은 제외된다 — 코어 pull()이 CHAIN_GONE으로 거부하는 상태다', () => {
    const board = focusBoardA();
    board.beginRemoval(A.x1y2);
    expect(focusableChains(board)).not.toContain(A.x1y2);
  });

  it('removed도 제외된다', () => {
    const board = focusBoardA();
    board.beginRemoval(A.x1y2);
    board.completeRemoval(A.x1y2);
    expect(focusableChains(board)).not.toContain(A.x1y2);
  });

  it('사슬이 없는 보드는 빈 목록이다', () => {
    const board = focusBoardA();
    for (const id of focusableChains(board)) {
      board.beginRemoval(id);
      board.completeRemoval(id);
    }
    expect(focusableChains(board)).toEqual([]);
  });
});

describe('focusColumns — 열 구조 (§2.2)', () => {
  it('대표점 x 오름차순으로 열이 만들어진다', () => {
    const columns: readonly FocusColumn[] = focusColumns(focusBoardA());
    expect(columns.map((c) => c.x)).toEqual([1, 3, 5]);
  });

  it('열 안은 y 오름차순이다', () => {
    const column = focusColumns(focusBoardA())[0];
    expect(column.ids).toEqual([A.x1y2, A.x1y5, A.x1y8]);
  });

  it('사슬이 하나도 없는 x는 열로 세지 않는다', () => {
    expect(focusColumns(focusBoardB()).map((c) => c.x)).toEqual([2, 6]);
  });

  it('제거된 사슬은 열에서 빠지고, 열이 비면 열 자체가 사라진다', () => {
    const board = focusBoardB();
    board.beginRemoval(FB_RIGHT);
    expect(focusColumns(board).map((c) => c.x)).toEqual([2]);
  });
});

describe('initialFocus — 가장 왼쪽 열의 가장 아래 (§2.2 · CTL-005)', () => {
  it('F-A의 초기 포커스는 대표점 (1,8)이다', () => {
    expect(initialFocus(focusBoardA())).toBe(A.x1y8);
  });

  it('사슬이 1개면 그 사슬이다', () => {
    expect(initialFocus(focusBoardC())).toBe(FC_ONLY);
  });

  it('빈 보드는 null이다', () => {
    expect(initialFocus(new Board({ chains: [] }))).toBeNull();
  });

  it('왼쪽 열이 통째로 사라지면 다음 열의 가장 아래를 잡는다', () => {
    const board = focusBoardA();
    for (const id of [A.x1y2, A.x1y5, A.x1y8]) {
      board.beginRemoval(id);
      board.completeRemoval(id);
    }
    expect(initialFocus(board)).toBe(A.x3y8);
  });
});

describe('moveFocus UP/DOWN — 같은 열 안 순환 (§2.2 · CTL-003)', () => {
  it('UP은 y가 작은 쪽으로 간다', () => {
    expect(moveFocus(focusBoardA(), A.x1y8, 'UP')).toBe(A.x1y5);
  });

  it('DOWN은 y가 큰 쪽으로 간다', () => {
    expect(moveFocus(focusBoardA(), A.x1y2, 'DOWN')).toBe(A.x1y5);
  });

  it('열 맨 위에서 UP은 맨 아래로 순환한다', () => {
    expect(moveFocus(focusBoardA(), A.x1y2, 'UP')).toBe(A.x1y8);
  });

  it('열 맨 아래에서 DOWN은 맨 위로 순환한다', () => {
    expect(moveFocus(focusBoardA(), A.x1y8, 'DOWN')).toBe(A.x1y2);
  });

  it('열에 사슬이 1개뿐이면 UP·DOWN은 이동하지 않는다 (거부음 신호 = null)', () => {
    const board = focusBoardC2();
    expect(moveFocus(board, FC2_LEFT, 'UP')).toBeNull();
    expect(moveFocus(board, FC2_LEFT, 'DOWN')).toBeNull();
  });
});

describe('moveFocus LEFT/RIGHT — 열 이동 순환 (§2.2 · CTL-003)', () => {
  it('LEFT는 왼쪽 열의 같은 y를 잡는다', () => {
    expect(moveFocus(focusBoardA(), A.x3y5, 'LEFT')).toBe(A.x1y5);
  });

  it('RIGHT는 오른쪽 열의 같은 y를 잡는다', () => {
    expect(moveFocus(focusBoardA(), A.x3y5, 'RIGHT')).toBe(A.x5y5);
  });

  it('가장 왼쪽 열에서 LEFT는 가장 오른쪽 열로 순환한다', () => {
    expect(moveFocus(focusBoardA(), A.x1y5, 'LEFT')).toBe(A.x5y5);
  });

  it('가장 오른쪽 열에서 RIGHT는 가장 왼쪽 열로 순환한다', () => {
    expect(moveFocus(focusBoardA(), A.x5y5, 'RIGHT')).toBe(A.x1y5);
  });

  it('새 열에 같은 y가 없으면 y 최근접을 잡는다', () => {
    const board = focusBoardD();
    // (3,9)에서 RIGHT → 열 x=7에는 (7,4)뿐이다
    expect(moveFocus(board, FD_B, 'RIGHT')).toBe(FD_C);
  });

  it('거리 동률이면 위쪽(y가 작은 쪽)을 잡는다 — F-B (CTL-003 핵심)', () => {
    // (6,7)에서 LEFT → 열 x=2의 (2,4)·(2,10)이 거리 3으로 동률
    expect(moveFocus(focusBoardB(), FB_RIGHT, 'LEFT')).toBe(FB_TOP);
    expect(moveFocus(focusBoardB(), FB_RIGHT, 'LEFT')).not.toBe(FB_BOTTOM);
  });

  it('열이 1개뿐이면 LEFT·RIGHT도 이동하지 않는다 (작업 계획 P-10)', () => {
    const board = focusBoardC();
    expect(moveFocus(board, FC_ONLY, 'LEFT')).toBeNull();
    expect(moveFocus(board, FC_ONLY, 'RIGHT')).toBeNull();
  });

  it('열이 2개면 LEFT와 RIGHT가 같은 상대 열로 간다 (양방향 순환)', () => {
    const board = focusBoardC2();
    expect(moveFocus(board, FC2_RIGHT, 'LEFT')).toBe(FC2_LEFT);
    expect(moveFocus(board, FC2_RIGHT, 'RIGHT')).toBe(FC2_LEFT);
  });

  it('포커스 대상이 아닌 사슬에서 출발하면 null이다', () => {
    const board = focusBoardA();
    board.beginRemoval(A.x1y2);
    expect(moveFocus(board, A.x1y2, 'RIGHT')).toBeNull();
  });
});

describe('안전수를 타이브레이크에 쓰지 않는다 (§2.2)', () => {
  it('블로커를 제거해 안전수 집합이 바뀌어도 이동 결과가 같다', () => {
    const before = moveFocus(focusBoardD(), FD_A, 'RIGHT');
    const board = focusBoardD();
    // FD_D를 없애면 FD_C가 안전수가 되지만 순환 선택 결과는 그대로여야 한다
    board.beginRemoval(FD_D);
    board.completeRemoval(FD_D);
    board.recomputeAll();
    expect(moveFocus(board, FD_A, 'RIGHT')).toBe(before);
  });
});

describe('CTL-002 — 순환 선택 결정성', () => {
  it('같은 보드·같은 포커스·같은 입력을 100회 반복해도 결과가 같다', () => {
    const board = focusBoardA();
    const ids = focusableChains(board);
    const baseline = new Map<string, ChainId | null>();
    for (const id of ids) {
      for (const dir of DIRECTIONS) baseline.set(`${id}:${dir}`, moveFocus(board, id, dir));
    }
    for (let round = 0; round < 100; round += 1) {
      for (const id of ids) {
        for (const dir of DIRECTIONS) {
          expect(moveFocus(board, id, dir)).toBe(baseline.get(`${id}:${dir}`));
        }
      }
    }
  });

  it('같은 좌표표로 다시 만든 보드도 같은 결과를 낸다', () => {
    for (const dir of DIRECTIONS) {
      expect(moveFocus(focusBoardB(), FB_RIGHT, dir)).toBe(moveFocus(focusBoardB(), FB_RIGHT, dir));
    }
  });
});

describe('focusAfterRemoval — 제거 직후 포커스 (§2.2 · CTL-005 · 작업 계획 Q-2)', () => {
  function removedBoard(id: ChainId): Board {
    const board = focusBoardD();
    board.beginRemoval(id); // ③A 시점에 포커스 대상에서 빠진다
    return board;
  }

  it('마지막 레버 방향(DOWN)에 사슬이 있으면 그 사슬을 잡는다', () => {
    expect(focusAfterRemoval(removedBoard(FD_A), FD_A, 'DOWN')).toBe(FD_B);
  });

  it('그 방향에 사슬이 없으면 RIGHT로 대체한다', () => {
    // (3,4)에서 UP → 같은 열 위쪽 없음 → RIGHT → (7,4)
    expect(focusAfterRemoval(removedBoard(FD_A), FD_A, 'UP')).toBe(FD_C);
  });

  it('RIGHT도 실패하면 DOWN을 시도하고, 그래도 없으면 최근접으로 간다', () => {
    // (11,4)에서 RIGHT → 오른쪽 열 없음 → DOWN → 같은 열 아래 없음 → 최근접 (7,4)
    expect(focusAfterRemoval(removedBoard(FD_D), FD_D, 'RIGHT')).toBe(FD_C);
  });

  it('마지막 레버 방향이 없으면 RIGHT → DOWN 순으로 대체한다', () => {
    expect(focusAfterRemoval(removedBoard(FD_B), FD_B, null)).toBe(FD_C);
  });

  it('LEFT 방향도 비순환이다 — 왼쪽에 열이 없으면 대체로 넘어간다', () => {
    // (3,4)에서 LEFT → x<3 열 없음 → RIGHT → (7,4). 순환이었다면 (11,4)를 잡았을 것이다
    expect(focusAfterRemoval(removedBoard(FD_A), FD_A, 'LEFT')).toBe(FD_C);
  });

  it('사슬이 1개 남으면 그 사슬을 잡는다', () => {
    const board = focusBoardD();
    for (const id of [FD_A, FD_B, FD_C]) board.beginRemoval(id);
    expect(focusAfterRemoval(board, FD_C, 'UP')).toBe(FD_D);
  });

  it('남은 사슬이 없으면 null이다', () => {
    const board = focusBoardD();
    for (const id of [FD_A, FD_B, FD_C, FD_D]) board.beginRemoval(id);
    expect(focusAfterRemoval(board, FD_A, 'DOWN')).toBeNull();
  });

  it('완전히 제거된(removed) 사슬을 기준으로도 대표점을 읽을 수 있다', () => {
    const board = focusBoardD();
    board.beginRemoval(FD_A);
    board.completeRemoval(FD_A);
    expect(focusAfterRemoval(board, FD_A, 'DOWN')).toBe(FD_B);
  });

  it('없는 사슬 id로 부르면 던진다', () => {
    expect(() => focusAfterRemoval(focusBoardD(), 999, null)).toThrow();
  });
});

describe('focusDistance · worstCaseMoves — 조작 수 (§6.1 축 6 · CTL-004)', () => {
  it('자기 자신까지의 거리는 0이다', () => {
    expect(focusDistance(focusBoardA(), A.x1y2, A.x1y2)).toBe(0);
  });

  it('한 번에 갈 수 있으면 1이다', () => {
    expect(focusDistance(focusBoardA(), A.x1y2, A.x1y5)).toBe(1);
  });

  it('순환을 이용한 최단 경로를 찾는다', () => {
    // (1,2) → (5,5)는 LEFT(순환) 다음 DOWN으로 2회다
    expect(focusDistance(focusBoardA(), A.x1y2, A.x5y5)).toBe(2);
  });

  it('포커스 대상이 아닌 사슬까지는 Infinity다', () => {
    const board = focusBoardA();
    board.beginRemoval(A.x5y5);
    expect(focusDistance(board, A.x1y2, A.x5y5)).toBe(Number.POSITIVE_INFINITY);
  });

  it('F-A의 최악 조작 수는 2다', () => {
    expect(worstCaseMoves(focusBoardA())).toBe(2);
  });

  it('F-A의 구조 상한 ⌊3/2⌋+⌊3/2⌋ = 2와 실측이 같다', () => {
    expect(structuralMoveBound(focusBoardA())).toBe(2);
    expect(worstCaseMoves(focusBoardA())).toBeLessThanOrEqual(structuralMoveBound(focusBoardA()));
  });

  it('사슬이 1개면 최악 조작 수는 0이다', () => {
    expect(worstCaseMoves(focusBoardC())).toBe(0);
    expect(structuralMoveBound(focusBoardC())).toBe(0);
  });

  it('빈 보드의 구조 상한은 0이다', () => {
    expect(structuralMoveBound(new Board({ chains: [] }))).toBe(0);
  });

  it('F-A의 어떤 순서쌍도 12회를 넘지 않는다 (CTL-004)', () => {
    const board = focusBoardA();
    const ids = focusableChains(board);
    for (const from of ids) {
      for (const to of ids) expect(focusDistance(board, from, to)).toBeLessThanOrEqual(12);
    }
  });
});

describe('레버 이동은 항상 순환이다 — 제거 후 규칙(비순환)과 섞이지 않는다 (Q-2)', () => {
  it('평시 RIGHT는 오른쪽 끝에서도 실패하지 않는다', () => {
    const dirs: readonly Direction[] = ['RIGHT', 'RIGHT', 'RIGHT'];
    let cur: ChainId | null = A.x1y5;
    const board = focusBoardA();
    for (const dir of dirs) {
      cur = cur === null ? null : moveFocus(board, cur, dir);
      expect(cur).not.toBeNull();
    }
    expect(cur).toBe(A.x1y5); // 3열을 한 바퀴 돌아 제자리
  });

  it('제거 후 RIGHT는 오른쪽 끝에서 실패해 DOWN 대체로 넘어간다', () => {
    const board = focusBoardD();
    board.beginRemoval(FD_D);
    expect(focusAfterRemoval(board, FD_D, 'RIGHT')).not.toBe(FD_A);
  });
});
