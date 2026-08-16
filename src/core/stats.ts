// 순수 운영 통계 (§10.5 · admin §7.1·§7.2·§7.4 · §11.5 — 작업 계획 §3.2)
//
// **파일 포맷을 모른다.** `stats.csv` 코덱은 `src/game/statsDoc.ts`가 갖는다 (P-1).
// 시각은 주입된 `WallClock`으로만 읽는다 — `Date`를 직접 부르는 곳은 조립 지점 1곳뿐이다 (§2.3 바).
//
// 이 모듈이 소유하는 것: admin §7.1 지표 10종 · §7.2 매출성 미터 6종 · 본 게임 고유 집계
// (세션 점유 시간 · 도달 보드 히스토그램 · 최근 200 유료 세션 점수 링 버퍼) · 날짜 롤오버 ·
// 시간 역행 감지 · 통계 초기화 · 크래시 마커 보관.

/**
 * 롤오버·시간 역행 판정의 유일한 시각 입구. 단조 시계(`Clock`)와 **다르다** (§2.3 마·바).
 * `Clock.now()`는 경과 시간용이고 이쪽은 "오늘이 며칠인가"를 본다.
 */
export interface WallClock {
  /** epoch ms — 24시간 역행 감지용 */
  nowMs(): number;
  /** OS 로컬 날짜 `YYYY-MM-DD` — 롤오버 기준 (§10.5 · admin §11.5) */
  localDate(): string;
  /** ISO 8601 — 감사 이벤트 타임스탬프. 순수 계층이 `Date`를 부르지 않기 위한 입구다 */
  nowIso(): string;
}

/** §5.5 · §12.1 — 최근 200 유료 세션 점수 링 버퍼 */
export const SCORE_RING_CAPACITY = 200;

/** 24시간(ms) — admin §11.5 "24시간 이상 과거로 이동" 판정 */
export const CLOCK_BACKSTEP_MS = 86_400_000;

/** 같은 날짜로의 롤오버 반복을 알아보기 위해 기억하는 최근 목적지 수 (Q-3) */
const ROLLOVER_HISTORY = 8;

/** §10.5 — 롤오버를 확인하는 4지점 */
export type RolloverReason = 'boot' | 'run_start' | 'admin_enter' | 'stats_reset';

/** §11.7 · admin §7.3·§7.4·§11.5 — 감사 로그 종류. 파일 기록은 WU-05 (P-12) */
export type AuditKind =
  'CLOCK_CHANGED' | 'CREDIT_RECOVERED' | 'STATS_RESET' | 'EVENT_GRANT' | 'CREDIT_LOG_FAILURE';

export interface AuditEvent {
  readonly kind: AuditKind;
  /** ISO 8601 */
  readonly at: string;
  readonly detail: string;
}

export type AuditSink = (e: AuditEvent) => void;

/** 런 1회의 결과 — 결과 화면이 닫힐 때 통계로 넘어온다 (§10.5) */
export interface RunOutcome {
  readonly boardReached: number;
  readonly score: number;
  /** 관리자 테스트 플레이면 false — **아무것도 집계하지 않는다** (CRD-607) */
  readonly counted: boolean;
}

/** §10.6 — "런 진행 중" 표식. 재기동 시 이 값이 남아 있으면 크래시다 */
export interface RunMarker {
  readonly source: 'paid' | 'event';
  readonly amount: number;
  readonly startedIso: string;
}

export interface BoardHistogramEntry {
  readonly board: number;
  readonly count: number;
}

/** admin §7.1 10지표 + §7.2 6미터 + 본 게임 고유값 — 화면(WU-05)이 읽는 유일한 표면 */
export interface StatsView {
  readonly date: string;
  // ── admin §7.1 ──
  readonly paidPlayTotal: number;
  readonly paidPlayToday: number;
  readonly paidContinue: number;
  readonly eventPlayTotal: number;
  readonly eventPlayToday: number;
  readonly eventContinue: number;
  readonly eventCreditBalance: number;
  readonly eventGrantedTotal: number;
  readonly eventUsedTotal: number;
  readonly eventUsedToday: number;
  // ── admin §7.2 ──
  readonly coinPulseTotal: number;
  readonly coinPulseToday: number;
  readonly paidCreditGranted: number;
  readonly paidCreditUsed: number;
  readonly serviceCreditGranted: number;
  /** 단가 미설정이면 null — 화면이 숨긴다 (admin §7.2 · §10.1 N11c) */
  readonly estimatedGross: number | null;
  // ── 본 게임 고유 (§10.5) ──
  readonly occupancyMsTotal: number;
  readonly occupancySessions: number;
  /** §1.5 KPI 평균 점유 시간 */
  readonly avgOccupancyMs: number;
  readonly boardHistogram: readonly BoardHistogramEntry[];
  readonly scoreSamples: number;
  readonly clockChangedCount: number;
}

export interface RolloverResult {
  readonly rolled: boolean;
  readonly from: string;
  readonly to: string;
  readonly clockChanged: boolean;
}

/** `src/game/statsDoc.ts`가 CSV로 옮기는 전량 (§12.1) */
export interface StatsSnapshot {
  readonly date: string;
  readonly paidPlayTotal: number;
  readonly paidPlayToday: number;
  readonly paidContinue: number;
  readonly eventPlayTotal: number;
  readonly eventPlayToday: number;
  readonly eventContinue: number;
  readonly eventGrantedTotal: number;
  readonly eventUsedTotal: number;
  readonly eventUsedToday: number;
  readonly coinPulseTotal: number;
  readonly coinPulseToday: number;
  readonly paidCreditGranted: number;
  readonly paidCreditUsed: number;
  readonly serviceCreditGranted: number;
  readonly occupancyMsTotal: number;
  readonly occupancySessions: number;
  readonly lastEpochMs: number;
  readonly lastRolloverDate: string;
  readonly rolloverRepeats: number;
  readonly clockChangedCount: number;
  readonly histogram: readonly BoardHistogramEntry[];
  readonly scores: readonly number[];
  readonly marker: RunMarker | null;
}

export interface StatsModelDeps {
  readonly wall: WallClock;
  readonly audit?: AuditSink;
  readonly ringCapacity?: number;
}

interface Counters {
  date: string;
  paidPlayTotal: number;
  paidPlayToday: number;
  paidContinue: number;
  eventPlayTotal: number;
  eventPlayToday: number;
  eventContinue: number;
  eventGrantedTotal: number;
  eventUsedTotal: number;
  eventUsedToday: number;
  coinPulseTotal: number;
  coinPulseToday: number;
  paidCreditGranted: number;
  paidCreditUsed: number;
  serviceCreditGranted: number;
  occupancyMsTotal: number;
  occupancySessions: number;
  lastEpochMs: number;
  lastRolloverDate: string;
  rolloverRepeats: number;
  clockChangedCount: number;
}

function emptyCounters(): Counters {
  return {
    date: '',
    paidPlayTotal: 0,
    paidPlayToday: 0,
    paidContinue: 0,
    eventPlayTotal: 0,
    eventPlayToday: 0,
    eventContinue: 0,
    eventGrantedTotal: 0,
    eventUsedTotal: 0,
    eventUsedToday: 0,
    coinPulseTotal: 0,
    coinPulseToday: 0,
    paidCreditGranted: 0,
    paidCreditUsed: 0,
    serviceCreditGranted: 0,
    occupancyMsTotal: 0,
    occupancySessions: 0,
    lastEpochMs: 0,
    lastRolloverDate: '',
    rolloverRepeats: 0,
    clockChangedCount: 0,
  };
}

/** 음수·NaN을 0으로 — 손상된 저장 파일이 통계를 오염시키지 않게 한다 */
function safeCount(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export class StatsModel {
  private readonly wall: WallClock;
  private readonly auditSink: AuditSink;
  private readonly ringCapacity: number;

  private c: Counters = emptyCounters();
  private histogram = new Map<number, number>();
  private ring: number[] = [];
  private marker: RunMarker | null = null;
  private eventBalance = 0;
  private openedAtMs: number | null = null;
  /** 최근 롤오버 목적지 — "같은 날짜로 2회" 판정용 (Q-3). 메모리 전용 */
  private rollTargets: string[] = [];

  constructor(deps: StatsModelDeps) {
    this.wall = deps.wall;
    this.auditSink = deps.audit ?? ((): void => undefined);
    this.ringCapacity = deps.ringCapacity ?? SCORE_RING_CAPACITY;
  }

  // ── 롤오버 (§10.5 · admin §11.5 · CRD-605) ───────────────────────────────

  /**
   * §10.5 4지점에서 부른다. 날짜가 바뀌었으면 **오늘 지표 4종만** 0으로 만들고,
   * 시간 역행·같은 날짜 재롤오버면 `CLOCK CHANGED`를 남긴다 (Q-3).
   *
   * 시간이 역행해도 **오늘 지표는 정상 초기화한다.** 경고는 부가 신호이지 집계 중단이 아니다.
   */
  touch(reason: RolloverReason): RolloverResult {
    const today = this.wall.localDate();
    const from = this.c.date;
    const nowMs = this.wall.nowMs();
    let clockChanged = false;
    let rolled = false;

    if (today !== from) {
      rolled = true;
      // ① 오늘 지표 4종만 0 (admin §11.5 · CRD-605)
      this.c.paidPlayToday = 0;
      this.c.eventPlayToday = 0;
      this.c.eventUsedToday = 0;
      this.c.coinPulseToday = 0;
      this.c.date = today;

      // ② 같은 날짜로 2회 이상 롤오버 → 시계가 앞뒤로 흔들렸다는 뜻이다 (Q-3)
      if (this.rollTargets.includes(today)) {
        this.c.rolloverRepeats += 1;
        clockChanged = true;
      } else {
        this.c.rolloverRepeats = 1;
      }
      this.c.lastRolloverDate = today;
      this.rollTargets.push(today);
      if (this.rollTargets.length > ROLLOVER_HISTORY) this.rollTargets.shift();

      // ③ 과거 방향 롤오버 (첫 부팅은 `from`이 빈 문자열이라 해당 없음)
      if (from !== '' && today < from) clockChanged = true;
    }

    // ④ 날짜가 그대로여도 24시간 이상 뒤로 간 것은 시계 조작이다 (admin §11.5)
    if (this.c.lastEpochMs > 0 && nowMs < this.c.lastEpochMs - CLOCK_BACKSTEP_MS) {
      clockChanged = true;
    }
    if (nowMs > this.c.lastEpochMs) this.c.lastEpochMs = nowMs;

    if (clockChanged) {
      this.c.clockChangedCount += 1;
      this.auditSink({
        kind: 'CLOCK_CHANGED',
        at: this.wall.nowIso(),
        detail: `${reason} ${from === '' ? '(none)' : from} -> ${today}`,
      });
    }
    return { rolled, from, to: today, clockChanged };
  }

  // ── 집계 훅 (호출 1회 = 사건 1건, 멱등이 아니다) ─────────────────────────

  /** P-7 — 펄스는 **상한 거부와 무관하게** +1, 지급은 실제로 들어간 양만 */
  noteCoinPulse(applied: number): void {
    this.c.coinPulseTotal += 1;
    this.c.coinPulseToday += 1;
    this.c.paidCreditGranted += safeCount(applied);
  }

  noteEventGranted(applied: number): void {
    this.c.eventGrantedTotal += safeCount(applied);
  }

  /** P-8 — 서비스 크레딧은 전용 미터만 올린다. 코인 펄스·유료 지급은 건드리지 않는다 */
  noteServiceGranted(applied: number): void {
    this.c.serviceCreditGranted += safeCount(applied);
  }

  /** §10.2 원복 — 사용 미터를 되돌린다 (§5.3) */
  noteRefund(source: 'paid' | 'event', amount: number): void {
    const n = safeCount(amount);
    if (source === 'paid') {
      this.c.paidCreditUsed = Math.max(0, this.c.paidCreditUsed - n);
      return;
    }
    this.c.eventUsedTotal = Math.max(0, this.c.eventUsedTotal - n);
    this.c.eventUsedToday = Math.max(0, this.c.eventUsedToday - n);
  }

  /** §10.5 — 유료/이벤트 플레이 +1 (차감과 원자적, P-3) */
  notePlayStarted(source: 'paid' | 'event'): void {
    if (source === 'paid') {
      this.c.paidPlayTotal += 1;
      this.c.paidPlayToday += 1;
      return;
    }
    this.c.eventPlayTotal += 1;
    this.c.eventPlayToday += 1;
  }

  /**
   * §10.2 진입 실패 원복 — 플레이 카운트를 되돌린다.
   * 열려 있던 세션도 **집계 없이** 닫는다(점유 시간은 더하지 않는다, §5.3).
   */
  notePlayReverted(source: 'paid' | 'event'): void {
    if (source === 'paid') {
      this.c.paidPlayTotal = Math.max(0, this.c.paidPlayTotal - 1);
      this.c.paidPlayToday = Math.max(0, this.c.paidPlayToday - 1);
    } else {
      this.c.eventPlayTotal = Math.max(0, this.c.eventPlayTotal - 1);
      this.c.eventPlayToday = Math.max(0, this.c.eventPlayToday - 1);
    }
    this.openedAtMs = null;
  }

  /** §4.5 · admin §7.1 — 컨티뉴 1회당 +1 */
  noteContinue(source: 'paid' | 'event'): void {
    if (source === 'paid') this.c.paidContinue += 1;
    else this.c.eventContinue += 1;
  }

  noteContinueReverted(source: 'paid' | 'event'): void {
    if (source === 'paid') this.c.paidContinue = Math.max(0, this.c.paidContinue - 1);
    else this.c.eventContinue = Math.max(0, this.c.eventContinue - 1);
  }

  /** admin §7.2 `PAID CREDIT USED` · §7.1 `TOTAL/TODAY EVENT CREDIT USED` */
  noteCreditUsed(source: 'paid' | 'event', amount: number): void {
    const n = safeCount(amount);
    if (source === 'paid') {
      this.c.paidCreditUsed += n;
      return;
    }
    this.c.eventUsedTotal += n;
    this.c.eventUsedToday += n;
  }

  /** P-11 — 세션 점유 시간은 **첫 결제 1회**에서 열린다. 컨티뉴로 다시 열지 않는다 */
  noteSessionOpened(atMs: number): void {
    if (this.openedAtMs !== null) return;
    this.openedAtMs = atMs;
  }

  /** §10.5 — 결과 화면 종료. 점유 시간 + 도달 보드 히스토그램 + 점수 링 버퍼 */
  noteSessionClosed(atMs: number, o: RunOutcome): void {
    if (!o.counted) return; // CRD-607 — 테스트 플레이는 아무것도 남기지 않는다
    const openedAt = this.openedAtMs;
    this.openedAtMs = null;
    if (openedAt !== null) {
      this.c.occupancyMsTotal += Math.max(0, atMs - openedAt);
      this.c.occupancySessions += 1;
    }
    const board = safeCount(o.boardReached);
    if (board > 0) this.histogram.set(board, (this.histogram.get(board) ?? 0) + 1);
    this.pushScore(o.score);
  }

  /** 지갑 미러 — `EVENT CREDIT BALANCE`는 별도 누적 상태가 아니다 (2.3 라) */
  setEventBalance(n: number): void {
    this.eventBalance = safeCount(n);
  }

  // ── 조회 ─────────────────────────────────────────────────────────────────

  view(coinUnitPrice: number | null): StatsView {
    const sessions = this.c.occupancySessions;
    return {
      date: this.c.date,
      paidPlayTotal: this.c.paidPlayTotal,
      paidPlayToday: this.c.paidPlayToday,
      paidContinue: this.c.paidContinue,
      eventPlayTotal: this.c.eventPlayTotal,
      eventPlayToday: this.c.eventPlayToday,
      eventContinue: this.c.eventContinue,
      eventCreditBalance: this.eventBalance,
      eventGrantedTotal: this.c.eventGrantedTotal,
      eventUsedTotal: this.c.eventUsedTotal,
      eventUsedToday: this.c.eventUsedToday,
      coinPulseTotal: this.c.coinPulseTotal,
      coinPulseToday: this.c.coinPulseToday,
      paidCreditGranted: this.c.paidCreditGranted,
      paidCreditUsed: this.c.paidCreditUsed,
      serviceCreditGranted: this.c.serviceCreditGranted,
      estimatedGross: coinUnitPrice === null ? null : this.c.coinPulseTotal * coinUnitPrice,
      occupancyMsTotal: this.c.occupancyMsTotal,
      occupancySessions: sessions,
      avgOccupancyMs: sessions === 0 ? 0 : Math.round(this.c.occupancyMsTotal / sessions),
      boardHistogram: this.boardHistogram(),
      scoreSamples: this.ring.length,
      clockChangedCount: this.c.clockChangedCount,
    };
  }

  /**
   * §5.5 — 표본이 링 용량 미만이면 `null`(고정 임계표를 쓴다). 아니면 "상위 N%"의 N.
   * 자기보다 높은 표본의 비율이므로 최고점은 0을 돌려준다.
   */
  topPercentOf(score: number): number | null {
    if (this.ring.length < this.ringCapacity) return null;
    const higher = this.ring.filter((s) => s > score).length;
    return (higher / this.ring.length) * 100;
  }

  /** 도달 보드 히스토그램 — 보드 번호 오름차순 (§11.7 밸런스 지표) */
  boardHistogram(): readonly BoardHistogramEntry[] {
    return [...this.histogram.entries()]
      .map(([board, count]) => ({ board, count }))
      .sort((a, b) => a.board - b.board);
  }

  /** 점수 링 버퍼 — 오래된 것부터 (§5.5 표본) */
  scoreRing(): readonly number[] {
    return [...this.ring];
  }

  get today(): string {
    return this.c.date;
  }

  // ── 초기화 (admin §7.4) ──────────────────────────────────────────────────

  /**
   * `RESET PAID STATISTICS` — 누적/오늘 유료 플레이·유료 컨티뉴 + 점수 링 버퍼(Q-4).
   * **영구 코인 미터와 도달 보드 히스토그램은 건드리지 않는다** (admin §7.2 · CRD-605).
   */
  resetPaid(): void {
    this.touch('stats_reset');
    this.c.paidPlayTotal = 0;
    this.c.paidPlayToday = 0;
    this.c.paidContinue = 0;
    this.ring = []; // §5.5 "통계 초기화 후 분포 표본도 함께 비워진다" (Q-4)
    this.auditSink({ kind: 'STATS_RESET', at: this.wall.nowIso(), detail: 'paid' });
  }

  /** `RESET EVENT STATISTICS` — 이벤트 전량. 잔액 비우기는 호출자가 지갑에 한다 */
  resetEvent(): void {
    this.touch('stats_reset');
    this.c.eventPlayTotal = 0;
    this.c.eventPlayToday = 0;
    this.c.eventContinue = 0;
    this.c.eventGrantedTotal = 0;
    this.c.eventUsedTotal = 0;
    this.c.eventUsedToday = 0;
    this.eventBalance = 0;
    this.auditSink({ kind: 'STATS_RESET', at: this.wall.nowIso(), detail: 'event' });
  }

  // ── 크래시 마커 (§10.6) ──────────────────────────────────────────────────

  get runMarker(): RunMarker | null {
    return this.marker;
  }

  setRunMarker(m: RunMarker | null): void {
    this.marker = m;
  }

  // ── 직렬화 (코덱은 game/statsDoc.ts) ─────────────────────────────────────

  toSnapshot(): StatsSnapshot {
    return {
      ...this.c,
      histogram: this.boardHistogram(),
      scores: [...this.ring],
      marker: this.marker,
    };
  }

  loadSnapshot(s: StatsSnapshot): void {
    this.c = {
      date: s.date,
      paidPlayTotal: safeCount(s.paidPlayTotal),
      paidPlayToday: safeCount(s.paidPlayToday),
      paidContinue: safeCount(s.paidContinue),
      eventPlayTotal: safeCount(s.eventPlayTotal),
      eventPlayToday: safeCount(s.eventPlayToday),
      eventContinue: safeCount(s.eventContinue),
      eventGrantedTotal: safeCount(s.eventGrantedTotal),
      eventUsedTotal: safeCount(s.eventUsedTotal),
      eventUsedToday: safeCount(s.eventUsedToday),
      coinPulseTotal: safeCount(s.coinPulseTotal),
      coinPulseToday: safeCount(s.coinPulseToday),
      paidCreditGranted: safeCount(s.paidCreditGranted),
      paidCreditUsed: safeCount(s.paidCreditUsed),
      serviceCreditGranted: safeCount(s.serviceCreditGranted),
      occupancyMsTotal: safeCount(s.occupancyMsTotal),
      occupancySessions: safeCount(s.occupancySessions),
      lastEpochMs: safeCount(s.lastEpochMs),
      lastRolloverDate: s.lastRolloverDate,
      rolloverRepeats: safeCount(s.rolloverRepeats),
      clockChangedCount: safeCount(s.clockChangedCount),
    };
    this.histogram = new Map();
    for (const e of s.histogram) {
      const board = safeCount(e.board);
      if (board > 0) {
        this.histogram.set(board, (this.histogram.get(board) ?? 0) + safeCount(e.count));
      }
    }
    this.ring = [];
    for (const score of s.scores) this.pushScore(score);
    this.marker = s.marker;
    this.rollTargets = s.lastRolloverDate === '' ? [] : [s.lastRolloverDate];
    this.openedAtMs = null;
  }

  private pushScore(score: number): void {
    if (!Number.isFinite(score)) return;
    this.ring.push(Math.trunc(score));
    while (this.ring.length > this.ringCapacity) this.ring.shift();
  }
}
