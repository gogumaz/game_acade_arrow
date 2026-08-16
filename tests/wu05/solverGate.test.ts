// 솔버 게이트 포트 (§11.5 · ADM-402 — 계획 T2 · P-7)
//
// **판정은 WU-08로 이월하지만 배선은 지금 증명한다.** 여기서 고정하는 것은 셋이다.
//   ① 규격 상수(5구간 × 3시드 = 15보드 / 3초)가 기획서 문언 그대로다
//   ② 스텁은 `pending: 'WU-08'`을 세우고 **통과했다고 쓰지 않는다**
//   ③ `ok:false`·3초 초과 게이트를 끼우면 저장이 **실제로** 막힌다 (교체 지점 1곳)

import { describe, expect, it } from 'vitest';
import {
  FACTORY_ADMIN_PARAMS,
  SOLVER_GATE_SPEC,
  SOLVER_REASON_TEXT,
  validateAdminParams,
} from '../../src/core/adminParams';
import { stubSolverGate } from '../../src/game/admin/solverGate';
import { failingSolverGate, flushAsync, makeAdmin, okSolverGate, slowSolverGate } from './harness';

describe('4-1 규격 상수 (§11.5 문언)', () => {
  it('5구간 × 3시드 = 15보드다', () => {
    expect(SOLVER_GATE_SPEC.tiers).toBe(5);
    expect(SOLVER_GATE_SPEC.seedsPerTier).toBe(3);
    expect(SOLVER_GATE_SPEC.boards).toBe(15);
    expect(SOLVER_GATE_SPEC.tiers * SOLVER_GATE_SPEC.seedsPerTier).toBe(SOLVER_GATE_SPEC.boards);
  });

  it('검증 시간 상한은 3초다', () => {
    expect(SOLVER_GATE_SPEC.timeBudgetMs).toBe(3000);
  });

  it('실패 사유 3종이 §11.5 문언과 대응한다', () => {
    expect(SOLVER_REASON_TEXT.no_solution).toBe('해법 0개');
    expect(SOLVER_REASON_TEXT.deadlock).toBe('순환 교착');
    expect(SOLVER_REASON_TEXT.over_target_time).toBe('목표 시간 1.8배 초과');
  });
});

describe('4-2 스텁 (WU-08 대기)', () => {
  const stub = stubSolverGate();

  it('`ok:true`지만 `pending: WU-08`을 세운다', () => {
    const r = stub.validate(FACTORY_ADMIN_PARAMS);
    expect(r.ok).toBe(true);
    expect(r.pending).toBe('WU-08');
  });

  it('검사한 보드가 0이라 "통과했다"고 쓰지 않는다', () => {
    const r = stub.validate(FACTORY_ADMIN_PARAMS);
    expect(r.boardsChecked).toBe(0);
    expect(r.elapsedMs).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it('스텁으로는 저장이 막히지 않는다', () => {
    expect(validateAdminParams(FACTORY_ADMIN_PARAMS, stub).errors).toEqual([]);
  });

  it('실물 게이트는 `pending`을 세우지 않는다', () => {
    expect(okSolverGate().validate(FACTORY_ADMIN_PARAMS).pending).toBeUndefined();
    expect(failingSolverGate().validate(FACTORY_ADMIN_PARAMS).pending).toBeUndefined();
  });
});

describe('4-3 차단 배선 증명 (가짜 게이트 3종)', () => {
  it('ok 게이트 — 저장이 실제로 성사된다', async () => {
    const rig = makeAdmin({ solverGate: okSolverGate() });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(true);
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(121);
  });

  it('fail 게이트 — 저장이 막히고 라이브가 그대로다 (ADM-402 배선)', async () => {
    const rig = makeAdmin({ solverGate: failingSolverGate() });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
    expect(rig.admin.draft.core.sessionTimeSec).toBe(121);
  });

  it('slow 게이트 — 3초를 넘기면 저장이 막힌다', async () => {
    const rig = makeAdmin({ solverGate: slowSolverGate(3001) });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    expect(await rig.admin.save()).toBe(false);
    expect(rig.admin.validationReport?.errors.some((e) => e.code === 'SOLVER')).toBe(true);
  });

  it('fail 게이트에서는 홀드로도 저장되지 않는다 (오류는 경고가 아니다)', async () => {
    const rig = makeAdmin({ solverGate: failingSolverGate() });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    rig.holdConfirm(2500);
    await flushAsync();
    expect(rig.admin.liveParams.core.sessionTimeSec).toBe(120);
  });

  it('솔버 오류는 화면 목록에 전부 실린다', async () => {
    const rig = makeAdmin({ solverGate: failingSolverGate() });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    const view = rig.admin.view();
    expect(view.errors.filter((line) => line.startsWith('SOLVER GATE'))).toHaveLength(2);
  });

  it('스텁이면 화면 배지가 `[WU-08 대기] SKIPPED`다', () => {
    const rig = makeAdmin({ solverGate: stubSolverGate() });
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    expect(rig.admin.view().solverBadge).toBe('[WU-08 대기] SKIPPED');
  });

  it('실물 게이트가 통과하면 배지에 보드 수·시간이 실린다', () => {
    const rig = makeAdmin({ solverGate: okSolverGate(15, 1842) });
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    rig.admin.validate();
    rig.press('DOWN');
    rig.press('UP');
    // VALIDATE 행을 실행해 보고서를 만든다
    rig.admin.goTo(['PARAMS', 'P_VALIDATE']);
    rig.press('BUTTON1');
    expect(rig.admin.view().solverBadge).toBe('ok (15보드 / 1842ms)');
  });

  it('실패 게이트면 배지가 실패 건수를 보여 준다', async () => {
    const rig = makeAdmin({ solverGate: failingSolverGate() });
    rig.admin.goTo(['PARAMS', 'P_SESSION']);
    rig.press('RIGHT');
    await rig.admin.save();
    expect(rig.admin.view().solverBadge).toBe('실패 2건');
  });

  it('교체 지점은 `createApp({ solverGate })` 1곳이다 — 컨트롤러는 포트만 안다', () => {
    const rig = makeAdmin({ solverGate: okSolverGate(15, 10) });
    expect(rig.admin.validate().solver.boardsChecked).toBe(15);
    const rig2 = makeAdmin({ solverGate: stubSolverGate() });
    expect(rig2.admin.validate().solver.pending).toBe('WU-08');
  });
});
