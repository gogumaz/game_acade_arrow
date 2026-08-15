// WU-02 T5 — 점수 · 콤보 · 힌트 계수 · 클리어 정산 (§5.1~§5.4 · §7.2)
//
// 인수 항목: SCR-301 · SCR-302 · SCR-303 · SCR-304(콤보분) · SCR-305 · SCR-306 · SCR-307

import { describe, expect, it } from 'vitest';
import { createChain } from '../../src/core/chain';
import { resolveParams } from '../../src/core/params';
import {
  ComboTracker,
  awardedScore,
  chainBaseScore,
  hintMultiplierPercent,
  settleBoard,
  type BoardSettlement,
  type SettlementInput,
} from '../../src/core/score';
import type { Chain } from '../../src/core/types';
import { FIXTURE_0110, FIXTURE_DEPTH_CHAIN, chainsOf, pt } from './fixtures';

const P = resolveParams();

/** L·B·D를 임의로 지정한 합성 사슬 — 점수 공식 표본용 (배치 유효성과 무관) */
function synthetic(length: number, bends: number, depth: number): Chain {
  return { id: 1, points: [pt(0, 0), pt(1, 0)], length, bends, depth };
}

describe('SCR-301 §5.1 기본점 공식', () => {
  it('기본점 = 100 + 20 × max(L−3, 0) + 40 × B + 60 × D', () => {
    expect(chainBaseScore(synthetic(3, 0, 0), P)).toBe(100);
    expect(chainBaseScore(synthetic(5, 1, 1), P)).toBe(240); // 100 + 40 + 40 + 60
    expect(chainBaseScore(synthetic(8, 3, 4), P)).toBe(560); // 100 + 100 + 120 + 240
  });

  it('L·B·D 조합 격자 100건에서 공식과 정확히 일치한다', () => {
    let samples = 0;
    for (let l = 2; l <= 11; l += 1) {
      for (let b = 0; b <= 4; b += 1) {
        for (let d = 0; d <= 1; d += 1) {
          const expected = 100 + 20 * Math.max(l - 3, 0) + 40 * b + 60 * d;
          expect(chainBaseScore(synthetic(l, b, d), P)).toBe(expected);
          samples += 1;
        }
      }
    }
    expect(samples).toBe(100);
  });

  it('의존 깊이 항이 가장 큰 계수를 갖는다 (논리 난이도의 주축)', () => {
    expect(P.scoreDepthCoef).toBeGreaterThan(P.scoreBendCoef);
    expect(P.scoreBendCoef).toBeGreaterThan(P.scoreLengthCoef);
  });

  it('픽스처 사슬의 기본점이 계획 표와 같다', () => {
    expect(chainsOf(FIXTURE_0110).map((c) => chainBaseScore(c, P))).toEqual([240, 100]);
    expect(chainsOf(FIXTURE_DEPTH_CHAIN).map((c) => chainBaseScore(c, P))).toEqual([
      120, 160, 220, 280,
    ]);
  });

  it('계수를 바꾸면 그대로 반영된다 (전부 [운영 설정])', () => {
    const custom = resolveParams({ scoreBase: 50, scoreLengthCoef: 0, scoreDepthCoef: 150 });
    expect(chainBaseScore(synthetic(9, 2, 3), custom)).toBe(50 + 0 + 80 + 450);
  });
});

describe('SCR-302 §5.1 길이 하한 처리', () => {
  it('L < 3에서 길이 항이 0이고 음수 점수가 나오지 않는다', () => {
    expect(chainBaseScore(synthetic(2, 0, 0), P)).toBe(100);
    expect(chainBaseScore(synthetic(1, 0, 0), P)).toBe(100);
    expect(chainBaseScore(synthetic(0, 0, 0), P)).toBe(100);
  });

  it('실제 보드 케이스 — FIXTURE_DEPTH_CHAIN의 L=2 사슬 C2·C3', () => {
    const [, , c2, c3] = chainsOf(FIXTURE_DEPTH_CHAIN);
    expect(c2.length).toBe(2);
    expect(c3.length).toBe(2);
    expect(chainBaseScore(c2, P)).toBe(220); // 100 + 0 + 0 + 120
    expect(chainBaseScore(c3, P)).toBe(280); // 100 + 0 + 0 + 180
  });

  it('L = 3이 길이 가산의 시작점이다', () => {
    expect(chainBaseScore(synthetic(3, 0, 0), P)).toBe(100);
    expect(chainBaseScore(synthetic(4, 0, 0), P)).toBe(120);
  });
});

describe('§5.1 획득점 = floor(기본점 × 콤보 배율)', () => {
  it('배율 1.00에서는 기본점 그대로다', () => {
    expect(awardedScore(240, 100)).toBe(240);
  });

  it('소수점은 버린다', () => {
    expect(awardedScore(100, 115)).toBe(115);
    expect(awardedScore(101, 115)).toBe(116); // 116.15 → 116
    expect(awardedScore(333, 115)).toBe(382); // 382.95 → 382
  });

  it('상한 배율 2.50에서도 정수다', () => {
    expect(awardedScore(240, 250)).toBe(600);
    expect(awardedScore(101, 250)).toBe(252); // 252.5 → 252
  });
});

describe('SCR-303 · SCR-304 §5.2 콤보', () => {
  it('첫 성공은 ×1.00이다', () => {
    const combo = new ComboTracker(P);
    expect(combo.centis).toBe(100);
    expect(combo.onSuccess(0)).toBe(100);
  });

  it('창 안(2.2초 이내) 연속 성공에서 +0.15씩 오른다', () => {
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(200);
    expect(combo.onSuccess(1000)).toBe(115);
    combo.markRemovalCompleted(1200);
    expect(combo.onSuccess(2000)).toBe(130);
  });

  it('11회 연속 성공에서 상한 2.50에 도달하고 더 오르지 않는다', () => {
    const combo = new ComboTracker(P);
    const seen: number[] = [];
    let t = 0;
    for (let i = 0; i < 14; i += 1) {
      seen.push(combo.onSuccess(t));
      combo.markRemovalCompleted(t + 100);
      t += 1000;
    }
    expect(seen.slice(0, 11)).toEqual([100, 115, 130, 145, 160, 175, 190, 205, 220, 235, 250]);
    expect(seen.slice(11)).toEqual([250, 250, 250]);
    expect(combo.maxCentis).toBe(250);
  });

  it('창 경계 2200ms는 포함, 2201ms는 초과다', () => {
    const inside = new ComboTracker(P);
    inside.onSuccess(0);
    inside.markRemovalCompleted(0);
    expect(inside.onSuccess(2200)).toBe(115);

    const outside = new ComboTracker(P);
    outside.onSuccess(0);
    outside.markRemovalCompleted(0);
    expect(outside.onSuccess(2201)).toBe(100);
  });

  it('SCR-304 — 2.2초를 초과하면 1.00으로 리셋된다', () => {
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(0);
    combo.onSuccess(1000);
    combo.markRemovalCompleted(1000);
    expect(combo.centis).toBe(115);
    expect(combo.onSuccess(5000)).toBe(100);
  });

  it('SCR-304 — 실패는 즉시 1.00으로 리셋한다 (§3.5)', () => {
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(0);
    combo.onSuccess(500);
    expect(combo.centis).toBe(115);
    combo.onFailure();
    expect(combo.centis).toBe(100);
  });

  it('SCR-304 — 컨티뉴도 1.00으로 초기화한다 (§4.5)', () => {
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(0);
    combo.onSuccess(500);
    combo.onContinue();
    expect(combo.centis).toBe(100);
  });

  it('실패·컨티뉴 후 곧바로 성공해도 기준 시각이 없어 ×1.00에서 다시 시작한다', () => {
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(0);
    combo.onFailure();
    expect(combo.onSuccess(10)).toBe(100);
  });

  it('판정 기준 시각은 직전 성공의 제거 완료 시각이다 — 긴 사슬이 불리해지지 않는다', () => {
    // 입력 시각 기준이면 창을 벗어나지만, 완료 시각 기준이면 창 안이다
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(700); // 슬라이드 아웃 0.7초
    expect(combo.onSuccess(2500)).toBe(115);
  });

  it('maxCentis는 런 최고 콤보를 기억한다 (§5.7 랭킹용)', () => {
    const combo = new ComboTracker(P);
    combo.onSuccess(0);
    combo.markRemovalCompleted(0);
    combo.onSuccess(100);
    combo.markRemovalCompleted(100);
    combo.onSuccess(200);
    expect(combo.centis).toBe(130);
    combo.onFailure();
    expect(combo.centis).toBe(100);
    expect(combo.maxCentis).toBe(130);
  });

  it('콤보는 정수 centis로만 계산돼 부동소수 드리프트가 없다', () => {
    const combo = new ComboTracker(P);
    let t = 0;
    for (let i = 0; i < 8; i += 1) {
      const value = combo.onSuccess(t);
      expect(Number.isInteger(value)).toBe(true);
      combo.markRemovalCompleted(t);
      t += 100;
    }
    expect(combo.centis).toBe(205); // 1.0 + 0.15 × 7 — 부동소수라면 2.0499999…
  });

  it('창·증분·상한은 전부 [운영 설정]이다', () => {
    const custom = resolveParams({ comboWindowSec: 1, comboStep: 0.5, comboCap: 2 });
    const combo = new ComboTracker(custom);
    combo.onSuccess(0);
    combo.markRemovalCompleted(0);
    expect(combo.onSuccess(1000)).toBe(150);
    combo.markRemovalCompleted(1000);
    expect(combo.onSuccess(2000)).toBe(200); // 상한 2.0
    combo.markRemovalCompleted(2000);
    expect(combo.onSuccess(3001)).toBe(100); // 창 1.0초 초과
  });
});

describe('SCR-305 §7.2 힌트 계수 — 횟수당 누적 max(1 − 0.2n, 0.4)', () => {
  it('0회는 감점이 없다', () => {
    expect(hintMultiplierPercent(0, P)).toBe(100);
  });

  it('1회 ×0.8 · 2회 ×0.6 · 3회 이상 ×0.4', () => {
    expect(hintMultiplierPercent(1, P)).toBe(80);
    expect(hintMultiplierPercent(2, P)).toBe(60);
    expect(hintMultiplierPercent(3, P)).toBe(40);
  });

  it('보드당 누적 상한 −60%에서 멈춘다 (하한 ×0.4)', () => {
    for (const uses of [4, 5, 10, 100]) {
      expect(hintMultiplierPercent(uses, P)).toBe(40);
    }
  });

  it('정산 1회당 계수 곱셈은 정확히 한 번이다 (§5.3·SCR-305의 "한 번만")', () => {
    const input: SettlementInput = {
      chainScoreSum: 1000,
      timeRemainingMs: 0,
      hearts: 0,
      mistakes: 1,
      hintUses: 1,
    };
    const settlement = settleBoard(input, P);
    expect(settlement.hintPercent).toBe(80);
    expect(settlement.adjustedChainScore).toBe(800); // 1000 × 0.8 — 0.64가 아니다
    expect(settlement.boardFinal).toBe(800);
  });

  it('클리어 보너스에는 적용되지 않는다 (§5.3 · SCR-305)', () => {
    const input: SettlementInput = {
      chainScoreSum: 1000,
      timeRemainingMs: 60000,
      hearts: 2,
      mistakes: 1,
      hintUses: 2,
    };
    const settlement = settleBoard(input, P);
    expect(settlement.adjustedChainScore).toBe(600); // 1000 × 0.6
    expect(settlement.clearTimeBonus).toBe(6000); // 감점 없음
    expect(settlement.clearHeartBonus).toBe(3000); // 감점 없음
    expect(settlement.boardFinal).toBe(9600);
  });

  it('감점률·상한은 [운영 설정]이다', () => {
    const custom = resolveParams({ hintScorePenaltyPercent: -50, hintPenaltyCapPercent: -100 });
    expect(hintMultiplierPercent(1, custom)).toBe(50);
    expect(hintMultiplierPercent(2, custom)).toBe(0);
    expect(hintMultiplierPercent(3, custom)).toBe(0); // 하한 없음
  });

  it('감점 0% 설정이면 언제나 100이다', () => {
    const custom = resolveParams({ hintScorePenaltyPercent: 0 });
    expect(hintMultiplierPercent(5, custom)).toBe(100);
  });
});

describe('SCR-306 · SCR-307 §5.4 보드 클리어 정산', () => {
  const base: SettlementInput = {
    chainScoreSum: 2000,
    timeRemainingMs: 47500,
    hearts: 3,
    mistakes: 0,
    hintUses: 0,
  };

  it('클리어 정산 = floor(남은 초) × 100 + 남은 하트 × 1,500', () => {
    const settlement: BoardSettlement = settleBoard(base, P);
    expect(settlement.clearTimeBonus).toBe(4700); // floor(47.5) = 47 → 4,700
    expect(settlement.clearHeartBonus).toBe(4500); // 3 × 1,500
  });

  it('남은 시간은 초 단위로 버림한다', () => {
    expect(settleBoard({ ...base, timeRemainingMs: 999 }, P).clearTimeBonus).toBe(0);
    expect(settleBoard({ ...base, timeRemainingMs: 1000 }, P).clearTimeBonus).toBe(100);
    expect(settleBoard({ ...base, timeRemainingMs: 1999 }, P).clearTimeBonus).toBe(100);
  });

  it('하트 0이면 하트 보너스가 0이다', () => {
    expect(settleBoard({ ...base, hearts: 0 }, P).clearHeartBonus).toBe(0);
  });

  it('SCR-307 — 오입력 0 AND 힌트 0에서만 퍼펙트 5,000점이 붙는다', () => {
    expect(settleBoard(base, P).perfectBonus).toBe(5000);
    expect(settleBoard({ ...base, mistakes: 1 }, P).perfectBonus).toBe(0);
    expect(settleBoard({ ...base, hintUses: 1 }, P).perfectBonus).toBe(0);
    expect(settleBoard({ ...base, mistakes: 2, hintUses: 3 }, P).perfectBonus).toBe(0);
  });

  it('보드 최종 = 조정 사슬 점수 + 시간 + 하트 + 퍼펙트', () => {
    const settlement = settleBoard(base, P);
    expect(settlement.chainScoreSum).toBe(2000);
    expect(settlement.adjustedChainScore).toBe(2000);
    expect(settlement.hintPercent).toBe(100);
    expect(settlement.boardFinal).toBe(2000 + 4700 + 4500 + 5000);
    expect(settlement.boardFinal).toBe(16200);
  });

  it('힌트를 쓴 보드는 퍼펙트가 무효라 계수 적용 위치가 결과를 바꾸지 않는다', () => {
    const settlement = settleBoard({ ...base, hintUses: 1 }, P);
    expect(settlement.perfectBonus).toBe(0);
    expect(settlement.boardFinal).toBe(1600 + 4700 + 4500);
  });

  it('사슬 점수 0인 보드도 정산이 성립한다', () => {
    const settlement = settleBoard({ ...base, chainScoreSum: 0 }, P);
    expect(settlement.adjustedChainScore).toBe(0);
    expect(settlement.boardFinal).toBe(4700 + 4500 + 5000);
  });

  it('정산 결과는 전부 정수다', () => {
    const settlement = settleBoard({ ...base, chainScoreSum: 3333, hintUses: 1 }, P);
    for (const value of Object.values(settlement)) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(settlement.adjustedChainScore).toBe(2666); // floor(3333 × 0.8) = 2666
  });

  it('클리어 계수·퍼펙트는 [운영 설정]이다', () => {
    const custom = resolveParams({ clearTimeCoef: 0, clearHeartCoef: 0, perfectBonus: 0 });
    const settlement = settleBoard(base, custom);
    expect(settlement.clearTimeBonus).toBe(0);
    expect(settlement.clearHeartBonus).toBe(0);
    expect(settlement.perfectBonus).toBe(0);
    expect(settlement.boardFinal).toBe(2000);
  });

  it('실제 픽스처 조합 — FIXTURE_0110 두 사슬을 무실수·무힌트로 정산', () => {
    const [a, b] = chainsOf(FIXTURE_0110);
    const chainScoreSum = chainBaseScore(b, P) + chainBaseScore(a, P);
    expect(chainScoreSum).toBe(340);
    const settlement = settleBoard(
      { chainScoreSum, timeRemainingMs: 120000, hearts: 3, mistakes: 0, hintUses: 0 },
      P
    );
    expect(settlement.boardFinal).toBe(340 + 12000 + 4500 + 5000);
  });

  it('합성 사슬로 만든 점수도 같은 식을 탄다 (createChain 경로 회귀)', () => {
    const chain = createChain(1, [pt(5, 0), pt(5, 1), pt(5, 2), pt(5, 3)], 0);
    expect(chainBaseScore(chain, P)).toBe(120);
  });
});
