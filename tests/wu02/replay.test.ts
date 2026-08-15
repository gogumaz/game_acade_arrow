// WU-02 T7 — 재현성과 공장 기본값 고정 (§6.6 · §11.4 · SCR-312 · 완료 기준 4)
//
// 같은 시드·같은 입력 순서·같은 입력 시각이면 최종 점수까지 완전히 재현된다. 코어가 실시간이나
// 난수를 한 번이라도 읽으면 이 파일의 재현성 테스트가 깨진다.

import { describe, expect, it } from 'vitest';
import { GRID_HEIGHT, GRID_WIDTH } from '../../src/core/grid';
import {
  FACTORY_PARAMS,
  PARAM_RANGES,
  resolveParams,
  validateCoreParams,
  type CoreParams,
  type NumericParamKey,
  type ParamRange,
  type ParamViolation,
} from '../../src/core/params';
import { RunSession, type RunState } from '../../src/core/session';
import type { BoardSettlement } from '../../src/core/score';
import type { ChainId, ProcessStep } from '../../src/core/types';
import {
  FIXTURE_0110,
  FIXTURE_DEPTH_CHAIN,
  FIXTURE_PERFECT,
  TestClock,
  buildBoard,
  chainsOf,
  lcg,
  type Fixture,
} from './fixtures';

// ── 공장 기본값 리터럴 고정 (§8 표 · §11.4) ────────────────────────────────

describe('§11.4 공장 기본값 25항목 리터럴 고정', () => {
  it('FACTORY_PARAMS가 기획서 N 값과 문자 단위로 같다', () => {
    expect(FACTORY_PARAMS).toEqual({
      sessionTimeSec: 120,
      initialHearts: 3,
      continueEnabled: true,
      continueHeartRecover: 3,
      continueTimeRefillSec: 120,
      continuePromptTimeSec: 10,
      timeGainBaseSec: 0.25,
      timeGainPerDepthSec: 0.08,
      timeGainCapSec: 0.9,
      failTimePenaltySec: -3,
      scoreBase: 100,
      scoreLengthCoef: 20,
      scoreBendCoef: 40,
      scoreDepthCoef: 60,
      comboWindowSec: 2.2,
      comboStep: 0.15,
      comboCap: 2.5,
      clearTimeCoef: 100,
      clearHeartCoef: 1500,
      perfectBonus: 5000,
      hintScorePenaltyPercent: -20,
      hintPenaltyCapPercent: -60,
      slideOutBaseSec: 0.18,
      slideOutPerSegmentSec: 0.022,
      slideOutCapSec: 0.75,
    });
  });

  it('필드 수는 25개다 (코어가 소비하는 §11.4 항목 전량)', () => {
    expect(Object.keys(FACTORY_PARAMS)).toHaveLength(25);
  });

  it('격자 규격이 13 × 19로 고정돼 있다', () => {
    expect(GRID_WIDTH).toBe(13);
    expect(GRID_HEIGHT).toBe(19);
  });

  it('PARAM_RANGES의 label이 §11.4 항목명과 일치한다', () => {
    expect(PARAM_RANGES.sessionTimeSec.label).toBe('SESSION TIME');
    expect(PARAM_RANGES.initialHearts.label).toBe('INITIAL HEARTS');
    expect(PARAM_RANGES.continueHeartRecover.label).toBe('CONTINUE HEART RECOVER');
    expect(PARAM_RANGES.continueTimeRefillSec.label).toBe('CONTINUE TIME REFILL');
    expect(PARAM_RANGES.continuePromptTimeSec.label).toBe('CONTINUE PROMPT TIME');
    expect(PARAM_RANGES.timeGainBaseSec.label).toBe('TIME GAIN BASE');
    expect(PARAM_RANGES.timeGainPerDepthSec.label).toBe('TIME GAIN PER DEPTH');
    expect(PARAM_RANGES.timeGainCapSec.label).toBe('TIME GAIN CAP');
    expect(PARAM_RANGES.failTimePenaltySec.label).toBe('FAIL TIME PENALTY');
    expect(PARAM_RANGES.hintScorePenaltyPercent.label).toBe('HINT SCORE PENALTY');
    expect(PARAM_RANGES.hintPenaltyCapPercent.label).toBe('HINT PENALTY CAP');
    expect(PARAM_RANGES.slideOutBaseSec.label).toBe('SLIDE OUT BASE');
    expect(PARAM_RANGES.slideOutPerSegmentSec.label).toBe('SLIDE OUT PER SEGMENT');
    expect(PARAM_RANGES.slideOutCapSec.label).toBe('SLIDE OUT CAP');
  });

  it('수치 파라미터 24종이 전부 범위 표에 등재돼 있다 (continueEnabled 제외)', () => {
    const numericKeys = Object.keys(FACTORY_PARAMS).filter(
      (key) => key !== 'continueEnabled'
    ) as NumericParamKey[];
    expect(numericKeys).toHaveLength(24);
    const groups = new Set<string>();
    for (const key of numericKeys) {
      const range: ParamRange = PARAM_RANGES[key];
      expect(range.label.length).toBeGreaterThan(0);
      expect(range.min).toBeLessThanOrEqual(range.max);
      expect(range.unit.length).toBeGreaterThan(0);
      expect(range.group.length).toBeGreaterThan(0);
      groups.add(range.group);
    }
    expect([...groups].sort()).toEqual(['세션', '시간', '연출', '점수', '힌트'].sort());
  });

  it('공장 기본값이 전부 §11.4 조정 범위 안에 있다', () => {
    expect(validateCoreParams(FACTORY_PARAMS)).toEqual([]);
  });

  it('범위를 벗어난 값은 위반 목록에 오른다', () => {
    const violations: readonly ParamViolation[] = validateCoreParams({
      ...FACTORY_PARAMS,
      sessionTimeSec: 200,
      initialHearts: 0,
      slideOutCapSec: 2,
    });
    // `initialHearts: 0`은 `continueHeartRecover`(1 ~ 초기 하트)의 의존 상한도 함께 깨뜨린다.
    // 목록 순서는 PARAM_RANGES 선언 순서를 따르는 결정적 순서다.
    expect(violations.map((v) => v.key)).toEqual([
      'sessionTimeSec',
      'initialHearts',
      'continueHeartRecover',
      'slideOutCapSec',
    ]);
    expect(violations[0].value).toBe(200);
    expect(violations[0].range.max).toBe(150);
  });

  it('의존 상한(1 ~ 초기 하트 · 45초 ~ 세션 시간)도 검사한다', () => {
    const params: CoreParams = {
      ...FACTORY_PARAMS,
      initialHearts: 2,
      continueHeartRecover: 3,
      sessionTimeSec: 90,
      continueTimeRefillSec: 120,
    };
    const violations = validateCoreParams(params);
    expect(violations.map((v) => v.key)).toEqual(['continueHeartRecover', 'continueTimeRefillSec']);
    expect(violations[0].range.max).toBe(2);
    expect(violations[1].range.max).toBe(90);
  });

  it('resolveParams 결과의 수치가 전부 정수다 (P-4 정수 산술 규약)', () => {
    const resolved = resolveParams();
    for (const [key, value] of Object.entries(resolved)) {
      if (typeof value === 'number') {
        expect(`${key}=${String(Number.isInteger(value))}`).toBe(`${key}=true`);
      }
    }
    expect(resolved.slideOutPerSegmentMs).toBe(22); // 0.022 × 1000 의 부동소수 잔차 제거
    expect(resolved.comboStepCentis).toBe(15);
    expect(resolved.comboCapCentis).toBe(250);
    expect(resolved.failTimePenaltyMs).toBe(-3000);
    expect(resolved.timeGainCapMs).toBe(900);
  });

  it('overrides가 공장 기본값 위에 얹힌다 (WU-05 params.csv 경로)', () => {
    const resolved = resolveParams({ sessionTimeSec: 90, comboCap: 3 });
    expect(resolved.sessionTimeMs).toBe(90000);
    expect(resolved.comboCapCentis).toBe(300);
    expect(resolved.scoreBase).toBe(100); // 건드리지 않은 값은 공장 기본값 그대로
  });
});

// ── SCR-312 재현성 ────────────────────────────────────────────────────────

interface ScriptStep {
  readonly waitMs: number;
  readonly chainId: ChainId;
}

interface ReplayResult {
  readonly state: RunState;
  readonly traces: readonly (readonly ProcessStep[])[];
  readonly settlements: readonly BoardSettlement[];
  readonly rejections: readonly string[];
}

/** 고정 시드에서 입력열을 만든다 — 코어가 아니라 **테스트**가 난수를 쓴다 */
function makeScript(fixture: Fixture, seed: number, steps: number): ScriptStep[] {
  const random = lcg(seed);
  const ids = chainsOf(fixture).map((c) => c.id);
  const script: ScriptStep[] = [];
  for (let i = 0; i < steps; i += 1) {
    script.push({
      waitMs: Math.floor(random() * 600),
      chainId: ids[Math.floor(random() * ids.length)],
    });
  }
  return script;
}

/** 같은 각본을 그대로 흘린다. 시계 각본까지 스크립트가 결정하므로 실행마다 동일해야 한다 */
function replay(
  fixture: Fixture,
  script: readonly ScriptStep[],
  overrides?: Partial<CoreParams>
): ReplayResult {
  const clock = new TestClock(0);
  const session = new RunSession({ ...FACTORY_PARAMS, ...overrides }, clock);
  const traces: ProcessStep[][] = [];
  const settlements: BoardSettlement[] = [];
  const rejections: string[] = [];

  const started = session.start(buildBoard(fixture));
  traces.push([...started.trace]);

  for (const step of script) {
    clock.advance(step.waitMs);
    const tick = session.tick();
    traces.push([...tick.trace]);
    if (tick.settlement !== undefined) settlements.push(tick.settlement);

    const pull = session.pull(step.chainId);
    traces.push([...pull.trace]);
    if (pull.rejection !== undefined) rejections.push(`${step.chainId}:${pull.rejection}`);
  }

  // 남은 제거를 마무리한다
  for (let i = 0; i < 4; i += 1) {
    clock.advance(1000);
    const tick = session.tick();
    traces.push([...tick.trace]);
    if (tick.settlement !== undefined) settlements.push(tick.settlement);
  }

  return { state: session.state, traces, settlements, rejections };
}

describe('SCR-312 §6.6 재현성 (완료 기준 4)', () => {
  const scenarios = [
    { name: 'FIXTURE_DEPTH_CHAIN · seed 20260815', fixture: FIXTURE_DEPTH_CHAIN, seed: 20260815 },
    { name: 'FIXTURE_0110 · seed 777', fixture: FIXTURE_0110, seed: 777 },
    { name: 'FIXTURE_PERFECT · seed 31337', fixture: FIXTURE_PERFECT, seed: 31337 },
  ] as const;

  for (const scenario of scenarios) {
    it(`500 입력 시나리오 — ${scenario.name} 에서 두 실행의 RunState 전 필드가 같다`, () => {
      const script = makeScript(scenario.fixture, scenario.seed, 500);
      expect(script).toHaveLength(500);
      const first = replay(scenario.fixture, script);
      const second = replay(scenario.fixture, script);
      expect(second.state).toEqual(first.state);
    });

    it(`500 입력 시나리오 — ${scenario.name} 에서 trace 열과 정산이 같다`, () => {
      const script = makeScript(scenario.fixture, scenario.seed, 500);
      const first = replay(scenario.fixture, script);
      const second = replay(scenario.fixture, script);
      expect(second.traces).toEqual(first.traces);
      expect(second.settlements).toEqual(first.settlements);
      expect(second.rejections).toEqual(first.rejections);
    });
  }

  it('시나리오가 실제로 게임을 굴린다 (빈 실행이 아님을 증명)', () => {
    const script = makeScript(FIXTURE_DEPTH_CHAIN, 20260815, 500);
    const result = replay(FIXTURE_DEPTH_CHAIN, script);
    expect(result.state.phase).toBe('ended');
    expect(result.state.displayScore).toBeGreaterThan(0);
    expect(result.traces.flat().length).toBeGreaterThan(20);
    expect(result.rejections.length).toBeGreaterThan(0);
  });

  it('입력 순서가 달라지면 결과도 달라진다 (테스트가 공허하지 않다)', () => {
    const a = replay(FIXTURE_DEPTH_CHAIN, makeScript(FIXTURE_DEPTH_CHAIN, 20260815, 500));
    const b = replay(FIXTURE_DEPTH_CHAIN, makeScript(FIXTURE_DEPTH_CHAIN, 424242, 500));
    expect(b.state).not.toEqual(a.state);
  });

  it('시계 각본이 같으면 최종 점수까지 완전히 같다 (§3.7 마지막 문단)', () => {
    const script: ScriptStep[] = [
      { waitMs: 0, chainId: 10 },
      { waitMs: 300, chainId: 11 },
      { waitMs: 300, chainId: 12 },
      { waitMs: 300, chainId: 13 },
    ];
    const first = replay(FIXTURE_DEPTH_CHAIN, script);
    const second = replay(FIXTURE_DEPTH_CHAIN, script);
    expect(first.state.clearedBoards).toBe(1);
    expect(first.settlements).toHaveLength(1);
    expect(second.state.displayScore).toBe(first.state.displayScore);
    expect(second.settlements[0]).toEqual(first.settlements[0]);
  });

  it('파라미터가 달라지면 점수가 달라진다 (주입이 실제로 먹는다)', () => {
    const script: ScriptStep[] = [
      { waitMs: 0, chainId: 10 },
      { waitMs: 300, chainId: 11 },
      { waitMs: 300, chainId: 12 },
      { waitMs: 300, chainId: 13 },
    ];
    const base = replay(FIXTURE_DEPTH_CHAIN, script);
    const tuned = replay(FIXTURE_DEPTH_CHAIN, script, { scoreDepthCoef: 0, perfectBonus: 0 });
    expect(tuned.state.displayScore).toBeLessThan(base.state.displayScore);
  });

  it('같은 각본을 10회 반복해도 최종 점수가 흔들리지 않는다 (부동소수 드리프트 0)', () => {
    const script = makeScript(FIXTURE_DEPTH_CHAIN, 987654, 120);
    const scores = new Set<number>();
    for (let i = 0; i < 10; i += 1) {
      scores.add(replay(FIXTURE_DEPTH_CHAIN, script).state.displayScore);
    }
    expect(scores.size).toBe(1);
  });
});
