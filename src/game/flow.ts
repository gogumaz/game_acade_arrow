// 화면 흐름 상태기계 (§4.1 · §4.6 · §4.7 · §2.7 — 작업 계획 §7)
//
// 씬은 상태를 만들지 않는다. 이 클래스가 화면·타이머·입력 라우팅·크레딧·랭킹 결선을 전부 갖고,
// 씬은 `tick()` · `snapshot()` · `onScreenChange()`만 쓴다 (P-1).
//
// 모든 화면 타이머는 **데드라인 비교**다. 프레임 누적을 쓰면 프레임 드랍이 카운트다운을 늘려
// SES-211이 흔들린다.

import type { CoreParams, ResolvedParams } from '../core/params';
import { resolveParams } from '../core/params';
import { RunSession } from '../core/session';
import type { EndReason } from '../core/session';
import type { RunOutcome } from '../core/stats';
import type { Clock, InputAction, PlayerId } from '../core/types';
import { TUTORIAL_CHAIN_SAFE, tutorialBoard, type BoardSource } from './boardSource';
import type { ChargeSource, CreditBalance, CreditsPort } from './creditsService';
import {
  GRADE_THRESHOLDS,
  gradeOf,
  type Grade,
  type GradeThresholds,
  type TipReason,
} from './grade';
import { filterSimultaneous } from './inputBuffer';
import { NameEntryModel } from './nameEntry';
import type { RankingEntry } from './rankingStore';
import { RankingStore } from './rankingStore';
import { RunController, type RunSnapshot } from './runController';
import {
  SafePauseModel,
  closedDoorSensor,
  type DoorSensorPort,
  type SafePauseView,
} from './safePause';
import { openPaidPlayGate, type BlockReason, type PaidPlayGate } from './safety';
import type { Sfx } from './sfx';
import {
  ATTRACT_PANELS,
  ATTRACT_PANEL_MS,
  HINT_COOLDOWN_MS,
  HINT_DISPLAY_MS,
  NAME_ENTRY_MS,
  RESULT_AUTO_MS,
  RUN_IDLE_END_MS,
  TUTORIAL_IDLE_MS,
  TUTORIAL_MAX_PLAYS,
} from './timing';

/** §11.1 · admin §2.2 — 관리자 화면 5분 무입력이면 안전 복귀한다 (ADM-006) */
export const ADMIN_IDLE_MS = 300000;

/** §11.4 중 **flow가 소비하는** 시간 3종 (WU-05 Q-1). 넘기지 않으면 WU-03 상수 그대로다 */
export interface UiTimings {
  readonly hintShowMs: number;
  readonly hintCooldownMs: number;
  readonly nameEntryMs: number;
}

const DEFAULT_UI_TIMINGS: UiTimings = {
  hintShowMs: HINT_DISPLAY_MS,
  hintCooldownMs: HINT_COOLDOWN_MS,
  nameEntryMs: NAME_ENTRY_MS,
};

export type Screen =
  'ATTRACT' | 'READY' | 'TUTORIAL' | 'RUN' | 'CONTINUE' | 'RESULT' | 'NAME_ENTRY' | 'ADMIN';

export interface ResultSummary {
  readonly score: number;
  readonly grade: Grade;
  readonly maxComboCentis: number;
  readonly boardReached: number;
  readonly continues: number;
  readonly endReason: EndReason;
  readonly tip: TipReason;
  readonly qualifies: boolean;
  readonly perfectStreak: number;
}

export interface NameEntryView {
  readonly value: string;
  readonly cursor: number;
  readonly remainingMs: number;
}

export interface FlowSnapshot {
  readonly screen: Screen;
  readonly credits: CreditBalance;
  readonly canStart: boolean;
  readonly canContinue: boolean;
  /** 화면 카운트다운 잔여(ms). 카운트다운이 없는 화면은 0 */
  readonly countdownMs: number;
  /** 어트랙트 패널 번호 0..2 (P-9) */
  readonly attractPanel: number;
  readonly ranking: readonly RankingEntry[];
  readonly bestToday: RankingEntry | null;
  readonly run: RunSnapshot | null;
  readonly result: ResultSummary | null;
  readonly nameEntry: NameEntryView | null;
  readonly paidPlays: number;
  /**
   * 런 종료 사유. **CONTINUE 화면에서도 읽을 수 있어야** §8.4의 `TIME UP` / `HEART OUT` 구분이
   * 성립한다 — 결과 요약(`result`)은 RESULT 진입 시점에야 만들어지기 때문이다.
   */
  readonly endReason: EndReason | null;
  /**
   * §12.4 — 유료 시작이 막혀 있는 사유. `null`이면 평소대로다.
   * 어트랙트·READY가 이 값 하나로 차단 문구를 낸다 (P-5).
   */
  readonly paidBlockReason: BlockReason | null;
  /** §12.3 SAFE PAUSE — 정지·카운트다운 상태 (P-7) */
  readonly safePause: SafePauseView;
}

export interface FlowDeps {
  readonly clock: Clock;
  readonly credits: CreditsPort;
  readonly boardSource: BoardSource;
  readonly ranking: RankingStore;
  readonly params: CoreParams;
  readonly sfx: Sfx;
  /** 벽시계 — 랭킹 등록 날짜(§5.7)의 유일한 입구다. 순수 계층은 `new Date()`를 직접 부르지 않는다 */
  readonly nowIso: () => string;
  readonly makeSession?: (params: CoreParams, clock: Clock) => RunSession;
  /** 랭킹이 바뀌었다 — 호출자가 `Storage.scheduleSave()`를 건다 */
  readonly onRankingChanged?: () => void;
  /**
   * §10.5 — **결과 화면이 닫히는 시점** 1건. 세션 점유 시간 종료·도달 보드 히스토그램·
   * 점수 링 버퍼가 전부 이 훅으로 처리된다 (작업 계획 P-4). WU-04 `CreditsService.closeSession`.
   */
  readonly onSessionEnd?: (o: RunOutcome) => void;
  /** §11.6 관리자 테스트 플레이 — 랭킹·통계에서 제외한다 (CRD-607) */
  readonly isTestPlay?: () => boolean;
  /** §11.4 등급 임계 4행 — 관리자 편집값 (WU-05 Q-1). 기본은 공장 임계표 */
  readonly gradeThresholds?: () => GradeThresholds;
  /** §11.4 힌트 표시·쿨다운·이름 입력 시간 (WU-05 Q-1) */
  readonly uiTimings?: () => UiTimings;
  /**
   * §11 관리자 화면 입력 위임. 넘기지 않으면 WU-03과 같이 `BUTTON2`만 복귀로 쓴다
   * (기본 동작 보존 — WU-03 flow 판정이 그대로 성립한다).
   */
  readonly adminInput?: (action: InputAction) => void;
  /**
   * ADM-006 — 5분 무입력 자동 복귀 직전 확인. `false`를 돌려주면 **복귀하지 않는다**
   * (미저장 작업 보호 · admin §2.2).
   */
  readonly adminIdleGuard?: () => boolean;
  /**
   * §12.4 유료 플레이 차단 게이트 (P-5). 넘기지 않으면 항상 통과라 WU-03 동작 그대로다.
   * `startPaidRun()`의 **첫 줄**이 유일한 검사 지점이다 — 우회 경로를 만들지 않는다.
   */
  readonly paidGate?: PaidPlayGate;
  /**
   * §12.3 SAFE PAUSE — 도어 신호. 실물은 §17 `[보류]`이고 기본은 항상 닫힘이다 (P-7).
   */
  readonly door?: DoorSensorPort;
  /**
   * 이월 F-3 — **OS 로컬 날짜** `YYYY-MM-DD`. 랭킹 등록 날짜와 `BEST TODAY`가 같은 기준을
   * 쓰게 하는 유일한 입구다. 기본값은 `nowIso()`의 날짜부라 WU-03 동작과 동일하다.
   */
  readonly localDate?: () => string;
  /**
   * §12.3 — 런 중 `SERVICE` 키를 SAFE PAUSE 토글로 쓸 것인가 (가정 (나)).
   *
   * **기본값은 false**다. WU-03이 "런 중 SERVICE는 무시"를 계약으로 고정했고(§2.7 · admin §2.2)
   * 그 판정이 지금도 살아 있다. 실기 하네스(정비 키 스위치)가 붙을 때 이 플래그를 켜면
   * 배선이 완성되며, 그 전까지 SAFE PAUSE의 실동작 경로는 도어 포트와 `safePauseNow()`다.
   */
  readonly serviceSafePause?: boolean;
}

type ScreenListener = (to: Screen, from: Screen) => void;

export class FlowMachine {
  private readonly clock: Clock;
  private readonly credits: CreditsPort;
  private readonly boardSource: BoardSource;
  private readonly ranking: RankingStore;
  private params: CoreParams;
  private p: ResolvedParams;
  private readonly sfx: Sfx;
  private readonly nowIso: () => string;
  private readonly makeSession: (params: CoreParams, clock: Clock) => RunSession;
  private readonly onRankingChanged: () => void;
  private readonly onSessionEnd: (o: RunOutcome) => void;
  private readonly isTestPlay: () => boolean;
  private readonly gradeThresholds: () => GradeThresholds;
  private readonly uiTimings: () => UiTimings;
  private readonly adminInput: ((action: InputAction) => void) | null;
  private readonly adminIdleGuard: () => boolean;
  private readonly paidGate: PaidPlayGate;
  private readonly door: DoorSensorPort;
  private readonly serviceSafePause: boolean;
  private readonly localDate: () => string;
  /** §12.3 — 런 타이머 정지·3초 재개는 이 모델 1개가 전부다 (P-7) */
  private readonly safePause: SafePauseModel;
  private readonly listeners = new Set<ScreenListener>();
  private readonly traceLog: string[] = [];

  private current: Screen = 'ATTRACT';
  private enteredAtMs = 0;
  private lastInputAtMs = 0;
  private controller: RunController | null = null;
  private paidPlaysCount = 0;
  private chargedSource: ChargeSource = 'none';
  private perfectStreak = 0;
  private bestPerfectStreak = 0;
  private resultSummary: ResultSummary | null = null;
  private nameModel: NameEntryModel | null = null;
  private attractOffset = 0;
  private adminReturn: Screen = 'ATTRACT';
  /** 이번 프레임에 도착한 버튼 (도착 순서) — §2.4 동시 입력 판정의 입력 */
  private frameButtons: InputAction[] = [];
  /** 그중 이미 디스패치한 개수 */
  private dispatchedButtons = 0;

  constructor(deps: FlowDeps) {
    this.clock = deps.clock;
    this.credits = deps.credits;
    this.boardSource = deps.boardSource;
    this.ranking = deps.ranking;
    this.params = deps.params;
    this.p = resolveParams(deps.params);
    this.sfx = deps.sfx;
    this.nowIso = deps.nowIso;
    this.makeSession = deps.makeSession ?? ((params, clock) => new RunSession(params, clock));
    this.onRankingChanged = deps.onRankingChanged ?? ((): void => undefined);
    this.onSessionEnd = deps.onSessionEnd ?? ((): void => undefined);
    this.isTestPlay = deps.isTestPlay ?? ((): boolean => false);
    this.gradeThresholds = deps.gradeThresholds ?? ((): GradeThresholds => GRADE_THRESHOLDS);
    this.uiTimings = deps.uiTimings ?? ((): UiTimings => DEFAULT_UI_TIMINGS);
    this.adminInput = deps.adminInput ?? null;
    this.adminIdleGuard = deps.adminIdleGuard ?? ((): boolean => true);
    this.paidGate = deps.paidGate ?? openPaidPlayGate();
    this.door = deps.door ?? closedDoorSensor();
    this.serviceSafePause = deps.serviceSafePause ?? false;
    this.localDate = deps.localDate ?? ((): string => this.nowIso().slice(0, 10));
    this.safePause = new SafePauseModel({
      onPause: () => this.controller?.pause(),
      onResume: () => this.controller?.resume(),
    });
    this.enteredAtMs = deps.clock.now();
    this.lastInputAtMs = deps.clock.now();
  }

  /**
   * §11.4 — 관리자 `SAVE`가 통과했을 때만 부른다. 반영 시점은 **다음 게임**이며
   * 진행 중 세션·컨티뉴 직전 세션·테스트 플레이에 소급되지 않는다 (admin §8.4 · P-8).
   */
  applyParams(next: CoreParams): void {
    this.params = next;
    this.p = resolveParams(next);
  }

  /** 현재 적용 중인 코어 파라미터 — 관리자 화면이 "현재 영향"을 표시할 때 읽는다 */
  get activeParams(): CoreParams {
    return this.params;
  }

  get screen(): Screen {
    return this.current;
  }

  get trace(): readonly string[] {
    return [...this.traceLog];
  }

  get paidPlays(): number {
    return this.paidPlaysCount;
  }

  onScreenChange(fn: ScreenListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 입력 1건. **P2는 게임에 도달하기 전에 버린다** (§2.1) */
  handle(action: InputAction, player: PlayerId = 1): void {
    if (player !== 1) return;
    if (action === 'RESERVED') return; // §2.1 10행 — 어떤 물리 입력에도 연결하지 않는다

    // §2.7 무인 방치 방지 — 코인을 넣는 사람은 앞에 있다 (작업 계획 P-6)
    this.lastInputAtMs = this.clock.now();

    if (action === 'COIN') {
      this.insertCoin();
      return;
    }
    if (action === 'SERVICE') {
      this.serviceKey();
      return;
    }

    // §2.4 · CTL-010 — **버튼 2종만** 프레임 단위로 모은다. 레버·START·COIN·SERVICE는
    // 위에서 이미 즉시 처리됐다 (§2.6 "레버 입력은 잠금과 무관하게 즉시 반영된다")
    if (action === 'BUTTON1' || action === 'BUTTON2') {
      this.pushButton(action);
      return;
    }
    this.dispatch(action);
  }

  /**
   * §2.4 동시 입력 — 같은 프레임에 두 버튼이 눌리면 `BUTTON1`만 소비하고 `BUTTON2`는 버린다.
   *
   * `BUTTON2`는 **프레임이 끝날 때까지 붙잡아 둔다.** 먼저 눌린 `BUTTON2`를 즉시 실행해 버리면
   * 뒤이어 같은 프레임에 온 `BUTTON1`이 규칙을 되돌릴 방법이 없기 때문이다(힌트 소비는
   * `noteHintUsed()`를 이미 불러 §7.2 감점이 확정된다).
   *
   * 반대로 `BUTTON1`이 도착하면 그 순간 승부가 나므로 **더 기다리지 않고 그 자리에서 확정**한다.
   * 덕분에 주 조작인 당기기에는 프레임 지연이 붙지 않고(§16.3 80ms 예산), 대상 사슬도
   * 누른 시점의 포커스 그대로 잡힌다(§2.6 "입력 시점의 대상").
   */
  private pushButton(action: InputAction): void {
    this.frameButtons.push(action);
    if (action === 'BUTTON1') this.settleButtons();
  }

  /** 이번 프레임 버튼을 §2.4 필터에 통과시키고 **아직 안 보낸 것만** 디스패치한다 */
  private settleButtons(): void {
    const kept = filterSimultaneous(this.frameButtons);
    for (let i = this.dispatchedButtons; i < kept.length; i += 1) this.dispatch(kept[i]);
    this.dispatchedButtons = kept.length;
  }

  /** 화면별 입력 정책표 (작업 계획 §7.2). 버튼은 `settleButtons()`를 거쳐서만 들어온다 */
  private dispatch(action: InputAction): void {
    switch (this.current) {
      case 'ATTRACT':
        this.handleAttract(action);
        return;
      case 'READY':
        if (action === 'START') this.startPaidRun();
        return;
      case 'TUTORIAL':
        // §2.4 미니 튜토리얼 — BUTTON2는 무효, 지정 안전수만 BUTTON1에 반응한다
        if (action !== 'BUTTON2' && action !== 'START') this.requireController().handle(action);
        return;
      case 'RUN':
        // §12.3 — SAFE PAUSE 중에는 게임 조작이 보드에 닿지 않는다 (정비 중 오조작 방지)
        if (this.safePause.active) return;
        if (action !== 'START') this.requireController().handle(action);
        return;
      case 'CONTINUE':
        this.handleContinue(action);
        return;
      case 'RESULT':
        if (action === 'BUTTON1' || action === 'START') this.leaveResult();
        return;
      case 'NAME_ENTRY':
        this.handleNameEntry(action);
        return;
      case 'ADMIN':
        // §11.1 — 관리자 화면에서 START·게임 조작은 무효다. 컨트롤러가 붙어 있으면 나머지를
        // 전부 위임하고, 없으면 WU-03과 같이 `BUTTON2`만 복귀로 쓴다
        if (action === 'START') return;
        if (this.adminInput !== null) {
          this.adminInput(action);
          return;
        }
        if (action === 'BUTTON2') this.leaveAdmin();
        return;
    }
  }

  tick(): void {
    const now = this.clock.now();
    // 프레임 마감 — 붙잡아 둔 `BUTTON2`가 있으면 여기서 나간다. 화면 타이머보다 **먼저** 처리해야
    // 같은 프레임의 입력이 그 화면에서 소비된다
    this.settleButtons();
    this.frameButtons = [];
    this.dispatchedButtons = 0;

    switch (this.current) {
      case 'TUTORIAL':
        this.tickTutorial(now);
        return;
      case 'RUN':
        this.tickRun(now);
        return;
      case 'CONTINUE':
        this.requireController().tick();
        if (now - this.enteredAtMs >= this.p.continuePromptTimeMs) this.go('RESULT');
        return;
      case 'RESULT':
        if (now - this.enteredAtMs >= RESULT_AUTO_MS) this.leaveResult();
        return;
      case 'NAME_ENTRY':
        this.tickNameEntry(now);
        return;
      case 'ADMIN':
        // ADM-006 — 5분 무입력 안전 복귀. 미저장 작업이 있으면 가드가 막는다 (admin §2.2)
        if (now - this.lastInputAtMs >= ADMIN_IDLE_MS && this.adminIdleGuard()) this.leaveAdmin();
        return;
      default:
        return;
    }
  }

  snapshot(): FlowSnapshot {
    const now = this.clock.now();
    const model = this.nameModel;
    return {
      screen: this.current,
      credits: this.credits.balance(),
      canStart: this.credits.canStart(),
      canContinue: this.credits.canContinue(),
      countdownMs: this.countdownMs(now),
      attractPanel: this.attractPanel(now),
      ranking: this.ranking.top(),
      // 이월 F-3 — `BEST TODAY`는 **로컬 날짜** 기준이다 (UTC 자정에 오늘이 바뀌면 안 된다)
      bestToday: this.ranking.bestOf(this.localDate()),
      run: this.controller === null ? null : this.controller.snapshot(),
      result: this.resultSummary,
      nameEntry:
        model === null
          ? null
          : { value: model.value, cursor: model.cursor, remainingMs: model.remainingMs(now) },
      paidPlays: this.paidPlaysCount,
      endReason: this.controller?.ended?.reason ?? this.resultSummary?.endReason ?? null,
      paidBlockReason: this.paidGate.reason(),
      safePause: this.safePause.view(now),
    };
  }

  // ── 입력 ───────────────────────────────────────────────────────────────

  /** §2.7 — **어떤 화면에서도 항상 적립**한다. 이 메서드에 화면 분기가 없다는 사실이 CTL-011이다 */
  private insertCoin(): void {
    const accepted = this.credits.insertCoin();
    this.sfx.play(accepted ? 'coin' : 'reject');
    // §4.7 — 어트랙트에서 코인이 들어오면 즉시 시작 화면으로
    if (this.current === 'ATTRACT' && this.credits.canStart()) this.go('READY');
  }

  /**
   * §2.7 — 어트랙트·시작 화면에서만 관리자로 진입한다.
   *
   * §12.3 · 가정 (나) — **런 중에는 SAFE PAUSE 토글**이다. 진행 중인 런을 버리고 관리자로
   * 보내면 플레이어가 낸 크레딧이 사라지므로, 정비 중 정지·재개만 허용한다.
   */
  private serviceKey(): void {
    if (this.current === 'ATTRACT' || this.current === 'READY') {
      this.adminReturn = this.current;
      this.go('ADMIN');
      return;
    }
    if (this.current === 'ADMIN') {
      this.leaveAdmin();
      return;
    }
    // WU-03 계약 — 런 중 SERVICE는 기본적으로 **무시**된다. 정비 키 스위치가 붙는 실기에서만
    // `serviceSafePause`로 켠다 (가정 (나) · 이월)
    if (!this.serviceSafePause) return;
    if (this.current === 'RUN' || this.current === 'TUTORIAL') this.toggleSafePause();
  }

  /**
   * SERVICE 1회 = 정지, 다시 1회 = 해제(3초 카운트다운). 도어 정지는 SERVICE로 풀지 않는다.
   * 공개 메서드다 — 실기 어댑터·테스트가 키 배선 없이도 SAFE PAUSE를 실행할 수 있다.
   */
  toggleSafePause(): void {
    if (this.safePause.state === 'idle') {
      this.safePause.trigger('service');
      this.sfx.play('reject');
      return;
    }
    if (this.safePause.state === 'paused' && this.safePause.reason === 'service') {
      this.safePause.release(this.clock.now());
      this.sfx.play('confirm');
    }
  }

  /** §12.3 — 도어 신호를 상태 모델에 옮긴다. 실물은 §17 `[보류]`라 기본은 항상 닫힘이다 */
  private pollDoor(): void {
    const open = this.door.isOpen();
    if (open) {
      if (this.safePause.reason !== 'door') this.safePause.trigger('door');
      return;
    }
    if (this.safePause.state === 'paused' && this.safePause.reason === 'door') {
      this.safePause.release(this.clock.now());
    }
  }

  /** §12.3 — 도어·정비 어댑터가 직접 부르는 정지/해제 (키 배선과 무관한 실동작 경로) */
  safePauseNow(reason: 'service' | 'door' = 'service'): boolean {
    if (this.current !== 'RUN' && this.current !== 'TUTORIAL') return false;
    return this.safePause.trigger(reason);
  }

  releaseSafePause(): boolean {
    return this.safePause.release(this.clock.now());
  }

  /** §12.3 — 화면이 그리는 SAFE PAUSE 상태 */
  get safePauseView(): SafePauseView {
    return this.safePause.view(this.clock.now());
  }

  private handleAttract(action: InputAction): void {
    if (action === 'START') {
      // 코인 투입이 즉시 READY로 보내므로 이 분기는 사실상 크레딧 부족 경로다
      if (this.credits.canStart()) this.go('READY');
      else this.sfx.play('reject');
      return;
    }
    if (action === 'LEFT' || action === 'UP') this.stepAttractPanel(-1);
    else if (action === 'RIGHT' || action === 'DOWN') this.stepAttractPanel(1);
  }

  private handleContinue(action: InputAction): void {
    if (action === 'BUTTON2') {
      this.go('RESULT');
      return;
    }
    if (action !== 'BUTTON1') return;
    // QA-1(착수 §9 추기) — 컨티뉴도 **유료 결제**이므로 차단 조건이 서 있으면 받지 않는다.
    // 기록 불가 상태의 추가 결제 금지(§12.4 취지). 낸 크레딧은 지갑에 그대로 남고,
    // `G`(BUTTON2) 포기·시간 초과 → RESULT 흐름은 위에서 그대로 살아 있다
    if (!this.isTestPlay() && this.paidGate.reason() !== null) {
      this.sfx.play('reject');
      this.traceLog.push('paid-blocked');
      return;
    }
    // 작업 계획 Q-6 — 코인은 적립만 하고 **확정은 BUTTON1**이다 (§10.2 "확정 입력 직후" 차감)
    if (!this.credits.canContinue()) {
      this.sfx.play('reject');
      return;
    }
    const source = this.credits.chargeContinue();
    if (source === 'none') {
      this.sfx.play('reject');
      return;
    }
    if (!this.requireController().continueRun()) {
      // §10.2 — 낸 금액 그대로 되돌린다. `1` 하드코딩은 `CONTINUE COINS ≥ 2`에서 크레딧을 삼켰다
      this.credits.refund(this.credits.continueCoins, source, '컨티뉴 복귀 실패');
      this.go('RESULT');
      return;
    }
    this.sfx.play('confirm');
    this.go('RUN');
  }

  private handleNameEntry(action: InputAction): void {
    const model = this.requireNameModel();
    model.handle(action);
    if (model.committed) this.commitName(model);
  }

  // ── 전이 ───────────────────────────────────────────────────────────────

  /** §10.2 — 차감은 **START 유효 판정 직후, 미니 튜토리얼 진입 전**이다 (CRD-601) */
  private startPaidRun(): void {
    // §12.4 — 차단 조건이 하나라도 서 있으면 **지갑에 손대기 전에** 거절한다.
    // 크레딧은 그대로 남고(§12.4 "들어온 크레딧은 유지"), 화면이 사유를 표시한다 (P-5).
    // 관리자 테스트 플레이는 **면제**다(계획 §5 · FIX-2) — 크레딧 없는 진단 경로이므로
    // 저장 불가·치명 반복이 서 있을수록 오히려 실행할 수 있어야 한다 (§11.6)
    if (!this.isTestPlay() && this.paidGate.reason() !== null) {
      this.sfx.play('reject');
      this.traceLog.push('paid-blocked');
      return;
    }
    if (!this.credits.canStart()) {
      this.sfx.play('reject');
      return;
    }
    const source = this.credits.chargeStart();
    if (source === 'none') {
      this.sfx.play('reject');
      return;
    }
    this.chargedSource = source;
    this.paidPlaysCount += 1;
    this.sfx.play('confirm');
    // §10.2 — "차감 후 게임 진입에 실패하면 크레딧을 **원복**하고 사유를 남긴다".
    // 보드 생성이 끝내 실패하면 여기서 예외가 나오는데, WU-03까지는 그대로 크레딧이 사라졌다 (이월 F-3)
    try {
      // §4.1 · Q-4 — 앱 실행 후 유료 런 첫 3회만 미니 튜토리얼을 보여 준다.
      // **테스트 플레이도 예외가 아니다** — WU-04 CRD-607 ①이 그 동작을 이미 고정했다
      if (this.paidPlaysCount <= TUTORIAL_MAX_PLAYS) this.enterTutorial();
      else this.enterRun();
    } catch (err) {
      this.paidPlaysCount -= 1;
      this.credits.refund(this.credits.coinsPerPlay, this.chargedSource, '런 진입 실패');
      this.chargedSource = 'none';
      this.disposeController();
      this.sfx.play('reject');
      this.go(this.credits.canStart() ? 'READY' : 'ATTRACT');
      this.traceLog.push(`entry-failed:${String(err)}`);
    }
  }

  /** Q-5 — 전용 세션으로 돌리고 곧바로 정지한다. 본 런의 콤보 기준 시각이 오염되지 않는다 */
  private enterTutorial(): void {
    this.disposeController();
    this.controller = this.newController();
    this.controller.start(0, tutorialBoard());
    this.controller.setTutorial({ onlyChain: TUTORIAL_CHAIN_SAFE });
    this.controller.pause(); // §4.7 런 타이머 정지
    this.go('TUTORIAL');
  }

  private enterRun(): void {
    this.disposeController();
    this.controller = this.newController();
    this.controller.start(1);
    this.perfectStreak = 0;
    this.bestPerfectStreak = 0;
    this.go('RUN');
  }

  private tickTutorial(now: number): void {
    const controller = this.requireController();
    this.pollDoor();
    if (this.safePause.active) {
      const resumed = this.safePause.tick(now);
      this.lastInputAtMs = now;
      // 미니 튜토리얼은 런 타이머가 이미 멈춰 있다 — 카운트다운만 흘려보낸다
      if (!resumed) return;
    }
    controller.tick();
    const done = controller
      .snapshot()
      .chains.some((c) => c.id === TUTORIAL_CHAIN_SAFE && c.state === 'removed');
    if (done || now - this.lastInputAtMs >= TUTORIAL_IDLE_MS) this.enterRun();
  }

  private tickRun(now: number): void {
    const controller = this.requireController();
    // §12.3 SAFE PAUSE — 정지·카운트다운 중에는 런 타이머도 방치 종료도 돌지 않는다.
    // 무입력 시계를 계속 밀어 주지 않으면 정비를 마치고 돌아온 순간 5분 종료가 터진다
    this.pollDoor();
    if (this.safePause.active) {
      const resumed = this.safePause.tick(now);
      this.lastInputAtMs = now;
      if (!resumed) return;
    }
    // §2.7 다 — 무입력 종료는 런 타이머보다 **먼저** 본다. 같은 프레임에 둘 다 성립하면
    // 방치 종료가 이기고 CONTINUE를 건너뛴다 (SES-212)
    if (now - this.lastInputAtMs >= RUN_IDLE_END_MS) {
      controller.endRun('external');
      this.go('RESULT');
      return;
    }
    const report = controller.tick();
    if (report.settlement !== undefined) {
      this.perfectStreak = report.settlement.perfectBonus > 0 ? this.perfectStreak + 1 : 0;
      if (this.perfectStreak > this.bestPerfectStreak) this.bestPerfectStreak = this.perfectStreak;
    }
    const ended = controller.ended;
    if (ended !== null) {
      // §2.7 다 — 5분 무입력은 CONTINUE를 건너뛰고 결과 화면으로 간다
      this.go(ended.reason === 'external' ? 'RESULT' : 'CONTINUE');
    }
  }

  private tickNameEntry(now: number): void {
    const model = this.requireNameModel();
    if (model.expired(now)) this.commitName(model);
  }

  private leaveResult(): void {
    const summary = this.resultSummary;
    if (summary !== null && summary.qualifies) {
      this.nameModel = new NameEntryModel(this.clock.now(), this.uiTimings().nameEntryMs);
      this.go('NAME_ENTRY');
      return;
    }
    this.finishSession();
  }

  private commitName(model: NameEntryModel): void {
    const summary = this.resultSummary;
    if (summary !== null) {
      const rank = this.ranking.submit({
        initials: model.finalValue(),
        score: summary.score,
        board: summary.boardReached,
        maxComboCentis: summary.maxComboCentis,
        continues: summary.continues,
        // F-3 — 날짜부는 **로컬 날짜**, 시각부는 `nowIso()` 그대로다. 기본 주입에서는
        // 두 값이 같은 문자열이라 WU-03 판정이 한 줄도 바뀌지 않는다
        registeredAt: `${this.localDate()}${this.nowIso().slice(10)}`,
      });
      if (rank !== null) this.onRankingChanged();
    }
    this.nameModel = null;
    this.finishSession();
  }

  /** §2.7 — 남은 크레딧은 유지된다. `C` 이상이면 어트랙트를 건너뛰고 시작 화면으로 */
  private finishSession(): void {
    // §10.5 — 결과 화면 종료 = 세션 점유 시간의 끝. 요약을 지우기 **전에** 넘긴다 (P-4)
    const summary = this.resultSummary;
    if (summary !== null) {
      this.onSessionEnd({
        boardReached: summary.boardReached,
        score: summary.score,
        counted: !this.isTestPlay(),
      });
    }
    this.disposeController();
    this.resultSummary = null;
    this.chargedSource = 'none';
    this.go(this.credits.canStart() ? 'READY' : 'ATTRACT');
  }

  private leaveAdmin(): void {
    this.go(this.credits.canStart() ? 'READY' : this.adminReturn);
  }

  /**
   * §11.6 — 테스트 플레이 중단. 진행 중인 런을 **집계 없이** 버리고 관리자 화면으로 돌아간다.
   * 클리어·런 종료·`G` 2초 홀드 세 경로가 전부 여기로 모인다.
   */
  abortToAdmin(): void {
    this.disposeController();
    this.resultSummary = null;
    this.chargedSource = 'none';
    this.nameModel = null;
    this.go('ADMIN');
  }

  private go(next: Screen): void {
    const from = this.current;
    // 런이 끝났으면 정지 상태를 들고 다니지 않는다 (다음 런이 멈춘 채로 시작하면 안 된다)
    if (next !== 'RUN' && next !== 'TUTORIAL') this.safePause.reset();
    if (next === 'RESULT' && from !== 'RESULT') this.buildResult();
    this.current = next;
    this.enteredAtMs = this.clock.now();
    // 무입력 시계는 **화면 진입에서 다시 시작**한다. 튜토리얼 10초·인게임 5분은 "그 화면에
    // 들어온 뒤" 기준이며, 앞 화면에서 마지막으로 누른 시각을 물려받으면 안 된다 (§2.7 · §4.7)
    this.lastInputAtMs = this.enteredAtMs;
    this.traceLog.push(`${from}→${next}`);
    for (const fn of [...this.listeners]) fn(next, from);
  }

  private buildResult(): void {
    const controller = this.controller;
    if (controller === null) return;
    const run = controller.snapshot();
    const ended = controller.ended;
    const reason: EndReason = ended === null ? 'external' : ended.reason;
    const score = run.displayScore;
    this.resultSummary = {
      score,
      grade: gradeOf(score, this.bestPerfectStreak, this.gradeThresholds()),
      maxComboCentis: run.maxComboCentis,
      boardReached: run.boardNumber,
      continues: run.continueCount,
      endReason: reason,
      tip: tipReasonOf(reason, run.hearts),
      // §11.6 · CRD-607 — 테스트 플레이는 **랭킹에 일절 집계하지 않는다**.
      // `qualifies`가 false면 `NAME_ENTRY`에 아예 도달하지 않아 `ranking.submit()`이 불리지 않는다
      qualifies: !this.isTestPlay() && this.ranking.qualifies(score),
      perfectStreak: this.bestPerfectStreak,
    };
  }

  // ── 보조 ───────────────────────────────────────────────────────────────

  private newController(): RunController {
    const ui = this.uiTimings();
    return new RunController({
      session: this.makeSession(this.params, this.clock),
      boardSource: this.boardSource,
      clock: this.clock,
      sfx: this.sfx,
      params: this.params,
      hint: { displayMs: ui.hintShowMs, cooldownMs: ui.hintCooldownMs },
    });
  }

  private disposeController(): void {
    this.controller?.dispose();
    this.controller = null;
  }

  private stepAttractPanel(step: number): void {
    this.attractOffset = (this.attractOffset + step + ATTRACT_PANELS) % ATTRACT_PANELS;
    this.sfx.play('select');
  }

  private attractPanel(now: number): number {
    if (this.current !== 'ATTRACT') return 0;
    const auto = Math.floor((now - this.enteredAtMs) / ATTRACT_PANEL_MS);
    return (((auto + this.attractOffset) % ATTRACT_PANELS) + ATTRACT_PANELS) % ATTRACT_PANELS;
  }

  private countdownMs(now: number): number {
    const elapsed = now - this.enteredAtMs;
    switch (this.current) {
      case 'TUTORIAL':
        return Math.max(0, TUTORIAL_IDLE_MS - (now - this.lastInputAtMs));
      case 'CONTINUE':
        return Math.max(0, this.p.continuePromptTimeMs - elapsed);
      case 'RESULT':
        return Math.max(0, RESULT_AUTO_MS - elapsed);
      case 'NAME_ENTRY':
        return this.nameModel === null ? 0 : this.nameModel.remainingMs(now);
      case 'RUN':
        return Math.max(0, RUN_IDLE_END_MS - (now - this.lastInputAtMs));
      default:
        return 0;
    }
  }

  private requireController(): RunController {
    const controller = this.controller;
    if (controller === null) throw new Error(`FlowMachine: ${this.current} 화면에 런이 없다`);
    return controller;
  }

  private requireNameModel(): NameEntryModel {
    const model = this.nameModel;
    if (model === null) throw new Error('FlowMachine: 이름 입력 모델이 없다');
    return model;
  }

  /** 결제 소스 조회 — 진입 실패 원복(§10.2)이 필요한 호출자를 위한 표면 */
  get lastChargeSource(): ChargeSource {
    return this.chargedSource;
  }
}

/** §8.4 — 팁은 실패 원인에서 자동 선택한다 */
function tipReasonOf(reason: EndReason, hearts: number): TipReason {
  if (reason === 'hearts' || hearts <= 0) return 'hearts';
  if (reason === 'time') return 'time';
  return 'mistakes';
}
