// 위험 작업 4단계 (admin §13 · §11.7 — 계획 T7 · ADM-204 · 돌연변이 ②)
//
// 홀드 시간을 **실제로** 판정한다: 2초를 못 채우고 뗀 `H`는 실행되지 않는다.
// 이것이 성립하려면 뗌 이벤트가 필요하고, 그것이 계획 P-6(입력 phase 스트림)의 이유다.

import { describe, expect, it } from 'vitest';
import {
  DANGER_AUTO_CANCEL_MS,
  DangerGate,
  RISK_HOLD_MS,
  type DangerRequest,
} from '../../src/game/admin/danger';
import { flushAsync, makeAdmin } from './harness';

function req(level: DangerRequest['level'] = 'HIGH', id = 'reset.paid'): DangerRequest {
  return { id, level, label: 'RESET PAID STATISTICS', summary: '유료 통계 3개 항목' };
}

describe('9-1 위험 등급별 홀드 시간 (admin §13)', () => {
  it('낮음·중간은 홀드가 없다', () => {
    expect(RISK_HOLD_MS.LOW).toBe(0);
    expect(RISK_HOLD_MS.MEDIUM).toBe(0);
  });

  it('높음은 2초, 치명은 3초다', () => {
    expect(RISK_HOLD_MS.HIGH).toBe(2000);
    expect(RISK_HOLD_MS.CRITICAL).toBe(3000);
  });

  it('자동 취소는 10초다', () => {
    expect(DANGER_AUTO_CANCEL_MS).toBe(10000);
  });
});

describe('9-2 상태 전이', () => {
  it('초기 상태는 IDLE이다', () => {
    const g = new DangerGate();
    expect(g.state).toBe('IDLE');
    expect(g.pending).toBe(null);
    expect(g.locked).toBe(false);
  });

  it('`arm`이 확인 화면을 연다', () => {
    const g = new DangerGate();
    expect(g.arm(req(), 0)).toBe(true);
    expect(g.state).toBe('ARMED');
    expect(g.pending?.label).toBe('RESET PAID STATISTICS');
    expect(g.requiredHoldMs).toBe(2000);
  });

  it('중간 등급은 `H` 1회로 곧바로 실행된다', () => {
    const g = new DangerGate();
    g.arm(req('MEDIUM', 'grant.event'), 0);
    expect(g.press(0)?.id).toBe('grant.event');
    expect(g.state).toBe('EXECUTING');
  });

  it('높음 등급은 `H` 누름만으로 실행되지 않는다 (돌연변이 ②)', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    expect(g.press(0)).toBe(null);
    expect(g.state).toBe('HOLDING');
  });

  it('2초를 채우고 떼면 실행된다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    expect(g.release(2000)?.id).toBe('reset.paid');
    expect(g.state).toBe('EXECUTING');
  });

  it('2초를 못 채우고 떼면 실행되지 않고 확인 화면으로 돌아간다 (ADM-204)', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    expect(g.release(1999)).toBe(null);
    expect(g.state).toBe('ARMED');
    expect(g.lastRejected).toBe('TOO_SHORT');
  });

  it('떼지 않아도 `tick`이 2초에 실행을 알린다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    expect(g.tick(1999)).toBe(null);
    expect(g.tick(2000)?.id).toBe('reset.paid');
  });

  it('치명 등급은 3초를 요구한다', () => {
    const g = new DangerGate();
    g.arm(req('CRITICAL', 'system.reboot'), 0);
    g.press(0);
    expect(g.tick(2999)).toBe(null);
    expect(g.tick(3000)?.id).toBe('system.reboot');
  });

  it('`finish`가 IDLE로 되돌린다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    g.tick(2000);
    expect(g.finish()?.id).toBe('reset.paid');
    expect(g.state).toBe('IDLE');
    expect(g.pending).toBe(null);
  });
});

describe('9-3 해제 규칙 (admin §13)', () => {
  it('`G`가 확인 상태를 해제한다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    expect(g.cancel()).toBe(true);
    expect(g.state).toBe('IDLE');
  });

  it('홀드 중에도 `G`로 해제된다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    expect(g.cancel()).toBe(true);
    expect(g.state).toBe('IDLE');
  });

  it('10초가 지나면 자동 취소한다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    expect(g.tick(9999)).toBe(null);
    expect(g.state).toBe('ARMED');
    g.tick(10000);
    expect(g.state).toBe('IDLE');
  });

  it('자동 취소까지 남은 시간을 알려 준다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    expect(g.autoCancelLeftMs(3000)).toBe(7000);
    expect(g.autoCancelLeftMs(99999)).toBe(0);
  });

  it('실행 중에는 해제되지 않는다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    g.tick(2000);
    expect(g.cancel()).toBe(false);
    expect(g.state).toBe('EXECUTING');
  });

  it('실행 중에는 새 확인도 열리지 않는다 (입력 잠금)', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    g.tick(2000);
    expect(g.locked).toBe(true);
    expect(g.arm(req('CRITICAL'), 3000)).toBe(false);
  });

  it('짧은 홀드 뒤 다시 눌러 채우면 실행된다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    g.release(500);
    g.press(600);
    expect(g.release(2600)?.id).toBe('reset.paid');
  });

  it('IDLE 상태에서는 취소가 아무 일도 하지 않는다', () => {
    expect(new DangerGate().cancel()).toBe(false);
  });

  it('ARMED가 아니면 `press`가 무시된다', () => {
    const g = new DangerGate();
    expect(g.press(0)).toBe(null);
  });

  it('HOLDING이 아니면 `release`가 무시된다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    expect(g.release(5000)).toBe(null);
  });
});

describe('9-4 진행 표시', () => {
  it('홀드 중이 아니면 0이다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    expect(g.progress01(1000)).toBe(0);
  });

  it('절반을 채우면 0.5다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    expect(g.progress01(1000)).toBe(0.5);
  });

  it('넘겨도 1을 넘지 않는다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    expect(g.progress01(9999)).toBe(1);
  });

  it('홀드가 필요 없는 등급은 진행 표시 없이 곧장 실행 상태가 된다', () => {
    const g = new DangerGate();
    g.arm(req('MEDIUM'), 0);
    g.press(0);
    expect(g.state).toBe('EXECUTING');
    expect(g.progress01(0)).toBe(0);
  });
});

describe('9-5 컨트롤러 결선 (뗌 이벤트로 실제 판정 — P-6)', () => {
  it('짧게 눌렀다 떼면 랭킹이 지워지지 않는다 (ADM-404 · 돌연변이 ②)', () => {
    const rig = makeAdmin();
    rig.ranking.size = 10;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.press('DOWN');
    rig.press('BUTTON1'); // 확인 화면
    rig.holdConfirm(500);
    expect(rig.ranking.cleared).toBe(0);
    expect(rig.ranking.size).toBe(10);
  });

  it('2초를 채우면 실행된다', async () => {
    const rig = makeAdmin();
    rig.ranking.size = 10;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    rig.holdConfirm(2000);
    await flushAsync();
    expect(rig.ranking.cleared).toBe(1);
  });

  it('커서를 옮기면 확인 상태가 풀린다 (admin §13)', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['RESET', 'R_PAID']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    expect(rig.admin.view().danger).not.toBe(null);
    rig.press('DOWN');
    expect(rig.admin.view().danger).toBe(null);
  });

  it('`G`로도 풀린다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['RESET', 'R_PAID']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    rig.press('BUTTON2');
    expect(rig.admin.view().danger).toBe(null);
    expect(rig.admin.currentPath).toEqual(['RESET', 'R_PAID']);
  });

  it('10초 무입력이면 확인이 자동 취소된다', () => {
    const rig = makeAdmin();
    rig.admin.goTo(['RESET', 'R_PAID']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    rig.clock.advance(10000);
    rig.admin.tick();
    expect(rig.admin.view().danger).toBe(null);
  });

  it('확인 화면이 홀드 시간·요약·자동 취소를 보여 준다', () => {
    const rig = makeAdmin();
    rig.ranking.size = 7;
    rig.admin.goTo(['RESET', 'R_RANKING']);
    rig.press('DOWN');
    rig.press('BUTTON1');
    const danger = rig.admin.view().danger;
    expect(danger?.requiredHoldMs).toBe(2000);
    expect(danger?.summary).toContain('랭킹 7건');
    expect(danger?.autoCancelLeftMs).toBe(10000);
  });

  it('치명 등급에는 잔액 경고가 붙는다 (admin §10.6)', () => {
    const rig = makeAdmin();
    rig.credits.balanceRef = { paid: 4, event: 1 };
    rig.admin.goTo(['MAINTENANCE', 'M_SYSTEM']);
    rig.press('DOWN');
    rig.press('BUTTON1'); // REBOOT
    const danger = rig.admin.view().danger;
    expect(danger?.level).toBe('CRITICAL');
    expect(danger?.requiredHoldMs).toBe(3000);
    expect(danger?.balanceWarning).toContain('유료 4');
  });

  it('실행 중에는 추가 입력이 잠긴다', () => {
    const g = new DangerGate();
    g.arm(req(), 0);
    g.press(0);
    g.tick(2000);
    expect(g.locked).toBe(true);
  });
});
