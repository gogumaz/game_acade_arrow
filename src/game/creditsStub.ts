// 크레딧 최소 스텁 (§10.1~§10.4 — 착수 리포트 §3. **WU-04가 통째로 교체**한다)
//
// WU-03이 필요한 것은 "코인 적립 / 시작 차감 / 컨티뉴 차감 / 실패 시 원복" 4가지뿐이다.
// 그런데 §10.4 **혼합 결제 금지**는 나중에 얹으면 분기가 화면 흐름 전체에 퍼지므로 지금 넣는다.
// 이벤트 잔액은 1차 런에서 항상 0이지만 분기와 테스트를 미리 둔다.
//
// **하지 않는 것(WU-04)**: `credit_log.csv` 기록, 통계 10종, 날짜 롤오버, 크래시 복구, 코인 단가.

/** §10.3 유료 99 · 이벤트 5 — 고정값이며 설정 대상이 아니다 */
export const CREDIT_CAPS = { paid: 99, event: 5 } as const;

/** §10.1 N11a·N11b 공장 기본값 */
export const DEFAULT_COINS_PER_PLAY = 1;
export const DEFAULT_CONTINUE_COINS = 1;

export interface CreditBalance {
  readonly paid: number;
  readonly event: number;
}

/** 결제 소스. `'none'`은 결제 실패다 (§10.4 "둘 다 부족하면 결제하지 않고 거부음") */
export type ChargeSource = 'paid' | 'event' | 'none';

export interface CreditsPort {
  /** §10.1 N11a — 1회 시작 비용. 화면이 가격(`n CREDIT`)을 표시하는 유일한 근거다 (§8.4) */
  readonly coinsPerPlay: number;
  /** §10.1 N11b — 컨티뉴 비용 */
  readonly continueCoins: number;
  /** 상한 초과면 `false` — 화면은 거부 표시를 낸다 (§10.3 · CRD-602는 WU-04) */
  insertCoin(): boolean;
  balance(): CreditBalance;
  /** 크레딧이 `COINS PER PLAY` 이상인가 (§2.7 START 유효 조건) */
  canStart(): boolean;
  canContinue(): boolean;
  chargeStart(): ChargeSource;
  chargeContinue(): ChargeSource;
  /** §10.2 — 차감 후 게임 진입에 실패하면 원복한다. 사유 기록은 WU-04가 파일로 옮긴다 */
  refund(amount: number, source: ChargeSource, reason: string): void;
}

export interface RefundRecord {
  readonly amount: number;
  readonly source: ChargeSource;
  readonly reason: string;
}

export interface CreditsStub extends CreditsPort {
  /** §10.3 이벤트 크레딧은 **관리자 지급으로만** 늘어난다. 지급 UI는 WU-05, 통계는 WU-04 */
  grantEvent(n: number): number;
  /** 원복 이력 — WU-04가 `credit_log.csv` 행으로 옮긴다 */
  readonly refunds: readonly RefundRecord[];
}

export interface CreditsConfig {
  /** §10.1 N11a `COINS PER PLAY` */
  coinsPerPlay?: number;
  /** §10.1 N11b `CONTINUE COINS` */
  continueCoins?: number;
}

export function createCreditsStub(cfg: CreditsConfig = {}): CreditsStub {
  const coinsPerPlay = cfg.coinsPerPlay ?? DEFAULT_COINS_PER_PLAY;
  const continueCoins = cfg.continueCoins ?? DEFAULT_CONTINUE_COINS;
  let paid = 0;
  let event = 0;
  const refunds: RefundRecord[] = [];

  /**
   * §10.4 혼합 결제 금지 — EVENT만으로 전액을 낼 수 있으면 EVENT, 아니면 PAID 단독,
   * 둘 다 부족하면 실패다. **두 지갑을 섞어 쓰는 경로 자체를 만들지 않는다.**
   */
  const charge = (cost: number): ChargeSource => {
    if (event >= cost) {
      event -= cost;
      return 'event';
    }
    if (paid >= cost) {
      paid -= cost;
      return 'paid';
    }
    return 'none';
  };

  const affordable = (cost: number): boolean => event >= cost || paid >= cost;

  return {
    coinsPerPlay,
    continueCoins,
    insertCoin(): boolean {
      if (paid >= CREDIT_CAPS.paid) return false;
      paid += 1;
      return true;
    },
    balance(): CreditBalance {
      return { paid, event };
    },
    canStart(): boolean {
      return affordable(coinsPerPlay);
    },
    canContinue(): boolean {
      return affordable(continueCoins);
    },
    chargeStart(): ChargeSource {
      return charge(coinsPerPlay);
    },
    chargeContinue(): ChargeSource {
      return charge(continueCoins);
    },
    refund(amount: number, source: ChargeSource, reason: string): void {
      if (source === 'paid') paid = Math.min(paid + amount, CREDIT_CAPS.paid);
      else if (source === 'event') event = Math.min(event + amount, CREDIT_CAPS.event);
      refunds.push({ amount, source, reason });
    },
    grantEvent(n: number): number {
      const before = event;
      event = Math.min(event + n, CREDIT_CAPS.event);
      return event - before;
    },
    get refunds(): readonly RefundRecord[] {
      return refunds;
    },
  };
}
