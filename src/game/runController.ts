// 런 1회의 조작 계층 — 포커스 + 입력 버퍼 + 힌트 + `RunSession` 결선 (작업 계획 P-4)
//
// 화면 상태기계(`flow.ts`)와 분리한 이유: 여기에 다 넣으면 SCR·CTL 인수를 화면 전이와 섞지 않고
// 판정할 수 없다. 이 클래스는 **런 안에서만** 산다 — 크레딧·랭킹·화면 전환은 모른다.
//
// Phaser를 모른다. 시각은 주입된 `Clock`에서만 읽는다.

import { headDirection } from '../core/chain';
import type { CoreParams, ResolvedParams } from '../core/params';
import { resolveParams } from '../core/params';
import { Board, slideOutMs } from '../core/puzzle';
import type { AutoCorrection, EndReason, PullResult, RunSession } from '../core/session';
import type { BoardSettlement } from '../core/score';
import type { ChainId, ChainState, Clock, Direction, GridPoint, InputAction } from '../core/types';
import type { BoardSource } from './boardSource';
import { seedFor, tierLabel, tierOf, type Tier } from './boardSource';
import {
  focusAfterRemoval,
  focusDistance,
  focusableChains,
  initialFocus,
  moveFocus,
} from './focus';
import { HintController, type HintOptions, type HintView } from './hint';
import { PullBuffer, type PullOutcome } from './inputBuffer';
import type { Sfx } from './sfx';
import { BOARD_TRANSITION_MS } from './timing';

let runSeedSerial = 0;

export interface ChainView {
  readonly id: ChainId;
  readonly points: readonly GridPoint[];
  readonly state: ChainState;
  readonly depth: number;
  readonly isFocus: boolean;
  readonly isHint: boolean;
}

export interface RemovalView {
  readonly chainId: ChainId;
  readonly points: readonly GridPoint[];
  readonly startedAtMs: number;
  /** 코어 `RemovalHandle.durationMs` — WU-03이 직접 계산하지 않는다 (§3.4) */
  readonly durationMs: number;
  /** 머리가 지나갈 격자 점 열 + 보드 밖 첫 점 (§3.4 경로 추종) */
  readonly exitPath: readonly GridPoint[];
}

export interface BlockView {
  readonly chainId: ChainId;
  readonly blockers: readonly ChainId[];
  readonly atMs: number;
}

export interface RunSnapshot {
  readonly boardNumber: number;
  readonly tier: Tier;
  readonly tierLabel: string;
  readonly chains: readonly ChainView[];
  /** 포커스 사슬의 진로 `R(S)` — 점선 프리뷰용. **막힘 여부는 담지 않는다** (§2.3) */
  readonly focusPath: readonly GridPoint[];
  readonly focusId: ChainId | null;
  readonly removing: readonly RemovalView[];
  readonly timeRemainingMs: number;
  readonly hearts: number;
  readonly displayScore: number;
  readonly comboCentis: number;
  readonly maxComboCentis: number;
  readonly chainsLeft: number;
  readonly chainsTotal: number;
  readonly hint: HintView;
  /** 이 보드의 힌트 사용 횟수 — §8.2 6단 `이 보드 −20n%` 표시의 입력 (감점 계산은 코어) */
  readonly hintUses: number;
  readonly lastBlock: BlockView | null;
  /** 방금 정산한 보드의 클리어·퍼펙트 — §8.4 `CLEAR` / `PERFECT · +5,000` 중앙 문구의 입력 */
  readonly lastClear: { readonly perfect: boolean; readonly bonus: number } | null;
  readonly transitioning: boolean;
  readonly continueCount: number;
  readonly clearedBoards: number;
  readonly tutorial: boolean;
}

export interface RunTickReport {
  readonly settlement?: BoardSettlement;
  readonly autoCorrection?: AutoCorrection;
  readonly ended?: { readonly reason: EndReason };
  /** 보드 전환이 끝나 새 보드를 적재했다 */
  readonly boardAdvancedTo?: number;
}

export interface RunControllerDeps {
  readonly session: RunSession;
  readonly boardSource: BoardSource;
  readonly clock: Clock;
  readonly sfx: Sfx;
  readonly params: CoreParams;
  /**
   * §11.4 `HINT SHOW TIME`·`HINT COOLDOWN` — 관리자가 편집한 값 (WU-05 Q-1).
   * 넘기지 않으면 `HintController`의 공장 기본값(2.5초 / 5.0초)이 그대로 쓰인다.
   */
  readonly hint?: HintOptions;
}

export class RunController {
  private readonly session: RunSession;
  private readonly boardSource: BoardSource;
  private readonly clock: Clock;
  private readonly sfx: Sfx;
  private readonly p: ResolvedParams;
  private readonly hintCtl: HintController;
  private readonly buffer: PullBuffer;

  private board: Board | null = null;
  private boardNumber = 0;
  private chainsTotal = 0;
  private focusId: ChainId | null = null;
  private lastDir: Direction | null = null;
  private removals = new Map<ChainId, RemovalView>();
  private lastBlock: BlockView | null = null;
  private lastClear: { perfect: boolean; bonus: number } | null = null;
  private transitionUntilMs: number | null = null;
  private endState: { reason: EndReason } | null = null;
  private tutorialChain: ChainId | null = null;
  private boardStartedAtMs = 0;
  private runSeed = 'wu03';

  constructor(deps: RunControllerDeps) {
    this.session = deps.session;
    this.boardSource = deps.boardSource;
    this.clock = deps.clock;
    this.sfx = deps.sfx;
    this.p = resolveParams(deps.params);
    this.hintCtl = new HintController(deps.hint);
    this.buffer = new PullBuffer(
      {
        isLocked: () => this.session.isLocked(),
        pull: (id) => this.session.pull(id),
        onUnlock: (fn) => this.session.onUnlock(fn),
      },
      () => this.focusId,
      (id) => this.isFocusable(id),
      (result) => this.onPullResult(result)
    );
  }

  /** 런 시작. `board`를 주면 그것을 쓴다(미니 튜토리얼 전용 보드) */
  start(boardNumber: number, board?: Board): void {
    runSeedSerial += 1;
    this.runSeed = `run-${String(Math.floor(this.clock.now()))}-${String(runSeedSerial)}`;
    const next =
      board ?? this.boardSource.next({ boardNumber, seed: seedFor(boardNumber, this.runSeed) });
    this.session.start(next);
    this.adoptBoard(next, boardNumber);
  }

  /** §4.7 미니 튜토리얼 — 지정 안전수 1개만 반응하고 포커스도 그 사슬로 고정 시작한다 */
  setTutorial(mode: { onlyChain: ChainId }): void {
    this.tutorialChain = mode.onlyChain;
    this.focusId = mode.onlyChain;
  }

  get isTutorial(): boolean {
    return this.tutorialChain !== null;
  }

  /** §4.3-5 — 런 타이머만 멈춘다 (미니 튜토리얼) */
  pause(): void {
    this.session.pause();
  }

  resume(): void {
    this.session.resume();
  }

  get ended(): { reason: EndReason } | null {
    return this.endState;
  }

  get focus(): ChainId | null {
    return this.focusId;
  }

  /** 인게임 입력 6종만 소비한다. 화면 전환·크레딧 입력은 `flow`가 먼저 걸러 낸다 */
  handle(action: InputAction): void {
    if (action === 'UP' || action === 'DOWN' || action === 'LEFT' || action === 'RIGHT') {
      this.moveLever(action);
      return;
    }
    if (action === 'BUTTON1') this.pressPull();
    else if (action === 'BUTTON2') this.pressHint();
  }

  tick(): RunTickReport {
    const now = this.clock.now();
    const result = this.session.tick();
    this.syncRemovals(now);
    this.hintCtl.tick(now, new Set(focusableChains(this.requireBoard())));
    this.repairFocus();

    const report: RunTickReport = {};
    const out = report as {
      settlement?: BoardSettlement;
      autoCorrection?: AutoCorrection;
      ended?: { reason: EndReason };
      boardAdvancedTo?: number;
    };

    if (result.autoCorrection !== undefined) out.autoCorrection = result.autoCorrection;
    if (result.settlement !== undefined) {
      out.settlement = result.settlement;
      const perfect = result.settlement.perfectBonus > 0;
      this.lastClear = { perfect, bonus: result.settlement.perfectBonus };
      this.sfx.play(perfect ? 'perfect' : 'clear');
      // §4.2 보드 전환 0.8초 — **그동안에도 런 타이머는 계속 흐른다**(session.tick을 계속 부른다)
      this.transitionUntilMs = now + BOARD_TRANSITION_MS;
      this.boardSource.report?.({
        boardNumber: this.boardNumber,
        elapsedMs: Math.max(0, now - this.boardStartedAtMs),
        mistakes: this.session.state.mistakesThisBoard,
      });
      const nextNumber = this.boardNumber + 1;
      this.boardSource.prepare?.({
        boardNumber: nextNumber,
        seed: seedFor(nextNumber, this.runSeed),
      });
    }
    // 종료는 `TickResult.ended`만 봐서는 놓친다: 실패 경로(`pull()`의 ③B④⑤⑦⑧⑨)가 그 호출 안에서
    // 런을 끝내면 다음 `tick()`은 `phase === 'ended'`에서 곧바로 되돌아 나오며 `ended`를 담지 않는다.
    // 그래서 **세션 위상**을 직접 본다.
    const phase = this.session.state;
    if (this.endState === null && phase.phase === 'ended') {
      out.ended = this.noteEnd(phase.endReason ?? 'external');
    }

    if (
      this.transitionUntilMs !== null &&
      now >= this.transitionUntilMs &&
      this.endState === null &&
      this.removals.size === 0
    ) {
      this.transitionUntilMs = null;
      out.boardAdvancedTo = this.advanceBoard();
    }
    return report;
  }

  /** §4.5 컨티뉴 확정 후 호출. 코어가 하트·시간을 회복하고 콤보를 1.0으로 되돌린다 */
  continueRun(): boolean {
    if (!this.session.continueRun()) return false;
    this.endState = null;
    this.buffer.clear();
    this.hintCtl.reset();
    this.repairFocus();
    if (this.session.state.phase === 'boardCleared') {
      this.transitionUntilMs = this.clock.now() + BOARD_TRANSITION_MS;
    }
    return true;
  }

  /** §2.7 5분 무입력 — 런을 종료하고 결과 화면으로 (크레딧은 유지) */
  endRun(reason: EndReason): void {
    if (this.endState !== null) return;
    this.session.endRun(reason);
    this.noteEnd(reason);
  }

  private noteEnd(reason: EndReason): { reason: EndReason } {
    const state = { reason };
    this.endState = state;
    this.sfx.play('gameover');
    return state;
  }

  dispose(): void {
    this.buffer.dispose();
  }

  snapshot(): RunSnapshot {
    const board = this.requireBoard();
    const now = this.clock.now();
    const state = this.session.state;
    const hintView = this.hintCtl.view(now);
    const chains: ChainView[] = board.chains().map((chain) => ({
      id: chain.id,
      points: chain.points,
      state: board.stateOf(chain.id),
      depth: chain.depth,
      isFocus: chain.id === this.focusId,
      isHint: chain.id === hintView.targetId,
    }));
    const tier = tierOf(this.boardNumber);
    return {
      boardNumber: this.boardNumber,
      tier,
      tierLabel: tierLabel(tier),
      chains,
      focusPath: this.focusId === null ? [] : pathPreview(board, this.focusId),
      focusId: this.focusId,
      removing: [...this.removals.values()],
      timeRemainingMs: state.timeRemainingMs,
      hearts: state.hearts,
      displayScore: state.displayScore,
      comboCentis: state.comboCentis,
      maxComboCentis: state.maxComboCentis,
      chainsLeft: board.activeChains().length,
      chainsTotal: this.chainsTotal,
      hint: hintView,
      hintUses: state.hintUsesThisBoard,
      lastBlock: this.lastBlock,
      lastClear: this.lastClear,
      transitioning: this.transitionUntilMs !== null,
      continueCount: state.continueCount,
      clearedBoards: state.clearedBoards,
      tutorial: this.tutorialChain !== null,
    };
  }

  // ── 내부 ───────────────────────────────────────────────────────────────

  private moveLever(dir: Direction): void {
    // §2.6 — 레버 입력은 **판정 잠금과 무관하게 즉시** 반영된다
    this.lastDir = dir;
    const from = this.focusId;
    if (from === null) {
      this.sfx.play('reject');
      return;
    }
    const next = moveFocus(this.requireBoard(), from, dir);
    if (next === null) {
      this.sfx.play('reject'); // §2.2 "이동하지 않고 거부음만 낸다"
      return;
    }
    this.focusId = next;
    this.sfx.play('select');
  }

  private pressPull(): void {
    // §2.4 미니 튜토리얼 — 지정 안전수만 반응한다. 그 밖의 사슬은 코어를 부르지 않으므로
    // 하트가 줄지 않는다
    if (this.tutorialChain !== null && this.focusId !== this.tutorialChain) return;
    const outcome: PullOutcome = this.buffer.press(this.clock.now());
    if (outcome === 'EXECUTED' || outcome === 'BUFFERED') this.sfx.play('pull');
    else if (outcome === 'NO_FOCUS') this.sfx.play('reject');
    // 'DROPPED'는 §2.6대로 **조용히** 버린다
  }

  private pressHint(): void {
    if (this.tutorialChain !== null) return; // §2.4 미니 튜토리얼에서 BUTTON2는 무효
    const board = this.requireBoard();
    const focus = this.focusId;
    const result = this.hintCtl.request(this.clock.now(), {
      candidates: this.session.hintOrderedSafeMoves(),
      locked: this.session.isLocked(),
      depthOf: (id) => board.chain(id)?.depth ?? 0,
      distanceTo: (id) => (focus === null ? 0 : focusDistance(board, focus, id)),
    });
    if (result.used) {
      // §7.2 — 감점 계수는 코어 소관이고 WU-03은 "표시가 실제로 시작된 때만 1회" 센다
      this.session.noteHintUsed();
      this.sfx.play('hint');
      return;
    }
    // §7.1이 거부음을 명시한 것은 안전수 0뿐이다. 쿨다운·표시 중·잠금은 HUD 표시로만 알린다
    if (result.rejection === 'NO_SAFE_MOVE') this.sfx.play('reject');
  }

  private onPullResult(result: PullResult): void {
    if (!result.accepted) return;
    if (result.safe === true) {
      const chain = this.requireBoard().chain(result.chainId);
      this.sfx.play('slide', {
        comboCentis: this.session.state.comboCentis,
        segments: Math.max(1, (chain?.points.length ?? 2) - 1),
        pan: chain === undefined ? 0 : directionPan(headDirection(chain)),
      });
      this.lastBlock = null;
      this.syncRemovals(this.clock.now());
      this.repairFocus();
      return;
    }
    this.sfx.play('block', { pan: blockerPan(this.requireBoard(), result) });
    if (result.charged === true) this.sfx.play('heart');
    this.lastBlock = {
      chainId: result.chainId,
      blockers: result.blockers ?? [],
      atMs: this.clock.now(),
    };
  }

  /** `removing` 상태 사슬을 연출 목록과 맞춘다. 자동 보정(§3.8)도 같은 경로로 들어온다 */
  private syncRemovals(now: number): void {
    const board = this.requireBoard();
    for (const chain of board.activeChains()) {
      if (board.stateOf(chain.id) !== 'removing') continue;
      if (this.removals.has(chain.id)) continue;
      this.removals.set(chain.id, {
        chainId: chain.id,
        points: chain.points,
        startedAtMs: now,
        durationMs: slideOutMs(chain, this.p),
        exitPath: board.exitPath(chain.id),
      });
    }
    for (const id of [...this.removals.keys()]) {
      if (board.chain(id) === undefined || board.stateOf(id) !== 'removing')
        this.removals.delete(id);
    }
    if (this.lastBlock !== null && !this.isFocusable(this.lastBlock.chainId)) this.lastBlock = null;
  }

  /**
   * §2.2 — 포커스는 **자동으로 튀지 않는다**. 포커스 사슬이 포커스 대상 집합에서 빠졌을 때만
   * "마지막 레버 방향 1회 이동(비순환), 없으면 RIGHT → DOWN 대체" 규칙을 적용한다.
   */
  private repairFocus(): void {
    const board = this.requireBoard();
    const current = this.focusId;
    if (current !== null && this.isFocusable(current)) return;
    this.focusId =
      current === null ? initialFocus(board) : focusAfterRemoval(board, current, this.lastDir);
  }

  private isFocusable(id: ChainId): boolean {
    const board = this.board;
    if (board === null || board.chain(id) === undefined) return false;
    const state = board.stateOf(id);
    return state === 'normal' || state === 'blocked';
  }

  private advanceBoard(): number {
    const nextNumber = this.boardNumber + 1;
    const board = this.boardSource.next({
      boardNumber: nextNumber,
      seed: seedFor(nextNumber, this.runSeed),
    });
    this.session.loadBoard(board);
    this.adoptBoard(board, nextNumber);
    return nextNumber;
  }

  private adoptBoard(board: Board, boardNumber: number): void {
    this.board = board;
    this.boardNumber = boardNumber;
    this.chainsTotal = board.chains().length;
    this.focusId = initialFocus(board);
    this.lastDir = null;
    this.removals = new Map();
    this.lastBlock = null;
    this.lastClear = null;
    this.transitionUntilMs = null;
    this.boardStartedAtMs = this.clock.now();
    this.buffer.clear();
    this.hintCtl.reset();
    // 보드 적재 직후에 이미 `removing`인 사슬이 있을 수 있다 — §3.8 자동 보정은 `start()`·
    // `loadBoard()`의 ⑦에서 곧바로 발동한다
    this.syncRemovals(this.clock.now());
  }

  private requireBoard(): Board {
    const board = this.board;
    if (board === null) throw new Error('RunController: start()를 먼저 호출한다');
    return board;
  }
}

function directionPan(direction: Direction): number {
  if (direction === 'LEFT') return -0.75;
  if (direction === 'RIGHT') return 0.75;
  return 0;
}

function blockerPan(board: Board, result: PullResult): number {
  const source = board.chain(result.chainId);
  const blocker = result.blockers?.[0] === undefined ? undefined : board.chain(result.blockers[0]);
  if (source === undefined || blocker === undefined) return 0;
  const sourceHead = source.points[source.points.length - 1];
  const blockerHead = blocker.points[blocker.points.length - 1];
  return Math.max(-1, Math.min(1, (blockerHead.x - sourceHead.x) / 6));
}

/** §2.3 진로 프리뷰 — 머리 다음 칸부터 보드 경계까지. 보드 밖 첫 점은 뺀다 */
function pathPreview(board: Board, id: ChainId): readonly GridPoint[] {
  const chain = board.chain(id);
  if (chain === undefined) return [];
  headDirection(chain); // 머리 두 점이 인접한지 확인(형태 불변식)
  const exit = board.exitPath(id);
  return exit.slice(0, Math.max(0, exit.length - 1));
}
