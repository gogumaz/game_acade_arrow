// 런 마커와 크래시 크레딧 복구 (§10.6 — 인수 CRD-606)
//
// 판정 대상: 마커 생애(write/clear) · 재기동 판독 · **1회 소비**(이중 복구 방지) ·
// 서비스 미터 귀속(P-8) · 정상 종료 시 무복구 · 복구 금액 정책(Q-2).

import { describe, it, expect } from 'vitest';
import type { RunMarker } from '../../src/core/stats';
import {
  CRASH_RECOVERY_REASON,
  CrashRecovery,
  type RecoverPolicy,
  type RecoveryResult,
} from '../../src/game/crashRecovery';
import { parseCreditLogCsv } from '../../src/persist/csv';
import { makeRecovery, type RecoveryRig } from './harness';

const MARKER: RunMarker = { source: 'paid', amount: 1, startedIso: '2026-08-16T10:00:00.000Z' };

/** 코인 → 시작 결제까지 마친 상태 (마커가 남아 있다) */
function charged(coinsPerPlay = 1): RecoveryRig {
  const rig = makeRecovery({ coinsPerPlay });
  for (let i = 0; i < coinsPerPlay; i += 1) rig.credits.insertCoin();
  rig.credits.chargeStart();
  rig.recovery.mark(rig.markers[rig.markers.length - 1]);
  return rig;
}

describe('마커 생애', () => {
  it('차감 직후 마커가 남고 즉시 저장된다 (디바운스 없음 — §6.2)', () => {
    const rig = charged();
    expect(rig.stats.runMarker).toMatchObject({ source: 'paid', amount: 1 });
    expect(rig.saves.count).toBe(1);
  });

  it('마커 시각은 결제 시각이다', () => {
    const rig = charged();
    expect(rig.stats.runMarker?.startedIso).toBe(rig.wall.nowIso());
  });

  it('결과 화면 진입(정상 종료)에서 마커가 사라지고 즉시 저장된다', () => {
    const rig = charged();
    rig.recovery.clear();
    expect(rig.stats.runMarker).toBeNull();
    expect(rig.saves.count).toBe(2);
  });

  it('마커가 없을 때 clear()는 쓸데없이 저장하지 않는다', () => {
    const rig = makeRecovery();
    rig.recovery.clear();
    expect(rig.saves.count).toBe(0);
  });

  it('컨티뉴 결제가 마커를 덮어쓴다 (마지막 결제가 복구 대상)', () => {
    const rig = makeRecovery({ coinsPerPlay: 1, continueCoins: 2 });
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.insertCoin();
    rig.credits.chargeStart();
    rig.recovery.mark(rig.markers[0]);
    rig.credits.chargeContinue();
    rig.recovery.mark(rig.markers[1]);
    expect(rig.stats.runMarker).toMatchObject({ source: 'paid', amount: 2 });
  });
});

describe('CRD-606 — 재기동 복구', () => {
  it('마커가 없으면 아무 일도 없다 (정상 종료 뒤 부팅)', () => {
    const rig = makeRecovery();
    const r: RecoveryResult = rig.recovery.recoverOnBoot();
    expect(r).toEqual({ recovered: false, granted: 0, marker: null });
    expect(rig.credits.balance().paid).toBe(0);
  });

  it('마커가 있으면 소비 크레딧이 서비스 크레딧으로 돌아온다', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    const r = rig.recovery.recoverOnBoot();
    expect(r).toMatchObject({ recovered: true, granted: 1 });
    expect(r.marker).toEqual(MARKER);
    expect(rig.credits.balance().paid).toBe(1);
  });

  it('복구분은 **유료 지갑**에 들어가고 SERVICE CREDIT GRANTED만 오른다 (P-8)', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    rig.recovery.recoverOnBoot();
    expect(rig.credits.view()).toMatchObject({
      serviceCreditGranted: 1,
      coinPulseTotal: 0,
      paidCreditGranted: 0,
      paidPlayTotal: 0, // 그 판은 이미 소비됐다 — 플레이 카운트는 건드리지 않는다
    });
    expect(rig.credits.balance().event).toBe(0);
  });

  it('이벤트로 낸 런도 유료 지갑으로 복구한다 (이벤트 지표를 오염시키지 않는다)', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker({ ...MARKER, source: 'event' });
    rig.recovery.recoverOnBoot();
    expect(rig.credits.balance()).toEqual({ paid: 1, event: 0 });
    expect(rig.credits.view().eventPlayTotal).toBe(0);
  });

  it('credit_log에 service_grant 1줄이 남는다', async () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    rig.recovery.recoverOnBoot();
    await rig.flush();
    const r = parseCreditLogCsv(rig.logCsv());
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      action: 'service_grant',
      source: 'service',
      reason: CRASH_RECOVERY_REASON,
      paidBalance: 1,
    });
  });

  it('CREDIT_RECOVERED 감사 이벤트를 남긴다 (§11.7 — 파일은 WU-05)', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    rig.recovery.recoverOnBoot();
    const e = rig.audits.filter((x) => x.kind === 'CREDIT_RECOVERED');
    expect(e).toHaveLength(1);
    expect(e[0].detail).toContain(MARKER.startedIso);
  });

  it('복구 뒤 마커가 사라진 상태를 즉시 저장한다', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    rig.recovery.recoverOnBoot();
    expect(rig.stats.runMarker).toBeNull();
    expect(rig.saves.count).toBe(1);
  });
});

describe('마커 1회 소비 — 이중 복구 방지', () => {
  it('같은 마커로 두 번 복구되지 않는다', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    expect(rig.recovery.recoverOnBoot().granted).toBe(1);
    expect(rig.recovery.recoverOnBoot()).toEqual({ recovered: false, granted: 0, marker: null });
    expect(rig.credits.balance().paid).toBe(1);
  });

  it('지우기가 지급보다 먼저다 — 지급이 던져도 마커는 남지 않는다', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker(MARKER);
    const broken = new CrashRecovery({
      stats: rig.stats,
      credits: {
        grantService: () => {
          throw new Error('지급 실패');
        },
      } as unknown as RecoveryRig['credits'],
      saveNow: () => undefined,
    });
    expect(() => broken.recoverOnBoot()).toThrow('지급 실패');
    expect(rig.stats.runMarker).toBeNull(); // 다음 부팅에서 두 번 복구되지 않는다
  });

  it('정상 종료한 런은 재기동에서 복구 대상이 아니다', () => {
    const rig = charged();
    rig.recovery.clear(); // RESULT 진입
    expect(rig.recovery.recoverOnBoot().recovered).toBe(false);
    expect(rig.credits.view().serviceCreditGranted).toBe(0);
  });
});

describe('Q-2 — 복구 금액 정책', () => {
  it("기본값 'charged'는 마커에 적힌 실제 차감량을 복구한다", () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker({ ...MARKER, amount: 3 });
    expect(rig.recovery.recoverOnBoot().granted).toBe(3);
    expect(rig.credits.balance().paid).toBe(3);
  });

  it("'one'은 문언 그대로 항상 1개를 복구한다", () => {
    const rig = makeRecovery();
    const policy: RecoverPolicy = 'one';
    const recovery = new CrashRecovery({
      stats: rig.stats,
      credits: rig.credits,
      saveNow: () => undefined,
      policy,
    });
    rig.stats.setRunMarker({ ...MARKER, amount: 3 });
    expect(recovery.recoverOnBoot().granted).toBe(1);
  });

  it('공장값 C=1에서는 두 정책이 같다 (§10.6 문언과 완전히 같다)', () => {
    for (const policy of ['charged', 'one'] as RecoverPolicy[]) {
      const rig = makeRecovery();
      const recovery = new CrashRecovery({
        stats: rig.stats,
        credits: rig.credits,
        saveNow: () => undefined,
        policy,
      });
      rig.stats.setRunMarker(MARKER);
      expect(recovery.recoverOnBoot().granted).toBe(1);
    }
  });

  it('손상된 마커 금액도 최소 1개는 복구한다', () => {
    const rig = makeRecovery();
    rig.stats.setRunMarker({ ...MARKER, amount: 0 });
    expect(rig.recovery.recoverOnBoot().granted).toBe(1);
  });

  it('유료 상한 99에서는 더 늘지 않는다', () => {
    const rig = makeRecovery();
    for (let i = 0; i < 99; i += 1) rig.credits.insertCoin();
    rig.stats.setRunMarker(MARKER);
    expect(rig.recovery.recoverOnBoot().granted).toBe(0);
    expect(rig.credits.balance().paid).toBe(99);
  });
});
