// 크레딧 서비스 — `CreditsPort` 정식 구현 (§10 전체 · admin §7 — 작업 계획 §3.4)
//
// 순수 지갑(`core/credits`)과 순수 통계(`core/stats`)를 `credit_log.csv`·감사 로그·크래시 마커에
// 결선하는 유일한 지점이다. WU-03의 `creditsStub`을 대체하지만 **`CreditsPort` 인터페이스는 한 줄도
// 바뀌지 않는다** (P-2) — `flow.ts`의 호출부 8종이 그대로 살아 있어야 WU-03의 회귀 근거가 남는다.
//
// `credit_log.csv` 기록 시점 (변동 즉시 1줄, §12.1 — 잔액은 **변동 후** 값이다)
//   coin_insert   coin      ''                 상한 거부는 잔액이 안 변하므로 기록하지 않는다 (P-7)
//   pay           paid/event  start|continue   컨티뉴 구분은 reason 칸이 한다 (Q-1)
//   refund        paid/event  사유              §10.2
//   event_grant   event       지급 사유          admin §7.3
//   event_clear   event       boot|reset        §10.3 · admin §7.4
//   service_grant service      crash_recovery   §10.6 · P-8
//   (테스트 플레이는 **한 줄도 기록하지 않는다** — CRD-607)

import {
  CREDIT_CAPS,
  CreditWallet,
  DEFAULT_COINS_PER_PLAY,
  DEFAULT_CONTINUE_COINS,
  type ChargeSource,
  type CreditBalance,
  type WalletSource,
} from '../core/credits';
import type { AuditSink, RunMarker, RunOutcome, StatsModel, StatsView } from '../core/stats';
import type { Clock } from '../core/types';
import { creditLogLine, parseCreditLogCsv, type CreditLogAction } from '../persist/csv';

export type { ChargeSource, CreditBalance } from '../core/credits';
export { CREDIT_CAPS, DEFAULT_COINS_PER_PLAY, DEFAULT_CONTINUE_COINS } from '../core/credits';

/**
 * WU-03과 **동일한** 포트. 메서드 추가·시그니처 변경은 계획 §13-10 금지 사항이다.
 * (`ChargeSource` 유니온에 `'free'`가 늘어난 것은 허용 — P-6)
 */
export interface CreditsPort {
  /** §10.1 N11a — 1회 시작 비용. 화면이 가격(`n CREDIT`)을 표시하는 유일한 근거다 (§8.4) */
  readonly coinsPerPlay: number;
  /** §10.1 N11b — 컨티뉴 비용 */
  readonly continueCoins: number;
  /** 상한 초과면 `false` — 화면은 거부 표시를 낸다 (§10.3 · CRD-602) */
  insertCoin(): boolean;
  balance(): CreditBalance;
  /** 크레딧이 `COINS PER PLAY` 이상인가 (§2.7 START 유효 조건) */
  canStart(): boolean;
  canContinue(): boolean;
  chargeStart(): ChargeSource;
  chargeContinue(): ChargeSource;
  /** §10.2 — 차감 후 게임 진입에 실패하면 원복하고 사유를 `credit_log.csv`에 남긴다 */
  refund(amount: number, source: ChargeSource, reason: string): void;
}

/** §12.4 "차감 로그 기록 실패 **반복**"의 조작적 정의 */
export const CREDIT_LOG_FAIL_LIMIT = 3;

/** §12.4 — WU-06이 화면을 붙인다. WU-04는 신호까지만 (2.3 사) */
export type BlockReason = 'credit_log_write';

export interface CreditsServiceDeps {
  readonly stats: StatsModel;
  /** 단조 시계 — 세션 점유 시간 (§10.5) */
  readonly clock: Clock;
  /** 벽시계 — `credit_log.csv` timestamp */
  readonly nowIso: () => string;
  /** credit_log 1줄 append. **실패를 던져야** §12.4 신호가 산다 (`Storage.appendLineStrict`) */
  readonly appendCreditLog: (line: string) => Promise<void>;
  readonly wallet?: CreditWallet;
  /** §11.3 `COINS PER PLAY` 1~9 (기본 1) */
  readonly coinsPerPlay?: number;
  /** §11.3 `CONTINUE COINS` 1~9 (기본 1) */
  readonly continueCoins?: number;
  /** §11.3 N11c `COIN UNIT PRICE` — 미설정이면 `ESTIMATED GROSS`를 숨긴다 (기본 null) */
  readonly coinUnitPrice?: number | null;
  readonly audit?: AuditSink;
  /** §11.6 관리자 테스트 플레이 — true면 차감·집계·로그를 전부 우회한다 (CRD-607) */
  readonly isTestPlay?: () => boolean;
  /** 런 시작·컨티뉴 차감 **직후** 마커를 남긴다 (§10.6) */
  readonly onRunCharged?: (m: RunMarker) => void;
  /**
   * 마커가 가리키던 결제를 **원복했다** — 호출자가 마커를 해제한다 (§10.6 · 검증 V-1).
   *
   * 원복된 결제는 §13.7 CRD-606이 말하는 "**소비된** 크레딧"이 아니다. 마커를 그대로 두면
   * 다음 부팅이 이미 돌려준 크레딧을 서비스 크레딧으로 한 번 더 지급해 원장(INV-2)이 깨진다.
   */
  readonly onRunReverted?: () => void;
  /** 통계가 바뀌었다 — 호출자가 디바운스 저장을 건다 */
  readonly onStatsChanged?: () => void;
}

/** §8.1 — 1~9 밖의 설정값은 범위로 조인다 */
function clampCost(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(9, Math.trunc(n)));
}

export class CreditsService implements CreditsPort {
  /**
   * §11.3 — `COINS PER PLAY`·`CONTINUE COINS`는 관리자 `MACHINE SETTINGS`가 바꾼다.
   * 반영 시점이 "다음 결제"이므로 진행 중인 결제에 소급되지 않는다. 읽는 쪽(`CreditsPort`의
   * `readonly` 필드)은 getter로 그대로 충족되므로 `flow.ts` 호출부는 한 줄도 바뀌지 않는다.
   */
  private coinsCost: number;
  private continueCost: number;

  private readonly wallet: CreditWallet;
  private readonly stats: StatsModel;
  private readonly clock: Clock;
  private readonly nowIso: () => string;
  private readonly appendCreditLog: (line: string) => Promise<void>;
  private readonly auditSink: AuditSink;
  private readonly isTestPlay: () => boolean;
  private readonly onRunCharged: (m: RunMarker) => void;
  private readonly onRunReverted: () => void;
  private readonly onStatsChanged: () => void;

  private coinPrice: number | null;
  /** 방금 성공한 결제 — 진입 실패 원복이 어떤 카운트를 되돌릴지 정한다 (P-3 · §5.3) */
  private pending: { kind: 'start' | 'continue'; source: WalletSource; amount: number } | null =
    null;
  private logChain: Promise<void> = Promise.resolve();
  private logFailStreak = 0;
  private blocked: BlockReason | null = null;

  constructor(deps: CreditsServiceDeps) {
    this.stats = deps.stats;
    this.clock = deps.clock;
    this.nowIso = deps.nowIso;
    this.appendCreditLog = deps.appendCreditLog;
    this.wallet = deps.wallet ?? new CreditWallet();
    this.coinsCost = clampCost(deps.coinsPerPlay ?? DEFAULT_COINS_PER_PLAY, DEFAULT_COINS_PER_PLAY);
    this.continueCost = clampCost(
      deps.continueCoins ?? DEFAULT_CONTINUE_COINS,
      DEFAULT_CONTINUE_COINS
    );
    this.coinPrice = deps.coinUnitPrice ?? null;
    this.auditSink = deps.audit ?? ((): void => undefined);
    this.isTestPlay = deps.isTestPlay ?? ((): boolean => false);
    this.onRunCharged = deps.onRunCharged ?? ((): void => undefined);
    this.onRunReverted = deps.onRunReverted ?? ((): void => undefined);
    this.onStatsChanged = deps.onStatsChanged ?? ((): void => undefined);
  }

  // ── CreditsPort ──────────────────────────────────────────────────────────

  get coinsPerPlay(): number {
    return this.coinsCost;
  }

  get continueCoins(): number {
    return this.continueCost;
  }

  /** §11.3 N11a — 반영 시점은 **다음 결제**다 (진행 중 세션에 소급되지 않는다) */
  setCoinsPerPlay(n: number): void {
    this.coinsCost = clampCost(n, DEFAULT_COINS_PER_PLAY);
    this.changed();
  }

  /** §11.3 N11b */
  setContinueCoins(n: number): void {
    this.continueCost = clampCost(n, DEFAULT_CONTINUE_COINS);
    this.changed();
  }

  /**
   * §10.6 · §11.6 — **화면·모드와 무관하게 언제나 적립한다.** 관리자 화면에서도, 테스트 플레이
   * 중에도 코인은 유료 크레딧이 된다. 이 메서드에 테스트 플래그 분기가 없다는 사실이 그 규칙이다.
   */
  insertCoin(): boolean {
    const r = this.wallet.insertCoin();
    // P-7 — 펄스는 상한 거부와 무관하게 +1, 지급 미터는 실제로 들어간 양만
    this.stats.noteCoinPulse(r.applied);
    if (r.applied > 0) this.log('coin_insert', 'coin', '');
    this.changed();
    return r.accepted;
  }

  balance(): CreditBalance {
    return this.wallet.balance;
  }

  canStart(): boolean {
    if (this.isTestPlay()) return true; // §11.6 — 크레딧 없이 런을 실행한다
    return this.wallet.affordable(this.coinsPerPlay);
  }

  /** §11.6 — 테스트 플레이는 **컨티뉴를 차단한다** */
  canContinue(): boolean {
    if (this.isTestPlay()) return false;
    return this.wallet.affordable(this.continueCoins);
  }

  /** §10.2 — START 유효 판정 직후, 미니 튜토리얼 진입 전 (CRD-601) */
  chargeStart(): ChargeSource {
    this.stats.touch('run_start'); // §10.5 롤오버 4지점 중 2번째
    if (this.isTestPlay()) return 'free'; // CRD-607 — 지갑·통계·로그 전부 불변
    const r = this.wallet.charge(this.coinsPerPlay);
    if (r.source === 'none') return 'none';
    this.stats.notePlayStarted(r.source);
    this.stats.noteCreditUsed(r.source, r.amount);
    this.stats.noteSessionOpened(this.clock.now()); // P-11 — 첫 결제 1회만
    this.pending = { kind: 'start', source: r.source, amount: r.amount };
    this.log('pay', r.source, 'start');
    this.onRunCharged({ source: r.source, amount: r.amount, startedIso: this.nowIso() });
    this.changed();
    return r.source;
  }

  /** §10.2 — 컨티뉴 확정 입력 직후, 보드 복귀 전 (CRD-601) */
  chargeContinue(): ChargeSource {
    if (this.isTestPlay()) return 'free';
    const r = this.wallet.charge(this.continueCoins);
    if (r.source === 'none') return 'none';
    this.stats.noteContinue(r.source);
    this.stats.noteCreditUsed(r.source, r.amount);
    this.pending = { kind: 'continue', source: r.source, amount: r.amount };
    this.log('pay', r.source, 'continue');
    // 마지막 결제가 복구 대상이므로 마커를 덮어쓴다 (§10.6)
    this.onRunCharged({ source: r.source, amount: r.amount, startedIso: this.nowIso() });
    this.changed();
    return r.source;
  }

  /**
   * §10.2 — 낸 지갑으로 되돌리고 사유를 남긴다. 카운트도 같이 되돌린다 (§5.3).
   *
   * 되돌린 결제가 **마커가 가리키던 그 결제**라면 마커도 함께 해제한다(검증 V-1).
   * 원복과 크래시 복구가 같은 1회 결제에 동시에 적용되면 크레딧이 두 번 지급된다.
   * 마커 해제를 화면 전이(`RESULT` 진입)가 아니라 **여기**에 두었기 때문에, 원복이 어느
   * 경로에서 일어나든(START 직후·컨티뉴 복귀 실패·앞으로 닫을 F-1 튜토리얼 전환 실패)
   * 마커는 자동으로 따라 해제된다.
   */
  refund(amount: number, source: ChargeSource, reason: string): void {
    if (source !== 'paid' && source !== 'event') return; // 'none'·'free'는 되돌릴 것이 없다
    const pendingNow = this.pending;
    // 이월 V-2 — 되돌릴 금액의 권위는 **실제 차감액**(`pending.amount`)이다. 호출자가 넘긴
    // `COINS PER PLAY`는 결제 이후 관리자가 값을 바꾸면 실제 차감액과 어긋난다 (§11.3 반영
    // 시점은 "다음 결제"). 마커가 가리키는 결제가 아니면 인자를 그대로 쓴다
    const applied =
      pendingNow !== null && pendingNow.source === source ? pendingNow.amount : amount;
    const r = this.wallet.refund(applied, source);
    this.stats.noteRefund(source, r.applied);
    const pending = this.pending;
    if (pending !== null && pending.source === source) {
      if (pending.kind === 'start') this.stats.notePlayReverted(source);
      else this.stats.noteContinueReverted(source);
      // 이 결제는 **소비되지 않았다** — CRD-606 복구 대상에서 빼야 한다
      this.onRunReverted();
    }
    this.pending = null;
    this.log('refund', source, reason);
    this.changed();
  }

  // ── WU-05 인계면 (조회·운영) ─────────────────────────────────────────────

  /** admin §7.1 10지표 + §7.2 6미터 한 번에 */
  view(): StatsView {
    this.stats.setEventBalance(this.wallet.balance.event);
    return this.stats.view(this.coinPrice);
  }

  /** admin §7.2 — 코인 펄스 × 단가. 단가 미설정이면 null (화면이 숨긴다) */
  estimatedGross(): number | null {
    return this.view().estimatedGross;
  }

  get coinUnitPrice(): number | null {
    return this.coinPrice;
  }

  /** §11.3 N11c — 관리자가 설치 시 결정한다 (설정 UI는 WU-05) */
  setCoinUnitPrice(price: number | null): void {
    this.coinPrice = price === null || !Number.isFinite(price) ? null : price;
    this.changed();
  }

  /** admin §7.3 — H 1회당 +1, 최대 5. 실제 지급량을 돌려준다 */
  grantEvent(n: number, reason = 'admin'): number {
    const r = this.wallet.grantEvent(n);
    if (r.applied > 0) {
      this.stats.noteEventGranted(r.applied);
      this.log('event_grant', 'event', reason);
    }
    this.auditSink({
      kind: 'EVENT_GRANT',
      at: this.nowIso(),
      detail: `${reason} +${r.applied} (max ${CREDIT_CAPS.event})`,
    });
    this.changed();
    return r.applied;
  }

  /** §10.6 — 서비스 크레딧은 **유료 지갑**에 들어가고 전용 미터만 올린다 (P-8) */
  grantService(n: number, reason: string): number {
    const r = this.wallet.grantService(n);
    if (r.applied > 0) {
      this.stats.noteServiceGranted(r.applied);
      this.log('service_grant', 'service', reason);
    }
    this.changed();
    return r.applied;
  }

  /** §10.3 재시작 · admin §7.4 — 이벤트 잔액을 비운다 */
  clearEventBalance(reason: 'boot' | 'reset'): number {
    const cleared = this.wallet.clearEvent();
    if (cleared > 0) this.log('event_clear', 'event', reason);
    this.stats.setEventBalance(this.wallet.balance.event);
    this.changed();
    return cleared;
  }

  /** admin §7.4 `RESET PAID STATISTICS` — PAID 잔액·영구 미터·이벤트는 유지된다 */
  resetPaidStatistics(): void {
    this.stats.resetPaid();
    this.changed();
  }

  /** admin §7.4 `RESET EVENT STATISTICS` — EVENT 잔액까지 비운다 */
  resetEventStatistics(): void {
    this.clearEventBalance('reset');
    this.stats.resetEvent();
    this.changed();
  }

  /** §10.5 롤오버 4지점 중 3번째 — `flow.onScreenChange(to === 'ADMIN')`이 부른다 */
  noteAdminEntered(): void {
    this.stats.touch('admin_enter');
    this.changed();
  }

  /** §10.5 롤오버 4지점 중 1번째 — 부팅 */
  noteBoot(): void {
    this.stats.touch('boot');
    this.changed();
  }

  /** `flow.onSessionEnd` 수신부 — 점유 시간·도달 보드·점수 표본이 여기서 확정된다 */
  closeSession(o: RunOutcome): void {
    const counted = o.counted && !this.isTestPlay();
    this.stats.noteSessionClosed(this.clock.now(), { ...o, counted });
    this.changed();
  }

  /** §5.5 — 표본 200 미만이면 null(고정 임계표). 배선은 §16 이월 1 (P-10) */
  scorePercentile(score: number): number | null {
    return this.stats.topPercentOf(score);
  }

  /** §12.4 신호 — 화면·복귀 정책은 WU-06 */
  get blockReason(): BlockReason | null {
    return this.blocked;
  }

  /** 연속 실패 횟수 — 진단 표시용 */
  get creditLogFailStreak(): number {
    return this.logFailStreak;
  }

  /**
   * 부팅 잔액 복원 (P-9) — `credit_log.csv`의 **마지막 유효 행 `paidBalance`**.
   * 손상 행은 파서가 이미 버리므로 "마지막 유효 행"이 자연히 잡힌다. 행이 없으면 0.
   */
  restorePaidFromLog(csv: string | null): number {
    if (csv === null) return 0;
    const rows = parseCreditLogCsv(csv);
    if (rows.length === 0) return 0;
    const last = rows[rows.length - 1];
    const want = Math.max(0, Math.min(CREDIT_CAPS.paid, Math.trunc(last.paidBalance)));
    if (!this.wallet.restorePaid(want)) return 0;
    this.changed();
    return this.wallet.balance.paid;
  }

  /** 대기 중인 `credit_log` append가 끝날 때까지 기다린다 (테스트·종료 처리) */
  flushLog(): Promise<void> {
    return this.logChain;
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  private log(action: CreditLogAction, source: string, reason: string): void {
    const b = this.wallet.balance;
    const line = creditLogLine({
      timestamp: this.nowIso(),
      action,
      source,
      paidBalance: b.paid,
      eventBalance: b.event,
      reason,
    });
    // 큐를 하나로 묶어 기록 **순서**를 보장한다 (§12.2 단일 큐와 같은 이유)
    this.logChain = this.logChain.then(() =>
      this.appendCreditLog(line).then(
        () => {
          this.logFailStreak = 0;
          // §12.4 · WU-06 P-5 — 기록이 한 번이라도 성공하면 차단을 **해제**한다.
          // WU-04는 신호를 켜기만 했고 끄는 경로가 없어 재부팅 전에는 영영 막혀 있었다
          this.blocked = null;
        },
        (err: unknown) => {
          this.noteLogFailure(err);
        }
      )
    );
  }

  /** §12.4 — 연속 3회 실패면 유료 플레이 차단 신호를 켠다 */
  private noteLogFailure(err: unknown): void {
    this.logFailStreak += 1;
    this.auditSink({
      kind: 'CREDIT_LOG_FAILURE',
      at: this.nowIso(),
      detail: `${this.logFailStreak}회 연속 실패: ${String(err)}`,
    });
    if (this.logFailStreak >= CREDIT_LOG_FAIL_LIMIT) this.blocked = 'credit_log_write';
  }

  private changed(): void {
    this.onStatsChanged();
  }
}
