import { describe, expect, it } from 'vitest';

import { generateBoard } from '../../src/core/generator';
import { buildSolverModel, safeMovesForMask, verifySolution } from '../../src/core/solver';

describe('WU-08 acceptance stress', () => {
  it('GEN-401/402/404/405/409/410 — 100,000 deterministic boards have a valid solution and constraints', () => {
    for (let index = 0; index < 100_000; index += 1) {
      const boardNumber = (index % 20) + 1;
      const generated = generateBoard(boardNumber, `stress-${String(index)}`);
      expect(verifySolution(generated.board, generated.bundle.solutionOrder)).toBe(true);
      expect(generated.bundle.maxColumnHeads).toBeLessThanOrEqual(8);
      expect(generated.bundle.focusMoveBound).toBeLessThanOrEqual(12);
      expect(generated.bundle.vector.chains).toBeLessThanOrEqual(40);
    }
  }, 180_000);

  it('GEN-403 — solver and live Board verdicts agree for 1,000,000 inputs', () => {
    let inputs = 0;
    for (let sample = 0; sample < 1000; sample += 1) {
      const generated = generateBoard(13, `runtime-${String(sample)}`);
      const board = generated.board;
      const model = buildSolverModel(board);
      const index = new Map(model.ids.map((id, at) => [id, at] as const));
      let active = model.allActive;
      for (const move of generated.bundle.solutionOrder) {
        const expected = safeMovesForMask(model, active);
        const actual = board.safeMoves();
        for (let repeat = 0; repeat < 25; repeat += 1) {
          expect(actual).toEqual(expected);
          inputs += 1;
        }
        board.beginRemoval(move);
        board.completeRemoval(move);
        active &= ~(1n << BigInt(index.get(move) ?? -1));
      }
    }
    expect(inputs).toBe(1_000_000);
  }, 180_000);
});
