// 힌트 (§7.1 · §7.2 — 작업 계획 §6)
//
// **감점 자체는 코어(`settleBoard`) 소관**이다. 이 모듈이 하는 일은 대상 선정·표시 수명·쿨다운
// 뿐이며, 소비가 성립한 순간 호출자가 `session.noteHintUsed()`를 **정확히 1회** 부른다.
// 힌트는 포커스를 옮기지 않고(HNT-505) 사슬을 대신 제거하지 않는다(§7.1 금지).

import type { ChainId } from '../core/types';
import { HINT_COOLDOWN_MS, HINT_DISPLAY_MS } from './timing';

export type HintState = 'READY' | 'SHOWING' | 'COOLDOWN';

export type HintRejection = 'LOCKED' | 'ALREADY_SHOWING' | 'COOLDOWN' | 'NO_SAFE_MOVE';

export interface HintView {
  readonly state: HintState;
  /** `SHOWING`일 때만 값이 있다 */
  readonly targetId: ChainId | null;
  readonly cooldownLeftMs: number;
}

export interface HintContext {
  /** 코어가 **깊이 오름차순 → id 오름차순**으로 준 안전수 (`RunSession.hintOrderedSafeMoves`) */
  readonly candidates: readonly ChainId[];
  /** 판정 잠금 중이면 입력을 버린다 — 쿨다운도 소비하지 않는다 (§2.6) */
  readonly locked: boolean;
  depthOf(id: ChainId): number;
  /** 포커스에서 그 사슬까지의 **레버 조작 수** (작업 계획 Q-3). 포커스가 없으면 전부 같은 값 */
  distanceTo(id: ChainId): number;
}

export interface HintRequestResult {
  readonly used: boolean;
  readonly targetId?: ChainId;
  readonly rejection?: HintRejection;
}

/**
 * §7.1 선택 기준 — **의존 깊이 최소** → 동률이면 **포커스에서 가장 가까운** → 그래도 동률이면 **id 최소**.
 * "가장 가까운"은 격자 거리가 아니라 실제로 플레이어가 지불하는 **레버 조작 수**다 (Q-3).
 */
export function pickHintTarget(ctx: HintContext): ChainId | null {
  if (ctx.candidates.length === 0) return null;
  let best: ChainId | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const id of ctx.candidates) {
    const depth = ctx.depthOf(id);
    if (depth > bestDepth) continue;
    const distance = ctx.distanceTo(id);
    if (best === null || depth < bestDepth || distance < bestDistance) {
      best = id;
      bestDepth = depth;
      bestDistance = distance;
    }
    // 깊이·거리가 모두 동률이면 먼저 온 쪽(= 코어가 준 id 오름차순의 앞)이 남는다
  }
  return best;
}

export interface HintOptions {
  displayMs?: number;
  cooldownMs?: number;
}

export class HintController {
  private readonly displayMs: number;
  private readonly cooldownMs: number;
  private targetId: ChainId | null = null;
  private displayUntilMs = 0;
  private cooldownUntilMs = 0;
  private uses = 0;

  constructor(opts: HintOptions = {}) {
    this.displayMs = opts.displayMs ?? HINT_DISPLAY_MS;
    this.cooldownMs = opts.cooldownMs ?? HINT_COOLDOWN_MS;
  }

  /** 소비가 성립하면 `used: true` — 호출자는 그때만 `noteHintUsed()`를 1회 부른다 */
  request(now: number, ctx: HintContext): HintRequestResult {
    if (ctx.locked) return { used: false, rejection: 'LOCKED' };
    const state = this.stateAt(now);
    if (state === 'SHOWING') return { used: false, rejection: 'ALREADY_SHOWING' };
    if (state === 'COOLDOWN') return { used: false, rejection: 'COOLDOWN' };

    const target = pickHintTarget(ctx);
    if (target === null) return { used: false, rejection: 'NO_SAFE_MOVE' };

    this.targetId = target;
    this.displayUntilMs = now + this.displayMs;
    // 쿨다운은 **소비 시점 기준**이다 (§7.2 N5d = 표시 2.5초 + 자력 판단 2.5초)
    this.cooldownUntilMs = now + this.cooldownMs;
    this.uses += 1;
    return { used: true, targetId: target };
  }

  /** 표시 만료 · 대상 제거 시 즉시 해제 (HNT-502) */
  tick(now: number, aliveIds: ReadonlySet<ChainId>): void {
    if (this.targetId === null) return;
    if (now >= this.displayUntilMs || !aliveIds.has(this.targetId)) {
      this.targetId = null;
      this.displayUntilMs = 0;
    }
  }

  view(now: number): HintView {
    const state = this.stateAt(now);
    return {
      state,
      targetId: state === 'SHOWING' ? this.targetId : null,
      cooldownLeftMs: Math.max(0, this.cooldownUntilMs - now),
    };
  }

  /** 이번 컨트롤러가 성립시킨 소비 횟수 — `noteHintUsed()` 호출 수와 같아야 한다 (HNT-503) */
  get useCount(): number {
    return this.uses;
  }

  /** 보드 전환·런 시작 — 표시와 쿨다운을 함께 비운다 */
  reset(): void {
    this.targetId = null;
    this.displayUntilMs = 0;
    this.cooldownUntilMs = 0;
  }

  private stateAt(now: number): HintState {
    if (this.targetId !== null && now < this.displayUntilMs) return 'SHOWING';
    if (now < this.cooldownUntilMs) return 'COOLDOWN';
    return 'READY';
  }
}
