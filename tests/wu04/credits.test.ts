// `CreditWallet` — 상한 · 혼합 결제 금지 · 원복 · 서비스 크레딧 · 부팅 복원 (§10.1~§10.4 · §10.6)
//
// 인수: CRD-602(상한) · CRD-603(혼합 금지). 불변식 INV-1~3은 마지막 describe가 고정한다.

import { describe, it, expect } from 'vitest';
import {
  CREDIT_CAPS,
  CreditWallet,
  DEFAULT_COINS_PER_PLAY,
  DEFAULT_CONTINUE_COINS,
  type ChargeResult,
  type ChargeSource,
  type CreditBalance,
  type GrantKind,
  type GrantResult,
  type WalletSource,
} from '../../src/core/credits';

function walletWith(paid: number, event = 0): CreditWallet {
  const w = new CreditWallet();
  for (let i = 0; i < paid; i += 1) w.insertCoin();
  if (event > 0) w.grantEvent(event);
  return w;
}

describe('§10.1 공장 기본값', () => {
  it('시작 1 · 컨티뉴 1이다 (N11a·N11b)', () => {
    expect(DEFAULT_COINS_PER_PLAY).toBe(1);
    expect(DEFAULT_CONTINUE_COINS).toBe(1);
  });

  it('빈 지갑은 0/0이고 pristine이다', () => {
    const w = new CreditWallet();
    const expected: CreditBalance = { paid: 0, event: 0 };
    expect(w.balance).toEqual(expected);
    expect(w.pristine).toBe(true);
  });

  it('초기값을 주면 상한으로 조여서 받는다', () => {
    expect(new CreditWallet({ paid: 500, event: 50 }).balance).toEqual({ paid: 99, event: 5 });
  });
});

describe('§10.3 상한 (CRD-602)', () => {
  it('유료 상한은 99 · 이벤트 상한은 5다', () => {
    expect(CREDIT_CAPS.paid).toBe(99);
    expect(CREDIT_CAPS.event).toBe(5);
  });

  it('99에서 코인을 더 넣으면 거부되고 잔액이 그대로다', () => {
    const w = walletWith(CREDIT_CAPS.paid);
    const r: GrantResult = w.insertCoin();
    expect(r.accepted).toBe(false);
    expect(r.applied).toBe(0);
    expect(w.balance.paid).toBe(99);
  });

  it('상한을 넘는 이벤트 지급은 들어간 만큼만 applied로 돌려준다', () => {
    const w = new CreditWallet();
    expect(w.grantEvent(9)).toMatchObject({ accepted: true, applied: 5 });
    expect(w.grantEvent(3)).toMatchObject({ accepted: false, applied: 0 });
    expect(w.balance.event).toBe(5);
  });

  it('서비스 크레딧도 유료 상한 99를 넘지 않는다', () => {
    const w = walletWith(98);
    expect(w.grantService(5).applied).toBe(1);
    expect(w.balance.paid).toBe(99);
  });

  it('원복도 상한을 넘지 않는다', () => {
    const w = walletWith(CREDIT_CAPS.paid);
    w.refund(5, 'paid');
    expect(w.balance.paid).toBe(99);
  });
});

describe('§10.4 혼합 결제 금지 (CRD-603 · INV-3)', () => {
  it('EVENT만으로 전액을 낼 수 있으면 EVENT만 쓴다', () => {
    const w = walletWith(5, 3);
    const r = w.charge(2);
    expect(r.source).toBe('event');
    expect(w.balance).toEqual({ paid: 5, event: 1 });
  });

  it('EVENT가 부족하면 섞지 않고 PAID 단독으로 낸다', () => {
    const w = walletWith(4, 2);
    const r = w.charge(3);
    expect(r.source).toBe('paid');
    expect(w.balance).toEqual({ paid: 1, event: 2 }); // 이벤트는 1도 줄지 않는다
  });

  it('둘 다 부족하면 결제하지 않는다', () => {
    const w = walletWith(3, 2);
    const r: ChargeResult = w.charge(4);
    expect(r).toMatchObject({ source: 'none', amount: 0 });
    expect(r.balance).toEqual({ paid: 3, event: 2 });
    expect(w.balance).toEqual({ paid: 3, event: 2 });
  });

  it('EVENT와 PAID의 **합**으로는 결제되지 않는다 (합이 충분해도 실패)', () => {
    const w = walletWith(3, 3); // 합 6 ≥ 5
    expect(w.charge(5).source).toBe('none');
    expect(w.balance).toEqual({ paid: 3, event: 3 });
  });

  it('한 번의 charge가 두 지갑을 함께 줄이는 일은 없다 (INV-3)', () => {
    for (const [paid, event, cost] of [
      [9, 5, 1],
      [9, 5, 5],
      [9, 5, 7],
      [0, 5, 3],
      [9, 0, 3],
    ] as const) {
      const w = walletWith(paid, event);
      const before = w.balance;
      const r = w.charge(cost);
      const after = w.balance;
      const paidMoved = before.paid !== after.paid;
      const eventMoved = before.event !== after.event;
      expect(paidMoved && eventMoved).toBe(false);
      if (r.source !== 'none') expect(r.amount).toBe(cost);
    }
  });

  it('affordable은 두 지갑 중 하나라도 전액을 낼 수 있을 때만 참이다', () => {
    const w = walletWith(3, 3);
    expect(w.affordable(3)).toBe(true);
    expect(w.affordable(4)).toBe(false);
    expect(w.affordable(0)).toBe(false); // 비용 0은 결제가 아니다
  });
});

describe('§10.2 원복', () => {
  it('낸 지갑으로만 되돌아온다 — paid', () => {
    const w = walletWith(2);
    const r = w.charge(2);
    w.refund(2, r.source);
    expect(w.balance).toEqual({ paid: 2, event: 0 });
  });

  it('낸 지갑으로만 되돌아온다 — event', () => {
    const w = walletWith(0, 2);
    const r = w.charge(2);
    w.refund(2, r.source);
    expect(w.balance).toEqual({ paid: 0, event: 2 });
  });

  it("'none'·'free'는 아무것도 되돌리지 않는다 (P-6)", () => {
    const w = walletWith(1, 1);
    for (const source of ['none', 'free'] as ChargeSource[]) {
      expect(w.refund(3, source)).toMatchObject({ accepted: false, applied: 0 });
    }
    expect(w.balance).toEqual({ paid: 1, event: 1 });
  });
});

describe('§10.3 이벤트 잔액 · §10.6 서비스 크레딧', () => {
  it('clearEvent는 지운 양을 돌려주고 잔액을 0으로 만든다', () => {
    const w = walletWith(2, 4);
    expect(w.clearEvent()).toBe(4);
    expect(w.balance).toEqual({ paid: 2, event: 0 });
    expect(w.clearEvent()).toBe(0);
  });

  it('서비스 크레딧은 **유료 지갑**에 들어간다 (P-8)', () => {
    const w = new CreditWallet();
    const kind: GrantKind = 'service';
    expect(kind).toBe('service');
    expect(w.grantService(2).applied).toBe(2);
    expect(w.balance).toEqual({ paid: 2, event: 0 });
  });

  it('0 이하 지급은 아무 일도 하지 않는다', () => {
    const w = new CreditWallet();
    expect(w.grantEvent(0).applied).toBe(0);
    expect(w.grantService(-3).applied).toBe(0);
    expect(w.balance).toEqual({ paid: 0, event: 0 });
  });
});

describe('P-9 부팅 잔액 복원', () => {
  it('pristine 지갑에만 적용된다', () => {
    const w = new CreditWallet();
    expect(w.restorePaid(7)).toBe(true);
    expect(w.balance.paid).toBe(7);
  });

  it('코인이 먼저 들어왔으면 복원이 그것을 덮어쓰지 않는다 (§5.4 부팅 경합)', () => {
    const w = new CreditWallet();
    w.insertCoin();
    expect(w.pristine).toBe(false);
    expect(w.restorePaid(7)).toBe(false);
    expect(w.balance.paid).toBe(1);
  });

  it('복원은 한 번만 적용된다', () => {
    const w = new CreditWallet();
    w.restorePaid(4);
    expect(w.restorePaid(9)).toBe(false);
    expect(w.balance.paid).toBe(4);
  });

  it('복원값도 상한으로 조인다', () => {
    const w = new CreditWallet();
    w.restorePaid(1000);
    expect(w.balance.paid).toBe(99);
  });
});

describe('불변식 INV-1 · INV-2', () => {
  it('INV-1 — 무작위 조작 200회 뒤에도 0 ≤ paid ≤ 99 · 0 ≤ event ≤ 5', () => {
    const w = new CreditWallet();
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 200; i += 1) {
      const pick = Math.floor(rand() * 5);
      if (pick === 0) w.insertCoin();
      else if (pick === 1) w.grantEvent(Math.floor(rand() * 4));
      else if (pick === 2) w.grantService(Math.floor(rand() * 3));
      else if (pick === 3) w.charge(1 + Math.floor(rand() * 4));
      else w.refund(Math.floor(rand() * 3), rand() < 0.5 ? 'paid' : 'event');
      expect(w.balance.paid).toBeGreaterThanOrEqual(0);
      expect(w.balance.paid).toBeLessThanOrEqual(CREDIT_CAPS.paid);
      expect(w.balance.event).toBeGreaterThanOrEqual(0);
      expect(w.balance.event).toBeLessThanOrEqual(CREDIT_CAPS.event);
    }
  });

  it('INV-2 — 유료 원장: 지급 합 − 사용 합 = 잔액', () => {
    const w = new CreditWallet();
    let granted = 0;
    let used = 0;
    for (let i = 0; i < 40; i += 1) granted += w.insertCoin().applied;
    granted += w.grantService(3).applied;
    for (let i = 0; i < 12; i += 1) used += w.charge(2).amount;
    const refunded = w.refund(2, 'paid').applied;
    expect(granted + refunded - used).toBe(w.balance.paid);
  });

  it('INV-2 — 상한에서 삼킨 코인은 원장 양변에서 함께 빠진다', () => {
    const w = new CreditWallet();
    let granted = 0;
    for (let i = 0; i < 120; i += 1) granted += w.insertCoin().applied;
    expect(granted).toBe(99); // 펄스는 120회지만 지갑에 들어간 것은 99 (P-7)
    expect(w.balance.paid).toBe(99);
  });

  it('WalletSource는 charge 성공 소스 2종이다', () => {
    const sources: WalletSource[] = ['paid', 'event'];
    const w = walletWith(1, 1);
    expect(sources).toContain(w.charge(1).source);
  });
});
