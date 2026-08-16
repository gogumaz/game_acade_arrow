// 저장 검증 파이프라인 (§11.5 — 계획 T2 · ADM-401 · ADM-403)
//
// 오류 4종(RANGE · TIER_MONOTONIC · SOLVER · GRADE_ORDER)과 경고 3종을 전수로 판정하고,
// 세션 예산 검산식이 **기획서 §4.3 검산표와 ±1.0초 이내**로 일치함을 고정한다.

import { describe, expect, it } from 'vitest';
import {
  FACTORY_ADMIN_PARAMS,
  PARAM_TIERS,
  SESSION_BUDGET_UNBOUNDED,
  SOLVER_GATE_SPEC,
  applyPreset,
  sessionBudgetBoards,
  sessionBudgetCumulative,
  tierBudget,
  tierOfBoard,
  validateAdminParams,
  writeField,
  type AdminParams,
  type IssueCode,
} from '../../src/core/adminParams';
import { stubSolverGate } from '../../src/game/admin/solverGate';
import { failingSolverGate, okSolverGate, slowSolverGate } from './harness';

const gate = okSolverGate();

function check(p: AdminParams, g = gate): ReturnType<typeof validateAdminParams> {
  return validateAdminParams(p, g);
}

function codes(p: AdminParams, g = gate): IssueCode[] {
  const r = check(p, g);
  return [...r.errors, ...r.warnings].map((i) => i.code);
}

describe('2-1 공장값은 통과한다', () => {
  it('오류·경고가 하나도 없다', () => {
    const r = check(FACTORY_ADMIN_PARAMS);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('도달 보드는 13이다 (§4.3 "숙련자는 120초에 12~13보드")', () => {
    expect(check(FACTORY_ADMIN_PARAMS).reachedBoards).toBe(13);
  });

  it('스텁 게이트를 써도 오류가 생기지 않는다 (pending은 오류가 아니다)', () => {
    const r = check(FACTORY_ADMIN_PARAMS, stubSolverGate());
    expect(r.errors).toEqual([]);
    expect(r.solver.pending).toBe('WU-08');
  });
});

describe('2-2 RANGE 오류 (ADM-401)', () => {
  it('코어 항목이 범위를 벗어나면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 200);
    const errors = check(p).errors;
    expect(errors.map((e) => e.code)).toContain('RANGE');
    expect(errors[0].label).toBe('SESSION TIME');
    expect(errors[0].detail).toContain('90~150');
  });

  it('의존 상한(컨티뉴 하트 ≤ 초기 하트)도 `validateCoreParams`가 그대로 잡는다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 2);
    p = writeField(p, 'core.continueHeartRecover', 5);
    expect(check(p).errors.some((e) => e.key === 'core.continueHeartRecover')).toBe(true);
  });

  it('의존 상한(컨티뉴 시간 ≤ 세션 시간)도 잡는다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 90);
    p = writeField(p, 'core.continueTimeRefillSec', 120);
    expect(check(p).errors.some((e) => e.key === 'core.continueTimeRefillSec')).toBe(true);
  });

  it('비코어 항목(적응 난이도)도 범위를 본다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'difficulty.upPercent', 10);
    expect(check(p).errors.some((e) => e.key === 'difficulty.upPercent')).toBe(true);
  });

  it('구간표 셀도 범위를 본다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.WARMUP.chains.min', 1);
    expect(check(p).errors.some((e) => e.key === 'tiers.WARMUP.chains.min')).toBe(true);
  });

  it('MIN > MAX도 RANGE 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.WARMUP.chains.min', 12);
    const p2 = writeField(p, 'tiers.WARMUP.chains.max', 6);
    const issue = check(p2).errors.find((e) => e.detail.includes('MIN 12 > MAX 6'));
    expect(issue).toBeDefined();
  });

  it('enum이 목록 밖이면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'difficulty.preset', 'INSANE');
    expect(check(p).errors.some((e) => e.key === 'difficulty.preset')).toBe(true);
  });

  it('toggle이 불리언이 아니면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'difficulty.adaptive', 'yes');
    expect(check(p).errors.some((e) => e.detail.includes('ON/OFF'))).toBe(true);
  });

  it('clock 형식이 어긋나면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'machine.nightMuteStart', '25시');
    expect(check(p).errors.some((e) => e.detail.includes('HH:MM'))).toBe(true);
  });

  it('미설정 단가(null)는 오류가 아니다', () => {
    expect(check(FACTORY_ADMIN_PARAMS).errors).toEqual([]);
    const p = writeField(FACTORY_ADMIN_PARAMS, 'machine.coinUnitPrice', 1500);
    expect(check(p).errors).toEqual([]);
  });

  it('미설정이 허용되지 않는 필드에 null이 들어가면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'machine.attractVolume', null);
    expect(check(p).errors.some((e) => e.detail === '값 없음')).toBe(true);
  });

  it('오류 여러 개면 **전체 목록**을 돌려준다 (admin §9.4)', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 200);
    p = writeField(p, 'core.initialHearts', 30);
    p = writeField(p, 'difficulty.window', 99);
    expect(check(p).errors.length).toBeGreaterThanOrEqual(3);
  });

  it('오류 목록의 순서가 결정적이다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 200);
    p = writeField(p, 'difficulty.window', 99);
    const first = check(p).errors.map((e) => e.key);
    const second = check(p).errors.map((e) => e.key);
    expect(first).toEqual(second);
    expect(first[0]).toBe('core.sessionTimeSec');
  });
});

describe('2-3 TIER_MONOTONIC 오류 (ADM-403)', () => {
  it('뒤 구간의 사슬 수가 앞보다 작으면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.RHYTHM.chains.min', 5);
    const issue = check(p).errors.find((e) => e.code === 'TIER_MONOTONIC');
    expect(issue?.key).toBe('tiers.RHYTHM.chains.min');
    expect(issue?.detail).toContain('뒤 구간이 더 쉬우면');
  });

  it('뒤 구간의 의존 깊이가 앞보다 작으면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.MASTER.depth.max', 8);
    expect(check(p).errors.some((e) => e.code === 'TIER_MONOTONIC')).toBe(true);
  });

  it('MIN·MAX 양쪽을 본다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.ENDLESS.chains.max', 30);
    expect(check(p).errors.some((e) => e.key === 'tiers.ENDLESS.chains.max')).toBe(true);
  });

  it('초기 안전수가 줄어드는 것은 오류가 아니다 (§6.2에서 감소하는 축)', () => {
    expect(FACTORY_ADMIN_PARAMS.tiers.MASTER.safeMoves.min).toBeLessThan(
      FACTORY_ADMIN_PARAMS.tiers.WARMUP.safeMoves.min
    );
    expect(check(FACTORY_ADMIN_PARAMS).errors).toEqual([]);
  });

  it('목표 시간은 단조성 대상이 아니다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'tiers.ENDLESS.targetSec.min', 5);
    const monotonic = check(p).errors.filter((e) => e.code === 'TIER_MONOTONIC');
    expect(monotonic).toEqual([]);
  });

  it('뒤 구간을 전부 하한으로 눕히면 첫 경계에서 2축 × MIN/MAX = 4건이 잡힌다', () => {
    let p = FACTORY_ADMIN_PARAMS;
    for (const tier of PARAM_TIERS.slice(1)) {
      p = writeField(p, `tiers.${tier}.chains.min`, 4);
      p = writeField(p, `tiers.${tier}.chains.max`, 4);
      p = writeField(p, `tiers.${tier}.depth.min`, 1);
      p = writeField(p, `tiers.${tier}.depth.max`, 1);
    }
    // 리듬 이후는 서로 같아 위반이 아니다 — 어긋난 경계는 워밍업 → 리듬 하나뿐이다
    const monotonic = check(p).errors.filter((e) => e.code === 'TIER_MONOTONIC');
    expect(monotonic).toHaveLength(4);
    expect(monotonic.map((e) => e.key)).toEqual([
      'tiers.RHYTHM.chains.min',
      'tiers.RHYTHM.chains.max',
      'tiers.RHYTHM.depth.min',
      'tiers.RHYTHM.depth.max',
    ]);
  });

  it('구간마다 한 단계씩 낮추면 경계 4개에서 전부 잡힌다 (2축 × MIN/MAX × 4경계 = 16)', () => {
    let p = FACTORY_ADMIN_PARAMS;
    const values = [40, 30, 20, 10, 5];
    PARAM_TIERS.forEach((tier, i) => {
      p = writeField(p, `tiers.${tier}.chains.min`, values[i]);
      p = writeField(p, `tiers.${tier}.chains.max`, values[i]);
      p = writeField(p, `tiers.${tier}.depth.min`, values[i] / 5);
      p = writeField(p, `tiers.${tier}.depth.max`, values[i] / 5);
    });
    expect(check(p).errors.filter((e) => e.code === 'TIER_MONOTONIC')).toHaveLength(16);
  });
});

describe('2-4 GRADE_ORDER 오류', () => {
  it('S+ ≤ S이면 오류다 (동점도 위반)', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'grade.sPlus', 200000);
    expect(check(p).errors.some((e) => e.code === 'GRADE_ORDER')).toBe(true);
  });

  it('S < A이면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'grade.s', 100000);
    const issue = check(p).errors.find((e) => e.code === 'GRADE_ORDER');
    expect(issue?.label).toBe('GRADE S THRESHOLD');
  });

  it('A ≤ B이면 오류다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'grade.a', 65000);
    expect(check(p).errors.some((e) => e.label === 'GRADE A THRESHOLD')).toBe(true);
  });

  it('세 쌍이 모두 깨지면 3건이 나온다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'grade.sPlus', 1000);
    p = writeField(p, 'grade.s', 1000);
    p = writeField(p, 'grade.a', 1000);
    p = writeField(p, 'grade.b', 1000);
    expect(check(p).errors.filter((e) => e.code === 'GRADE_ORDER')).toHaveLength(3);
  });

  it('엄격 내림차순이면 통과한다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'grade.sPlus', 999000);
    expect(check(p).errors.filter((e) => e.code === 'GRADE_ORDER')).toEqual([]);
  });
});

describe('2-5 SOLVER 오류 (ADM-402 배선)', () => {
  it('`ok:false` 게이트면 실패 보드 목록이 그대로 오류가 된다', () => {
    const r = check(FACTORY_ADMIN_PARAMS, failingSolverGate());
    const solver = r.errors.filter((e) => e.code === 'SOLVER');
    expect(solver).toHaveLength(2);
    expect(solver[0].detail).toContain('해법 0개');
    expect(solver[1].detail).toContain('순환 교착');
  });

  it('3초 상한을 넘으면 `ok:true`라도 오류다', () => {
    const r = check(FACTORY_ADMIN_PARAMS, slowSolverGate(3200));
    const solver = r.errors.filter((e) => e.code === 'SOLVER');
    expect(solver).toHaveLength(1);
    expect(solver[0].detail).toContain('3000ms 초과');
  });

  it('상한과 정확히 같으면 통과한다', () => {
    const r = check(FACTORY_ADMIN_PARAMS, slowSolverGate(SOLVER_GATE_SPEC.timeBudgetMs));
    expect(r.errors).toEqual([]);
  });

  it('스텁은 `pending`을 세우고 오류를 만들지 않는다', () => {
    const r = check(FACTORY_ADMIN_PARAMS, stubSolverGate());
    expect(r.errors.filter((e) => e.code === 'SOLVER')).toEqual([]);
    expect(r.solver.pending).toBe('WU-08');
  });

  it('실물 게이트 결과는 `pending`을 세우지 않는다', () => {
    expect(check(FACTORY_ADMIN_PARAMS, okSolverGate()).solver.pending).toBeUndefined();
  });
});

describe('2-6 경고 3종', () => {
  it('초기 하트 1은 경고다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 1);
    expect(codes(p)).toContain('WARN_HEARTS');
  });

  it('초기 하트 6~9는 경고다', () => {
    for (const n of [6, 7, 8, 9]) {
      const p = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', n);
      expect(check(p).warnings.some((w) => w.code === 'WARN_HEARTS')).toBe(true);
    }
  });

  it('초기 하트 2~5는 경고가 아니다', () => {
    for (const n of [2, 3, 4, 5]) {
      const p = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', n);
      expect(check(p).warnings.some((w) => w.code === 'WARN_HEARTS')).toBe(false);
    }
  });

  it('TIME GAIN CAP > 1.0은 경고다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.timeGainCapSec', 1.1);
    expect(check(p).warnings.some((w) => w.code === 'WARN_TIME_GAIN_CAP')).toBe(true);
  });

  it('TIME GAIN CAP = 1.0은 경고가 아니다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.timeGainCapSec', 1);
    expect(check(p).warnings.some((w) => w.code === 'WARN_TIME_GAIN_CAP')).toBe(false);
  });

  it('도달 보드 8 미만은 경고다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'KIDS');
    expect(check(p).reachedBoards).toBeLessThan(8);
    expect(check(p).warnings.some((w) => w.code === 'WARN_SESSION_BUDGET')).toBe(true);
  });

  it('도달 보드 20 초과는 경고다', () => {
    const p = applyPreset(FACTORY_ADMIN_PARAMS, 'HARD');
    expect(check(p).reachedBoards).toBeGreaterThan(20);
    expect(check(p).warnings.some((w) => w.code === 'WARN_SESSION_BUDGET')).toBe(true);
  });

  it('경고는 오류 목록에 섞이지 않는다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 7);
    expect(check(p).errors).toEqual([]);
    expect(check(p).warnings).toHaveLength(1);
  });

  it('경고 3종이 동시에 날 수 있다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.initialHearts', 7);
    p = writeField(p, 'core.timeGainCapSec', 1.2);
    p = applyPreset(p, 'HARD');
    const set = new Set(check(p).warnings.map((w) => w.code));
    expect(set).toEqual(new Set(['WARN_HEARTS', 'WARN_TIME_GAIN_CAP', 'WARN_SESSION_BUDGET']));
  });
});

describe('2-7 세션 예산 검산 (§4.3 검산표 대조 — R7)', () => {
  const P = FACTORY_ADMIN_PARAMS;

  it('보드 번호 → 구간 경계가 §6.2와 같다', () => {
    expect([1, 3].map(tierOfBoard)).toEqual(['WARMUP', 'WARMUP']);
    expect([4, 6].map(tierOfBoard)).toEqual(['RHYTHM', 'RHYTHM']);
    expect([7, 9].map(tierOfBoard)).toEqual(['PRESSURE', 'PRESSURE']);
    expect([10, 12].map(tierOfBoard)).toEqual(['MASTER', 'MASTER']);
    expect([13, 99].map(tierOfBoard)).toEqual(['ENDLESS', 'ENDLESS']);
  });

  it('구간별 회복량이 §4.3 표와 같다', () => {
    expect(tierBudget(P, 'WARMUP').gainPerChain).toBeCloseTo(0.37, 2);
    expect(tierBudget(P, 'RHYTHM').gainPerChain).toBeCloseTo(0.47, 2);
    expect(tierBudget(P, 'PRESSURE').gainPerChain).toBeCloseTo(0.61, 2);
    expect(tierBudget(P, 'MASTER').gainPerChain).toBeCloseTo(0.77, 2);
    expect(tierBudget(P, 'ENDLESS').gainPerChain).toBeCloseTo(0.89, 2);
  });

  it('회복 상한 0.9초가 엔드리스에서 실제로 걸린다 (§4.3 마지막 문단)', () => {
    // 0.25 + 0.08 × 8 = 0.89 < 0.9 이지만 깊이를 조금만 올리면 곧바로 상한에 닿는다
    const deeper = writeField(P, 'tiers.ENDLESS.depth.max', 24);
    expect(tierBudget(deeper, 'ENDLESS').gainPerChain).toBe(0.9);
  });

  it('구간별 순 소모가 §4.3 표와 ±1.0초 이내다', () => {
    const expected: Readonly<Record<string, number>> = {
      WARMUP: 8.4,
      RHYTHM: 8.9,
      PRESSURE: 9.9,
      MASTER: 10.2,
      ENDLESS: 7.7,
    };
    for (const tier of PARAM_TIERS) {
      expect(Math.abs(tierBudget(P, tier).netCost - expected[tier])).toBeLessThanOrEqual(1);
    }
  });

  it('누적 소모가 §4.3 표와 ±1.0초 이내다', () => {
    const table: readonly (readonly [number, number])[] = [
      [3, 25.2],
      [6, 51.9],
      [9, 81.6],
      [12, 112.2],
      [13, 119.9],
    ];
    for (const [boards, expected] of table) {
      expect(Math.abs(sessionBudgetCumulative(P, boards) - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('13보드는 세션 시간 안이고 14보드는 넘는다', () => {
    expect(sessionBudgetCumulative(P, 13)).toBeLessThanOrEqual(P.core.sessionTimeSec);
    expect(sessionBudgetCumulative(P, 14)).toBeGreaterThan(P.core.sessionTimeSec);
  });

  it('공장값 도달 보드는 정확히 13이다', () => {
    expect(sessionBudgetBoards(P)).toBe(13);
  });

  it('세션 시간을 늘리면 도달 보드가 늘어난다', () => {
    expect(sessionBudgetBoards(writeField(P, 'core.sessionTimeSec', 150))).toBeGreaterThan(13);
  });

  it('순 소모가 0 이하이면 999로 절단한다', () => {
    const p = writeField(P, 'core.timeGainBaseSec', 0.5);
    expect(sessionBudgetBoards(writeField(p, 'core.timeGainCapSec', 1.2))).toBe(
      SESSION_BUDGET_UNBOUNDED
    );
  });

  it('조정 범위 안에서 가장 가혹한 설정이어도 1보드는 남는다 (0은 범위 밖에서만 나온다)', () => {
    let p = writeField(P, 'core.sessionTimeSec', 90);
    p = writeField(p, 'tiers.WARMUP.targetSec.min', 90);
    p = writeField(p, 'tiers.WARMUP.targetSec.max', 90);
    p = writeField(p, 'core.timeGainBaseSec', 0);
    p = writeField(p, 'core.timeGainPerDepthSec', 0);
    expect(sessionBudgetBoards(p)).toBe(1);
    expect(check(p).warnings.some((w) => w.code === 'WARN_SESSION_BUDGET')).toBe(true);
  });

  it('손상된 저장 파일처럼 범위를 벗어난 값이 들어와도 0에서 멈춘다 (방어 분기)', () => {
    let p = writeField(P, 'core.sessionTimeSec', 90);
    p = writeField(p, 'tiers.WARMUP.targetSec.max', 200);
    p = writeField(p, 'core.timeGainBaseSec', 0);
    p = writeField(p, 'core.timeGainPerDepthSec', 0);
    expect(sessionBudgetBoards(p)).toBe(0);
  });
});

describe('2-8 보고 형태', () => {
  it('오류가 있으면 저장 불가 판정에 쓰이는 배열이 비어 있지 않다', () => {
    const p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 999);
    expect(check(p).errors.length).toBeGreaterThan(0);
  });

  it('보고에는 솔버 결과와 도달 보드가 함께 실린다', () => {
    const r = check(FACTORY_ADMIN_PARAMS, okSolverGate(15, 1842));
    expect(r.solver.boardsChecked).toBe(15);
    expect(r.solver.elapsedMs).toBe(1842);
    expect(r.reachedBoards).toBe(13);
  });

  it('오류 코드 4종·경고 코드 3종만 나온다', () => {
    let p = writeField(FACTORY_ADMIN_PARAMS, 'core.sessionTimeSec', 999);
    p = writeField(p, 'grade.s', 1);
    p = writeField(p, 'tiers.RHYTHM.chains.min', 4);
    const all = new Set(codes(p, failingSolverGate()));
    for (const code of all) {
      expect([
        'RANGE',
        'TIER_MONOTONIC',
        'SOLVER',
        'GRADE_ORDER',
        'WARN_HEARTS',
        'WARN_TIME_GAIN_CAP',
        'WARN_SESSION_BUDGET',
      ]).toContain(code);
    }
    expect(all.has('SOLVER')).toBe(true);
  });
});
