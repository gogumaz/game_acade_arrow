// 순수 크레딧 지갑 (§10.1~§10.4 · §10.6 — 작업 계획 §3.1)
//
// **시계·파일·화면을 모른다.** `credit_log.csv` 기록·통계 귀속·감사 로그는 전부
// `src/game/creditsService.ts`가 갖는다 (작업 계획 P-1). 덕분에 상한·혼합 결제 금지 같은
// 돈 규칙을 IO 없이 단위 판정할 수 있다.
//
// 이 모듈이 지키는 불변식은 3가지다.
//   INV-1  어떤 호출로도 `paid ≤ 99` · `event ≤ 5` · 둘 다 `≥ 0`
//   INV-2  원장: 지급 합(코인+서비스+원복) − 사용 합 = 잔액 (상한에서 삼킨 분은 `applied`가 0)
//   INV-3  `charge()`는 한 번에 **한 지갑만** 건드린다 (§10.4 혼합 결제 금지)

/** §10.3 — 유료 99 · 이벤트 5. 고정값이며 설정 대상이 아니다 */
export const CREDIT_CAPS = { paid: 99, event: 5 } as const;

/** §10.1 N11a 공장 기본값 */
export const DEFAULT_COINS_PER_PLAY = 1;
/** §10.1 N11b 공장 기본값 */
export const DEFAULT_CONTINUE_COINS = 1;

export interface CreditBalance {
  readonly paid: number;
  readonly event: number;
}

/**
 * 결제 소스.
 * - `'none'` = 결제 실패 (§10.4 "둘 다 부족하면 결제하지 않고 거부음")
 * - `'free'` = 관리자 테스트 플레이 (§11.6 "크레딧 없이 런을 실행" — 작업 계획 P-6)
 */
export type ChargeSource = 'paid' | 'event' | 'none' | 'free';

/** 실제로 크레딧이 오가는 두 지갑. `charge()`의 성공 소스는 항상 이 둘 중 하나다 */
export type WalletSource = 'paid' | 'event';

/** 지갑이 늘어난 사유 — 미터 귀속을 결정한다 (작업 계획 P-7 · P-8) */
export type GrantKind = 'coin' | 'event' | 'service' | 'refund';

export interface GrantResult {
  /** 상한 초과로 1도 못 넣었으면 false — 화면은 거부 표시를 낸다 (§10.3 · CRD-602) */
  readonly accepted: boolean;
  /** 상한 클램프 후 **실제로 들어간 양** — 미터는 이 값만 센다 (P-7) */
  readonly applied: number;
  readonly balance: CreditBalance;
}

export interface ChargeResult {
  readonly source: WalletSource | 'none';
  /** 실제 차감량. `source === 'none'`이면 0 */
  readonly amount: number;
  readonly balance: CreditBalance;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** 어느 지갑에 얼마를 넣을 수 있는가 — 상한이 삼킨 몫은 `applied`에서 빠진다 */
function grantableAmount(current: number, add: number, cap: number): number {
  const want = Math.trunc(Number.isFinite(add) ? add : 0);
  if (want <= 0) return 0;
  return Math.max(0, Math.min(want, cap - current));
}

export class CreditWallet {
  private paidBalance: number;
  private eventBalance: number;
  /** 잔액을 바꾼 호출이 한 번이라도 있었는가 — 부팅 복원 경합 방지 (P-9) */
  private touched = false;

  constructor(init: Partial<CreditBalance> = {}) {
    this.paidBalance = clampInt(init.paid ?? 0, 0, CREDIT_CAPS.paid);
    this.eventBalance = clampInt(init.event ?? 0, 0, CREDIT_CAPS.event);
  }

  get balance(): CreditBalance {
    return { paid: this.paidBalance, event: this.eventBalance };
  }

  /** 지갑이 한 번도 변하지 않았는가 (P-9 — 부팅 복원은 이때만 적용된다) */
  get pristine(): boolean {
    return !this.touched;
  }

  /** §2.7 — 코인 1개당 유료 +1. 상한 99에서는 `accepted: false` (§10.3 · CRD-602) */
  insertCoin(): GrantResult {
    return this.grantPaid(1);
  }

  /** §10.3 — 관리자 지급으로만 늘어난다. 상한 5 */
  grantEvent(n: number): GrantResult {
    const applied = grantableAmount(this.eventBalance, n, CREDIT_CAPS.event);
    if (applied > 0) {
      this.eventBalance += applied;
      this.touched = true;
    }
    return { accepted: applied > 0, applied, balance: this.balance };
  }

  /** §10.6 — 크래시 복구·정비용 서비스 크레딧. **유료 지갑**에 들어간다 (P-8) */
  grantService(n: number): GrantResult {
    return this.grantPaid(n);
  }

  /** §10.2 — 차감 후 진입 실패. **낸 지갑으로만** 되돌아오고 상한을 넘지 않는다 */
  refund(amount: number, source: ChargeSource): GrantResult {
    if (source === 'paid') return this.grantPaid(amount);
    if (source === 'event') return this.grantEvent(amount);
    // 'none'(결제 실패) · 'free'(테스트 플레이)는 되돌릴 것이 없다 (P-6)
    return { accepted: false, applied: 0, balance: this.balance };
  }

  /** §10.3 재시작 · admin §7.4 `RESET EVENT` — 지운 양을 돌려준다 */
  clearEvent(): number {
    const cleared = this.eventBalance;
    if (cleared > 0) {
      this.eventBalance = 0;
      this.touched = true;
    }
    return cleared;
  }

  /**
   * 부팅 잔액 복원 (P-9). `pristine`일 때만 적용되므로 복원이 끝나기 전에 들어온 코인을
   * 덮어쓰지 않는다. 한 번 적용하면 지갑이 `touched`가 되어 두 번 복원되지 않는다.
   */
  restorePaid(n: number): boolean {
    if (this.touched) return false;
    this.paidBalance = clampInt(n, 0, CREDIT_CAPS.paid);
    this.touched = true;
    return true;
  }

  /** §2.7 START 유효 조건 · §4.5 컨티뉴 가능 조건. 비용은 1 이상이어야 한다 */
  affordable(cost: number): boolean {
    const need = Math.trunc(Number.isFinite(cost) ? cost : 0);
    if (need < 1) return false;
    return this.eventBalance >= need || this.paidBalance >= need;
  }

  /**
   * §10.4 혼합 결제 금지 — EVENT 전액 가능 → EVENT / 부족 → PAID 단독 / 둘 다 부족 → `'none'`.
   * **두 지갑을 함께 깎는 코드 경로 자체를 두지 않는다** (INV-3).
   */
  charge(cost: number): ChargeResult {
    const need = Math.trunc(Number.isFinite(cost) ? cost : 0);
    if (need < 1) return { source: 'none', amount: 0, balance: this.balance };
    if (this.eventBalance >= need) {
      this.eventBalance -= need;
      this.touched = true;
      return { source: 'event', amount: need, balance: this.balance };
    }
    if (this.paidBalance >= need) {
      this.paidBalance -= need;
      this.touched = true;
      return { source: 'paid', amount: need, balance: this.balance };
    }
    return { source: 'none', amount: 0, balance: this.balance };
  }

  private grantPaid(n: number): GrantResult {
    const applied = grantableAmount(this.paidBalance, n, CREDIT_CAPS.paid);
    if (applied > 0) {
      this.paidBalance += applied;
      this.touched = true;
    }
    return { accepted: applied > 0, applied, balance: this.balance };
  }
}
