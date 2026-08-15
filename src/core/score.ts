// 점수 · 콤보 · 힌트 계수 · 보드 클리어 정산 (§5.1~§5.4 · §7.2)
//
// 전부 **정수 산술**이다 (작업 계획 P-4). 콤보 배율은 1/100 정수(centis), 힌트 계수는 정수
// 퍼센트, 점수는 정수다. 부동소수 누적(`1.0 + 0.15 × 7 = 2.0499999…`)으로 점수가 1점 흔들리는
// 경로를 원천 차단해 §6.6 재현성(SCR-312)을 지킨다.

import type { ResolvedParams } from './params';
import type { Chain } from './types';

/**
 * §5.1 기본점 = `100 + 20 × max(L−3, 0) + 40 × B + 60 × D`.
 *
 * `D`는 **생성 확정 의존 깊이**(`chain.depth`)다. 제거 시점에 다시 계산하지 않아야 같은 시드에서
 * 점수가 완전히 재현된다 (§5.1).
 */
export function chainBaseScore(chain: Chain, p: ResolvedParams): number {
  return (
    p.scoreBase +
    p.scoreLengthCoef * Math.max(chain.length - 3, 0) +
    p.scoreBendCoef * chain.bends +
    p.scoreDepthCoef * chain.depth
  );
}

/** §5.1 획득점 = `floor(기본점 × 콤보 배율)`. `comboCentis` 100 = ×1.00 */
export function awardedScore(base: number, comboCentis: number): number {
  return Math.floor((base * comboCentis) / 100);
}

/**
 * §5.2 콤보 — 직전 성공의 **제거 완료 시각**(§3.7 ⑥) 기준으로 창을 판정한다.
 * 애니메이션이 긴 사슬이 불리해지지 않게 하는 규칙이므로 기준 시각을 ⑤가 아니라 ⑥에서 받는다.
 */
export class ComboTracker {
  private readonly params: ResolvedParams;
  private current = 100;
  private best = 100;
  private lastCompletedAtMs: number | null = null;

  constructor(p: ResolvedParams) {
    this.params = p;
  }

  /** 현재 배율 (1/100 단위) */
  get centis(): number {
    return this.current;
  }

  /** 런 최고 콤보 (§5.7 랭킹용) */
  get maxCentis(): number {
    return this.best;
  }

  /**
   * ⑤ 성공 반영 — 창 안이면 증분(상한 적용), 아니면 100으로 복귀한다.
   * 첫 성공은 기준 시각이 없으므로 ×1.00이다.
   */
  onSuccess(atMs: number): number {
    const last = this.lastCompletedAtMs;
    if (last !== null && atMs - last <= this.params.comboWindowMs) {
      this.current = Math.min(
        this.current + this.params.comboStepCentis,
        this.params.comboCapCentis
      );
    } else {
      this.current = 100;
    }
    if (this.current > this.best) this.best = this.current;
    return this.current;
  }

  /** ⑥ 제거 완료 — 다음 성공의 창 판정 기준 시각을 갱신한다 */
  markRemovalCompleted(atMs: number): void {
    this.lastCompletedAtMs = atMs;
  }

  /** §3.5 실패 — 즉시 1.0 복귀 */
  onFailure(): void {
    this.current = 100;
    this.lastCompletedAtMs = null;
  }

  /** §4.5 컨티뉴 — 끊긴 흐름을 돈으로 되사지 못하게 1.0 초기화 */
  onContinue(): void {
    this.current = 100;
    this.lastCompletedAtMs = null;
  }
}

/**
 * §7.2 힌트 계수 — **횟수당 누적** `max(1 − 0.2n, 0.4)`를 정수 퍼센트로 계산한다
 * (1회 80 · 2회 60 · 3회 이상 40). 0회는 100이다.
 *
 * §5.3·SCR-305의 "한 번만"은 "정산 1회당 계수 곱셈이 1번"이라는 뜻이며, 감점 크기 자체는
 * §7.2 N5a·N5a′의 누적 규정(2026-08-15 최종 승인 결정)을 따른다 (작업 계획 Q-1).
 */
export function hintMultiplierPercent(uses: number, p: ResolvedParams): number {
  if (uses <= 0) return 100;
  const raw = 100 + p.hintScorePenaltyPercent * uses;
  const floorPercent = 100 + p.hintPenaltyCapPercent;
  return Math.max(raw, floorPercent);
}

export interface SettlementInput {
  /** 그 보드에서 얻은 사슬 점수 합 (감점 전) */
  readonly chainScoreSum: number;
  /** 정산 시점의 런 타이머 잔여 시간 */
  readonly timeRemainingMs: number;
  /** 정산 시점의 하트 수 */
  readonly hearts: number;
  /** 그 보드의 오입력 수 */
  readonly mistakes: number;
  /** 그 보드의 힌트 사용 횟수 */
  readonly hintUses: number;
}

export interface BoardSettlement {
  readonly chainScoreSum: number;
  /** 힌트 계수를 곱한 뒤의 사슬 점수 — 계수 곱셈은 정산당 **정확히 1회**다 */
  readonly adjustedChainScore: number;
  readonly clearTimeBonus: number;
  readonly clearHeartBonus: number;
  readonly perfectBonus: number;
  /** 100 = 감점 없음 */
  readonly hintPercent: number;
  readonly boardFinal: number;
}

/**
 * §5.4 보드 클리어 정산.
 *
 * ```text
 * 클리어 시간 보너스 = floor(잔여 ms / 1000) × 클리어 시간 계수
 * 클리어 하트 보너스 = 남은 하트 × 클리어 하트 계수
 * 퍼펙트          = 오입력 0 AND 힌트 0 이면 퍼펙트 보너스, 아니면 0
 * 보드 최종        = floor(사슬 점수 합 × 힌트 계수 / 100) + 시간 보너스 + 하트 보너스 + 퍼펙트
 * ```
 *
 * **힌트 계수는 사슬 점수 합에만 곱한다.** §5.3 "클리어 정산의 시간·하트 보너스는 감점 대상이
 * 아니다" · §7.2 "그 보드의 사슬 점수 합에 한 번 곱한다" · SCR-305 "클리어 보너스에는 적용되지
 * 않는다"가 모두 같은 규정이다. 퍼펙트는 힌트를 쓴 보드에서 정의상 0이라 위치가 결과를 바꾸지 않는다.
 */
export function settleBoard(input: SettlementInput, p: ResolvedParams): BoardSettlement {
  const hintPercent = hintMultiplierPercent(input.hintUses, p);
  const adjustedChainScore = Math.floor((input.chainScoreSum * hintPercent) / 100);
  const clearTimeBonus = Math.floor(input.timeRemainingMs / 1000) * p.clearTimeCoef;
  const clearHeartBonus = input.hearts * p.clearHeartCoef;
  const perfectBonus = input.mistakes === 0 && input.hintUses === 0 ? p.perfectBonus : 0;
  return {
    chainScoreSum: input.chainScoreSum,
    adjustedChainScore,
    clearTimeBonus,
    clearHeartBonus,
    perfectBonus,
    hintPercent,
    boardFinal: adjustedChainScore + clearTimeBonus + clearHeartBonus + perfectBonus,
  };
}
