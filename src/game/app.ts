// 조립 지점 (Composition Root) — 작업 계획 P-1
//
// **Phaser 타입을 쓰지 않는다.** 씬은 여기서 만든 `AppContext`를 레지스트리에서 읽기만 한다.
// 입력 구독도 여기 **1곳**뿐이다 — 씬마다 키를 다시 붙이면 중복 구독·해제 누락이 생기고,
// 그것이 아케이드에서 가장 흔한 입력 버그다.
//
// `performance.now()`·`new Date()`를 직접 부르는 곳도 이 파일뿐이다. 순수 계층은 주입된
// `Clock`·`WallClock`·`nowIso()`만 본다 (§6.6 재현성 · WU-04 §2.3 바).

import { CreditWallet } from '../core/credits';
import { FACTORY_PARAMS, type CoreParams } from '../core/params';
import { StatsModel, type AuditEvent, type AuditSink, type WallClock } from '../core/stats';
import type { Clock } from '../core/types';
import { FILES } from '../persist/csv';
import { browserEnvironment, Storage } from '../persist/storage';
import { fixtureBoardSource, type BoardSource } from './boardSource';
import { CrashRecovery, type RecoveryResult } from './crashRecovery';
import { CreditsService } from './creditsService';
import { FlowMachine } from './flow';
import { keyboard } from './input';
import type { InputAdapter } from './input';
import { RankingStore } from './rankingStore';
import { createSilentSfx, type Sfx } from './sfx';
import { statsSaveDocument } from './statsDoc';

export const APP_REGISTRY_KEY = 'arrowOutApp';

export interface AppContext {
  readonly flow: FlowMachine;
  readonly ranking: RankingStore;
  readonly credits: CreditsService;
  readonly stats: StatsModel;
  readonly recovery: CrashRecovery;
  readonly storage: Storage;
  readonly sfx: Sfx;
  readonly clock: Clock;
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
}

export interface AppOptions {
  readonly params?: CoreParams;
  readonly input?: InputAdapter;
  readonly boardSource?: BoardSource;
  readonly clock?: Clock;
  readonly wall?: WallClock;
  readonly storage?: Storage;
  readonly sfx?: Sfx;
  readonly nowIso?: () => string;
  /** §11.3 N11a·N11b·N11c — 운영 설정 연결(설정 화면)은 WU-05 */
  readonly coinsPerPlay?: number;
  readonly continueCoins?: number;
  readonly coinUnitPrice?: number | null;
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

  const flow = new FlowMachine({
    clock,
    credits,
    boardSource: options.boardSource ?? fixtureBoardSource(),
    ranking,
    params,
    sfx,
    nowIso,
    onRankingChanged: () => storage.scheduleSave(),
    onSessionEnd: (o) => {
      credits.closeSession(o);
    },
    isTestPlay: () => testPlay,
  });

  // §10.5 롤오버 3번째 지점(관리자 진입) · §10.6 마커 해제(정상 종료)는 기존 리스너로 얻는다 (P-5)
  const unwatchScreen = flow.onScreenChange((to) => {
    if (to === 'ADMIN') credits.noteAdminEntered();
    if (to === 'RESULT') recovery.clear();
  });

  /**
   * 부팅 순서 (§10.3 · §10.6 · P-9)
   *   ① 저장 문서 로드 → ② 유료 잔액 복원 → ③ 날짜 롤오버 확인
   *   → ④ 이벤트 잔액 0 → ⑤ 크래시 마커 복구
   */
  const ready: Promise<BootResult> = (async (): Promise<BootResult> => {
    await storage.init();
    const restoredPaid = credits.restorePaidFromLog(await storage.read(FILES.creditLog));
    credits.noteBoot();
    credits.clearEventBalance('boot');
    const result = recovery.recoverOnBoot();
    return { restoredPaid, recovery: result };
  })();

  const input = options.input ?? keyboard;
  input.attach();
  const unsubscribe = input.onAction((pa) => flow.handle(pa.action, pa.player));

  return {
    flow,
    ranking,
    credits,
    stats,
    recovery,
    storage,
    sfx,
    clock,
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
      input.detach();
    },
  };
}
