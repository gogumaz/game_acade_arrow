// 입력 어댑터 (§2.1 추상 입력 10종·개발 키 · §2.5 홀드 반복 · §17 [보류] Serial I/O)
//
// 구조
//   InputStateMachine — DOM을 모르는 순수 상태기계. 반복·3상태·구독을 전부 여기서 처리한다.
//   KeyboardInputAdapter — 키 이벤트 타깃에 붙는 개발용 구현체.
//   InputAdapter — 나중에 SerialInputAdapter를 끼우기 위한 계약
//
// Serial I/O 실물 연동은 §17 [보류] #1이다. WU-01은 어댑터 인터페이스와 3상태까지만 만들고
// 실제 패킷·펄스 상수는 Serial 구현체 안 1곳에서 교체한다.

import type { InputAction, PlayerId } from '../core/types';

export interface PlayerAction {
  player: PlayerId;
  action: InputAction;
}

/** 어댑터 상태 3종 (§11.7 진단) */
export type InputStatus = 'connected' | 'disconnected' | 'stuck';

/** §2.5 — 레버 홀드 시 연속 이동 시작까지의 지연 */
export const REPEAT_DELAY_MS = 250;
/** §2.5 — 연속 이동 반복 간격 */
export const REPEAT_INTERVAL_MS = 100;
/** §2.5 · §11.7 — 같은 입력이 이 시간 이상 유지되면 고착(stuck)으로 본다 */
export const STUCK_HOLD_MS = 5000;

/** 반복은 레버 4방향에만 적용한다 (§2.5) */
const DIRECTIONS: readonly InputAction[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

/** 코인·SERVICE·예약 슬롯은 "아무 키나 누르면 시작" 판정에서 제외한다 (§2.7) */
const ANY_KEY_EXCLUDED: readonly InputAction[] = ['COIN', 'SERVICE', 'RESERVED'];

// ── 주입 지점 ──────────────────────────────────────────────────────────────

/**
 * 타이머 핸들. 브라우저는 number, Node는 Timeout 객체를 돌려주므로 불투명하게 다룬다.
 * 상태기계는 핸들을 만들고 되돌려 주기만 하고 내용을 들여다보지 않는다.
 */
export type TimerHandle = unknown;

export interface InputTimers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** 기본 타이머 — 브라우저·Node 공통 전역을 그대로 쓴다 */
export const systemTimers: InputTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => {
    clearInterval(handle as Parameters<typeof clearInterval>[0]);
  },
};

/**
 * 키 이벤트의 최소 형태. 실제 `KeyboardEvent`가 이 형태를 만족하므로 DOM 없이도
 * 같은 코드로 테스트할 수 있다 (§2.1 `e.code` 우선 · `e.key` 폴백).
 */
export interface KeyEventLike {
  code?: string;
  key: string;
  repeat?: boolean;
  preventDefault?: () => void;
}

/** window를 대체할 수 있는 최소 이벤트 타깃 (jsdom 없이 테스트하기 위한 주입 지점) */
export interface KeyEventTarget {
  addEventListener(type: string, listener: (event: KeyEventLike) => void): void;
  removeEventListener(type: string, listener: (event: KeyEventLike) => void): void;
}

// ── §2.1 개발 키보드 대응표 ────────────────────────────────────────────────

export interface KeyMap {
  [code: string]: PlayerAction;
}

/**
 * §2.1 표 1~9행. P1 `W/A/S/D` + `H`(BUTTON1 당기기) + `G`(BUTTON2 힌트) + `F1`,
 * P2 `Numpad 8/4/5/6` + `L`(BUTTON1) + `K`(BUTTON2) + `F2`, 공통 `F10`(코인)·`F9`(SERVICE).
 *
 * 버튼 좌우는 물리 배치를 따른다 — 우측 버튼이 확정·실행(BUTTON1), 좌측 버튼이 보조·취소
 * (BUTTON2)다 (§2.4). P2 개발 키도 같은 좌우 규칙으로 둔다.
 *
 * 10행 `RESERVED`는 `[2차]` 예약 슬롯이라 **어떤 물리 입력에도 연결하지 않는다** (§2.1).
 * `Esc`(앱 종료)도 **의도적으로 넣지 않는다.** 키오스크 탈출 경로를 두지 않으므로 종료는
 * 관리자 `SYSTEM ACTIONS`의 홀드 조작이 preload `quit()` 채널로만 수행한다 (§11.7).
 *
 * 개발 키 `F9`는 출시 빌드에서 비활성화하고 물리 SERVICE 키만 남긴다 (§2.1 · §17 [보류] #2).
 */
export const KEYMAP: KeyMap = {
  KeyW: { player: 1, action: 'UP' },
  KeyS: { player: 1, action: 'DOWN' },
  KeyA: { player: 1, action: 'LEFT' },
  KeyD: { player: 1, action: 'RIGHT' },
  KeyH: { player: 1, action: 'BUTTON1' },
  KeyG: { player: 1, action: 'BUTTON2' },
  F1: { player: 1, action: 'START' },
  Numpad8: { player: 2, action: 'UP' },
  Numpad5: { player: 2, action: 'DOWN' },
  Numpad4: { player: 2, action: 'LEFT' },
  Numpad6: { player: 2, action: 'RIGHT' },
  KeyL: { player: 2, action: 'BUTTON1' },
  KeyK: { player: 2, action: 'BUTTON2' },
  F2: { player: 2, action: 'START' },
  F10: { player: 1, action: 'COIN' },
  F9: { player: 1, action: 'SERVICE' },
};

/** `e.code`가 비어 있는 환경(가상 키보드·자동화) 대비 `e.key` 폴백 (§2.1) */
export const KEYMAP_BY_KEY: KeyMap = {
  w: { player: 1, action: 'UP' },
  s: { player: 1, action: 'DOWN' },
  a: { player: 1, action: 'LEFT' },
  d: { player: 1, action: 'RIGHT' },
  h: { player: 1, action: 'BUTTON1' },
  g: { player: 1, action: 'BUTTON2' },
  F1: { player: 1, action: 'START' },
  '8': { player: 2, action: 'UP' },
  '5': { player: 2, action: 'DOWN' },
  '4': { player: 2, action: 'LEFT' },
  '6': { player: 2, action: 'RIGHT' },
  l: { player: 2, action: 'BUTTON1' },
  k: { player: 2, action: 'BUTTON2' },
  F2: { player: 2, action: 'START' },
  F10: { player: 1, action: 'COIN' },
  F9: { player: 1, action: 'SERVICE' },
};

/** `e.code` 우선 조회, 비어 있으면 `e.key` 폴백. 표에 없는 키는 undefined다 (§2.1) */
export function lookup(e: KeyEventLike): PlayerAction | undefined {
  if (e.code) return KEYMAP[e.code];
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return KEYMAP_BY_KEY[key];
}

/** 반복·고착 판정을 키 단위로 묶기 위한 식별자 */
export function sourceIdOf(e: KeyEventLike): string {
  return e.code ? e.code : `key:${e.key}`;
}

// ── 순수 상태기계 ──────────────────────────────────────────────────────────

type ActionListener = (pa: PlayerAction) => void;
type AnyKeyListener = () => void;
type StatusListener = (status: InputStatus) => void;

interface RepeatTimers {
  delay?: TimerHandle;
  interval?: TimerHandle;
}

/**
 * DOM을 모르는 입력 상태기계.
 *
 * - 레버 4방향: 즉시 1회 → 250ms 후 → 100ms 간격 (§2.5)
 * - 버튼 2종·START: keydown 1회당 1발화, OS 키 리피트 무시 (§2.5)
 * - `releaseAll()`(창 blur)에서 모든 반복 타이머 즉시 해제 (§2.5)
 * - 3상태: connected / disconnected / stuck (§11.7)
 */
export class InputStateMachine {
  private actionListeners: ActionListener[] = [];
  private anyKeyListeners: AnyKeyListener[] = [];
  private statusListeners: StatusListener[] = [];
  private readonly repeats = new Map<string, RepeatTimers>();
  private readonly stuckTimers = new Map<string, TimerHandle>();
  private readonly stuckSources = new Set<string>();
  private connected = false;

  constructor(private readonly timers: InputTimers = systemTimers) {}

  get status(): InputStatus {
    if (!this.connected) return 'disconnected';
    return this.stuckSources.size > 0 ? 'stuck' : 'connected';
  }

  onAction(fn: ActionListener): () => void {
    this.actionListeners.push(fn);
    return () => {
      this.actionListeners = this.actionListeners.filter((f) => f !== fn);
    };
  }

  /** "아무 키" 시작 입력 — 코인·SERVICE·예약 슬롯은 제외된다 (§2.7) */
  onAnyKey(fn: AnyKeyListener): () => void {
    this.anyKeyListeners.push(fn);
    return () => {
      this.anyKeyListeners = this.anyKeyListeners.filter((f) => f !== fn);
    };
  }

  /** 어댑터 상태 변경 통지 (§18.5 · DIA-005 · MNT-001) */
  onStatusChange(fn: StatusListener): () => void {
    this.statusListeners.push(fn);
    return () => {
      this.statusListeners = this.statusListeners.filter((f) => f !== fn);
    };
  }

  /** 어댑터 연결/분리. connected ↔ disconnected 전이의 유일한 입구다 */
  setConnected(next: boolean): void {
    if (this.connected === next) return;
    const before = this.status;
    if (!next) this.clearAllTimers();
    this.connected = next;
    this.notifyStatus(before);
  }

  /**
   * 입력 누름. `pa`가 undefined면 표에 없는 키이며 어떤 액션도 만들지 않는다 (§13 G1).
   * `repeat`은 OS 키 리피트 표시로, 참이면 아무 것도 하지 않는다 (§2.3).
   */
  press(sourceId: string, pa: PlayerAction | undefined, repeat = false): void {
    if (!this.connected) return;
    if (repeat) return;

    if (!pa || !ANY_KEY_EXCLUDED.includes(pa.action)) {
      for (const fn of [...this.anyKeyListeners]) fn();
    }
    if (!pa) return;

    this.fire(pa);
    this.armStuck(sourceId);
    if (DIRECTIONS.includes(pa.action)) this.armRepeat(sourceId, pa);
  }

  /** 입력 뗌. 반복·고착 감시를 해제하고 필요하면 stuck → connected로 되돌린다 */
  release(sourceId: string): void {
    const before = this.status;
    this.clearRepeat(sourceId);
    this.clearStuck(sourceId);
    this.notifyStatus(before);
  }

  /** 창 포커스 상실(blur) — 모든 반복 타이머를 즉시 해제해 입력 고착을 막는다 (§2.3) */
  releaseAll(): void {
    const before = this.status;
    this.clearAllTimers();
    this.notifyStatus(before);
  }

  private fire(pa: PlayerAction): void {
    for (const fn of [...this.actionListeners]) fn(pa);
  }

  private armRepeat(sourceId: string, pa: PlayerAction): void {
    this.clearRepeat(sourceId);
    const delay = this.timers.setTimeout(() => {
      const interval = this.timers.setInterval(() => this.fire(pa), REPEAT_INTERVAL_MS);
      this.repeats.set(sourceId, { interval });
    }, REPEAT_DELAY_MS);
    this.repeats.set(sourceId, { delay });
  }

  private clearRepeat(sourceId: string): void {
    const t = this.repeats.get(sourceId);
    if (!t) return;
    if (t.delay !== undefined) this.timers.clearTimeout(t.delay);
    if (t.interval !== undefined) this.timers.clearInterval(t.interval);
    this.repeats.delete(sourceId);
  }

  private armStuck(sourceId: string): void {
    this.clearStuckTimer(sourceId);
    const handle = this.timers.setTimeout(() => {
      this.stuckTimers.delete(sourceId);
      const before = this.status;
      this.stuckSources.add(sourceId);
      this.notifyStatus(before);
    }, STUCK_HOLD_MS);
    this.stuckTimers.set(sourceId, handle);
  }

  private clearStuckTimer(sourceId: string): void {
    const handle = this.stuckTimers.get(sourceId);
    if (handle !== undefined) this.timers.clearTimeout(handle);
    this.stuckTimers.delete(sourceId);
  }

  private clearStuck(sourceId: string): void {
    this.clearStuckTimer(sourceId);
    this.stuckSources.delete(sourceId);
  }

  private clearAllTimers(): void {
    for (const sourceId of [...this.repeats.keys()]) this.clearRepeat(sourceId);
    for (const sourceId of [...this.stuckTimers.keys()]) this.clearStuckTimer(sourceId);
    this.stuckSources.clear();
  }

  private notifyStatus(before: InputStatus): void {
    const now = this.status;
    if (now === before) return;
    for (const fn of [...this.statusListeners]) fn(now);
  }
}

// ── 어댑터 계약과 키보드 구현 ──────────────────────────────────────────────

/**
 * 입력 어댑터 계약 (§18.5 · §13 G2).
 * 개발 빌드는 KeyboardInputAdapter를, 출시 빌드는 Serial 구현체를 등록한다.
 */
export interface InputAdapter {
  /** 어댑터 식별자 — 진단 화면 표시용 */
  readonly id: string;
  readonly status: InputStatus;
  attach(): void;
  detach(): void;
  onAction(fn: ActionListener): () => void;
  onAnyKey(fn: AnyKeyListener): () => void;
  onStatusChange(fn: StatusListener): () => void;
}

export interface KeyboardAdapterOptions {
  /** 기본값은 브라우저 window. 테스트는 가짜 타깃을 넣는다 */
  target?: KeyEventTarget;
  timers?: InputTimers;
}

/** 브라우저 window를 최소 이벤트 타깃으로 취급한다 (유일한 DOM 접점) */
function browserTarget(): KeyEventTarget {
  return window as unknown as KeyEventTarget;
}

export class KeyboardInputAdapter implements InputAdapter {
  readonly id = 'keyboard';
  private readonly core: InputStateMachine;
  private readonly target: KeyEventTarget | null;
  private boundTarget: KeyEventTarget | null = null;
  private attached = false;

  constructor(options: KeyboardAdapterOptions = {}) {
    this.core = new InputStateMachine(options.timers ?? systemTimers);
    this.target = options.target ?? null;
  }

  get status(): InputStatus {
    return this.core.status;
  }

  attach(): void {
    if (this.attached) return;
    const target = this.target ?? browserTarget();
    target.addEventListener('keydown', this.onDown);
    target.addEventListener('keyup', this.onUp);
    target.addEventListener('blur', this.onBlur);
    this.boundTarget = target;
    this.attached = true;
    this.core.setConnected(true);
  }

  detach(): void {
    if (!this.attached) return;
    const target = this.boundTarget;
    if (target) {
      target.removeEventListener('keydown', this.onDown);
      target.removeEventListener('keyup', this.onUp);
      target.removeEventListener('blur', this.onBlur);
    }
    this.boundTarget = null;
    this.attached = false;
    this.core.setConnected(false);
  }

  onAction(fn: ActionListener): () => void {
    return this.core.onAction(fn);
  }

  onAnyKey(fn: AnyKeyListener): () => void {
    return this.core.onAnyKey(fn);
  }

  onStatusChange(fn: StatusListener): () => void {
    return this.core.onStatusChange(fn);
  }

  private readonly onDown = (e: KeyEventLike): void => {
    const pa = lookup(e);
    if (pa) e.preventDefault?.();
    this.core.press(sourceIdOf(e), pa, e.repeat === true);
  };

  private readonly onUp = (e: KeyEventLike): void => {
    this.core.release(sourceIdOf(e));
  };

  private readonly onBlur = (): void => {
    this.core.releaseAll();
  };
}

/** 개발 빌드 기본 어댑터. 출시 빌드에서는 Serial 구현체로 교체한다 (§13 G2) */
export const keyboard = new KeyboardInputAdapter();
