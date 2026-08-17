// 조립 지점 (Composition Root) — 작업 계획 P-1
//
// **Phaser 타입을 쓰지 않는다.** 씬은 여기서 만든 `AppContext`를 레지스트리에서 읽기만 한다.
// 입력 구독도 여기 **1곳**뿐이다 — 씬마다 키를 다시 붙이면 중복 구독·해제 누락이 생기고,
// 그것이 아케이드에서 가장 흔한 입력 버그다.
//
// `performance.now()`·`new Date()`를 직접 부르는 곳도 이 파일뿐이다. 순수 계층은 주입된
// `Clock`·`WallClock`·`nowIso()`만 본다 (§6.6 재현성 · WU-04 §2.3 바).

import {
  FACTORY_ADMIN_PARAMS,
  toCoreParams,
  type AdminParams,
  type SolverGate,
} from '../core/adminParams';
import { CreditWallet } from '../core/credits';
import { FACTORY_PARAMS, type CoreParams } from '../core/params';
import { StatsModel, type AuditEvent, type AuditSink, type WallClock } from '../core/stats';
import type { Clock } from '../core/types';
import { FILES } from '../persist/csv';
import { cutoffIso, pruneLog } from '../persist/retention';
import { browserEnvironment, Storage } from '../persist/storage';
import { AdminController } from './admin/controller';
import { AuditLogger } from './admin/audit';
import { ParamsStore } from './admin/paramsDoc';
import { realSolverGate } from './admin/solverGate';
import { testPlayBoardSource, type TestPlaySpec } from './admin/testPlay';
import { proceduralBoardSource, type BoardRequest, type BoardSource } from './boardSource';
import { CrashRecovery, type RecoveryResult } from './crashRecovery';
import { CreditsService } from './creditsService';
import { FlowMachine, type UiTimings } from './flow';
import { readHealth, type HealthReport } from './health';
import { keyboard, asPhaseSource } from './input';
import type { InputAdapter } from './input';
import { RankingStore } from './rankingStore';
import { SafetyMonitor } from './safety';
import { SettingsStore } from './settingsDoc';
import { createSilentSfx, type Sfx } from './sfx';
import { statsSaveDocument } from './statsDoc';
import { FxRuntime } from './fx';

export const APP_REGISTRY_KEY = 'arrowOutApp';

/** §11.6 — 테스트 플레이를 중단하고 편집 화면으로 돌아가는 `G` 홀드 시간 */
export const TEST_PLAY_ABORT_HOLD_MS = 2000;

export interface AppContext {
  readonly flow: FlowMachine;
  readonly ranking: RankingStore;
  readonly credits: CreditsService;
  readonly stats: StatsModel;
  readonly recovery: CrashRecovery;
  readonly storage: Storage;
  readonly sfx: Sfx;
  /** §9.2·§9.4 — 효과 예산, MOTION REDUCE, 프레임·입력 지연 계측 (WU-07) */
  readonly fx: FxRuntime;
  readonly clock: Clock;
  /** §11 관리자 페이지 — 8그룹 전 화면의 순수 컨트롤러 (WU-05) */
  readonly admin: AdminController;
  readonly params: ParamsStore;
  readonly settings: SettingsStore;
  /** §12.4 유료 차단 게이트 · §12.3 부팅 경고 (WU-06 P-5) */
  readonly safety: SafetyMonitor;
  /** 부팅 순서(§4.4 · §10.6)가 끝날 때 resolve — 테스트·씬이 기다린다 */
  readonly ready: Promise<BootResult>;
  /** §11.6 관리자 테스트 플레이 — WU-05가 뒤집는다. 플래그 소유는 여기 1곳뿐이다 */
  setTestPlay(on: boolean): void;
  isTestPlay(): boolean;
  /** WU-05 감사 로그 파일이 붙을 자리 (P-12 — WU-04는 콜백까지만) */
  onAudit(fn: AuditSink): () => void;
  dispose(): void;
}

export interface BootResult {
  /** `credit_log.csv`에서 되살린 유료 잔액 (P-9) */
  readonly restoredPaid: number;
  /** §10.6 크래시 복구 결과 */
  readonly recovery: RecoveryResult;
  /** §12.3 — 메인 프로세스 상태. 브라우저 개발 모드는 null (WU-06 P-8) */
  readonly health: HealthReport | null;
  /** SAV-706 — 12개월 보존 정리로 지운 행 수 (파일별) */
  readonly pruned: Readonly<Record<string, number>>;
}

export interface AppOptions {
  readonly params?: CoreParams;
  readonly input?: InputAdapter;
  readonly boardSource?: BoardSource;
  readonly clock?: Clock;
  readonly wall?: WallClock;
  readonly storage?: Storage;
  readonly sfx?: Sfx;
  readonly fx?: FxRuntime;
  readonly nowIso?: () => string;
  /** §11.3 N11a·N11b·N11c — `MACHINE SETTINGS`가 저장한 값이 부팅 순서에서 덮어쓴다 */
  readonly coinsPerPlay?: number;
  readonly continueCoins?: number;
  readonly coinUnitPrice?: number | null;
  /**
   * §11.5 솔버 게이트. 테스트는 대역을 주입할 수 있고 기본은 WU-08 실물 게이트다.
   */
  readonly solverGate?: SolverGate;
  /** §17 `[보류]` #3 — 실물 재시작·재부팅·종료 채널 */
  readonly system?: {
    restart(): Promise<string>;
    reboot(): Promise<string>;
    shutdown(): Promise<string>;
  };
}

/** 단조 시계 — `performance.now()`가 없으면 월클럭으로 강등한다 */
function systemClock(): Clock {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf === undefined ? { now: () => Date.now() } : { now: () => perf.now() };
}

/** 벽시계 — 롤오버는 **OS 로컬 날짜** 기준이다 (§10.5 · admin §11.5). UTC가 아니다 */
export function systemWallClock(): WallClock {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    nowMs: () => Date.now(),
    localDate: () => {
      const d = new Date();
      return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    },
    nowIso: () => new Date().toISOString(),
  };
}

export function createApp(options: AppOptions = {}): AppContext {
  const clock = options.clock ?? systemClock();
  const wall = options.wall ?? systemWallClock();
  const params = options.params ?? FACTORY_PARAMS;
  const sfx = options.sfx ?? createSilentSfx();
  const fx = options.fx ?? new FxRuntime();
  const nowIso = options.nowIso ?? ((): string => new Date().toISOString());

  // §11.6 — 테스트 플레이 플래그는 이 변수 1개가 전부다 (계획 §9)
  let testPlay = false;
  const auditListeners = new Set<AuditSink>();
  const audit: AuditSink = (e: AuditEvent) => {
    for (const fn of [...auditListeners]) fn(e);
  };

  const storage = options.storage ?? new Storage({ env: browserEnvironment() });
  const stats = new StatsModel({ wall, audit });
  const wallet = new CreditWallet();
  const ranking = new RankingStore();
  const paramsStore = new ParamsStore();
  const settingsStore = new SettingsStore();
  // 저장 파일이 없을 때의 기준값은 **호출자가 넘긴 옵션**이다. `storage.init()`이 파일을
  // 읽으면 그쪽이 이긴다 — 그래서 부팅 뒤 반영이 옵션을 덮어쓰지 않는다
  paramsStore.set({ ...FACTORY_ADMIN_PARAMS, core: params });
  settingsStore.set({
    ...FACTORY_ADMIN_PARAMS.machine,
    ...(options.coinsPerPlay === undefined ? {} : { coinsPerPlay: options.coinsPerPlay }),
    ...(options.continueCoins === undefined ? {} : { continueCoins: options.continueCoins }),
    ...(options.coinUnitPrice === undefined ? {} : { coinUnitPrice: options.coinUnitPrice }),
  });
  sfx.configure?.(settingsStore.machine);
  fx.configure(settingsStore.machine);
  settingsStore.mirrorInitialHearts(params.initialHearts);
  // WU-04 P-12가 비워 둔 자리 — 감사 이벤트를 그대로 `audit_log.csv` 1줄로 옮긴다
  const auditLogger = new AuditLogger({
    append: (file, line) => {
      void storage.appendLine(file, line);
    },
  });
  auditListeners.add((e) => {
    auditLogger.write(e);
  });

  const credits = new CreditsService({
    stats,
    clock,
    nowIso,
    wallet,
    audit,
    appendCreditLog: (line) => storage.appendLineStrict(FILES.creditLog, line),
    coinsPerPlay: options.coinsPerPlay ?? 1, // §10.1 N11a — 운영 설정 연결은 WU-05
    continueCoins: options.continueCoins ?? 1, // §10.1 N11b
    coinUnitPrice: options.coinUnitPrice ?? null, // §10.1 N11c — 미설정이면 ESTIMATED GROSS를 숨긴다
    isTestPlay: () => testPlay,
    onRunCharged: (m) => {
      recovery.mark(m);
    },
    // §10.6 · 검증 V-1 — 원복된 결제는 "소비된" 크레딧이 아니므로 복구 대상에서 뺀다.
    // 진입 실패 뒤에는 `RESULT`를 거치지 않고 `READY`/`ATTRACT`로 돌아가므로
    // 화면 리스너(`to === 'RESULT'`)만으로는 마커가 남는다
    onRunReverted: () => {
      recovery.clear();
    },
    onStatsChanged: () => storage.scheduleSave(),
  });

  // §12.4 — 다섯 차단 조건을 한 곳에서 판정한다. `flow`에는 훅이 1개만 붙는다 (P-5)
  const safety = new SafetyMonitor({
    storage: {
      get backendKind() {
        return storage.backendKind;
      },
      get saveFailStreak() {
        return storage.saveFailStreak;
      },
      bootOutcomeOf: (file) => storage.bootOutcomeOf(file),
    },
    credits: {
      get blockReason() {
        return credits.blockReason;
      },
    },
  });

  const recovery = new CrashRecovery({
    stats,
    credits,
    nowIso,
    audit,
    saveNow: () => {
      void storage.saveNow(FILES.stats);
    },
  });

  storage.register(ranking.asSaveDocument());
  storage.register(statsSaveDocument(stats));
  storage.register(paramsStore.asSaveDocument());
  storage.register(settingsStore.asSaveDocument());

  // §11.6 — 테스트 플레이만 보드 공급원을 갈아 끼운다. `FlowMachine`은 이 라우터 1개만 본다
  const baseBoards =
    options.boardSource ??
    proceduralBoardSource({
      now: () => clock.now(),
      onFallback: (message) => storage.logError(message),
    });
  let boardOverride: BoardSource | null = null;
  const boards: BoardSource = {
    next: (req: BoardRequest) => (boardOverride ?? baseBoards).next(req),
    prepare: (req: BoardRequest) => (boardOverride ?? baseBoards).prepare?.(req),
    report: (result) => (boardOverride ?? baseBoards).report?.(result),
    bundle: (boardNumber) => (boardOverride ?? baseBoards).bundle?.(boardNumber) ?? null,
  };

  // 관리자 컨트롤러는 flow보다 나중에 만들어지므로 참조를 지연해서 잡는다
  let admin: AdminController | null = null;

  const flow = new FlowMachine({
    clock,
    credits,
    boardSource: boards,
    ranking,
    params,
    sfx,
    nowIso,
    onRankingChanged: () => storage.scheduleSave(),
    onSessionEnd: (o) => {
      credits.closeSession(o);
    },
    isTestPlay: () => testPlay,
    // Q-1 — §11.4 등급 임계·힌트 시간·이름 입력 시간을 실제 런타임에 반영한다.
    // 기본값이 공장값이라 관리자가 손대지 않으면 WU-03과 완전히 같이 동작한다
    gradeThresholds: () => {
      const g = (admin?.liveParams ?? live()).grade;
      return { 'S+': g.sPlus, S: g.s, A: g.a, B: g.b };
    },
    scorePercentile: (score) => credits.scorePercentile(score),
    uiTimings: (): UiTimings => {
      const ui = (admin?.liveParams ?? live()).ui;
      return {
        hintShowMs: Math.round(ui.hintShowSec * 1000),
        hintCooldownMs: Math.round(ui.hintCooldownSec * 1000),
        nameEntryMs: Math.round(ui.nameEntrySec * 1000),
      };
    },
    adminInput: (action) => admin?.handle(action),
    adminIdleGuard: () => admin?.idleGuard() ?? true,
    // §12.4 — 유료 시작 차단. 게이트 하나가 다섯 조건 전부를 대표한다 (P-5)
    paidGate: safety,
    // 이월 F-3 — 랭킹 날짜·`BEST TODAY`는 **로컬 날짜** 기준이다
    localDate: () => wall.localDate(),
  });

  /** 저장 문서 2종을 합친 현재 라이브 값 */
  function live(): AdminParams {
    return { ...paramsStore.live, machine: settingsStore.machine };
  }

  /** §11.6 — 테스트 플레이로 나가기 전에 있던 관리자 화면. 복귀하면 그 자리로 되돌린다 */
  let testPlayReturn: readonly string[] | null = null;

  /**
   * 클리어·런 종료·`G` 2초 홀드 — 세 경로가 전부 여기로 모인다.
   *
   * **관리자 화면에서 시작한 테스트 플레이만** 관리자로 되돌린다. `setTestPlay(true)`만 켜고
   * 직접 런을 돌리는 경로(WU-04 CRD-607)는 예전처럼 `READY`/`ATTRACT`로 나간다.
   */
  function finishTestPlay(): void {
    if (!testPlay || testPlayReturn === null) return;
    const summary = flow.snapshot().result;
    admin?.endTestPlay({ score: summary?.score ?? 0, grade: summary?.grade ?? null });
    flow.abortToAdmin();
  }

  // §10.5 롤오버 3번째 지점(관리자 진입) · §10.6 마커 해제(정상 종료)는 기존 리스너로 얻는다 (P-5)
  const unwatchScreen = flow.onScreenChange((to, from) => {
    // MOTION REDUCE는 NEXT GAME: 런 진입에서 캡처하고 해당 런 도중에는 바꾸지 않는다.
    if (to === 'TUTORIAL' || (to === 'RUN' && from !== 'TUTORIAL' && from !== 'CONTINUE')) {
      fx.beginRun();
    }
    if (to === 'RESULT' || to === 'ATTRACT' || to === 'ADMIN') fx.endRun();
    if (to === 'ADMIN') {
      credits.noteAdminEntered();
      // 테스트 플레이 복귀는 **작업 사본을 지우지 않는다** — 진입 절차를 다시 밟지 않는다
      if (testPlayReturn !== null) {
        admin?.resume(testPlayReturn);
        testPlayReturn = null;
      } else {
        admin?.enter();
      }
    }
    if (to === 'RESULT') recovery.clear();
    // §11.6 — 테스트 런이 끝나면 결과를 관리자에 넘기고 편집 화면으로 되돌린다
    if (from === 'RESULT' && testPlay) finishTestPlay();
  });

  admin = new AdminController({
    clock,
    nowIso,
    params: paramsStore,
    settings: settingsStore,
    storage,
    solverGate: options.solverGate ?? realSolverGate(),
    credits,
    ranking,
    audit,
    sfx,
    applyParams: (p) => {
      flow.applyParams(toCoreParams(p));
      baseBoards.configure?.(p);
      sfx.configure?.(p.machine);
      fx.configure(p.machine);
    },
    leaveAdmin: () => {
      flow.handle('SERVICE');
    },
    inputStatus: () => input.status,
    // §12.3 · §12.4 — 부팅 경고·유료 차단 사유·STORAGE LOW의 유일한 출처 (WU-06 P-5 · P-8)
    safety,
    health: () => readHealth(storage),
    ...(options.system === undefined ? {} : { system: options.system }),
    testPlay: {
      start: (spec: TestPlaySpec, draft: AdminParams) => {
        testPlay = true;
        testPlayReturn = admin?.currentPath ?? [];
        boardOverride = testPlayBoardSource(baseBoards, spec);
        baseBoards.configure?.(draft);
        flow.applyParams(toCoreParams(draft));
        flow.handle('SERVICE'); // ADMIN → READY (테스트 플레이는 크레딧 없이 시작할 수 있다)
        flow.handle('START');
      },
      stop: () => {
        testPlay = false;
        boardOverride = null;
        baseBoards.configure?.(live());
        flow.applyParams(toCoreParams(live()));
      },
    },
    runSnapshot: () => flow.snapshot().run,
  });

  /**
   * SAV-706 — `credit_log.csv`·`audit_log.csv`의 12개월 초과 행을 부팅 시 1회 걷어 낸다.
   *
   * 파일을 나누지 않는다(착수 Q2(a)) — WU-04 잔액 복원과 WU-05 감사 조회가 단일 파일을
   * 전제하기 때문이다. **내용이 실제로 바뀐 파일만** 다시 쓴다.
   */
  async function pruneAppendLogs(): Promise<Record<string, number>> {
    const cutoff = cutoffIso(nowIso());
    const out: Record<string, number> = {};
    for (const file of [FILES.creditLog, FILES.auditLog] as const) {
      // FIX 사이클 1 (검증 F-3) — read-modify-write를 `rewriteLog()`로 감싼다. 정리 도중
      // 들어온 append(부팅 중 코인 적립)는 버퍼에 쌓였다가 재기록 뒤 반영되므로 유실되지 않는다.
      // 실패는 `rewriteLog`가 삼킨다 — 다음 부팅에 다시 시도한다
      await storage.rewriteLog(file, (csv) => {
        if (csv === null) return null;
        const result = pruneLog(csv, cutoff);
        out[file] = result.removed;
        return result.changed ? result.next : null;
      });
    }
    return out;
  }

  /**
   * 부팅 순서 (§10.3 · §10.6 · P-9)
   *   ① 저장 문서 로드 → ② 유료 잔액 복원 → ③ 날짜 롤오버 확인
   *   → ④ 이벤트 잔액 0 → ⑤ 크래시 마커 복구
   */
  const ready: Promise<BootResult> = (async (): Promise<BootResult> => {
    await storage.init();
    // §11.4 — 저장된 파라미터를 코어·서비스에 반영한다. 여기가 `params.csv` → 런타임의 유일한 통로다
    const loaded = live();
    flow.applyParams(toCoreParams(loaded));
    baseBoards.configure?.(loaded);
    credits.setCoinsPerPlay(loaded.machine.coinsPerPlay);
    credits.setContinueCoins(loaded.machine.continueCoins);
    credits.setCoinUnitPrice(loaded.machine.coinUnitPrice);
    sfx.configure?.(loaded.machine);
    fx.configure(loaded.machine);
    settingsStore.mirrorInitialHearts(loaded.core.initialHearts);
    // admin §4.3 `RESTART REQUIRED` — 분포 전환 표본 수는 **부팅에서만** 반영된다
    stats.setRingCapacity(loaded.grade.sampleThreshold);
    admin.refreshFromStores();
    const restoredPaid = credits.restorePaidFromLog(await storage.read(FILES.creditLog));
    credits.noteBoot();
    credits.clearEventBalance('boot');
    const result = recovery.recoverOnBoot();
    // §12.3 — 메인 프로세스 상태(치명 오류 창 · 디스크 여유 · machine.json). 가정 (라)
    const health = await readHealth(storage);
    safety.setHealth(health);
    // SAV-706 — 12개월 초과 로그 정리는 **부팅 1회**다. 바뀐 파일만 다시 쓴다
    const pruned = await pruneAppendLogs();
    return { restoredPaid, recovery: result, health, pruned };
  })();

  const input = options.input ?? keyboard;
  input.attach();
  const unsubscribe = input.onAction((pa) => {
    fx.noteInput(clock.now());
    flow.handle(pa.action, pa.player);
  });
  // P-6 — 누름/뗌 스트림을 **가진 어댑터에서만** 결선한다. 인터페이스는 바뀌지 않았다
  const phaseSource = asPhaseSource(input);
  // §11.6 — 테스트 플레이 중 `G`를 2초 유지하면 편집 화면으로 돌아온다.
  // 런 화면에서는 `BUTTON2`가 힌트라 액션 스트림으로는 구분할 수 없고, 이 홀드 판정이 유일한 길이다
  let abortHoldFromMs: number | null = null;
  const unsubscribePhase =
    phaseSource === null
      ? null
      : phaseSource.onPhase((e) => {
          admin.phase(e);
          if (e.player !== 1 || e.action !== 'BUTTON2') return;
          if (e.phase === 'down') {
            abortHoldFromMs = testPlay && flow.screen !== 'ADMIN' ? clock.now() : null;
            return;
          }
          const from = abortHoldFromMs;
          abortHoldFromMs = null;
          if (from !== null && clock.now() - from >= TEST_PLAY_ABORT_HOLD_MS) finishTestPlay();
        });

  return {
    flow,
    ranking,
    credits,
    stats,
    recovery,
    storage,
    sfx,
    fx,
    clock,
    admin,
    params: paramsStore,
    settings: settingsStore,
    safety,
    ready,
    setTestPlay(on: boolean): void {
      testPlay = on;
    },
    isTestPlay(): boolean {
      return testPlay;
    },
    onAudit(fn: AuditSink): () => void {
      auditListeners.add(fn);
      return () => auditListeners.delete(fn);
    },
    dispose(): void {
      unwatchScreen();
      unsubscribe();
      unsubscribePhase?.();
      input.detach();
      sfx.dispose?.();
    },
  };
}
