// `CreditsService` — `CreditsPort` 계약 · `credit_log.csv` 행 전수 · 통계 훅 · §12.4 신호
//
// 인수: CRD-601(차감 시점의 서비스분) · CRD-602 · CRD-603 · CRD-604 · CRD-607.
// `credit_log`는 **WU-01 코덱(`parseCreditLogCsv`)으로 되읽어** 왕복을 판정한다 (완료 기준 4).

import { describe, it, expect } from 'vitest';
import {
  CREDIT_LOG_FAIL_LIMIT,
  CreditsService,
  type BlockReason,
  type CreditsPort,
} from '../../src/game/creditsService';
import { CREDIT_LOG_HEADER, creditLogLine, parseCreditLogCsv } from '../../src/persist/csv';
import { makeService, type ServiceRig } from './harness';

function rows(rig: ServiceRig): ReturnType<typeof parseCreditLogCsv> {
  return parseCreditLogCsv([CREDIT_LOG_HEADER, ...rig.lines].join('\n'));
}

async function settled(rig: ServiceRig): Promise<ReturnType<typeof parseCreditLogCsv>> {
  await rig.flush();
  return rows(rig);
}

describe('CreditsPort 계약 (P-2 — 인터페이스는 WU-03과 동일하다)', () => {
  it('포트 메서드 8종을 전부 갖는다', () => {
    const rig = makeService();
    const port: CreditsPort = rig.credits;
    expect(typeof port.coinsPerPlay).toBe('number');
    expect(typeof port.continueCoins).toBe('number');
    for (const m of [
      'insertCoin',
      'balance',
      'canStart',
      'canContinue',
      'chargeStart',
      'chargeContinue',
      'refund',
    ] as const) {
      expect(typeof port[m]).toBe('function');
    }
  });

  it('§11.3 범위 밖 설정값은 1~9로 조인다 (admin §8.1)', () => {
    expect(makeService({ coinsPerPlay: 0 }).credits.coinsPerPlay).toBe(1);
    expect(makeService({ coinsPerPlay: 42 }).credits.coinsPerPlay).toBe(9);
    expect(makeService({ continueCoins: -3 }).credits.continueCoins).toBe(1);
  });
});

describe('§12.1 credit_log — 기록 시점표 전 행', () => {
  it('코인 적립은 coin_insert 1줄을 남긴다', async () => {
    const rig = makeService();
    rig.credits.insertCoin();
    const r = await settled(rig);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ action: 'coin_insert', source: 'coin', reason: '' });
    expect(r[0].paidBalance).toBe(1); // 잔액은 **변동 후** 값이다
  });

  it('상한 거부는 잔액이 변하지 않으므로 기록하지 않는다 (P-7 · CRD-602)', async () => {
    const rig = makeService();
    for (let i = 0; i < 99; i += 1) rig.credits.insertCoin();
    await rig.flush();
    const before = rig.lines.length;
    expect(rig.credits.insertCoin()).toBe(false);
    await rig.flush();
    expect(rig.lines).toHaveLength(before);
    // 그래도 펄스는 세었다 — 차이가 삼킨 코인 수다
    const v = rig.credits.view();
    expect(v.coinPulseTotal - v.paidCreditGranted).toBe(1);
  });

  it('런 시작 결제는 pay/start를 남긴다', async () => {
    const rig = makeService();
    rig.credits.insertCoin();
    expect(rig.credits.chargeStart()).toBe('paid');
    const r = await settled(rig);
    expect(r[1]).toMatchObject({ action: 'pay', source: 'paid', reason: 'start' });
    expect(r[1].paidBalance).toBe(0);
  });

  it('컨티뉴 결제는 pay/continue를 남긴다 (reason 칸이 둘을 가른다)', async () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.chargeContinue();
    const r = await settled(rig);
    expect(r.map((x) => `${x.action}:${x.reason}`)).toEqual([
      'coin_insert:',
      'coin_insert:',
      'pay:start',
      'pay:continue',
    ]);
  });

  it('원복은 사유 문자열을 그대로 남긴다 (§10.2)', async () => {
    const rig = makeService();
    rig.credits.insertCoin();
    const source = rig.credits.chargeStart();
    rig.credits.refund(1, source, '런 진입 실패');
    const r = await settled(rig);
    expect(r[2]).toMatchObject({ action: 'refund', source: 'paid', reason: '런 진입 실패' });
    expect(r[2].paidBalance).toBe(1);
  });

  it('이벤트 지급은 event_grant를 남긴다 (admin §7.3)', async () => {
    const rig = makeService();
    expect(rig.credits.grantEvent(2, '주말 이벤트')).toBe(2);
    const r = await settled(rig);
    expect(r[0]).toMatchObject({ action: 'event_grant', source: 'event', reason: '주말 이벤트' });
    expect(r[0].eventBalance).toBe(2);
  });

  it('이벤트 잔액 비움은 event_clear를 남긴다 (§10.3 · admin §7.4)', async () => {
    const rig = makeService();
    rig.credits.grantEvent(3);
    expect(rig.credits.clearEventBalance('reset')).toBe(3);
    const r = await settled(rig);
    expect(r[1]).toMatchObject({ action: 'event_clear', source: 'event', reason: 'reset' });
    expect(r[1].eventBalance).toBe(0);
  });

  it('비울 잔액이 없으면 event_clear를 남기지 않는다 (부팅마다 빈 줄이 쌓이지 않게)', async () => {
    const rig = makeService();
    rig.credits.clearEventBalance('boot');
    await rig.flush();
    expect(rig.lines).toHaveLength(0);
  });

  it('서비스 크레딧은 service_grant를 남긴다 (§10.6 · P-8)', async () => {
    const rig = makeService();
    expect(rig.credits.grantService(1, 'crash_recovery')).toBe(1);
    const r = await settled(rig);
    expect(r[0]).toMatchObject({
      action: 'service_grant',
      source: 'service',
      reason: 'crash_recovery',
    });
  });

  it('WU-01 코덱으로 되읽은 행이 기록한 값과 완전히 같다 (완료 기준 4)', async () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.refund(1, 'paid', '진입 실패');
    rig.credits.grantEvent(1);
    rig.credits.clearEventBalance('reset');
    rig.credits.grantService(1, 'crash_recovery');
    const r = await settled(rig);
    expect(r).toHaveLength(6);
    expect(r.map((x) => x.action)).toEqual([
      'coin_insert',
      'pay',
      'refund',
      'event_grant',
      'event_clear',
      'service_grant',
    ]);
    // 왕복: 파싱한 레코드를 다시 직렬화하면 원래 줄과 같다
    expect(r.map(creditLogLine)).toEqual(rig.lines);
  });

  it('기록 순서는 호출 순서와 같다 (단일 큐)', async () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.grantEvent(1);
    rig.credits.insertCoin();
    const r = await settled(rig);
    expect(r.map((x) => x.action)).toEqual(['coin_insert', 'event_grant', 'coin_insert']);
  });
});

describe('CRD-604 — 통계 훅', () => {
  it('런 시작 결제가 유료 플레이 +1 · 사용 미터 +C를 만든다 (P-3)', () => {
    const rig = makeService({ coinsPerPlay: 2 });
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    expect(rig.credits.view()).toMatchObject({
      paidPlayTotal: 1,
      paidPlayToday: 1,
      paidCreditUsed: 2,
      coinPulseTotal: 2,
      paidCreditGranted: 2,
    });
  });

  it('이벤트 결제는 이벤트 지표만 올린다 (§10.4)', () => {
    const rig = makeService();
    rig.credits.grantEvent(2);
    expect(rig.credits.chargeStart()).toBe('event');
    expect(rig.credits.view()).toMatchObject({
      eventPlayTotal: 1,
      eventUsedTotal: 1,
      eventUsedToday: 1,
      paidPlayTotal: 0,
      paidCreditUsed: 0,
    });
  });

  it('컨티뉴 결제가 컨티뉴 카운트 +1을 만든다 (§4.5)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.chargeContinue();
    expect(rig.credits.view()).toMatchObject({ paidContinue: 1, paidPlayTotal: 1 });
  });

  it('결제 실패는 아무 지표도 올리지 않는다', () => {
    const rig = makeService();
    expect(rig.credits.chargeStart()).toBe('none');
    expect(rig.credits.view()).toMatchObject({ paidPlayTotal: 0, paidCreditUsed: 0 });
    expect(rig.markers).toHaveLength(0);
  });

  it('세션 점유 시간은 첫 결제에서 열리고 closeSession에서 닫힌다 (P-11)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.clock.set(1000);
    rig.credits.chargeStart();
    rig.clock.set(50_000);
    rig.credits.chargeContinue(); // 다시 열지 않는다
    rig.clock.set(121_000);
    rig.credits.closeSession({ boardReached: 5, score: 9000, counted: true });
    expect(rig.credits.view()).toMatchObject({
      occupancyMsTotal: 120_000,
      occupancySessions: 1,
      scoreSamples: 1,
    });
    expect(rig.credits.view().boardHistogram).toEqual([{ board: 5, count: 1 }]);
  });

  it('원복은 플레이 카운트와 사용 미터를 함께 되돌린다 (§5.3)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    const source = rig.credits.chargeStart();
    rig.credits.refund(1, source, '런 진입 실패');
    expect(rig.credits.view()).toMatchObject({
      paidPlayTotal: 0,
      paidPlayToday: 0,
      paidCreditUsed: 0,
      coinPulseTotal: 1, // 코인은 실제로 들어왔다
      paidCreditGranted: 1,
    });
    expect(rig.credits.balance()).toEqual({ paid: 1, event: 0 });
  });

  it('컨티뉴 원복은 컨티뉴 카운트만 되돌린다 (플레이 카운트는 그대로)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    const source = rig.credits.chargeContinue();
    rig.credits.refund(1, source, '컨티뉴 복귀 실패');
    expect(rig.credits.view()).toMatchObject({ paidContinue: 0, paidPlayTotal: 1 });
  });

  it('원복을 두 번 불러도 카운트가 두 번 되돌아가지 않는다', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.refund(1, 'paid', 'a');
    rig.credits.refund(1, 'paid', 'b');
    expect(rig.credits.view().paidPlayTotal).toBe(0);
  });

  it('런 시작이 롤오버를 확인한다 (§10.5 4지점 중 2번째)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    expect(rig.credits.view().paidPlayToday).toBe(1);
    rig.wall.nextDay('2026-08-17');
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    expect(rig.credits.view()).toMatchObject({ paidPlayTotal: 2, paidPlayToday: 1 });
  });

  it('관리자 진입도 롤오버를 확인한다 (4지점 중 3번째)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.wall.nextDay('2026-08-17');
    rig.credits.noteAdminEntered();
    expect(rig.credits.view().paidPlayToday).toBe(0);
  });

  it('통계가 바뀔 때마다 저장 훅이 불린다', () => {
    const rig = makeService();
    const before = rig.changes.count;
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    expect(rig.changes.count).toBeGreaterThan(before);
  });
});

describe('admin §7.2 — ESTIMATED GROSS', () => {
  it('단가가 있으면 코인 펄스 × 단가다', () => {
    const rig = makeService({ coinUnitPrice: 1000 });
    for (let i = 0; i < 3; i += 1) rig.credits.insertCoin();
    expect(rig.credits.estimatedGross()).toBe(3000);
  });

  it('단가 미설정이면 null이다 (화면이 숨긴다)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    expect(rig.credits.coinUnitPrice).toBeNull();
    expect(rig.credits.estimatedGross()).toBeNull();
  });

  it('단가는 나중에 설정할 수 있다 (설정 UI는 WU-05)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.setCoinUnitPrice(500);
    expect(rig.credits.estimatedGross()).toBe(500);
    rig.credits.setCoinUnitPrice(null);
    expect(rig.credits.estimatedGross()).toBeNull();
  });
});

describe('admin §7.4 — 초기화 API', () => {
  function loaded(): ServiceRig {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.chargeContinue();
    rig.credits.grantEvent(3);
    rig.credits.closeSession({ boardReached: 2, score: 500, counted: true });
    return rig;
  }

  it('RESET PAID는 유료 잔액과 영구 미터를 건드리지 않는다', () => {
    const rig = loaded();
    rig.credits.insertCoin();
    const paidBefore = rig.credits.balance().paid;
    rig.credits.resetPaidStatistics();
    expect(rig.credits.balance().paid).toBe(paidBefore);
    expect(rig.credits.view()).toMatchObject({
      paidPlayTotal: 0,
      paidContinue: 0,
      coinPulseTotal: 3,
      paidCreditGranted: 3,
      eventGrantedTotal: 3,
    });
  });

  it('RESET EVENT는 EVENT 잔액까지 비운다', () => {
    const rig = loaded();
    rig.credits.resetEventStatistics();
    expect(rig.credits.balance().event).toBe(0);
    expect(rig.credits.view()).toMatchObject({
      eventGrantedTotal: 0,
      eventCreditBalance: 0,
      paidPlayTotal: 1,
    });
  });

  it('이벤트 지급은 EVENT_GRANT 감사 이벤트를 남긴다', () => {
    const rig = makeService();
    rig.credits.grantEvent(2, '점검 보상');
    expect(rig.audits.filter((e) => e.kind === 'EVENT_GRANT')).toHaveLength(1);
  });
});

describe('CRD-607 — 관리자 테스트 플레이', () => {
  function testPlayRig(): ServiceRig {
    let on = false;
    const rig = makeService({ isTestPlay: () => on });
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    on = true;
    return rig;
  }

  it('차감이 없고 지갑이 그대로다', () => {
    const rig = testPlayRig();
    const before = rig.credits.balance();
    expect(rig.credits.chargeStart()).toBe('free');
    expect(rig.credits.balance()).toEqual(before);
  });

  it('credit_log에 한 줄도 남지 않는다', async () => {
    const rig = testPlayRig();
    await rig.flush(); // 준비 단계(코인 2개)의 append를 먼저 비운다
    const before = rig.lines.length;
    rig.credits.chargeStart();
    rig.credits.chargeContinue();
    await rig.flush();
    expect(rig.lines).toHaveLength(before);
  });

  it('유료·이벤트 통계가 전부 그대로다', () => {
    const rig = testPlayRig();
    const before = rig.credits.view();
    rig.credits.chargeStart();
    rig.credits.chargeContinue();
    rig.credits.closeSession({ boardReached: 7, score: 99_999, counted: true });
    expect(rig.credits.view()).toEqual(before);
  });

  // `chargeStart()`는 테스트 플레이에서도 날짜만 확인한다 — 날짜 확인은 집계가 아니다.
  // 여기서 건너뛰면 자정을 넘긴 테스트 플레이 뒤의 첫 유료 런이 어제 통계 위에 얹힌다
  it('자정을 넘긴 테스트 플레이도 날짜는 확인하지만 지표는 올리지 않는다', () => {
    let on = true;
    const rig = makeService({ isTestPlay: () => on });
    on = false;
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    expect(rig.credits.view().paidPlayToday).toBe(1);

    on = true;
    rig.wall.nextDay('2026-08-17');
    rig.credits.chargeStart(); // 테스트 플레이
    expect(rig.credits.view()).toMatchObject({
      paidPlayToday: 0, // 롤오버는 일어났다
      paidPlayTotal: 1, // 테스트 플레이는 누적을 올리지 않았다
    });
  });

  it('크레딧 없이도 시작할 수 있다 (§11.6)', () => {
    let on = true;
    const rig = makeService({ isTestPlay: () => on });
    expect(rig.credits.balance().paid).toBe(0);
    expect(rig.credits.canStart()).toBe(true);
    on = false;
    expect(rig.credits.canStart()).toBe(false);
  });

  it('컨티뉴는 차단된다 (§11.6)', () => {
    const rig = testPlayRig();
    expect(rig.credits.canContinue()).toBe(false);
  });

  it('마커를 남기지 않는다 (§10.6 복구 대상이 아니다)', () => {
    const rig = testPlayRig();
    rig.credits.chargeStart();
    expect(rig.markers).toHaveLength(0);
  });

  it('코인 적립은 **차단하지 않는다** (§10.6 · §11.6)', async () => {
    let on = true;
    const rig = makeService({ isTestPlay: () => on });
    expect(rig.credits.insertCoin()).toBe(true);
    expect(rig.credits.balance().paid).toBe(1);
    expect(rig.credits.view().coinPulseTotal).toBe(1);
    on = false;
    await rig.flush();
    expect(rig.lines).toHaveLength(1);
  });
});

describe('§10.6 — 마커 통지', () => {
  it('런 시작 결제 직후 마커가 나온다', () => {
    const rig = makeService({ coinsPerPlay: 2 });
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    expect(rig.markers).toHaveLength(1);
    expect(rig.markers[0]).toMatchObject({ source: 'paid', amount: 2 });
    expect(rig.markers[0].startedIso).toBe(rig.wall.nowIso());
  });

  it('컨티뉴 결제도 마커를 덮어쓴다 (마지막 결제가 복구 대상)', () => {
    const rig = makeService();
    rig.credits.grantEvent(2);
    rig.credits.chargeStart();
    rig.credits.chargeContinue();
    expect(rig.markers).toHaveLength(2);
    expect(rig.markers[1]).toMatchObject({ source: 'event', amount: 1 });
  });

  // 검증 V-1 — 원복된 결제는 §13.7 CRD-606이 말하는 "소비된" 크레딧이 아니다.
  // 마커가 남으면 다음 부팅이 이미 돌려준 크레딧을 서비스 크레딧으로 또 준다
  it('런 시작 결제를 원복하면 마커 해제를 통지한다', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    const source = rig.credits.chargeStart();
    expect(rig.reverts.count).toBe(0);
    rig.credits.refund(1, source, '런 진입 실패');
    expect(rig.reverts.count).toBe(1);
  });

  it('컨티뉴 결제 원복도 마커 해제를 통지한다', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    const source = rig.credits.chargeContinue();
    rig.credits.refund(1, source, '컨티뉴 복귀 실패');
    expect(rig.reverts.count).toBe(1);
  });

  it('되돌릴 결제가 없는 원복은 마커를 건드리지 않는다 (진행 중인 런 보호)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.refund(1, 'paid', '관리자 직접 조정');
    expect(rig.reverts.count).toBe(0);
  });

  it('같은 결제를 두 번 원복해도 통지는 1회다', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.credits.refund(1, 'paid', 'a');
    rig.credits.refund(1, 'paid', 'b');
    expect(rig.reverts.count).toBe(1);
  });

  it('낸 지갑과 다른 소스로 원복하면 통지하지 않는다', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    rig.credits.chargeStart(); // paid로 결제
    rig.credits.refund(1, 'event', '엉뚱한 지갑');
    expect(rig.reverts.count).toBe(0);
  });
});

describe('§12.4 — 차감 로그 기록 실패 반복', () => {
  it(`연속 ${String(CREDIT_LOG_FAIL_LIMIT)}회 실패에서 유료 플레이 차단 신호가 켜진다`, async () => {
    const rig = makeService();
    rig.setLogFailing(true);
    for (let i = 0; i < CREDIT_LOG_FAIL_LIMIT; i += 1) rig.credits.insertCoin();
    await rig.flush();
    const reason: BlockReason | null = rig.credits.blockReason;
    expect(reason).toBe('credit_log_write');
    expect(rig.credits.creditLogFailStreak).toBe(CREDIT_LOG_FAIL_LIMIT);
  });

  it('한도 미만이면 아직 차단하지 않는다', async () => {
    const rig = makeService();
    rig.setLogFailing(true);
    rig.credits.insertCoin();
    await rig.flush();
    expect(rig.credits.blockReason).toBeNull();
  });

  it('성공하면 연속 실패 카운터가 0으로 돌아간다', async () => {
    const rig = makeService();
    rig.setLogFailing(true);
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    await rig.flush();
    expect(rig.credits.creditLogFailStreak).toBe(2);
    rig.setLogFailing(false);
    rig.credits.insertCoin();
    await rig.flush();
    expect(rig.credits.creditLogFailStreak).toBe(0);
    expect(rig.credits.blockReason).toBeNull();
  });

  it('실패는 CREDIT_LOG_FAILURE 감사 이벤트를 남긴다', async () => {
    const rig = makeService();
    rig.setLogFailing(true);
    rig.credits.insertCoin();
    await rig.flush();
    expect(rig.audits.filter((e) => e.kind === 'CREDIT_LOG_FAILURE')).toHaveLength(1);
  });

  it('로그가 실패해도 잔액은 메모리에 유지된다 (§10.6 "저장 불가 상태")', async () => {
    const rig = makeService();
    rig.setLogFailing(true);
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    await rig.flush();
    expect(rig.credits.balance().paid).toBe(2);
  });
});

describe('P-9 — 부팅 유료 잔액 복원', () => {
  it('마지막 유효 행의 paidBalance를 되살린다', () => {
    const rig = makeService();
    const csv = [
      CREDIT_LOG_HEADER,
      '2026-08-16T09:00:00.000Z,coin_insert,coin,1,0,',
      '2026-08-16T09:00:01.000Z,coin_insert,coin,2,0,',
      '2026-08-16T09:00:02.000Z,pay,paid,1,0,start',
    ].join('\n');
    expect(rig.credits.restorePaidFromLog(csv)).toBe(1);
    expect(rig.credits.balance().paid).toBe(1);
  });

  it('손상 행은 건너뛰고 마지막 **유효** 행을 쓴다', () => {
    const rig = makeService();
    const csv = [
      CREDIT_LOG_HEADER,
      '2026-08-16T09:00:00.000Z,coin_insert,coin,5,0,',
      'garbage-line',
      '2026-08-16T09:00:02.000Z,unknown_action,paid,9,0,',
    ].join('\n');
    expect(rig.credits.restorePaidFromLog(csv)).toBe(5);
  });

  it('파일이 없거나 행이 없으면 0이다', () => {
    expect(makeService().credits.restorePaidFromLog(null)).toBe(0);
    expect(makeService().credits.restorePaidFromLog(CREDIT_LOG_HEADER)).toBe(0);
  });

  it('복원 전에 코인이 들어왔으면 덮어쓰지 않는다 (§5.4 부팅 경합)', () => {
    const rig = makeService();
    rig.credits.insertCoin();
    expect(rig.credits.restorePaidFromLog(`${CREDIT_LOG_HEADER}\nT,coin_insert,coin,9,0,`)).toBe(0);
    expect(rig.credits.balance().paid).toBe(1);
  });

  it('상한을 넘는 값도 99로 조인다', () => {
    const rig = makeService();
    expect(rig.credits.restorePaidFromLog(`${CREDIT_LOG_HEADER}\nT,coin_insert,coin,500,0,`)).toBe(
      99
    );
  });

  it('이벤트 잔액은 복원하지 않는다 — 재시작 시 0이다 (§10.3)', () => {
    const rig = makeService();
    rig.credits.restorePaidFromLog(`${CREDIT_LOG_HEADER}\nT,event_grant,event,0,5,`);
    expect(rig.credits.balance().event).toBe(0);
  });
});

describe('§5.5 — 점수 백분위 제공 (배선은 §16 이월 1)', () => {
  it('표본이 차기 전에는 null이다', () => {
    const rig = makeService({ ringCapacity: 3 });
    rig.credits.closeSession({ boardReached: 1, score: 100, counted: true });
    expect(rig.credits.scorePercentile(100)).toBeNull();
  });

  it('표본이 차면 상위 N%를 돌려준다', () => {
    const rig = makeService({ ringCapacity: 4 });
    for (const s of [100, 200, 300, 400]) {
      rig.credits.closeSession({ boardReached: 1, score: s, counted: true });
    }
    expect(rig.credits.scorePercentile(300)).toBe(25);
  });
});

describe('CreditsService는 Phaser·DOM을 모른다', () => {
  it('클래스만으로 인스턴스가 만들어진다 (조립 없이)', () => {
    const service = new CreditsService({
      stats: makeService().stats,
      clock: { now: () => 0 },
      nowIso: () => 'T',
      appendCreditLog: () => Promise.resolve(),
    });
    expect(service.balance()).toEqual({ paid: 0, event: 0 });
  });
});
