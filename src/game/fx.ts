// WU-07 — 연출 계약·효과 예산·접근성 계측 (§8 · §9, EFX-801~809)
//
// Phaser와 분리된 순수 모듈이다. 렌더러는 이 계약만 읽고, 테스트는 실제 GPU 없이도
// 타이밍·대비·동시 효과 단순화·프레임/입력 지연 통계를 결정적으로 판정한다.

import type { MachineParams } from '../core/adminParams';

export const FX_TIMING = {
  focusMs: 60,
  immediateMaxMs: 100,
  bodyMaxMs: 500,
  boardWaveMs: 500,
  boardTransitionMs: 800,
  finaleMaxMs: 800,
  hintBreathMs: 1200,
  timePulseMs: 1000,
} as const;

/** §9.2 · EFX-807 — 7번째부터 비핵심 잔상·파동을 생략한다. */
export const MAX_FULL_EFFECTS = 6;

/** §9.4 · EFX-808 */
export const FULL_SCREEN_FLASH_MAX_HZ = 3;
export const LARGE_AREA_FLASH_MIN_INTERVAL_MS = 500;
export const LARGE_AREA_THRESHOLD = 0.25;

export type ChainVisualState = 'base' | 'focus' | 'blocked' | 'hint';
export type ColorVisionMode = 'protanopia' | 'deuteranopia' | 'tritanopia';
type EffectDetail = 'full' | 'simplified' | 'static';

/** 색을 빼도 남는 단서. 모든 상태가 3종 이상으로 구분된다(EFX-804). */
export const STATE_CUES: Readonly<Record<ChainVisualState, readonly string[]>> = {
  base: ['12px stroke', '2px outline', 'arrow marker'],
  focus: ['16.8px stroke', '2px outline', 'arrow marker', 'dashed route'],
  blocked: ['12px stroke', '2px outline', 'arrow marker', 'horizontal shake', 'blocker flash'],
  hint: ['12px stroke', 'wide outline', 'arrow marker', '1.2s breath'],
};

interface ActiveEffect {
  readonly id: string;
  readonly startedAtMs: number;
  readonly endsAtMs: number;
  readonly detail: EffectDetail;
}

/** 동시 효과와 MOTION REDUCE를 한 지점에서 판정한다. */
export class EffectBudget {
  private readonly active = new Map<string, ActiveEffect>();
  private motionReduce = false;

  configure(machine: Pick<MachineParams, 'motionReduce'>): void {
    this.motionReduce = machine.motionReduce;
  }

  start(id: string, nowMs: number, durationMs: number): ActiveEffect {
    this.prune(nowMs);
    const detail: EffectDetail = this.motionReduce
      ? 'static'
      : this.active.size >= MAX_FULL_EFFECTS
        ? 'simplified'
        : 'full';
    const effect = { id, startedAtMs: nowMs, endsAtMs: nowMs + Math.max(0, durationMs), detail };
    this.active.set(id, effect);
    return effect;
  }

  detailFor(id: string, nowMs: number): EffectDetail | null {
    this.prune(nowMs);
    return this.active.get(id)?.detail ?? null;
  }

  count(nowMs: number): number {
    this.prune(nowMs);
    return this.active.size;
  }

  clear(): void {
    this.active.clear();
  }

  private prune(nowMs: number): void {
    for (const [id, effect] of this.active) {
      if (nowMs >= effect.endsAtMs) this.active.delete(id);
    }
  }
}

interface PerformanceReport {
  readonly samples: number;
  readonly averageFps: number;
  readonly frameP95Ms: number;
  readonly inputSamples: number;
  readonly inputP95Ms: number;
  readonly simplified: boolean;
}

/** 최근 600프레임과 입력 240건만 보존하는 런타임 계측기. */
export class FxRuntime {
  private readonly frameMs: number[] = [];
  private readonly inputMs: number[] = [];
  private lastFrameAt: number | null = null;
  private pendingInputAt: number | null = null;
  private nextMotionReduce = false;
  private runMotionReduce = false;
  private runActive = false;

  configure(machine: Pick<MachineParams, 'motionReduce'>): void {
    this.nextMotionReduce = machine.motionReduce;
  }

  beginRun(): void {
    if (this.runActive) return;
    this.runActive = true;
    this.runMotionReduce = this.nextMotionReduce;
  }

  endRun(): void {
    this.runActive = false;
    this.pendingInputAt = null;
  }

  get motionReduced(): boolean {
    return this.runActive ? this.runMotionReduce : this.nextMotionReduce;
  }

  noteInput(nowMs: number): void {
    if (this.pendingInputAt === null) this.pendingInputAt = nowMs;
  }

  /** 다음 렌더 프레임에서 호출해 입력→화면 피드백 지연을 기록한다. */
  present(nowMs: number): void {
    if (this.pendingInputAt === null) return;
    pushLimited(this.inputMs, Math.max(0, nowMs - this.pendingInputAt), 240);
    this.pendingInputAt = null;
  }

  frame(nowMs: number): void {
    if (this.lastFrameAt !== null) {
      const elapsed = nowMs - this.lastFrameAt;
      if (elapsed > 0 && elapsed < 1000) pushLimited(this.frameMs, elapsed, 600);
    }
    this.lastFrameAt = nowMs;
  }

  report(): PerformanceReport {
    const frameAverage = average(this.frameMs);
    const frameP95Ms = percentile(this.frameMs, 0.95);
    const inputP95Ms = percentile(this.inputMs, 0.95);
    return {
      samples: this.frameMs.length,
      averageFps: frameAverage === 0 ? 0 : 1000 / frameAverage,
      frameP95Ms,
      inputSamples: this.inputMs.length,
      inputP95Ms,
      // 지속 프레임 저하에서는 잔상·파동을 선제 단순화한다. 18ms는 60Hz 한 프레임에 여유 1.33ms.
      simplified: this.frameMs.length >= 60 && frameP95Ms > 18,
    };
  }
}

export function contrastRatio(foreground: number, background: number): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

function relativeLuminance(color: number): number {
  const r = channel((color >> 16) & 0xff);
  const g = channel((color >> 8) & 0xff);
  const b = channel(color & 0xff);
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

/** 계측 증거에 쓰는 단순 색각 시뮬레이션 행렬. 색 외 단서 판정이 최종 권위다. */
export function simulateColorVision(color: number, mode: ColorVisionMode): number {
  const rgb = [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255];
  const matrix = COLOR_VISION_MATRIX[mode];
  const out = matrix.map((row) => clamp01(row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]));
  return (
    (Math.round(out[0] * 255) << 16) | (Math.round(out[1] * 255) << 8) | Math.round(out[2] * 255)
  );
}

const COLOR_VISION_MATRIX: Readonly<Record<ColorVisionMode, readonly (readonly number[])[]>> = {
  protanopia: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758],
  ],
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525],
  ],
};

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function pushLimited(values: number[], value: number, limit: number): void {
  values.push(value);
  if (values.length > limit) values.splice(0, values.length - limit);
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}
