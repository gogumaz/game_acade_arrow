import { describe, expect, it } from 'vitest';

import { FACTORY_ADMIN_PARAMS, tierOfBoard } from '../../src/core/adminParams';
import {
  AdaptiveDifficulty,
  GENERATION_LIMITS,
  GenerationPipeline,
  generateBoard,
} from '../../src/core/generator';
import { dependencyDepths } from '../../src/core/puzzle';
import {
  releaseBlockReasons,
  singleSafeStreak,
  solveBoard,
  verifySolution,
} from '../../src/core/solver';
import { focusColumns, worstCaseMoves } from '../../src/game/focus';
import { proceduralBoardSource } from '../../src/game/boardSource';
import { realSolverGate } from '../../src/game/admin/solverGate';
import { buildBoard, FIXTURE_DEADLOCK } from '../wu02/fixtures';

describe('WU-08 procedural generator', () => {
  it('fits every factory tier, remains monotonic, and saturates endless at 40', () => {
    let chains = 0;
    let depth = 0;
    for (let boardNumber = 1; boardNumber <= 20; boardNumber += 1) {
      const generated = generateBoard(boardNumber, `tier-${String(boardNumber)}`);
      const vector = generated.bundle.vector;
      const range = FACTORY_ADMIN_PARAMS.tiers[tierOfBoard(boardNumber)];
      expect(vector.chains).toBeGreaterThanOrEqual(range.chains.min);
      expect(vector.chains).toBeLessThanOrEqual(range.chains.max);
      expect(vector.safeMoves).toBeGreaterThanOrEqual(range.safeMoves.min);
      expect(vector.safeMoves).toBeLessThanOrEqual(range.safeMoves.max);
      expect(vector.maxDepth).toBeGreaterThanOrEqual(range.depth.min);
      expect(vector.maxDepth).toBeLessThanOrEqual(range.depth.max);
      expect(vector.chains).toBeGreaterThanOrEqual(chains);
      expect(vector.maxDepth).toBeGreaterThanOrEqual(depth);
      expect(dependencyDepths(generated.board).cyclic.size).toBe(0);
      expect(generated.bundle.maxColumnHeads).toBeLessThanOrEqual(GENERATION_LIMITS.maxColumnHeads);
      expect(Math.max(...focusColumns(generated.board).map((column) => column.ids.length))).toBe(
        generated.bundle.maxColumnHeads
      );
      expect(worstCaseMoves(generated.board)).toBeLessThanOrEqual(GENERATION_LIMITS.maxFocusMoves);
      expect(singleSafeStreak(generated.board, generated.bundle.solutionOrder)).toBeLessThan(5);
      expect(generated.bundle.focusMoveBound).toBeLessThanOrEqual(GENERATION_LIMITS.maxFocusMoves);
      chains = vector.chains;
      depth = vector.maxDepth;
    }
    expect(chains).toBe(40);
    expect(depth).toBe(20);
  });

  it('is deterministic by seed and changes geometry for another seed', () => {
    const a = generateBoard(13, 'same');
    const b = generateBoard(13, 'same');
    const c = generateBoard(13, 'other');
    expect(a.board.chains()).toEqual(b.board.chains());
    expect(a.bundle).toEqual(b.bundle);
    expect(c.board.chains()).not.toEqual(a.board.chains());
    expect(verifySolution(a.board, a.bundle.solutionOrder)).toBe(true);
  });

  it('exhaustively solves the generated dependency graph without deadlocks', () => {
    const generated = generateBoard(13, 'solver');
    const result = solveBoard(generated.board);
    expect(result.hasSolution).toBe(true);
    expect(result.deadlockStates).toBe(0);
    expect(result.truncated).toBe(false);
    expect(verifySolution(generated.board, result.solutionOrder)).toBe(true);
  });

  it('rejects a reachable cyclic deadlock', () => {
    const result = solveBoard(buildBoard(FIXTURE_DEADLOCK));
    expect(result.hasSolution).toBe(false);
    expect(result.deadlockStates).toBe(1);
  });

  it('applies adaptive decisions by one step and never changes score multiplier', () => {
    const adaptive = new AdaptiveDifficulty();
    expect(
      adaptive.record({ boardNumber: 1, elapsedMs: 4000, targetMs: 8000, mistakes: 0 }).delta
    ).toBe(0);
    expect(
      adaptive.record({ boardNumber: 2, elapsedMs: 5000, targetMs: 8000, mistakes: 0 })
    ).toMatchObject({
      before: 0,
      after: 1,
      delta: 1,
      scoreMultiplier: 1,
    });
    expect(
      adaptive.record({ boardNumber: 3, elapsedMs: 13000, targetMs: 8000, mistakes: 0 })
    ).toMatchObject({
      before: 1,
      after: 0,
      delta: -1,
      scoreMultiplier: 1,
    });
  });

  it('runs the bounded reseed, relaxation, and warmup recovery order', () => {
    const calls: number[] = [];
    const pipeline = new GenerationPipeline({
      attempt: (input) => {
        calls.push(input.relaxation);
        return null;
      },
    });
    const result = pipeline.generate(10, 'failure');
    expect(result.mode).toBe('warmup');
    expect(result.board.boardNumber).toBe(10);
    expect(calls.filter((value) => value === 0)).toHaveLength(32);
    expect(calls.filter((value) => value === 1)).toHaveLength(8);
    expect(calls.filter((value) => value === 2)).toHaveLength(8);
  });

  it('reuses the previous verified tier before the warmup fallback', () => {
    const pipeline = new GenerationPipeline({ attempt: () => null });
    pipeline.remember(generateBoard(7, 'verified-pressure'));
    const result = pipeline.generate(10, 'failed-master');
    expect(result.mode).toBe('fallback');
    expect(result.board.boardNumber).toBe(10);
    expect(result.bundle.vector.tier).toBe('PRESSURE');
  });

  it('jumps to fallback without another attempt when the 800ms budget expires', () => {
    let time = 0;
    let attempts = 0;
    const pipeline = new GenerationPipeline({
      now: () => {
        const current = time;
        time += 801;
        return current;
      },
      attempt: () => {
        attempts += 1;
        return generateBoard(10, 'too-late');
      },
    });
    const result = pipeline.generate(10, 'budget');
    expect(result.mode).toBe('warmup');
    expect(attempts).toBe(0);
  });

  it('procedural BoardSource prepares bundles and feeds adaptive results forward', () => {
    const source = proceduralBoardSource();
    source.prepare?.({ boardNumber: 1, seed: 'run-1' });
    const first = source.next({ boardNumber: 1, seed: 'run-1' });
    expect(first.seed).toContain('run-1#0:0');
    expect(source.bundle?.(1)?.vector.adaptiveLevel).toBe(0);
    source.report?.({ boardNumber: 1, elapsedMs: 1000, mistakes: 0 });

    source.next({ boardNumber: 2, seed: 'run-2' });
    source.report?.({ boardNumber: 2, elapsedMs: 1000, mistakes: 0 });
    source.next({ boardNumber: 3, seed: 'run-3' });
    expect(source.bundle?.(3)?.vector.adaptiveLevel).toBe(1);
    expect(source.bundle?.(3)?.vector.scoreMultiplier).toBe(1);
  });

  it('adaptive down keeps chain count while lowering only one candidate level', () => {
    const source = proceduralBoardSource();
    source.next({ boardNumber: 1, seed: 'down-1' });
    source.report?.({ boardNumber: 1, elapsedMs: 1000, mistakes: 1 });
    source.next({ boardNumber: 2, seed: 'down-2' });
    source.report?.({ boardNumber: 2, elapsedMs: 1000, mistakes: 1 });
    source.next({ boardNumber: 3, seed: 'down-3' });
    const bundle = source.bundle?.(3);
    expect(bundle?.vector.adaptiveLevel).toBe(-1);
    expect(bundle?.vector.chains).toBe(generateBoard(3, 'baseline').bundle.vector.chains);
    expect(bundle?.vector.scoreMultiplier).toBe(1);
  });

  it('real admin gate checks 5 tiers × 3 seeds with no pending marker', () => {
    const gate = realSolverGate();
    const result = gate.validate(FACTORY_ADMIN_PARAMS);
    expect(result).toMatchObject({ ok: true, failures: [], boardsChecked: 15 });
    expect(result.elapsedMs).toBeLessThan(3000);
    expect(result).not.toHaveProperty('pending');
  });

  it('enumerates all seven release block conditions', () => {
    expect(
      releaseBlockReasons({
        hasSolution: false,
        runtimeMismatchCount: 1,
        deadlockStates: 1,
        minimumContrastRatio: 4.49,
        frameP99Ms: 20.1,
        botP95Ms: 18001,
        targetMs: 10000,
        focusMoveBound: 13,
      })
    ).toHaveLength(7);
  });
});
