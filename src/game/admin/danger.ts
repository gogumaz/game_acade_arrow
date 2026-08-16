// 위험 작업 4단계 (admin §13 · §11.7 — 작업 계획 §9)
//
// 홀드 확인이 성립하려면 **뗌 이벤트**가 필요한데 WU-01 입력 계층은 누름만 발화했다(F-e).
// 그래서 `input.ts`에 `PhaseSource`를 추가하고(P-6) 이 상태기계가 그 스트림만 먹는다.
// 여기에는 시계도 파일도 없다 — `nowMs`를 인자로 받는 순수 상태기계다.
//
//   낮음   즉시 변경 + 자동 저장 + 토스트          (홀드 없음)
//   중간   변경 전/후 표시 + `H` 확정               (홀드 없음, 확인 화면은 있다)
//   높음   별도 화면 + `H` 2초 유지 + 백업          `RESET`·`RESTORE`·경고 저장·`RESTART`
//   치명   별도 화면 + `H` 3초 유지 + 잔액 경고     `REBOOT`·`SHUTDOWN`
//
// 공통 규칙(admin §13): 확인 중 `G`·커서 이동이면 해제 · **10초 자동 취소** ·
// 실행 중 추가 입력 잠금 + 진행 표시 · **성공·실패 모두** 감사 로그.

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const RISK_HOLD_MS: Readonly<Record<RiskLevel, number>> = {
  LOW: 0,
  MEDIUM: 0,
  HIGH: 2000,
  CRITICAL: 3000,
};

/** admin §13 — 확인 상태는 10초 후 자동 취소한다 */
export const DANGER_AUTO_CANCEL_MS = 10000;

type DangerState = 'IDLE' | 'ARMED' | 'HOLDING' | 'EXECUTING';

/** 확인을 요구하는 작업 1건. `id`는 컨트롤러가 실행부를 찾는 열쇠다 */
export interface DangerRequest {
  readonly id: string;
  readonly level: RiskLevel;
  readonly label: string;
  /** 확인 화면에 띄우는 대상 요약 — "유료 통계 3개 항목을 0으로 만듭니다" */
  readonly summary: string;
  /** 잔액 경고가 필요한 작업인가 (치명 등급 · admin §10.6) */
  readonly balanceWarning?: string;
}

type DangerRejection = 'TOO_SHORT' | 'NONE';

export class DangerGate {
  private current: DangerState = 'IDLE';
  private request: DangerRequest | null = null;
  private armedAtMs = 0;
  private holdFromMs = 0;
  private lastRejection: DangerRejection = 'NONE';

  get state(): DangerState {
    return this.current;
  }

  get pending(): DangerRequest | null {
    return this.request;
  }

  /** 실행 중에는 추가 입력을 잠근다 (admin §13) */
  get locked(): boolean {
    return this.current === 'EXECUTING';
  }

  get lastRejected(): DangerRejection {
    return this.lastRejection;
  }

  /** 이 작업에 필요한 홀드 시간(ms). 확인 화면 문구가 그대로 읽는다 */
  get requiredHoldMs(): number {
    return this.request === null ? 0 : RISK_HOLD_MS[this.request.level];
  }

  /** 진행 표시 0..1 — 홀드 중이 아니면 0 */
  progress01(nowMs: number): number {
    if (this.current !== 'HOLDING') return 0;
    const need = this.requiredHoldMs;
    if (need <= 0) return 1;
    return Math.max(0, Math.min(1, (nowMs - this.holdFromMs) / need));
  }

  /** 자동 취소까지 남은 ms — 확인 화면에 표시한다 */
  autoCancelLeftMs(nowMs: number): number {
    if (this.current !== 'ARMED') return 0;
    return Math.max(0, DANGER_AUTO_CANCEL_MS - (nowMs - this.armedAtMs));
  }

  /** 확인 화면을 연다. 이미 실행 중이면 무시한다 */
  arm(request: DangerRequest, nowMs: number): boolean {
    if (this.current === 'EXECUTING') return false;
    this.request = request;
    this.current = 'ARMED';
    this.armedAtMs = nowMs;
    this.holdFromMs = 0;
    this.lastRejection = 'NONE';
    return true;
  }

  /**
   * `H` 누름. 홀드가 필요 없는 등급(낮음·중간)은 이 자리에서 곧바로 실행 대상을 돌려준다.
   * 홀드가 필요하면 `null`을 돌려주고 `tick()`이 완료를 알린다.
   */
  press(nowMs: number): DangerRequest | null {
    if (this.current !== 'ARMED') return null;
    this.current = 'HOLDING';
    this.holdFromMs = nowMs;
    this.lastRejection = 'NONE';
    if (this.requiredHoldMs <= 0) return this.beginExecute();
    return null;
  }

  /**
   * `H` 뗌. 필요한 시간을 못 채웠으면 **저장되지 않고** 확인 화면으로 되돌아간다
   * (ADM-204 "`H` 1회로는 저장되지 않는다"의 실체).
   */
  release(nowMs: number): DangerRequest | null {
    if (this.current !== 'HOLDING') return null;
    if (nowMs - this.holdFromMs >= this.requiredHoldMs) return this.beginExecute();
    this.current = 'ARMED';
    this.armedAtMs = nowMs;
    this.lastRejection = 'TOO_SHORT';
    return null;
  }

  /** 홀드 완료·10초 자동 취소를 프레임마다 본다 */
  tick(nowMs: number): DangerRequest | null {
    if (this.current === 'HOLDING' && nowMs - this.holdFromMs >= this.requiredHoldMs) {
      return this.beginExecute();
    }
    if (this.current === 'ARMED' && nowMs - this.armedAtMs >= DANGER_AUTO_CANCEL_MS) {
      this.cancel();
    }
    return null;
  }

  /** `G` 또는 커서 이동 — 확인 상태를 해제한다. 실행 중에는 해제되지 않는다 */
  cancel(): boolean {
    if (this.current === 'EXECUTING' || this.current === 'IDLE') return false;
    this.current = 'IDLE';
    this.request = null;
    this.holdFromMs = 0;
    this.lastRejection = 'NONE';
    return true;
  }

  /** 실행이 끝났다 — 성공·실패 모두 여기로 온다 */
  finish(): DangerRequest | null {
    const done = this.request;
    this.current = 'IDLE';
    this.request = null;
    this.holdFromMs = 0;
    return done;
  }

  private beginExecute(): DangerRequest | null {
    this.current = 'EXECUTING';
    return this.request;
  }
}
