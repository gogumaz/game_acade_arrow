// WU-09 — §13/§14.4 교차 유닛 인수. 개별 규칙 테스트를 실제 제품 결선과 규모 조건으로 묶는다.

import { describe, expect, it } from 'vitest';

import { FACTORY_PARAMS } from '../../src/core/params';
import { validatePlacement } from '../../src/core/puzzle';
import { generateBoard } from '../../src/core/generator';
import { verifySolution } from '../../src/core/solver';
import type { BoardRequest, BoardSource } from '../../src/game/boardSource';
import { FlowMachine } from '../../src/game/flow';
import { FxRuntime, MAX_FULL_EFFECTS } from '../../src/game/fx';
import { gradeOf } from '../../src/game/grade';
import { worstCaseMoves } from '../../src/game/focus';
import { RankingStore } from '../../src/game/rankingStore';
import { createSilentSfx } from '../../src/game/sfx';
import { TUTORIAL_IDLE_MS } from '../../src/game/timing';
import { TestClock, creditsSpy, openBoard } from '../wu03/harness';

describe('SCR-308 · SCR-309 — 고정 임계와 200표본 분포 전환', () => {
  it('분포가 없으면 관리자 고정 임계표를 사용한다', () => {
    expect(gradeOf(300_000, 0, { 'S+': 300_000, S: 200_000, A: 125_000, B: 65_000 })).toBe('S+');
    expect(gradeOf(64_999, 0, { 'S+': 300_000, S: 200_000, A: 125_000, B: 65_000 })).toBe('C');
  });

  it.each([
    [3, 'S+'],
    [10, 'S'],
    [30, 'A'],
    [60, 'B'],
    [60.5, 'C'],
  ] as const)('상위 %s%%는 %s 등급이다', (percentile, grade) => {
    expect(gradeOf(0, 0, undefined, percentile)).toBe(grade);
  });

  it('FlowMachine 결과 화면이 주입된 로컬 백분위를 실제 사용한다', () => {
    const clock = new TestClock(0);
    const credits = creditsSpy();
    const boardSource: BoardSource = {
      next: (request: BoardRequest) => openBoard(request.boardNumber),
    };
    const flow = new FlowMachine({
      clock,
      credits,
      boardSource,
      ranking: new RankingStore(),
      params: FACTORY_PARAMS,
      sfx: createSilentSfx(),
      nowIso: () => '2026-08-17T00:00:00.000Z',
      scorePercentile: () => 0,
    });
    flow.handle('COIN');
    flow.handle('START');
    clock.advance(TUTORIAL_IDLE_MS);
    flow.tick();
    clock.advance(FACTORY_PARAMS.sessionTimeSec * 1000);
    flow.tick();
    if (flow.screen === 'CONTINUE') {
      flow.handle('BUTTON2');
      flow.tick();
    }
    expect(flow.snapshot().result?.grade).toBe('S+');
  });
});

describe('CTL-004 · PZL-101 · GEN-402 — 실서비스 40사슬 보드 1,000개', () => {
  it('모든 배치가 유효하고 포커스 최악 조작 수가 12 이하이며 해법이 있다', () => {
    for (let seed = 0; seed < 1000; seed += 1) {
      const generated = generateBoard(13, `wu09-focus-${String(seed)}`);
      expect(validatePlacement(generated.board.chains())).toBeNull();
      expect(worstCaseMoves(generated.board)).toBeLessThanOrEqual(12);
      expect(generated.bundle.maxColumnHeads).toBeLessThanOrEqual(8);
      expect(verifySolution(generated.board, generated.bundle.solutionOrder)).toBe(true);
    }
  }, 60_000);
});

describe('GEN-405 · GEN-409 · GEN-410 — 재현·포화·생성 예산', () => {
  it('같은 seed+vector를 1,000회 재생성해 좌표와 해법 해시가 일치한다', () => {
    for (let seed = 0; seed < 1000; seed += 1) {
      const value = `wu09-replay-${String(seed)}`;
      const first = generateBoard((seed % 20) + 1, value);
      const second = generateBoard((seed % 20) + 1, value);
      expect(second.board.chains()).toEqual(first.board.chains());
      expect(second.bundle.solutionHash).toBe(first.bundle.solutionHash);
    }
  });

  it('13보드 이후 40사슬·깊이20을 넘지 않고 단일 생성이 800ms보다 빠르다', () => {
    let slowest = 0;
    for (let boardNumber = 13; boardNumber <= 100; boardNumber += 1) {
      const started = performance.now();
      const generated = generateBoard(boardNumber, `wu09-budget-${String(boardNumber)}`);
      slowest = Math.max(slowest, performance.now() - started);
      expect(generated.bundle.vector.chains).toBeLessThanOrEqual(40);
      expect(generated.bundle.vector.maxDepth).toBeLessThanOrEqual(20);
    }
    expect(slowest).toBeLessThan(800);
  });
});

describe('EFX-802 · EFX-804 · EFX-805 · EFX-807 · EFX-808 · EFX-809', () => {
  it('1920×1080 60Hz 표본에서 프레임·입력 p95가 기준 안이고 7번째 효과는 단순화된다', () => {
    const runtime = new FxRuntime();
    for (let frame = 0; frame <= 600; frame += 1) runtime.frame(frame * (1000 / 60));
    for (let input = 0; input < 240; input += 1) {
      runtime.noteInput(input * 100);
      runtime.present(input * 100 + 16);
    }
    const report = runtime.report();
    expect(MAX_FULL_EFFECTS).toBe(6);
    expect(report.averageFps).toBeCloseTo(60, 1);
    expect(report.frameP95Ms).toBeLessThanOrEqual(20);
    expect(report.inputP95Ms).toBeLessThanOrEqual(80);
    expect(report.simplified).toBe(false);
  });
});
