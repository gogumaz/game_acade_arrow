// 런 마커·크래시 크레딧 복구 (§10.6 · CRD-606 — 작업 계획 §3.5 · §6)
//
// 마커는 `stats.csv`의 `#run` 섹션에 산다. 새 파일을 만들지 않는 이유는 §4.1과 같다 —
// `csv.test.ts`가 `FILES`를 7종 완전 일치로 고정하고 있다.
//
//   차감 성공 ─► mark()   ─► stats.setRunMarker(m) ─► saveNow(stats.csv)   [디바운스 없음]
//   정상 종료 ─► clear()  ─► stats.setRunMarker(null) ─► saveNow(stats.csv)
//   재기동    ─► recoverOnBoot()
//                 ├ 마커 없음 → 아무 일도 없다
//                 └ 마커 있음 → ① 마커를 **먼저** 지우고 ② 서비스 크레딧 지급
//                               ③ credit_log `service_grant` ④ 감사 로그 ⑤ 즉시 저장
//
// **지우기가 지급보다 먼저**다. 지급 중 예외가 나도 다음 부팅에서 두 번 복구되지 않는다.

import type { AuditSink, RunMarker, StatsModel } from '../core/stats';
import type { CreditsService } from './creditsService';

/**
 * Q-2 — 복구 금액 정책.
 * - `'charged'`(기본): 마커에 적힌 **실제 차감량**. 공장값 `C = 1`에서는 §10.6 문언과 같다
 * - `'one'`: 문언 그대로 항상 1개
 */
export type RecoverPolicy = 'charged' | 'one';

/** §10.6 — 복구분의 `credit_log` reason */
export const CRASH_RECOVERY_REASON = 'crash_recovery';

export interface CrashRecoveryDeps {
  readonly stats: StatsModel;
  readonly credits: CreditsService;
  /** 마커를 디바운스 없이 즉시 저장한다 (§6.2 — 지연되면 복구 창이 열린다) */
  readonly saveNow: () => void;
  readonly audit?: AuditSink;
  readonly policy?: RecoverPolicy;
  /** 감사 이벤트 타임스탬프 */
  readonly nowIso?: () => string;
}

export interface RecoveryResult {
  readonly recovered: boolean;
  readonly granted: number;
  readonly marker: RunMarker | null;
}

export class CrashRecovery {
  private readonly stats: StatsModel;
  private readonly credits: CreditsService;
  private readonly saveNow: () => void;
  private readonly auditSink: AuditSink;
  private readonly policy: RecoverPolicy;
  private readonly nowIso: () => string;

  constructor(deps: CrashRecoveryDeps) {
    this.stats = deps.stats;
    this.credits = deps.credits;
    this.saveNow = deps.saveNow;
    this.auditSink = deps.audit ?? ((): void => undefined);
    this.policy = deps.policy ?? 'charged';
    this.nowIso = deps.nowIso ?? ((): string => '');
  }

  /** 차감 직후 — `CreditsServiceDeps.onRunCharged`가 그대로 연결된다 */
  mark(m: RunMarker): void {
    this.stats.setRunMarker(m);
    this.saveNow();
  }

  /** 결과 화면 진입 = 정상 종료 (`flow.onScreenChange(to === 'RESULT')`) */
  clear(): void {
    if (this.stats.runMarker === null) return;
    this.stats.setRunMarker(null);
    this.saveNow();
  }

  /**
   * 재기동 판독. 마커는 **읽는 즉시 소비**하므로 두 번 복구되지 않는다.
   * 복구분은 유료 지갑 + `SERVICE CREDIT GRANTED`만 올린다 — 유료 플레이 카운트는 건드리지
   * 않는다(그 판은 이미 소비됐다).
   */
  recoverOnBoot(): RecoveryResult {
    const marker = this.stats.runMarker;
    if (marker === null) return { recovered: false, granted: 0, marker: null };

    // ① 지우기가 지급보다 먼저다 (이중 복구 방지)
    this.stats.setRunMarker(null);

    const amount = this.policy === 'one' ? 1 : Math.max(1, Math.trunc(marker.amount));
    // ②③ 서비스 크레딧 + credit_log `service_grant`
    const granted = this.credits.grantService(amount, CRASH_RECOVERY_REASON);
    // ④ 감사 로그 (파일 기록은 WU-05)
    this.auditSink({
      kind: 'CREDIT_RECOVERED',
      at: this.nowIso(),
      detail: `${marker.source} ${String(marker.amount)} -> service ${String(granted)} (${marker.startedIso})`,
    });
    // ⑤ 마커가 사라진 상태를 즉시 굳힌다
    this.saveNow();
    return { recovered: true, granted, marker };
  }
}
