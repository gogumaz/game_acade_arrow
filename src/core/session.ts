// 런 세션 — §3.7 처리 순서 ①~⑨ 조립 · 타이머 · 하트 · 시간 수지 · 종료 · 컨티뉴
// (§3.5~§3.8 · §4.2~§4.5 · §5.3)
//
// **당기기의 유일한 입구는 `pull()`이고, 진행의 유일한 입구는 `tick()`이다.** 시간·점수·하트·
// 콤보를 바꾸는 코드는 이 파일과 `score.ts` 안에만 있다 (작업 계획 P-1). 씬(WU-03)이 `Board`에서
// 부를 수 있는 것은 조회 계열뿐이며, 상태 전이 메서드는 `RunSession`이 정해진 순서로만 호출한다.
//
// 시간은 생성자로 주입한 `Clock.now()`에서만 읽는다. 코어는 시스템 시각(월클럭·고해상도 타이머)을
// 직접 호출하지 않고 기본 시계도 export 하지 않는다 (§6.6).

import type { CoreParams, ResolvedParams } from './params';
import { resolveParams } from './params';
import { Board, detectDeadlock, slideOutMs } from './puzzle';
import type { BoardSettlement } from './score';
import { ComboTracker, chainBaseScore, awardedScore, settleBoard } from './score';
import type { Chain, ChainId, Clock, ProcessStep } from './types';

export type RunPhase = 'ready' | 'running' | 'boardCleared' | 'ended';
export type EndReason = 'hearts' | 'time' | 'external';
export type PullRejection = 'NOT_RUNNING' | 'LOCKED' | 'CHAIN_GONE';

/** ③A가 만든 제거 예약. **실제 대기는 호출자(WU-03)** 몫이며 코어는 시각만 계산한다 */
export interface RemovalHandle {
  readonly chainId: ChainId;
  readonly durationMs: number;
  readonly completeAtMs: number;
}

export interface PullResult {
  readonly accepted: boolean;
  readonly rejection?: PullRejection;
  readonly chainId: ChainId;
  readonly safe?: boolean;
  /** 실패 경로에서만 — 하트·시간·콤보 비용이 실제로 청구됐는가 (§3.5 반복 실패 보호) */
  readonly charged?: boolean;
  /** 무변화 상태의 재실패라 비용을 물리지 않았다 (§3.5) */
  readonly protectedRepeat?: boolean;
  readonly blockers?: readonly ChainId[];
  /** ④에서 실제로 적용된 시간 변화(상한·하한 적용 후) */
  readonly timeDeltaMs?: number;
  readonly awarded?: number;
  readonly comboCentis?: number;
  /** 안전수일 때만 */
  readonly removal?: RemovalHandle;
  readonly trace: readonly ProcessStep[];
}

/** §3.8 자동 보정 기록 — 파일 기록(`error_YYYY-MM-DD.log`)과 OVERVIEW 경고는 WU-06 소관 */
export interface AutoCorrection {
  readonly chainId: ChainId;
  readonly boardNumber: number;
  readonly seed?: string;
  readonly revision: number;
}

export interface TickResult {
  readonly completedRemoval?: ChainId;
  /** 이번 tick에서 판정 잠금이 풀렸는가 */
  readonly unlocked: boolean;
  readonly settlement?: BoardSettlement;
  readonly autoCorrection?: AutoCorrection;
  readonly ended?: { readonly reason: EndReason };
  readonly trace: readonly ProcessStep[];
}

export interface RunState {
  readonly phase: RunPhase;
  readonly boardNumber: number;
  readonly timeRemainingMs: number;
  readonly hearts: number;
  readonly comboCentis: number;
  readonly maxComboCentis: number;
  /** 정산이 끝난 보드들의 누적 최종 점수 */
  readonly confirmedScore: number;
  /** 현재 보드에서 얻은 사슬 점수 합 — 힌트 감점 **전** 값 (§5.3 표시 규칙) */
  readonly boardChainScore: number;
  /** 화면 표시 점수 = 확정 + 현재 보드 사슬 점수. 클리어 순간 감점 후 값으로 정정된다 (§5.3) */
  readonly displayScore: number;
  readonly mistakesThisBoard: number;
  readonly hintUsesThisBoard: number;
  readonly clearedBoards: number;
  readonly continueCount: number;
  readonly endReason?: EndReason;
}

interface PendingRemoval {
  readonly handle: RemovalHandle;
  /** `auto`는 §3.8 자동 보정 — 점수·콤보·시간·하트가 전부 불변이다 */
  readonly kind: 'normal' | 'auto';
}

interface TailOutcome {
  completedRemoval?: ChainId;
  settlement?: BoardSettlement;
  autoCorrection?: AutoCorrection;
  ended?: { reason: EndReason };
  unlocked: boolean;
}

export class RunSession {
  private readonly p: ResolvedParams;
  private readonly clock: Clock;
  private readonly combo: ComboTracker;
  private readonly unlockListeners = new Set<() => void>();
  private readonly autoCorrectionListeners = new Set<(e: AutoCorrection) => void>();

  private board: Board | null = null;
  private phase: RunPhase = 'ready';
  private endReason: EndReason | undefined;
  private timeRemainingMs = 0;
  private hearts = 0;
  private confirmedScore = 0;
  private boardChainScore = 0;
  private mistakesThisBoard = 0;
  private hintUsesThisBoard = 0;
  private clearedBoards = 0;
  private continueCount = 0;
  private locked = false;
  private paused = false;
  private lastTickAtMs = 0;
  private pending: PendingRemoval | null = null;
  private boardSettled = false;

  /** §3.5 반복 실패 보호 — 이 `revision`에서 이미 비용을 낸 사슬들 */
  private protectedChains = new Set<ChainId>();
  private protectedRevision = -1;

  /** 시계는 필수 인자다. 코어는 기본 시계를 만들지 않는다 (§6.6) */
  constructor(params: CoreParams, clock: Clock) {
    this.p = resolveParams(params);
    this.clock = clock;
    this.combo = new ComboTracker(this.p);
  }

  get state(): Readonly<RunState> {
    return {
      phase: this.phase,
      boardNumber: this.board === null ? 0 : this.board.boardNumber,
      timeRemainingMs: this.timeRemainingMs,
      hearts: this.hearts,
      comboCentis: this.combo.centis,
      maxComboCentis: this.combo.maxCentis,
      confirmedScore: this.confirmedScore,
      boardChainScore: this.boardChainScore,
      displayScore: this.confirmedScore + this.boardChainScore,
      mistakesThisBoard: this.mistakesThisBoard,
      hintUsesThisBoard: this.hintUsesThisBoard,
      clearedBoards: this.clearedBoards,
      continueCount: this.continueCount,
      endReason: this.endReason,
    };
  }

  /** 런 시작 — 타이머 = 세션 시간, 하트 = 초기 하트 (§4.2) */
  start(board: Board): TickResult {
    if (this.phase !== 'ready') throw new Error('RunSession.start: 이미 시작된 런이다');
    this.board = board;
    this.phase = 'running';
    this.timeRemainingMs = this.p.sessionTimeMs;
    this.hearts = this.p.initialHearts;
    this.lastTickAtMs = this.clock.now();
    this.resetBoardCounters();
    return this.finishTail([], true);
  }

  /**
   * 보드 전환 (§4.2) — 타이머·하트·콤보는 **유지**되고 per-board 카운터만 초기화된다.
   * 런이 끝난 뒤에는 다음 보드를 시작하지 않는다 (§4.4 · SES-207).
   */
  loadBoard(board: Board): TickResult {
    if (this.phase === 'ended') throw new Error('RunSession.loadBoard: 종료된 런이다');
    if (this.phase === 'ready') throw new Error('RunSession.loadBoard: start()를 먼저 호출한다');
    this.board = board;
    this.phase = 'running';
    this.resetBoardCounters();
    return this.finishTail([], true);
  }

  /**
   * ①②③(④⑤) — 사슬 1개를 당긴다.
   *
   * 성공 경로: `S1 S2 S3A S4 S5`까지 동기 처리하고 `RemovalHandle`을 돌려준다. ⑥⑦⑧⑨는 다음
   * `tick()`이 처리한다. 실패 경로: `S1 S2 S3B S4 S5 S7 S8 S9`가 전부 이 호출 안에서 끝난다.
   *
   * **④와 ⑤ 사이에는 어떤 상태 변화도 끼어들지 않는다** (§3.7). 이 구간에서 `clock.now()`를
   * 다시 읽지 않고 보드·하트·잠금 상태도 건드리지 않는다 (PZL-110).
   */
  pull(chainId: ChainId): PullResult {
    // ── ① 입력 수신·잠금 ──
    const board = this.board;
    if (this.phase !== 'running' || board === null) {
      return { accepted: false, rejection: 'NOT_RUNNING', chainId, trace: [] };
    }
    if (this.locked) {
      return { accepted: false, rejection: 'LOCKED', chainId, trace: [] };
    }
    const chain = board.chain(chainId);
    if (chain === undefined) {
      return { accepted: false, rejection: 'CHAIN_GONE', chainId, trace: [] };
    }
    const state = board.stateOf(chainId);
    if (state === 'removing' || state === 'removed') {
      // 잠금 해제와 버퍼 소비 사이에 사라진 사슬 — **하트를 깎지 않는다** (CTL-008의 코어 근거)
      return { accepted: false, rejection: 'CHAIN_GONE', chainId, trace: [] };
    }
    const trace: ProcessStep[] = ['S1_INPUT_LOCK'];
    this.locked = true;
    const now = this.clock.now();

    // ── ② 진로 판정 ──
    const verdict = board.evaluate(chainId);
    trace.push('S2_VERDICT');

    return verdict.safe
      ? this.pullSuccess(board, chain, now, trace)
      : this.pullFailure(board, chain, verdict.blockers, trace);
  }

  /**
   * 시간 진행 + ⑥⑦⑧⑨.
   *
   * 제거가 아직 완료되지 않았으면 시간만 진행시키고 아무 단계도 밟지 않는다. 즉 진행 중인 제거가
   * 있으면 종료 판정이 ⑥ 이후로 미뤄지고, 그 사슬의 점수(⑤에서 이미 반영)는 인정된다 (§4.4).
   */
  tick(): TickResult {
    const now = this.clock.now();
    if (this.phase === 'ended') {
      this.lastTickAtMs = now;
      return { unlocked: false, trace: [] };
    }
    this.advanceTime(now);

    const trace: ProcessStep[] = [];
    let completedRemoval: ChainId | undefined;
    const pending = this.pending;
    if (pending !== null) {
      if (now < pending.handle.completeAtMs) {
        return { unlocked: false, trace: [] };
      }
      // ── ⑥ 제거 완료·점유 해제 (원자적) ──
      const board = this.requireBoard();
      board.completeRemoval(pending.handle.chainId);
      if (pending.kind === 'normal') this.combo.markRemovalCompleted(pending.handle.completeAtMs);
      this.pending = null;
      this.clearFailureProtection();
      completedRemoval = pending.handle.chainId;
      trace.push('S6_REMOVAL_COMPLETE');
    }

    const result = this.finishTail(trace, completedRemoval !== undefined);
    return completedRemoval === undefined ? result : { ...result, completedRemoval };
  }

  /** §2.6 판정 잠금 표면. 2칸 입력 버퍼 자체는 WU-03 소관이다 */
  isLocked(): boolean {
    return this.locked;
  }

  /** ⑨ 잠금 해제 이벤트 — WU-03의 입력 버퍼가 구독해 대기 입력을 소비한다 */
  onUnlock(fn: () => void): () => void {
    this.unlockListeners.add(fn);
    return () => this.unlockListeners.delete(fn);
  }

  /** §3.8 자동 보정 로그 훅 — 파일 기록은 WU-06 */
  onAutoCorrection(fn: (e: AutoCorrection) => void): () => void {
    this.autoCorrectionListeners.add(fn);
    return () => this.autoCorrectionListeners.delete(fn);
  }

  /** §5.3·§7.2 힌트 사용 횟수. 표시·쿨다운은 WU-03 */
  noteHintUsed(): void {
    this.hintUsesThisBoard += 1;
  }

  /**
   * §7.1 힌트 대상 후보 — 안전수를 **생성 확정 깊이 오름차순 → id 오름차순**으로 정렬한다.
   * "포커스에서 가장 가까운 사슬" 타이브레이크는 포커스를 아는 WU-03이 얹는다.
   */
  hintOrderedSafeMoves(): readonly ChainId[] {
    const board = this.board;
    if (board === null) return [];
    return [...board.safeMoves()].sort((a, b) => {
      const da = this.depthOf(board, a);
      const db = this.depthOf(board, b);
      return da === db ? a - b : da - db;
    });
  }

  /** §4.3-5 — 런 타이머만 멈춘다 (미니 튜토리얼·안전 중지). 제거 완료·판정은 계속 처리된다 */
  pause(): void {
    if (this.paused) return;
    this.advanceTime(this.clock.now());
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.lastTickAtMs = this.clock.now();
  }

  /** 외부 종료 (5분 무입력 등, WU-03이 호출) */
  endRun(reason: EndReason): void {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endReason = reason;
  }

  /**
   * §4.5 컨티뉴 — 보드 상태(배치·빨간 표시·누적 점수·보드 번호)를 그대로 보존하고
   * 하트·시간만 설정값으로 회복하며 콤보는 1.0으로 초기화한다.
   * 크레딧 차감·화면은 WU-04·WU-03 소관이며, `CONTINUE`가 OFF면 `false`를 돌려준다.
   */
  continueRun(): boolean {
    if (!this.p.continueEnabled) return false;
    if (this.phase !== 'ended') return false;
    this.hearts = this.p.continueHeartRecover;
    this.timeRemainingMs = this.p.continueTimeRefillMs;
    this.combo.onContinue();
    this.continueCount += 1;
    this.endReason = undefined;
    this.phase = this.boardSettled ? 'boardCleared' : 'running';
    this.lastTickAtMs = this.clock.now();
    return true;
  }

  // ── 내부 ───────────────────────────────────────────────────────────────

  private pullSuccess(board: Board, chain: Chain, now: number, trace: ProcessStep[]): PullResult {
    // ── ③A 제거 개시 (점유는 아직 유지) ──
    board.beginRemoval(chain.id);
    trace.push('S3A_REMOVAL_BEGIN');

    // ── ④ 시간 수지 ──
    const gain = Math.min(
      this.p.timeGainBaseMs + this.p.timeGainPerDepthMs * chain.depth,
      this.p.timeGainCapMs
    );
    const before = this.timeRemainingMs;
    this.timeRemainingMs = Math.min(before + gain, this.p.sessionTimeMs);
    const timeDeltaMs = this.timeRemainingMs - before;
    trace.push('S4_TIME');

    // ── ⑤ 점수·콤보 ── (④와 ⑤ 사이 무개입: now를 다시 읽지 않는다)
    const comboCentis = this.combo.onSuccess(now);
    const awarded = awardedScore(chainBaseScore(chain, this.p), comboCentis);
    this.boardChainScore += awarded;
    trace.push('S5_SCORE');

    const durationMs = slideOutMs(chain, this.p);
    const handle: RemovalHandle = { chainId: chain.id, durationMs, completeAtMs: now + durationMs };
    this.pending = { handle, kind: 'normal' };

    return {
      accepted: true,
      chainId: chain.id,
      safe: true,
      timeDeltaMs,
      awarded,
      comboCentis,
      removal: handle,
      trace,
    };
  }

  private pullFailure(
    board: Board,
    chain: Chain,
    blockers: readonly ChainId[],
    trace: ProcessStep[]
  ): PullResult {
    // ── ③B 막힘 처리 — 빨간 표시는 그 사슬이 제거될 때까지 잔존한다 (§3.5) ──
    board.markBlocked(chain.id);
    const isProtected =
      this.protectedRevision === board.revision && this.protectedChains.has(chain.id);
    if (!isProtected) this.hearts -= 1;
    trace.push('S3B_FAILURE');

    // ── ④ 시간 수지 (하한 0) ──
    const before = this.timeRemainingMs;
    if (!isProtected) {
      this.timeRemainingMs = Math.max(0, before + this.p.failTimePenaltyMs);
    }
    const timeDeltaMs = this.timeRemainingMs - before;
    trace.push('S4_TIME');

    // ── ⑤ 점수·콤보 — 실패는 점수 변화 0, 콤보만 1.0으로 리셋 (§3.5) ──
    if (!isProtected) {
      this.combo.onFailure();
      this.mistakesThisBoard += 1;
      this.protectedRevision = board.revision;
      this.protectedChains.add(chain.id);
    }
    trace.push('S5_SCORE');

    const tail = this.finishTail(trace, true);
    return {
      accepted: true,
      chainId: chain.id,
      safe: false,
      charged: !isProtected,
      protectedRepeat: isProtected,
      blockers,
      timeDeltaMs,
      comboCentis: this.combo.centis,
      trace: tail.trace,
    };
  }

  /**
   * ⑦⑧⑨ 공통 꼬리.
   *
   * - `S7`은 의존 갱신이 필요한 경로(보드 적재·제거 완료·실패 처리)에서만 남긴다.
   * - `S8`은 종료 판정이 실제로 돌아간 tick에만 남는다.
   * - `S9`는 **잠금이 실제로 풀린 순간**에만 남는다. 진행 중인 제거가 있으면 잠금이 유지된다.
   */
  private finishTail(trace: ProcessStep[], recompute: boolean): TickResult {
    const outcome: TailOutcome = { unlocked: false };

    // ── ⑦ 의존 관계 갱신 + §3.8 교착 감지 ──
    if (recompute) {
      trace.push('S7_RECOMPUTE');
      const correction = this.maybeAutoCorrect();
      if (correction !== null) outcome.autoCorrection = correction;
    }

    // ── ⑧ 클리어·종료 검사 (순서 고정: 클리어 → 하트 0 → 시간 0) ──
    if (this.phase !== 'ended') {
      trace.push('S8_END_CHECK');
      const board = this.board;
      if (board !== null && !this.boardSettled && board.isCleared()) {
        outcome.settlement = this.settleCurrentBoard();
      }
      if (this.hearts <= 0) {
        this.phase = 'ended';
        this.endReason = 'hearts';
        outcome.ended = { reason: 'hearts' };
      } else if (this.timeRemainingMs <= 0) {
        this.phase = 'ended';
        this.endReason = 'time';
        outcome.ended = { reason: 'time' };
      }
    }

    // ── ⑨ 입력 잠금 해제 ──
    if (this.locked && this.pending === null) {
      trace.push('S9_UNLOCK');
      this.locked = false;
      outcome.unlocked = true;
      for (const fn of [...this.unlockListeners]) fn();
    }

    return { ...outcome, trace };
  }

  /** §3.8 — 안전수 0이면 보정 대상 1개를 일반 제거와 **같은 경로**로 흘린다 (비용 없음) */
  private maybeAutoCorrect(): AutoCorrection | null {
    const board = this.board;
    if (board === null || this.pending !== null) return null;
    if (this.phase !== 'running') return null;
    const target = detectDeadlock(board);
    if (target === null) return null;
    const chain = board.chain(target);
    if (chain === undefined) return null;

    board.beginRemoval(target);
    const durationMs = slideOutMs(chain, this.p);
    const completeAtMs = this.clock.now() + durationMs;
    this.pending = { handle: { chainId: target, durationMs, completeAtMs }, kind: 'auto' };
    this.locked = true;

    const event: AutoCorrection = {
      chainId: target,
      boardNumber: board.boardNumber,
      seed: board.seed,
      revision: board.revision,
    };
    for (const fn of [...this.autoCorrectionListeners]) fn(event);
    return event;
  }

  private settleCurrentBoard(): BoardSettlement {
    const settlement = settleBoard(
      {
        chainScoreSum: this.boardChainScore,
        timeRemainingMs: this.timeRemainingMs,
        hearts: this.hearts,
        mistakes: this.mistakesThisBoard,
        hintUses: this.hintUsesThisBoard,
      },
      this.p
    );
    // §5.3 — 인게임은 감점 전 값을 보여 주고 클리어 순간 감점 후 값으로 정정한다
    this.confirmedScore += settlement.boardFinal;
    this.boardChainScore = 0;
    this.clearedBoards += 1;
    this.boardSettled = true;
    this.phase = 'boardCleared';
    return settlement;
  }

  /** `tick()`·`pause()`가 부르는 유일한 타이머 진행 지점 */
  private advanceTime(now: number): void {
    if (this.paused) {
      this.lastTickAtMs = now;
      return;
    }
    const elapsed = now - this.lastTickAtMs;
    this.lastTickAtMs = now;
    if (elapsed <= 0) return;
    this.timeRemainingMs = Math.max(0, this.timeRemainingMs - elapsed);
  }

  /** §3.5 — 점유가 바뀌면 반복 실패 보호가 전부 풀린다 */
  private clearFailureProtection(): void {
    this.protectedChains = new Set<ChainId>();
    this.protectedRevision = -1;
  }

  private resetBoardCounters(): void {
    this.boardChainScore = 0;
    this.mistakesThisBoard = 0;
    this.hintUsesThisBoard = 0;
    this.boardSettled = false;
    this.clearFailureProtection();
  }

  private depthOf(board: Board, id: ChainId): number {
    const chain = board.chain(id);
    return chain === undefined ? Number.POSITIVE_INFINITY : chain.depth;
  }

  private requireBoard(): Board {
    const board = this.board;
    if (board === null) throw new Error('RunSession: 보드가 없다');
    return board;
  }
}
