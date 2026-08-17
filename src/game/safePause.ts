// SAFE PAUSE 상태 모델 (§12.3 — 착수 Q3-a · 작업 계획 P-7)
//
// 정비 중 도어를 열거나 SERVICE 키를 누르면 진행 중인 런을 **버리지 않고** 안전하게 멈춘다.
// 해제하면 3초 카운트다운 뒤 재개한다 — 손을 뗀 상태에서 갑자기 타이머가 돌면 플레이어가
// 이미 진 상태로 돌아오기 때문이다.
//
// 상태  idle → paused → countdown → idle
//
// **시계를 모른다.** `tick(nowMs)`만 받으므로 카운트다운이 결정적으로 판정된다. 실제 도어
// 신호는 §17 `[보류]`이므로 포트 자리만 두고 기본 구현은 항상 닫힘이다.

/** §12.3 — 해제 후 재개까지 */
export const SAFE_PAUSE_COUNTDOWN_MS = 3000;

export type SafePauseState = 'idle' | 'paused' | 'countdown';

/** 무엇이 멈췄는지 — 화면 문구가 달라진다 */
export type SafePauseReason = 'service' | 'door';

export const SAFE_PAUSE_TEXT: Readonly<Record<SafePauseReason, string>> = {
  service: 'SAFE PAUSE · 정비 모드 · SERVICE로 재개',
  door: 'SAFE PAUSE · 도어 열림 · 닫으면 재개',
};

/** §17 `[보류]` #2 — 도어 센서 실물. 지금은 항상 닫힘이다 */
export interface DoorSensorPort {
  isOpen(): boolean;
}

export function closedDoorSensor(): DoorSensorPort {
  return { isOpen: () => false };
}

export interface SafePauseView {
  readonly state: SafePauseState;
  readonly reason: SafePauseReason | null;
  /** 카운트다운 잔여(ms). 카운트다운 중이 아니면 0 */
  readonly remainingMs: number;
  readonly text: string;
}

export interface SafePauseDeps {
  readonly countdownMs?: number;
  /** 런 타이머를 멈춘다 (`RunController.pause`) */
  readonly onPause?: (reason: SafePauseReason) => void;
  /** 카운트다운이 끝났다 — 런 타이머를 다시 돌린다 (`RunController.resume`) */
  readonly onResume?: () => void;
}

export class SafePauseModel {
  private readonly countdownMs: number;
  private readonly onPause: (reason: SafePauseReason) => void;
  private readonly onResume: () => void;

  private stateRef: SafePauseState = 'idle';
  private reasonRef: SafePauseReason | null = null;
  private countdownEndsAtMs = 0;
  /** 재개가 실제로 일어난 횟수 — 판정용 */
  private resumeCount = 0;

  constructor(deps: SafePauseDeps = {}) {
    this.countdownMs = deps.countdownMs ?? SAFE_PAUSE_COUNTDOWN_MS;
    this.onPause = deps.onPause ?? ((): void => undefined);
    this.onResume = deps.onResume ?? ((): void => undefined);
  }

  get state(): SafePauseState {
    return this.stateRef;
  }

  get reason(): SafePauseReason | null {
    return this.reasonRef;
  }

  /** 런 타이머가 멈춰 있어야 하는가 — `paused`와 `countdown` 둘 다 정지 상태다 */
  get active(): boolean {
    return this.stateRef !== 'idle';
  }

  get resumes(): number {
    return this.resumeCount;
  }

  /**
   * 정지 요청. 이미 멈춰 있으면 **사유만 갱신**하고 카운트다운은 취소한다 —
   * 카운트다운 중에 도어가 다시 열리면 재개하면 안 된다.
   */
  trigger(reason: SafePauseReason): boolean {
    const was = this.stateRef;
    this.reasonRef = reason;
    this.stateRef = 'paused';
    this.countdownEndsAtMs = 0;
    if (was === 'idle') this.onPause(reason);
    return was === 'idle';
  }

  /** 해제 — 3초 카운트다운을 시작한다. 멈춰 있지 않으면 아무 일도 없다 */
  release(nowMs: number): boolean {
    if (this.stateRef !== 'paused') return false;
    this.stateRef = 'countdown';
    this.countdownEndsAtMs = nowMs + this.countdownMs;
    return true;
  }

  /** 카운트다운 만료를 판정한다. 재개했으면 true */
  tick(nowMs: number): boolean {
    if (this.stateRef !== 'countdown') return false;
    if (nowMs < this.countdownEndsAtMs) return false;
    this.stateRef = 'idle';
    this.reasonRef = null;
    this.countdownEndsAtMs = 0;
    this.resumeCount += 1;
    this.onResume();
    return true;
  }

  /** 런이 끝났다 — 상태를 버린다 (재개 콜백 없이) */
  reset(): void {
    this.stateRef = 'idle';
    this.reasonRef = null;
    this.countdownEndsAtMs = 0;
  }

  remainingMs(nowMs: number): number {
    if (this.stateRef !== 'countdown') return 0;
    return Math.max(0, this.countdownEndsAtMs - nowMs);
  }

  view(nowMs: number): SafePauseView {
    const reason = this.reasonRef;
    return {
      state: this.stateRef,
      reason,
      remainingMs: this.remainingMs(nowMs),
      text:
        this.stateRef === 'idle'
          ? ''
          : this.stateRef === 'countdown'
            ? `RESUMING ${String(Math.ceil(this.remainingMs(nowMs) / 1000))}`
            : SAFE_PAUSE_TEXT[reason ?? 'service'],
    };
  }
}
