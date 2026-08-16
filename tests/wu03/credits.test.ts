// 크레딧 계약 (§10.1~§10.4) — 상한 · 혼합 결제 금지 · 차감/원복 (WU-03 작업 계획 §8.1)
//
// WU-04가 `creditsStub`을 `CreditsService`로 교체했다. 이 파일은 **구현체를 갈아도
// §10.1~§10.4 계약은 그대로**라는 사실을 증명하는 회귀 테스트로 그 자리에 남는다 (WU-04 Q-5).
// 통계·날짜 롤오버·크래시 복구(CRD-604~607)의 판정은 `tests/wu04/`가 갖는다.

import { describe, it, expect } from 'vitest';
import { StatsModel } from '../../src/core/stats';
import {
  CREDIT_CAPS,
  CreditsService,
  DEFAULT_COINS_PER_PLAY,
  DEFAULT_CONTINUE_COINS,
} from '../../src/game/creditsService';
import { parseCreditLogCsv } from '../../src/persist/csv';
import { creditsSpy, fixedWallClock, insertCoins } from './harness';

interface CreditsConfig {
  coinsPerPlay?: number;
  continueCoins?: number;
}

interface CreditsRig {
  readonly credits: CreditsService;
  /** 기록된 `credit_log.csv` 행 (헤더 없음) */
  readonly lines: string[];
}

function makeCredits(cfg: CreditsConfig = {}): CreditsRig {
  const lines: string[] = [];
  const credits = new CreditsService({
    stats: new StatsModel({ wall: fixedWallClock() }),
    clock: { now: () => 0 },
    nowIso: () => '2026-08-16T00:00:00.000Z',
    appendCreditLog: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
    coinsPerPlay: cfg.coinsPerPlay,
    continueCoins: cfg.continueCoins,
  });
  return { credits, lines };
}

function creditsOf(cfg: CreditsConfig = {}): CreditsService {
  return makeCredits(cfg).credits;
}

describe('코인 적립과 상한 (§10.3)', () => {
  it('코인 1개당 유료 크레딧이 1 오른다', () => {
    const credits = creditsOf();
    expect(credits.insertCoin()).toBe(true);
    expect(credits.balance()).toEqual({ paid: 1, event: 0 });
  });

  it('유료 크레딧 상한은 99다', () => {
    const credits = creditsOf();
    insertCoins(credits, CREDIT_CAPS.paid);
    expect(credits.balance().paid).toBe(99);
    expect(credits.insertCoin()).toBe(false);
    expect(credits.balance().paid).toBe(99);
  });

  it('이벤트 크레딧 상한은 5다', () => {
    const credits = creditsOf();
    expect(credits.grantEvent(9)).toBe(CREDIT_CAPS.event);
    expect(credits.balance().event).toBe(5);
    expect(credits.grantEvent(3)).toBe(0);
  });

  it('이벤트 시작 잔액은 0이다', () => {
    expect(creditsOf().balance().event).toBe(0);
  });

  it('공장 기본값은 시작 1 · 컨티뉴 1이다 (§10.1 N11a·N11b)', () => {
    expect(DEFAULT_COINS_PER_PLAY).toBe(1);
    expect(DEFAULT_CONTINUE_COINS).toBe(1);
  });
});

describe('시작·컨티뉴 판정 (§2.7 · §4.5)', () => {
  it('크레딧이 C 미만이면 시작할 수 없다', () => {
    const cfg: CreditsConfig = { coinsPerPlay: 2 };
    const credits = creditsOf(cfg);
    credits.insertCoin();
    expect(credits.canStart()).toBe(false);
    credits.insertCoin();
    expect(credits.canStart()).toBe(true);
  });

  it('컨티뉴 비용은 시작 비용과 따로 설정된다', () => {
    const credits = creditsOf({ coinsPerPlay: 3, continueCoins: 1 });
    credits.insertCoin();
    expect(credits.canStart()).toBe(false);
    expect(credits.canContinue()).toBe(true);
  });

  it('차감하면 잔액이 정확히 줄어든다', () => {
    const credits = creditsOf({ coinsPerPlay: 2 });
    insertCoins(credits, 5);
    expect(credits.chargeStart()).toBe('paid');
    expect(credits.balance().paid).toBe(3);
  });

  it('잔액이 부족하면 결제하지 않고 none을 돌려준다', () => {
    const credits = creditsOf({ coinsPerPlay: 2 });
    credits.insertCoin();
    expect(credits.chargeStart()).toBe('none');
    expect(credits.balance().paid).toBe(1);
  });

  it('컨티뉴 차감도 같은 규칙이다', () => {
    const credits = creditsOf({ continueCoins: 2 });
    insertCoins(credits, 3);
    expect(credits.chargeContinue()).toBe('paid');
    expect(credits.balance().paid).toBe(1);
    expect(credits.chargeContinue()).toBe('none');
  });
});

describe('§10.4 혼합 결제 금지 (CRD-603의 계약분)', () => {
  it('이벤트만으로 전액을 낼 수 있으면 EVENT만 쓴다', () => {
    const credits = creditsOf({ coinsPerPlay: 2 });
    credits.grantEvent(3);
    insertCoins(credits, 5);
    expect(credits.chargeStart()).toBe('event');
    expect(credits.balance()).toEqual({ paid: 5, event: 1 });
  });

  it('이벤트가 부족하면 섞지 않고 PAID 단독으로 낸다', () => {
    const credits = creditsOf({ coinsPerPlay: 3 });
    credits.grantEvent(2);
    insertCoins(credits, 4);
    expect(credits.chargeStart()).toBe('paid');
    expect(credits.balance()).toEqual({ paid: 1, event: 2 }); // 이벤트는 1도 쓰이지 않는다
  });

  it('둘 다 부족하면 결제하지 않는다', () => {
    const credits = creditsOf({ coinsPerPlay: 4 });
    credits.grantEvent(2);
    insertCoins(credits, 3);
    expect(credits.chargeStart()).toBe('none');
    expect(credits.balance()).toEqual({ paid: 3, event: 2 });
  });

  it('둘 다 부족하면 canStart도 false다', () => {
    const credits = creditsOf({ coinsPerPlay: 4 });
    credits.grantEvent(2);
    insertCoins(credits, 3);
    expect(credits.canStart()).toBe(false);
  });
});

describe('§10.2 원복', () => {
  it('유료로 낸 금액은 유료로 되돌아온다', () => {
    const credits = creditsOf({ coinsPerPlay: 2 });
    insertCoins(credits, 2);
    const source = credits.chargeStart();
    credits.refund(2, source, '진입 실패');
    expect(credits.balance().paid).toBe(2);
  });

  it('이벤트로 낸 금액은 이벤트로 되돌아온다', () => {
    const credits = creditsOf({ coinsPerPlay: 2 });
    credits.grantEvent(2);
    const source = credits.chargeStart();
    credits.refund(2, source, '진입 실패');
    expect(credits.balance()).toEqual({ paid: 0, event: 2 });
  });

  it('원복도 상한을 넘지 않는다', () => {
    const credits = creditsOf();
    insertCoins(credits, CREDIT_CAPS.paid);
    credits.refund(5, 'paid', '상한 확인');
    expect(credits.balance().paid).toBe(99);
  });

  it('none 소스는 아무것도 되돌리지 않는다', () => {
    const credits = creditsOf();
    credits.refund(3, 'none', '결제 실패');
    expect(credits.balance()).toEqual({ paid: 0, event: 0 });
  });

  // WU-03에서는 메모리 배열(`refunds`)이 사유를 들고 있었다. WU-04가 §12.1대로 파일 행으로 옮겼다
  it('원복 사유가 credit_log.csv 행에 남는다 (§10.2)', async () => {
    const rig = makeCredits();
    insertCoins(rig.credits, 1);
    rig.credits.chargeStart();
    rig.credits.refund(1, 'paid', '보드 생성 실패');
    await rig.credits.flushLog();

    const rows = parseCreditLogCsv(rig.lines.join('\n'));
    expect(rows.map((r) => r.action)).toEqual(['coin_insert', 'pay', 'refund']);
    expect(rows[2]).toMatchObject({ action: 'refund', source: 'paid', reason: '보드 생성 실패' });
    expect(rows[2].paidBalance).toBe(1);
  });
});

describe('CreditsSpy — 호출 횟수 계측 (CRD-601 판정 도구)', () => {
  it('차감 호출 횟수를 센다', () => {
    const spy = creditsSpy();
    insertCoins(spy, 2);
    spy.chargeStart();
    spy.chargeContinue();
    spy.refund(1, 'paid', 'x');
    expect(spy.calls).toEqual({ insertCoin: 2, chargeStart: 1, chargeContinue: 1, refund: 1 });
  });

  it('스파이를 거쳐도 잔액 계산은 같다', () => {
    const spy = creditsSpy({ coinsPerPlay: 2 });
    insertCoins(spy, 3);
    expect(spy.chargeStart()).toBe('paid');
    expect(spy.balance()).toEqual({ paid: 1, event: 0 });
    expect(spy.canContinue()).toBe(true);
  });
});
