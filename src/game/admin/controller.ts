// 관리자 컨트롤러 — 8그룹 전 화면의 조립 지점 (§11 전체 · admin §3~§13 — 작업 계획 P-1 · §9)
//
// **Phaser를 모른다.** 입력 라우팅 → 메뉴/편집기/위험 게이트 → `AdminView` 산출까지가 전부이고,
// 씬은 그 뷰를 그리기만 한다. 그래서 8그룹 전 화면·저장 검증·위험 작업이 Node 테스트로 판정된다.
//
// 화면 종류가 늘어도 늘어나는 것은 `rowsFor()`의 태그 1개뿐이다 — 항목별 분기는 없다.

import {
  FACTORY_ADMIN_PARAMS,
  FIELD_SCHEMA,
  PARAM_TIERS,
  fieldsOfGroup,
  specOfCell,
  validateAdminParams,
  type AdminParams,
  type DifficultyPreset,
  type FieldGroup,
  type FieldSpec,
  type ParamTier,
  type SolverGate,
  type ValidationReport,
} from '../../core/adminParams';
import type { AuditEvent, AuditSink, StatsView } from '../../core/stats';
import type { Clock, InputAction } from '../../core/types';
import { FILES, type SaveFileName } from '../../persist/csv';
import type { Storage } from '../../persist/storage';
import type { CreditBalance } from '../creditsService';
import type { Grade } from '../grade';
import type { HealthReport } from '../health';
import type { BlockReason, BootNotice } from '../safety';
import type { InputStatus, PhaseEvent } from '../input';
import type { RunSnapshot } from '../runController';
import type { Sfx } from '../sfx';
import type { SettingsStore } from '../settingsDoc';
import { DangerGate, type DangerRequest, type RiskLevel } from './danger';
import {
  InputTestModel,
  SerialState,
  overallStatus,
  probeStorage,
  statusReasons,
  type OverallStatus,
  type StorageProbeResult,
} from './diagnostics';
import { FieldEditor, formatChange, formatFieldValue } from './editor';
import { ADMIN_GROUPS, RowCursor, breadcrumbOf, findNode, type MenuNode } from './menu';
import type { ParamsStore } from './paramsDoc';
import { TestPlaySession, TIER_REPRESENTATIVE_BOARD, type TestPlaySpec } from './testPlay';
import {
  ADMIN_TEXT,
  FOOTER,
  MARKER,
  TOAST_MS,
  formatCount,
  formatDurationMs,
  formatMoney,
  formatStamp,
  infoRow,
  issueLines,
  menuRow,
  statusText,
  type AdminRow,
  type AdminToast,
  type AdminView,
  type DangerView,
  type ToastLevel,
} from './view';

/** admin §8.5 — 값 변경 후 800ms 디바운스 CSV 저장 */
export const MACHINE_SAVE_DEBOUNCE_MS = 800;

/** admin §3.2 — `SAVED · YYYY-MM-DD HH:MM:SS`를 최소 1초 표시한 뒤 복귀한다 */
export const EXIT_SAVED_HOLD_MS = 1000;

type SaveState = 'SAVED' | 'SAVING' | 'UNSAVED' | 'SAVE FAILED';

export interface AdminCreditsPort {
  view(): StatsView;
  balance(): CreditBalance;
  grantEvent(n: number, reason?: string): number;
  resetPaidStatistics(): void;
  resetEventStatistics(): void;
  setCoinUnitPrice(price: number | null): void;
  setCoinsPerPlay(n: number): void;
  setContinueCoins(n: number): void;
  readonly coinsPerPlay: number;
  readonly continueCoins: number;
  readonly coinUnitPrice: number | null;
}

interface AdminRankingPort {
  readonly size: number;
  clear(): void;
}

/** §17 `[보류]` #3 — REBOOT·SHUTDOWN은 홀드·경고·감사까지 하고 실행은 보류를 돌려준다 */
interface AdminSystemPort {
  restart(): Promise<string>;
  reboot(): Promise<string>;
  shutdown(): Promise<string>;
}

interface AdminTestPlayPort {
  start(spec: TestPlaySpec, draft: AdminParams): void;
  stop(): void;
}

export interface AdminControllerDeps {
  readonly clock: Clock;
  readonly nowIso: () => string;
  readonly params: ParamsStore;
  readonly settings: SettingsStore;
  readonly storage: Storage;
  readonly solverGate: SolverGate;
  readonly credits: AdminCreditsPort;
  readonly ranking: AdminRankingPort;
  readonly audit: AuditSink;
  readonly sfx: Sfx;
  /** SAVE 통과 시 코어·서비스에 반영하는 유일한 경로 (P-8 — 반영 시점은 NEXT GAME) */
  readonly applyParams: (p: AdminParams) => void;
  /** `EXIT & SAVE` · 5분 유휴 복귀 */
  readonly leaveAdmin: () => void;
  readonly inputStatus?: () => InputStatus;
  readonly system?: AdminSystemPort;
  readonly testPlay?: AdminTestPlayPort;
  readonly runSnapshot?: () => RunSnapshot | null;
  /**
   * §12.3 · §12.4 — 부팅 경고(BACKUP RESTORED · FACTORY DATA LOADED · PARAM 버전)와
   * 유료 차단 사유의 유일한 출처 (WU-06 P-5). 넘기지 않으면 경고도 차단 표시도 없다.
   */
  readonly safety?: AdminSafetyPort;
  /**
   * §12.3 — 메인 프로세스 상태(STORAGE LOW · 치명 오류 창). 가정 (라)에 따라 **부팅 시와
   * 관리자 진입 시** 다시 읽는다. 브라우저 개발 모드는 null이다 (WU-06 P-8).
   */
  readonly health?: () => Promise<HealthReport | null>;
}

/** `SafetyMonitor`가 그대로 만족하는 최소 표면 */
export interface AdminSafetyPort {
  reason(): BlockReason | null;
  consumeBootNotices(): readonly BootNotice[];
  setHealth(report: HealthReport | null): void;
}

/** 실행이 실패했을 때 어떤 종류로 감사 로그를 남길지 (admin §13 "성공·실패 모두") */
const DANGER_AUDIT_KIND: Readonly<Record<string, AuditEvent['kind']>> = {
  'reset.paid': 'STATS_RESET',
  'reset.event': 'STATS_RESET',
  'reset.ranking': 'RANKING_RESET',
  'reset.params': 'PARAM_RESTORE',
  'restore.group': 'PARAM_RESTORE',
  'grant.event': 'EVENT_GRANT',
  'save.warned': 'PARAM_SAVE',
  'system.restart': 'SYSTEM_ACTION',
  'system.reboot': 'SYSTEM_ACTION',
  'system.shutdown': 'SYSTEM_ACTION',
};

/** 위험 등급 배정 — admin §13 표를 그대로 옮긴 것 */
const RISK_OF: Readonly<Record<string, RiskLevel>> = {
  'reset.paid': 'HIGH',
  'reset.event': 'HIGH',
  'reset.ranking': 'HIGH',
  'reset.params': 'HIGH',
  'save.warned': 'HIGH',
  'restore.group': 'MEDIUM',
  'grant.event': 'MEDIUM',
  'system.restart': 'HIGH',
  'system.reboot': 'CRITICAL',
  'system.shutdown': 'CRITICAL',
};

export class AdminController {
  private readonly deps: AdminControllerDeps;
  private readonly cursor = new RowCursor();
  private readonly danger = new DangerGate();
  private readonly inputTest = new InputTestModel();
  private readonly serial = new SerialState();
  private readonly session = new TestPlaySession();

  private path: string[] = [];
  private editor: FieldEditor;
  private cellIndex = 0;
  private toastRef: (AdminToast & { untilMs: number }) | null = null;
  private saveStateRef: SaveState = 'SAVED';
  private lastSavedStamp = '';
  private report: ValidationReport | null = null;
  private probe: StorageProbeResult | null = null;
  private machineSaveAtMs: number | null = null;
  private unsavedPrompt = false;
  private exitAtMs: number | null = null;
  private testSpec: TestPlaySpec = { tier: 'WARMUP', seed: 1 };
  private entered = false;
  private cachedRows: readonly AdminRow[] = [];
  /** ADM-302 · SAV-702 — 저장이 실패한 채 복구 화면에 서 있는가 (P-13) */
  private saveFailedPrompt = false;
  /** §12.3 — 이번 부팅의 경고 목록. **최초 진입에서 한 번만** 채워진다 (P-1 · P-12) */
  private bootNoticeLines: readonly string[] = [];
  private healthRef: HealthReport | null = null;

  constructor(deps: AdminControllerDeps) {
    this.deps = deps;
    this.editor = new FieldEditor(this.compose());
  }

  // ── 진입·종료 (admin §3.1·§3.2) ──────────────────────────────────────────

  /**
   * 진입 5단계 (admin §3.1). 1·2단계는 이미 성립해 있다 —
   * ① `flow.serviceKey()`가 어트랙트·시작 화면만 허용하고(ADM-002)
   * ② `credits.noteAdminEntered()`를 `app.ts` 화면 리스너가 부른다(ADM-104).
   * 여기서는 ③ 장치 검사 ④ 잔액·미완료 저장 확인 ⑤ HOME + `admin_enter` 감사 로그를 한다.
   */
  enter(): void {
    this.path = [];
    this.cellIndex = 0;
    this.editor = new FieldEditor(this.compose());
    this.report = null;
    this.unsavedPrompt = false;
    this.exitAtMs = null;
    this.entered = true;
    this.saveFailedPrompt = false;
    this.serial.setStatus(this.deps.inputStatus?.() ?? 'connected');
    void this.runStorageProbe();
    // 부팅 경고는 **동기적으로** 흡수한다 — 진입 직후 그린 OVERVIEW가 경고를 놓치면 안 된다
    this.absorbBootNotices();
    // 가정 (라) — STORAGE LOW·치명 오류 창은 관리자 진입마다 다시 읽는다
    void this.refreshHealth();
    this.cursor.reset(this.rows());
    this.audit('ADMIN_ENTER', {
      target: 'ADMIN HOME',
      after: `credit ${String(this.deps.credits.balance().paid)}/${String(this.deps.credits.balance().event)}`,
    });
  }

  /**
   * §11.6 — 테스트 플레이에서 돌아왔다. **작업 사본을 그대로 두고** 편집하던 화면으로 복원한다
   * (`enter()`는 작업 사본을 버리므로 이 경로에서는 부르면 안 된다).
   */
  resume(path: readonly string[]): void {
    this.entered = true;
    this.exitAtMs = null;
    this.unsavedPrompt = false;
    if (!this.goTo(path)) this.goTo([]);
  }

  get isEntered(): boolean {
    return this.entered;
  }

  /**
   * ADM-006 — **작업 사본에 미저장 편집이 있는가**. 있으면 5분 유휴 자동 복귀를 막는다.
   *
   * 디바운스 대기 중인 자동 저장은 여기 넣지 않는다. 그것은 이미 확정된 값이 파일에 닿기를
   * 기다리는 것이고 스스로 완료되므로, 그것 때문에 복귀를 영구히 막으면 기기가 관리자 화면에
   * 갇힌다. 진행 상황은 `saveState`(`UNSAVED → SAVING → SAVED`)로 따로 보여 준다.
   */
  hasUnsavedWork(): boolean {
    return this.editor.dirty;
  }

  /** 예약된 자동 저장이 남아 있는가 (진입 4단계 "미완료 저장 확인" · 화면 표시용) */
  hasPendingSave(): boolean {
    return this.deps.storage.hasPendingSave;
  }

  /** 5분 유휴 가드 — `flow`가 그대로 부른다 */
  idleGuard = (): boolean => {
    if (!this.hasUnsavedWork()) return true;
    this.toast(ADMIN_TEXT.idleBlocked, 'warn');
    this.deps.sfx.play('reject');
    return false;
  };

  // ── 입력 ──────────────────────────────────────────────────────────────────

  /** 관리자 화면의 유일한 입력 입구. `START`는 `flow`가 이미 걸러 냈다 */
  handle(action: InputAction): void {
    if (this.danger.locked) return; // 실행 중 입력 잠금 (admin §13)
    switch (action) {
      case 'UP':
        this.moveCursor(-1);
        return;
      case 'DOWN':
        this.moveCursor(1);
        return;
      case 'LEFT':
        this.adjust(-1);
        return;
      case 'RIGHT':
        this.adjust(1);
        return;
      case 'BUTTON1':
        this.confirm();
        return;
      case 'BUTTON2':
        this.back();
        return;
      default:
        return;
    }
  }

  /** 누름/뗌 스트림 (P-6) — 홀드 확인과 `INPUT TEST`가 함께 먹는다 */
  phase(e: PhaseEvent): void {
    const now = this.deps.clock.now();
    this.inputTest.handle(e, now);
    if (e.player !== 1 || e.action !== 'BUTTON1') return;
    if (e.phase === 'up') this.finishDanger(this.danger.release(now));
  }

  tick(): void {
    const now = this.deps.clock.now();
    this.finishDanger(this.danger.tick(now));
    if (this.toastRef !== null && now >= this.toastRef.untilMs) this.toastRef = null;
    if (this.machineSaveAtMs !== null && now >= this.machineSaveAtMs) {
      this.machineSaveAtMs = null;
      void this.flushMachineSave();
    }
    if (this.exitAtMs !== null && now >= this.exitAtMs) {
      this.exitAtMs = null;
      this.entered = false;
      this.deps.leaveAdmin();
    }
    if (this.session.active) this.session.observe(this.deps.runSnapshot?.() ?? null, now);
  }

  // ── 커서·편집 ─────────────────────────────────────────────────────────────

  private moveCursor(delta: number): void {
    // admin §13 — 다른 행으로 이동하면 확인 상태를 해제한다
    if (this.danger.cancel()) this.deps.sfx.play('select');
    const rows = this.rows();
    if (this.cursor.move(delta, rows)) this.deps.sfx.play('select');
    this.cellIndex = 0;
    this.editor.breakAccel();
  }

  private adjust(direction: number): void {
    const spec = this.currentField();
    if (spec === null) {
      this.adjustPageValue(direction);
      return;
    }
    const changed = this.editor.adjust(spec, this.cellIndex, direction, this.deps.clock.now());
    this.deps.sfx.play(changed ? 'select' : 'reject');
    if (changed && spec.file === 'settings') this.noteMachineChange(spec);
  }

  /** 파라미터 행이 아닌 화면(테스트 플레이 설정 등)의 좌우 조작 */
  private adjustPageValue(direction: number): void {
    const row = this.currentRow();
    if (row === null) return;
    if (row.id === 'testplay.tier') {
      const i = PARAM_TIERS.indexOf(this.testSpec.tier);
      const next = Math.max(0, Math.min(PARAM_TIERS.length - 1, i + direction));
      this.testSpec = { ...this.testSpec, tier: PARAM_TIERS[next] };
      this.deps.sfx.play('select');
      return;
    }
    if (row.id === 'testplay.seed') {
      this.testSpec = { ...this.testSpec, seed: Math.max(1, this.testSpec.seed + direction) };
      this.deps.sfx.play('select');
      return;
    }
    if (row.id === 'params.preset') {
      const options: readonly DifficultyPreset[] = ['KIDS', 'STANDARD', 'HARD'];
      const i = options.indexOf(this.editor.draft.difficulty.preset);
      const next = Math.max(0, Math.min(options.length - 1, i + direction));
      this.editor.usePreset(options[next]);
      this.deps.sfx.play('select');
    }
  }

  private confirm(): void {
    const now = this.deps.clock.now();
    if (this.danger.pending !== null) {
      this.finishDanger(this.danger.press(now));
      return;
    }
    const spec = this.currentField();
    if (spec !== null && spec.cells.length > 1) {
      // 여러 셀 행(구간표 MIN~MAX · NIGHT MUTE)은 `H`로 편집 셀을 돌린다
      this.cellIndex = (this.cellIndex + 1) % spec.cells.length;
      this.deps.sfx.play('select');
      return;
    }
    const row = this.currentRow();
    if (row === null) return;
    this.activate(row.id);
  }

  private back(): void {
    if (this.danger.cancel()) {
      this.deps.sfx.play('reject');
      return;
    }
    // P-13 — `G`는 저장 실패 화면을 벗어나지 않는다 (ADM-302 "관리자 화면을 닫지 않는다")
    if (this.saveFailedPrompt) {
      this.deps.sfx.play('reject');
      return;
    }
    if (this.unsavedPrompt) {
      this.unsavedPrompt = false;
      this.deps.sfx.play('reject');
      return;
    }
    if (this.path.length > 0) {
      // GAME PARAMETERS를 벗어나면서 작업 사본을 폐기한다 (§11.4 · ADM-201)
      if (this.path[0] === 'PARAMS' && this.editor.dirty) {
        this.unsavedPrompt = true;
        this.deps.sfx.play('reject');
        return;
      }
      this.path = this.path.slice(0, -1);
      this.cellIndex = 0;
      this.cursor.reset(this.rows());
      this.deps.sfx.play('select');
      return;
    }
    if (this.hasUnsavedWork()) {
      this.unsavedPrompt = true;
      this.deps.sfx.play('reject');
      return;
    }
    void this.exitAndSave();
  }

  // ── 행 활성화 ─────────────────────────────────────────────────────────────

  private activate(id: string): void {
    const node = this.currentNode();
    const child = node.children?.find((c) => c.id === id);
    if (child !== undefined) {
      this.path = [...this.path, child.id];
      this.cellIndex = 0;
      this.cursor.reset(this.rows());
      this.deps.sfx.play('confirm');
      return;
    }
    switch (id) {
      case 'unsaved.save':
        this.unsavedPrompt = false;
        void this.save();
        return;
      case 'unsaved.discard':
        this.unsavedPrompt = false;
        this.editor.discard();
        this.toast(ADMIN_TEXT.discarded, 'ok');
        return;
      case 'unsaved.cancel':
        this.unsavedPrompt = false;
        return;
      case 'params.save':
        void this.save();
        return;
      case 'params.discard':
        this.editor.discard();
        this.report = null;
        this.toast(ADMIN_TEXT.discarded, 'ok');
        return;
      case 'params.validate':
        this.report = this.validate();
        this.toast(
          this.report.errors.length === 0
            ? '검증 통과'
            : ADMIN_TEXT.blockedByErrors(this.report.errors.length),
          this.report.errors.length === 0 ? 'ok' : 'error'
        );
        return;
      case 'testplay.start':
        this.startTestPlay();
        return;
      case 'savefailed.retry':
        void this.retrySave();
        return;
      case 'storage.probe':
        void this.runStorageProbe();
        return;
      case 'exit.now':
        void this.exitAndSave();
        return;
      default:
        this.arm(id);
        return;
    }
  }

  /** 위험 작업 확인 화면을 연다 (admin §13) */
  private arm(id: string): void {
    const level = RISK_OF[id] as RiskLevel | undefined;
    if (level === undefined) return;
    const request = this.requestOf(id, level);
    if (request === null) return;
    this.danger.arm(request, this.deps.clock.now());
    this.deps.sfx.play('confirm');
  }

  private requestOf(id: string, level: RiskLevel): DangerRequest | null {
    const balance = this.deps.credits.balance();
    const warn =
      balance.paid + balance.event > 0
        ? `유료 ${String(balance.paid)} · 이벤트 ${String(balance.event)} 크레딧이 남아 있습니다`
        : undefined;
    switch (id) {
      case 'reset.paid':
        return {
          id,
          level,
          label: 'RESET PAID STATISTICS',
          summary: ADMIN_TEXT.resetConfirm('유료 통계', 3),
        };
      case 'reset.event':
        return {
          id,
          level,
          label: 'RESET EVENT STATISTICS',
          summary: ADMIN_TEXT.resetConfirm('이벤트 통계', 6),
        };
      case 'reset.ranking':
        return {
          id,
          level,
          label: 'RESET RANKING',
          summary: ADMIN_TEXT.rankingResetConfirm(this.deps.ranking.size),
        };
      case 'reset.params':
        return {
          id,
          level,
          label: 'RESTORE GAME PARAMETERS',
          summary: ADMIN_TEXT.restoreConfirm('GAME PARAMETERS 전량'),
        };
      case 'restore.group':
        return {
          id,
          level,
          label: 'RESTORE THIS PRESET',
          summary: ADMIN_TEXT.restoreConfirm(this.currentGroupLabel()),
        };
      case 'grant.event':
        return { id, level, label: 'EVENT CREDIT GRANT', summary: '이벤트 크레딧 +1 (최대 5)' };
      case 'save.warned':
        return {
          id,
          level,
          label: 'SAVE (WARNING)',
          summary: ADMIN_TEXT.holdToSave(2),
        };
      case 'system.restart':
        return {
          id,
          level,
          label: 'RESTART GAME',
          summary: '저장 완료 후 앱을 다시 시작합니다',
          balanceWarning: warn,
        };
      case 'system.reboot':
        return {
          id,
          level,
          label: 'REBOOT MACHINE',
          summary: '기기를 재부팅합니다',
          balanceWarning: warn,
        };
      case 'system.shutdown':
        return {
          id,
          level,
          label: 'SHUTDOWN MACHINE',
          summary: '기기를 종료합니다',
          balanceWarning: warn,
        };
      default:
        return null;
    }
  }

  /**
   * 홀드가 완료된 작업을 실행한다. **성공·실패 모두** 감사 로그를 남긴다 (admin §13).
   *
   * 실패해도 반드시 `finish()`로 잠금을 푼다. `EXECUTING`에 고착하면 `handle()`이 모든 입력을
   * 버리고, 10초 자동 취소는 `ARMED`에서만 도는 탓에 **재부팅 말고는 탈출 경로가 없다.**
   */
  private finishDanger(request: DangerRequest | null): void {
    if (request === null) return;
    void this.execute(request)
      .catch((err: unknown) => {
        this.deps.sfx.play('reject');
        this.toast(`${request.label} — 실행 실패`, 'error');
        this.audit(DANGER_AUDIT_KIND[request.id] ?? 'SYSTEM_ACTION', {
          target: request.label,
          result: `failed: ${String(err)}`,
        });
      })
      .finally(() => {
        this.danger.finish();
      });
  }

  /**
   * 위험 작업 직전 `.bak`. 실패하면 **파괴적 작업을 실행하지 않는다** —
   * `commitSave()`와 같은 규칙이다 (계획 §5.4 "②가 실패하면 ③으로 가지 않는다").
   */
  private async backupOrAbort(
    file: SaveFileName,
    request: DangerRequest,
    kind: AuditEvent['kind']
  ): Promise<boolean> {
    if (await this.deps.storage.backup(file)) return true;
    this.deps.sfx.play('reject');
    this.toast(`${request.label} — 백업 실패 · 실행하지 않았습니다`, 'error');
    this.audit(kind, { target: file, result: 'backup_failed' });
    return false;
  }

  private async execute(request: DangerRequest): Promise<void> {
    switch (request.id) {
      case 'reset.paid':
        if (!(await this.backupOrAbort(FILES.stats, request, 'STATS_RESET'))) return;
        this.deps.credits.resetPaidStatistics();
        await this.deps.storage.saveNow(FILES.stats);
        this.audit('STATS_RESET', { target: 'paid', after: '0', detail: 'paid' });
        this.toast('유료 통계를 초기화했습니다', 'ok');
        return;
      case 'reset.event':
        if (!(await this.backupOrAbort(FILES.stats, request, 'STATS_RESET'))) return;
        this.deps.credits.resetEventStatistics();
        await this.deps.storage.saveNow(FILES.stats);
        this.audit('STATS_RESET', { target: 'event', after: '0', detail: 'event' });
        this.toast('이벤트 통계를 초기화했습니다', 'ok');
        return;
      case 'reset.ranking': {
        // §5.7 · admin §11.6 — 감사 로그에 **이니셜을 넣지 않는다**. 건수만 남긴다
        const before = this.deps.ranking.size;
        if (!(await this.backupOrAbort(FILES.ranking, request, 'RANKING_RESET'))) return;
        this.deps.ranking.clear();
        await this.deps.storage.saveNow(FILES.ranking);
        this.audit('RANKING_RESET', {
          target: FILES.ranking,
          before: String(before),
          after: '0',
        });
        this.toast(`랭킹 ${String(before)}건을 삭제했습니다`, 'ok');
        return;
      }
      case 'reset.params':
        if (!(await this.backupOrAbort(FILES.params, request, 'PARAM_RESTORE'))) return;
        // `initialHearts` 거울값이 바뀌므로 `settings.csv`도 다시 쓴다 → 그쪽도 백업한다
        if (!(await this.backupOrAbort(FILES.settings, request, 'PARAM_RESTORE'))) return;
        // §11.2가 `MACHINE SETTINGS`(§11.3)와 `GAME PARAMETERS`(§11.4)를 별도 그룹으로 갈랐고
        // §11.7 항목명도 `RESTORE GAME PARAMETERS`다 — **기기 설정은 이 작업의 범위 밖**이다.
        // 특히 `COIN UNIT PRICE`가 미설정으로 돌아가면 `ESTIMATED GROSS`가 사라진다
        this.editor.reset({ ...FACTORY_ADMIN_PARAMS, machine: this.editor.live.machine });
        this.pushLive();
        await this.deps.storage.saveNow(FILES.params);
        await this.deps.storage.saveNow(FILES.settings);
        this.audit('PARAM_RESTORE', { target: 'GAME PARAMETERS', after: 'FACTORY' });
        this.markSaved();
        this.toast('공장값으로 복원했습니다 (기기 설정은 유지)', 'ok');
        return;
      case 'restore.group': {
        const group = this.currentGroup();
        if (group !== null) this.editor.restore(group);
        this.audit('PARAM_RESTORE', { target: this.currentGroupLabel(), after: 'FACTORY(draft)' });
        this.toast('작업 사본을 공장값으로 되돌렸습니다', 'ok');
        return;
      }
      case 'grant.event': {
        const applied = this.deps.credits.grantEvent(1, 'admin');
        this.deps.sfx.play(applied > 0 ? 'coin' : 'reject');
        if (applied === 0) this.toast(ADMIN_TEXT.eventCreditMax, 'warn');
        return;
      }
      case 'save.warned':
        await this.commitSave(this.report);
        return;
      case 'system.restart':
      case 'system.reboot':
      case 'system.shutdown': {
        // ADM-307 — **모든 저장이 성공한 뒤에만** OS 액션을 실행한다 (`exitAndSave()`와
        // 같은 가드 · 검증 F-1). 메인 `drainQueue()`는 실패를 삼키므로 여기가 마지막 검사다
        const failuresBefore = this.deps.storage.saveFailureCount;
        await this.deps.storage.saveAll();
        if (this.deps.storage.saveFailureCount > failuresBefore) {
          this.noteSaveFailure(request.label);
          this.audit('SYSTEM_ACTION', { target: request.label, result: 'save_failed' });
          return;
        }
        const result = await this.runSystemAction(request.id);
        this.audit('SYSTEM_ACTION', { target: request.label, result });
        this.toast(`${request.label} — ${result}`, result === 'ok' ? 'ok' : 'warn');
        return;
      }
      default:
        return;
    }
  }

  private runSystemAction(id: string): Promise<string> {
    const port = this.deps.system;
    if (port === undefined) return Promise.resolve(ADMIN_TEXT.holdBadge);
    if (id === 'system.restart') return port.restart();
    if (id === 'system.reboot') return port.reboot();
    return port.shutdown();
  }

  // ── 저장 (§11.5 · 계획 §5.4 6단계) ───────────────────────────────────────

  validate(): ValidationReport {
    return validateAdminParams(this.editor.draft, this.deps.solverGate);
  }

  /**
   * ① 검증 → ② `.bak` → ③ draft를 live로 → ④ `saveNow` → ⑤ 감사 로그 → ⑥ 토스트.
   * ②가 실패하면 ③으로 가지 않는다. 오류가 있으면 **홀드로도** 저장되지 않는다 (§11.5).
   */
  async save(): Promise<boolean> {
    const report = this.validate();
    this.report = report;
    if (report.errors.length > 0) {
      this.deps.sfx.play('reject');
      this.toast(ADMIN_TEXT.blockedByErrors(report.errors.length), 'error');
      this.audit('PARAM_SAVE', {
        target: 'GAME PARAMETERS',
        after: this.changeSummary(),
        result: `blocked(${String(report.errors.length)})`,
      });
      return false;
    }
    if (report.warnings.length > 0) {
      // 경고는 `H` 2초 홀드로만 저장된다 (ADM-204). 여기서는 확인 화면만 연다
      this.arm('save.warned');
      return false;
    }
    return this.commitSave(report);
  }

  private async commitSave(report: ValidationReport | null): Promise<boolean> {
    const changes = this.changeSummary();
    const before = this.changeSummaryOf(this.editor.live);
    this.saveStateRef = 'SAVING';
    const ok = await this.deps.storage.backup(FILES.params);
    if (!ok) {
      this.noteSaveFailure(`backup ${FILES.params}`);
      this.audit('PARAM_SAVE', {
        target: 'GAME PARAMETERS',
        after: changes,
        result: 'backup_failed',
      });
      return false;
    }
    this.editor.commit();
    this.pushLive();
    const failuresBefore = this.deps.storage.saveFailureCount;
    await this.deps.storage.saveNow(FILES.params);
    await this.deps.storage.saveNow(FILES.settings);
    if (this.deps.storage.saveFailureCount > failuresBefore) {
      // ADM-302 — 관리자 화면을 닫지 않고 오류·재시도를 제공한다 (P-13)
      this.noteSaveFailure(`${FILES.params} / ${FILES.settings}`);
      this.audit('PARAM_SAVE', {
        target: 'GAME PARAMETERS',
        after: changes,
        result: 'write_failed',
      });
      return false;
    }
    const solver =
      report === null
        ? ''
        : report.solver.pending !== undefined
          ? 'solver=pending'
          : `solver=${report.solver.ok ? 'ok' : 'failed'}(${String(report.solver.boardsChecked)}보드 / ${String(report.solver.elapsedMs)}ms)`;
    this.audit('PARAM_SAVE', {
      target: 'GAME PARAMETERS',
      before,
      after: changes,
      result: solver === '' ? 'ok' : `ok ${solver}`,
    });
    this.markSaved();
    this.deps.sfx.play('confirm');
    this.toast(ADMIN_TEXT.saved(this.lastSavedStamp), 'ok');
    return true;
  }

  /**
   * MACHINE SETTINGS는 위험도 "낮음" — 즉시 반영 + 800ms 디바운스 저장 (admin §8.5 · §13).
   *
   * **그 행의 셀만 승격한다.** `commit()`으로 작업 사본 전체를 올리면 GAME PARAMETERS의
   * 미검증 편집분이 §11.5 파이프라인(`.bak`·검증·`param_save` 감사)을 통째로 건너뛰고
   * 라이브·`params.csv`에 들어간다. 두 문서의 커밋 경로는 분리돼 있어야 한다.
   */
  private noteMachineChange(spec: FieldSpec): void {
    const before = formatFieldValue(spec, this.editor.live);
    this.editor.commitCells(spec.cells.map((c) => c.key));
    this.pushLive();
    this.saveStateRef = 'UNSAVED';
    this.machineSaveAtMs = this.deps.clock.now() + MACHINE_SAVE_DEBOUNCE_MS;
    this.audit('SETTING_CHANGE', {
      target: spec.label,
      before,
      after: formatFieldValue(spec, this.editor.live),
    });
  }

  private async flushMachineSave(): Promise<void> {
    this.saveStateRef = 'SAVING';
    const failuresBefore = this.deps.storage.saveFailureCount;
    await this.deps.storage.saveNow(FILES.settings);
    if (this.deps.storage.saveFailureCount > failuresBefore) {
      this.noteSaveFailure(FILES.settings);
      return;
    }
    this.markSaved();
  }

  /** live를 저장 문서·서비스에 밀어 넣는다 (§11.4 반영 시점 NEXT GAME · NEXT CHARGE) */
  private pushLive(): void {
    const live = this.editor.live;
    this.deps.params.set(live);
    this.deps.settings.set(live.machine);
    this.deps.settings.mirrorInitialHearts(live.core.initialHearts);
    this.deps.credits.setCoinsPerPlay(live.machine.coinsPerPlay);
    this.deps.credits.setContinueCoins(live.machine.continueCoins);
    this.deps.credits.setCoinUnitPrice(live.machine.coinUnitPrice);
    this.deps.applyParams(live);
  }

  private markSaved(): void {
    this.saveStateRef = 'SAVED';
    this.lastSavedStamp = formatStamp(this.deps.nowIso());
    this.saveFailedPrompt = false;
  }

  /**
   * SAV-702 — 저장 실패를 한 곳에서 처리한다: 상태 · 복구 화면 · 소리 · 토스트 ·
   * `error_YYYY-MM-DD.log` (메인 프로세스 `app:logError`).
   */
  private noteSaveFailure(what: string): void {
    this.saveStateRef = 'SAVE FAILED';
    this.saveFailedPrompt = true;
    this.deps.sfx.play('reject');
    this.toast(ADMIN_TEXT.savePathHint, 'error');
    this.deps.storage.logError(`SAVE FAILED ${what}`);
    this.cursor.reset(this.rows());
  }

  /**
   * ADM-302 — 실패한 저장을 그대로 다시 시도한다. 성공하면 복구 화면을 닫고,
   * 다시 실패하면 화면을 유지한다 (재시도 횟수 제한은 두지 않는다 — 운영자가 판단한다).
   */
  async retrySave(): Promise<boolean> {
    this.saveStateRef = 'SAVING';
    const failuresBefore = this.deps.storage.saveFailureCount;
    await this.deps.storage.saveAll();
    if (this.deps.storage.saveFailureCount > failuresBefore) {
      this.noteSaveFailure('retry');
      this.audit('PARAM_SAVE', { target: 'RETRY SAVE', result: 'write_failed' });
      return false;
    }
    this.markSaved();
    this.deps.sfx.play('confirm');
    this.toast(ADMIN_TEXT.saved(this.lastSavedStamp), 'ok');
    this.audit('PARAM_SAVE', { target: 'RETRY SAVE', result: 'ok' });
    return true;
  }

  /** admin §3.2 — 모든 저장이 성공한 뒤에만 복귀한다 (ADM-307) */
  async exitAndSave(): Promise<boolean> {
    this.saveStateRef = 'SAVING';
    const failuresBefore = this.deps.storage.saveFailureCount;
    await this.deps.storage.saveAll();
    if (this.deps.storage.saveFailureCount > failuresBefore) {
      // ADM-307 — 모든 저장이 성공한 뒤에만 나간다. 실패하면 화면을 유지한다
      this.noteSaveFailure('EXIT & SAVE');
      this.audit('ADMIN_EXIT', { target: 'ADMIN HOME', result: 'failed' });
      return false;
    }
    this.markSaved();
    this.toast(ADMIN_TEXT.saved(this.lastSavedStamp), 'ok');
    this.audit('ADMIN_EXIT', { target: 'ADMIN HOME', result: 'ok' });
    // `SAVED · YYYY-MM-DD HH:MM:SS`를 1초 이상 보여 준 뒤 복귀한다
    this.exitAtMs = this.deps.clock.now() + EXIT_SAVED_HOLD_MS;
    return true;
  }

  // ── 테스트 플레이 (§11.6) ────────────────────────────────────────────────

  private startTestPlay(): void {
    const report = this.validate();
    this.report = report;
    if (report.errors.length > 0) {
      this.deps.sfx.play('reject');
      this.toast(ADMIN_TEXT.blockedByErrors(report.errors.length), 'error');
      return;
    }
    this.session.begin(this.testSpec, this.deps.clock.now());
    this.audit('TEST_PLAY', {
      target: 'START',
      after: `${this.testSpec.tier} seed ${String(this.testSpec.seed)}`,
    });
    this.deps.testPlay?.start(this.testSpec, this.editor.draft);
  }

  /** 클리어·런 종료·`G` 2초 홀드 — `app.ts`의 화면 리스너가 부른다 */
  endTestPlay(result: { score: number; grade: Grade | null }): void {
    if (!this.session.active) return;
    const report = this.session.end(result, this.deps.clock.now());
    this.audit('TEST_PLAY', {
      target: 'END',
      after: `board ${String(report.boardReached)} · score ${String(report.score)} · miss ${String(report.mistakes)}`,
    });
    this.deps.testPlay?.stop();
  }

  get testPlayReport(): ReturnType<TestPlaySession['end']> | null {
    return this.session.lastReport;
  }

  // ── 진단 ─────────────────────────────────────────────────────────────────

  private async runStorageProbe(): Promise<void> {
    this.probe = await probeStorage(this.deps.storage.backend);
  }

  /**
   * §12.3 — 메인 프로세스 상태를 다시 읽고 부팅 경고를 **한 번만** 흡수한다.
   *
   * `consumeBootNotices()`는 첫 호출에서만 목록을 돌려주므로(부팅당 1회 · P-12), 여기서
   * 받은 줄을 컨트롤러가 들고 있는 동안 OVERVIEW가 몇 번을 다시 그려도 같은 목록을 본다.
   */
  private async refreshHealth(): Promise<void> {
    this.healthRef = (await this.deps.health?.()) ?? null;
    this.deps.safety?.setHealth(this.healthRef);
    this.absorbBootNotices();
  }

  /**
   * 경고 목록을 컨트롤러가 들고 있는다. `SafetyMonitor`는 부팅당 1회만 내주므로
   * (P-12), 여기 담아 둬야 OVERVIEW를 몇 번 다시 그려도 같은 목록이 보인다.
   */
  private absorbBootNotices(): void {
    const notices = this.deps.safety?.consumeBootNotices() ?? [];
    if (notices.length > 0) this.bootNoticeLines = notices.map((n) => n.text);
  }

  /** §12.3 — 이번 부팅 경고 목록 (표시·판정용) */
  get bootNotices(): readonly string[] {
    return this.bootNoticeLines;
  }

  get health(): HealthReport | null {
    return this.healthRef;
  }

  get serialState(): SerialState {
    return this.serial;
  }

  get inputTestModel(): InputTestModel {
    return this.inputTest;
  }

  private statusNow(): OverallStatus {
    return overallStatus(this.statusInput());
  }

  private statusInput(): Parameters<typeof overallStatus>[0] {
    const kind = this.deps.storage.backendKind;
    return {
      ioConnected: (this.deps.inputStatus?.() ?? 'connected') !== 'disconnected',
      storageWritable: this.probe === null ? true : this.probe.writable,
      memoryBackend: kind === 'memory',
      fatalErrorsIn60s: this.healthRef?.fatalCount ?? 0,
      backupRestored: this.bootNoticeLines.some((l) => l.startsWith('BACKUP RESTORED')),
      clockChanged: this.deps.credits.view().clockChangedCount > 0,
      paramsVersionMismatch: this.deps.params.versionMismatch,
      coinPriceUnset: this.deps.credits.coinUnitPrice === null,
      stuckInput: this.inputTest.stuckSignals(this.deps.clock.now()).length > 0,
      storageLow: this.healthRef?.storageLow === true,
      factoryDataLoaded: this.bootNoticeLines.some((l) => l.startsWith('FACTORY DATA LOADED')),
    };
  }

  // ── 뷰 ───────────────────────────────────────────────────────────────────

  view(): AdminView {
    const rows = this.rows();
    this.cursor.clampTo(rows);
    const now = this.deps.clock.now();
    const report = this.report;
    return {
      breadcrumb: breadcrumbOf(this.path),
      clock: formatStamp(this.deps.nowIso()),
      status: statusText(this.statusNow()),
      rows,
      cursor: this.cursor.index,
      detail: this.detailLines(),
      footer: this.footer(),
      saveState: this.saveStateText(),
      toast:
        this.toastRef === null ? null : { text: this.toastRef.text, level: this.toastRef.level },
      danger: this.dangerView(now),
      errors: report === null ? [] : issueLines(report.errors),
      warnings: report === null ? [] : issueLines(report.warnings),
      solverBadge: this.solverBadge(),
    };
  }

  /** admin §4.3 — 마지막 저장 상태는 4종 중 하나로 **항상** 표시한다 */
  private saveStateText(): string {
    if (this.saveStateRef === 'SAVING') return ADMIN_TEXT.saving;
    if (this.saveStateRef === 'SAVE FAILED') return ADMIN_TEXT.saveFailed;
    if (this.saveStateRef === 'UNSAVED') return ADMIN_TEXT.unsaved;
    // 진입 직후처럼 이번 세션에 아직 저장한 적이 없으면 시각 없이 `SAVED`만 보여 준다
    return this.lastSavedStamp === '' ? 'SAVED' : ADMIN_TEXT.saved(this.lastSavedStamp);
  }

  private solverBadge(): string {
    const solver = this.report?.solver;
    if (solver === undefined) return ADMIN_TEXT.solverPending;
    if (solver.pending !== undefined) return ADMIN_TEXT.solverPending;
    return solver.ok
      ? ADMIN_TEXT.solverOk(solver.boardsChecked, solver.elapsedMs)
      : ADMIN_TEXT.solverFailed(solver.failures.length);
  }

  private dangerView(nowMs: number): DangerView | null {
    const request = this.danger.pending;
    if (request === null) return null;
    return {
      label: request.label,
      summary: request.summary,
      level: request.level,
      requiredHoldMs: this.danger.requiredHoldMs,
      progress01: this.danger.progress01(nowMs),
      executing: this.danger.locked,
      autoCancelLeftMs: this.danger.autoCancelLeftMs(nowMs),
      ...(request.balanceWarning === undefined ? {} : { balanceWarning: request.balanceWarning }),
      rejected: this.danger.lastRejected === 'TOO_SHORT',
    };
  }

  private footer(): string {
    if (this.danger.pending !== null) return FOOTER.danger;
    if (this.currentField() !== null) return FOOTER.fields;
    if (this.path.length === 0) return FOOTER.root;
    return FOOTER.menu;
  }

  private detailLines(): readonly string[] {
    const spec = this.currentField();
    if (spec === null) return this.pageDetail();
    const cell = spec.cells[Math.min(this.cellIndex, spec.cells.length - 1)];
    const lines = [
      `${spec.label} · ${spec.applyTiming}`,
      `범위 ${String(cell.min)} ~ ${String(cell.max)} (step ${String(cell.step)})`,
      `공장값 ${formatFieldValue(spec, FACTORY_ADMIN_PARAMS)}`,
    ];
    if (this.editor.isDirtySpec(spec)) {
      lines.push(formatChange(spec, this.editor.live, this.editor.draft));
    }
    if (spec.note !== undefined) lines.push(spec.note);
    if (spec.pendingUnit !== undefined) lines.push(ADMIN_TEXT.pendingBadge(spec.pendingUnit));
    return lines;
  }

  private pageDetail(): readonly string[] {
    if (this.unsavedPrompt) return [ADMIN_TEXT.unsavedChoice];
    return statusReasons(this.statusInput());
  }

  // ── 행 구성 ──────────────────────────────────────────────────────────────

  private currentNode(): MenuNode {
    return findNode(this.path) ?? { id: 'ADMIN', label: 'ADMIN', children: ADMIN_GROUPS };
  }

  private currentRow(): AdminRow | null {
    const rows = this.cachedRows;
    return rows.length === 0 ? null : (rows[Math.min(this.cursor.index, rows.length - 1)] ?? null);
  }

  /** 커서가 선 행이 파라미터 필드면 그 스키마, 아니면 null */
  private currentField(): FieldSpec | null {
    const row = this.currentRow();
    if (row === null) return null;
    return FIELD_SCHEMA.find((f) => f.id === row.id) ?? null;
  }

  private currentGroup(): FieldGroup | null {
    return this.currentNode().group ?? null;
  }

  private currentGroupLabel(): string {
    return this.currentNode().label;
  }

  rows(): readonly AdminRow[] {
    const built = this.saveFailedPrompt
      ? this.saveFailedRows()
      : this.unsavedPrompt
        ? this.unsavedRows()
        : this.rowsFor(this.currentNode());
    this.cachedRows = built;
    return built;
  }

  /**
   * ADM-302 · SAV-702 — 저장 실패 복구 화면 (P-13).
   *
   * 화면을 **닫지 않는다.** `H`는 같은 저장을 다시 시도하고, `G`는 아무 데로도 이동하지
   * 않는다. 저장 경로가 죽은 채 관리자에서 나가면 편집분이 조용히 사라지기 때문이다.
   */
  private saveFailedRows(): readonly AdminRow[] {
    return [
      infoRow('savefailed.head', ADMIN_TEXT.saveFailedTitle, ''),
      infoRow('savefailed.stay', '화면 유지', ADMIN_TEXT.saveFailedStay),
      infoRow('savefailed.test', '저장소 점검', ADMIN_TEXT.storageTestHint),
      menuRow('savefailed.retry', ADMIN_TEXT.saveRetry),
    ];
  }

  private unsavedRows(): readonly AdminRow[] {
    return [
      infoRow('unsaved.head', ADMIN_TEXT.unsavedChoice, ''),
      menuRow('unsaved.save', 'SAVE'),
      menuRow('unsaved.discard', 'DISCARD'),
      menuRow('unsaved.cancel', 'CANCEL'),
    ];
  }

  private rowsFor(node: MenuNode): readonly AdminRow[] {
    const tag = node.page;
    if (tag === undefined) {
      return (node.children ?? []).map((c) => menuRow(c.id, c.label));
    }
    switch (tag) {
      case 'fields':
        return this.fieldRows(node);
      case 'overview':
        return this.overviewRows();
      case 'sales.stats':
        return this.salesStatsRows();
      case 'sales.meters':
        return this.salesMeterRows();
      case 'sales.grant':
        return this.grantRows();
      case 'params.save':
        return this.saveRows();
      case 'params.testplay':
        return this.testPlayRows();
      case 'diag.input':
        return this.inputTestRows();
      case 'diag.sound':
        return this.soundRows();
      case 'diag.display':
        return this.displayRows();
      case 'diag.serial':
        return this.serialRows();
      case 'diag.storage':
        return this.storageRows();
      case 'diag.balance':
        return this.balanceRows();
      case 'diag.system':
        return this.systemRows();
      case 'data':
        return this.dataRows();
      case 'reset.paid':
      case 'reset.event':
      case 'reset.ranking':
      case 'reset.params':
        return this.resetRows(tag, node.label);
      case 'exit':
        return [menuRow('exit.now', 'EXIT & SAVE')];
      default:
        return [];
    }
  }

  private fieldRows(node: MenuNode): readonly AdminRow[] {
    const group = node.group;
    if (group === undefined) return [];
    const advancedOnly = node.advancedOnly === true;
    const specs = fieldsOfGroup(group).filter((f) =>
      advancedOnly ? f.advanced === true : f.advanced !== true
    );
    const rows: AdminRow[] = specs.map((spec) => this.fieldRow(spec));
    if (group === '난이도' && !advancedOnly) {
      rows.push(menuRow('restore.group', 'RESTORE THIS PRESET'));
    }
    if (group === '기기') {
      rows.push(
        infoRow('machine.fixed.paid', '유료 크레딧 최대', '99'),
        infoRow('machine.fixed.event', '이벤트 크레딧 최대', '5'),
        infoRow('machine.fixed.resolution', '논리 해상도', '1920 × 1080'),
        infoRow('machine.fixed.mode', '화면 모드', '전체화면 키오스크')
      );
    }
    return rows;
  }

  private fieldRow(spec: FieldSpec): AdminRow {
    const dirty = this.editor.isDirtySpec(spec);
    const owns = (key: string | undefined): boolean =>
      key !== undefined && specOfCell(key)?.id === spec.id;
    const issue = this.report?.errors.find((e) => owns(e.key));
    const warn = this.report?.warnings.find((w) => owns(w.key));
    return {
      id: spec.id,
      label: spec.label,
      value: dirty
        ? formatChange(spec, this.editor.live, this.editor.draft)
        : formatFieldValue(spec, this.editor.draft),
      marker:
        issue !== undefined
          ? MARKER.error
          : warn !== undefined
            ? MARKER.warn
            : dirty
              ? MARKER.normal
              : MARKER.none,
      selectable: true,
      applyTiming: spec.applyTiming,
      cellCount: spec.cells.length,
      cellIndex: this.cellIndex,
      ...(spec.pendingUnit === undefined
        ? {}
        : { badge: ADMIN_TEXT.pendingBadge(spec.pendingUnit) }),
    };
  }

  private overviewRows(): readonly AdminRow[] {
    const v = this.deps.credits.view();
    const b = this.deps.credits.balance();
    return [
      infoRow('ov.status', '종합 상태', statusText(this.statusNow())),
      infoRow('ov.clock', '시스템 시각', formatStamp(this.deps.nowIso())),
      infoRow(
        'ov.today',
        '오늘 유료 / 이벤트',
        `${formatCount(v.paidPlayToday)} / ${formatCount(v.eventPlayToday)}`
      ),
      infoRow('ov.credit', 'PAID / EVENT 잔액', `${formatCount(b.paid)} / ${formatCount(b.event)}`),
      infoRow('ov.pulse', '오늘 코인 펄스', formatCount(v.coinPulseToday)),
      infoRow('ov.io', '입력 / I/O', this.serial.status),
      infoRow('ov.storage', '저장소', this.deps.storage.backendKind),
      infoRow(
        'ov.params',
        'PARAM DATA VERSION',
        this.deps.params.versionMismatch ? '불일치 · 공장값' : 'ok'
      ),
      infoRow('ov.saved', '마지막 저장', this.lastSavedStamp === '' ? '—' : this.lastSavedStamp),
      // §12.4 — 유료 차단 사유. 차단이 아니면 `—`
      infoRow('ov.paidblock', '유료 플레이', this.paidBlockText()),
      // §12.3 — 부팅 복구 경고 (BACKUP RESTORED / FACTORY DATA LOADED / PARAM 버전)
      infoRow(
        'ov.boot',
        '부팅 경고',
        this.bootNoticeLines.length === 0
          ? ADMIN_TEXT.noBootNotice
          : this.bootNoticeLines.join(' · ')
      ),
      infoRow('ov.storagelow', '저장 공간', this.storageText()),
    ];
  }

  /** §12.4 — 차단 중이면 사유를, 아니면 `—` */
  private paidBlockText(): string {
    const reason = this.deps.safety?.reason() ?? null;
    return reason === null ? '허용' : ADMIN_TEXT.paidBlocked(reason);
  }

  private storageText(): string {
    const health = this.healthRef;
    if (health === null) return '—';
    if (health.storageLow) return ADMIN_TEXT.storageLow;
    return health.freeBytes === null
      ? '—'
      : `${String(Math.round(health.freeBytes / (1024 * 1024)))} MB 남음`;
  }

  private salesStatsRows(): readonly AdminRow[] {
    const v = this.deps.credits.view();
    const entries: readonly (readonly [string, number])[] = [
      ['TOTAL PAID PLAY', v.paidPlayTotal],
      ['TODAY PAID PLAY', v.paidPlayToday],
      ['PAID CONTINUE', v.paidContinue],
      ['TOTAL EVENT PLAY', v.eventPlayTotal],
      ['TODAY EVENT PLAY', v.eventPlayToday],
      ['EVENT CONTINUE', v.eventContinue],
      ['EVENT CREDIT BALANCE', v.eventCreditBalance],
      ['TOTAL EVENT GRANTED', v.eventGrantedTotal],
      ['TOTAL EVENT USED', v.eventUsedTotal],
      ['TODAY EVENT USED', v.eventUsedToday],
    ];
    return entries.map(([label, n], i) =>
      infoRow(`sales.stat.${String(i)}`, label, formatCount(n))
    );
  }

  private salesMeterRows(): readonly AdminRow[] {
    const v = this.deps.credits.view();
    const rows: AdminRow[] = [
      infoRow('meter.pulseTotal', 'COIN PULSE TOTAL', formatCount(v.coinPulseTotal)),
      infoRow('meter.pulseToday', 'COIN PULSE TODAY', formatCount(v.coinPulseToday)),
      infoRow('meter.granted', 'PAID CREDIT GRANTED', formatCount(v.paidCreditGranted)),
      infoRow('meter.used', 'PAID CREDIT USED', formatCount(v.paidCreditUsed)),
      infoRow('meter.service', 'SERVICE CREDIT GRANTED', formatCount(v.serviceCreditGranted)),
    ];
    // admin §7.2 — 단가 미설정이면 `ESTIMATED GROSS`를 **숨긴다**
    if (v.estimatedGross !== null) {
      rows.push(infoRow('meter.gross', 'ESTIMATED GROSS', formatMoney(v.estimatedGross)));
    }
    return rows;
  }

  private grantRows(): readonly AdminRow[] {
    const b = this.deps.credits.balance();
    return [
      infoRow('grant.balance', 'EVENT CREDIT BALANCE', `${formatCount(b.event)} / 5`),
      menuRow('grant.event', 'EVENT CREDIT GRANT +1'),
    ];
  }

  private saveRows(): readonly AdminRow[] {
    const report = this.report;
    const rows: AdminRow[] = [
      infoRow('save.dirty', '변경 항목', `${String(this.editor.dirtyKeys().length)}개`),
      infoRow('save.solver', 'SOLVER GATE', this.solverBadge()),
      infoRow(
        'save.budget',
        '세션 예산 도달 보드',
        report === null ? '—' : String(report.reachedBoards)
      ),
      menuRow('params.validate', 'VALIDATE'),
      menuRow('params.save', 'SAVE'),
      menuRow('params.discard', 'DISCARD (작업 사본 폐기)'),
    ];
    if (report !== null) {
      report.errors.forEach((issue, i) => {
        rows.push({
          id: `save.err.${String(i)}`,
          label: issue.label,
          value: issue.detail,
          marker: MARKER.error,
          selectable: false,
        });
      });
      report.warnings.forEach((issue, i) => {
        rows.push({
          id: `save.warn.${String(i)}`,
          label: issue.label,
          value: issue.detail,
          marker: MARKER.warn,
          selectable: false,
        });
      });
    }
    return rows;
  }

  private testPlayRows(): readonly AdminRow[] {
    const report = this.session.lastReport;
    const rows: AdminRow[] = [
      {
        id: 'testplay.tier',
        label: 'TIER',
        value: this.testSpec.tier,
        marker: MARKER.none,
        selectable: true,
      },
      {
        id: 'testplay.seed',
        label: 'SEED',
        value: String(this.testSpec.seed),
        marker: MARKER.none,
        selectable: true,
      },
      infoRow('testplay.board', '대표 보드', String(TIER_REPRESENTATIVE_BOARD[this.testSpec.tier])),
      infoRow('testplay.banner', '집계', ADMIN_TEXT.testPlayBanner),
      menuRow('testplay.start', 'START TEST PLAY'),
    ];
    if (report !== null) {
      rows.push(
        infoRow('testplay.r.board', '도달 보드', String(report.boardReached)),
        infoRow('testplay.r.miss', '오입력', String(report.mistakes)),
        infoRow('testplay.r.score', '최종 점수', formatCount(report.score)),
        infoRow('testplay.r.grade', '등급', report.grade ?? '—'),
        infoRow('testplay.r.time', '소요 시간', formatDurationMs(report.totalMs))
      );
      report.boardTimes.forEach((t, i) => {
        rows.push(
          infoRow(
            `testplay.r.t${String(i)}`,
            `보드 ${String(t.board)} 시간`,
            formatDurationMs(t.ms)
          )
        );
      });
    }
    return rows;
  }

  private inputTestRows(): readonly AdminRow[] {
    const now = this.deps.clock.now();
    const rows: AdminRow[] = [];
    for (const player of [1, 2] as const) {
      for (const signal of this.inputTest.signals(player, now)) {
        rows.push({
          id: `input.${String(player)}.${signal.action}`,
          label: `P${String(player)} ${signal.action}`,
          value: `${signal.pressed ? 'PRESS' : 'RELEASE'} · ${String(Math.round(signal.holdMs))}ms · ${String(signal.presses)}회`,
          marker: signal.stuck ? MARKER.error : signal.pressed ? MARKER.normal : MARKER.readOnly,
          selectable: false,
          ...(signal.stuck
            ? { badge: ADMIN_TEXT.stuckInput(`P${String(player)} ${signal.action}`) }
            : {}),
        });
      }
      for (const [a, b] of this.inputTest.opposing(player, now)) {
        rows.push({
          id: `input.${String(player)}.opposing.${a}`,
          label: `P${String(player)} 동시 반대 방향`,
          value: `${a} + ${b}`,
          marker: MARKER.warn,
          selectable: false,
        });
      }
    }
    return rows;
  }

  private soundRows(): readonly AdminRow[] {
    const names = ['select', 'confirm', 'reject', 'coin', 'clear'] as const;
    return names.map((n) => ({
      id: `sound.${n}`,
      label: `PLAY ${n.toUpperCase()}`,
      value: '',
      marker: MARKER.none,
      selectable: true,
      badge: ADMIN_TEXT.pendingBadge('WU-07'),
    }));
  }

  private displayRows(): readonly AdminRow[] {
    return [
      infoRow('display.logical', '논리 해상도', '1920 × 1080'),
      infoRow('display.mode', '화면 모드', '전체화면 키오스크'),
      infoRow(
        'display.pattern',
        '패턴',
        '안전 영역 · RGB · 백/흑',
        ADMIN_TEXT.pendingBadge('WU-07')
      ),
      infoRow('display.auto', '자동 종료', '30초 · G 즉시 복귀'),
    ];
  }

  private serialRows(): readonly AdminRow[] {
    return [
      infoRow('serial.status', '연결 상태', this.serial.status),
      infoRow('serial.attempts', '재연결 시도', `${String(this.serial.reconnectAttempts)} / 10`),
      infoRow(
        'serial.packet',
        '마지막 패킷',
        this.serial.lastPacketMs === null
          ? '—'
          : `${String(Math.round(this.serial.lastPacketMs))}ms`
      ),
      infoRow('serial.port', '포트 · 펌웨어', '—', ADMIN_TEXT.holdBadge),
      infoRow('serial.service', 'SERVICE REQUIRED', this.serial.serviceRequired ? 'YES' : 'NO'),
    ];
  }

  private storageRows(): readonly AdminRow[] {
    const probe = this.probe;
    return [
      infoRow('storage.backend', '백엔드', this.deps.storage.backendKind),
      infoRow(
        'storage.writable',
        '쓰기 권한',
        probe === null ? '—' : probe.writable ? 'OK' : 'FAIL'
      ),
      infoRow(
        'storage.readback',
        '읽기 검증',
        probe === null ? '—' : probe.readBackOk ? 'OK' : 'FAIL'
      ),
      infoRow(
        'storage.saved',
        '마지막 저장',
        this.lastSavedStamp === '' ? '—' : this.lastSavedStamp
      ),
      infoRow(
        'storage.recovery',
        '.bak 복구',
        this.bootNoticeLines.length === 0 ? '이번 부팅 없음' : this.bootNoticeLines.join(' · ')
      ),
      infoRow('storage.free', '남은 공간', this.storageText()),
      infoRow('storage.checksum', '체크섬', '—', ADMIN_TEXT.pendingBadge('WU-07')),
      menuRow('storage.probe', 'RUN STORAGE TEST'),
    ];
  }

  private balanceRows(): readonly AdminRow[] {
    const v = this.deps.credits.view();
    const rows: AdminRow[] = [
      infoRow('balance.sessions', '집계 세션', formatCount(v.occupancySessions)),
      infoRow('balance.avg', '평균 세션 시간', formatDurationMs(v.avgOccupancyMs)),
      infoRow(
        'balance.continue',
        '컨티뉴 전환율',
        v.paidPlayTotal === 0
          ? '표본 없음'
          : `${((v.paidContinue / v.paidPlayTotal) * 100).toFixed(1)} %`
      ),
      infoRow('balance.tierClear', '구간별 클리어율', '표본 없음'),
    ];
    for (const e of v.boardHistogram) {
      rows.push(
        infoRow(`balance.h${String(e.board)}`, `보드 ${String(e.board)} 도달`, formatCount(e.count))
      );
    }
    return rows;
  }

  private systemRows(): readonly AdminRow[] {
    return [
      menuRow('system.restart', 'RESTART GAME (H 2초)'),
      menuRow('system.reboot', 'REBOOT MACHINE (H 3초)'),
      menuRow('system.shutdown', 'SHUTDOWN MACHINE (H 3초)'),
      menuRow('exit.now', 'RETURN TO GAME'),
      // §12.1 — 기기 카드는 선택 불가 정보 행이라 위 4개 명령의 커서 순서를 바꾸지 않는다
      ...this.machineRows(),
    ];
  }

  private dataRows(): readonly AdminRow[] {
    const files: readonly SaveFileName[] = [
      FILES.settings,
      FILES.params,
      FILES.stats,
      FILES.ranking,
      FILES.creditLog,
      FILES.auditLog,
      FILES.playLog,
    ];
    return files.map((f) => infoRow(`data.${f}`, f, '등록됨'));
  }

  /**
   * §12.1 `machine.json` 기기 카드 (WU-06 P-11).
   *
   * `DATA & LOGS`가 아니라 `SYSTEM ACTIONS`에 붙인 이유: `DATA & LOGS`는 **저장 파일 7종
   * 목록**이라는 계약이 WU-05 판정으로 고정돼 있다(행 수 7). `machine.json`은 CSV 저장
   * 문서가 아니라 메인 프로세스가 쓰는 기기 식별 카드이므로 시스템 화면이 제자리다.
   */
  private machineRows(): readonly AdminRow[] {
    const m = this.healthRef?.machine ?? null;
    return [
      infoRow('machine.json.id', 'machine.json · MACHINE ID', m === null ? '—' : m.machineId),
      infoRow(
        'machine.json.ver',
        'APP / ELECTRON / NODE',
        m === null ? '—' : `${m.appVersion} / ${m.electron} / ${m.node}`
      ),
      infoRow(
        'machine.json.os',
        'PLATFORM / OS',
        m === null ? '—' : `${m.platform} ${m.arch} · ${m.osRelease}`
      ),
      infoRow('machine.json.io', 'I/O BOARD', m === null ? '—' : m.ioBoard),
      infoRow('machine.json.at', '기록 시각', m === null ? '—' : m.updatedAt),
    ];
  }

  private resetRows(tag: string, label: string): readonly AdminRow[] {
    const v = this.deps.credits.view();
    const detail =
      tag === 'reset.paid'
        ? `유료 플레이 ${formatCount(v.paidPlayTotal)} · 오늘 ${formatCount(v.paidPlayToday)} · 컨티뉴 ${formatCount(v.paidContinue)}`
        : tag === 'reset.event'
          ? `이벤트 플레이 ${formatCount(v.eventPlayTotal)} · 지급 ${formatCount(v.eventGrantedTotal)} · 사용 ${formatCount(v.eventUsedTotal)}`
          : tag === 'reset.ranking'
            ? `랭킹 ${String(this.deps.ranking.size)}건`
            : 'GAME PARAMETERS 전량';
    return [infoRow(`${tag}.detail`, '대상', detail), menuRow(tag, label)];
  }

  // ── 보조 ─────────────────────────────────────────────────────────────────

  /** 현재 저장 문서 상태로 `AdminParams` 1벌을 만든다 (부팅 직후 라이브 값) */
  private compose(): AdminParams {
    const base = this.deps.params.live;
    return { ...base, machine: this.deps.settings.machine };
  }

  /** 라이브 갱신을 컨트롤러 밖에서 했을 때 (부팅 로드 등) */
  refreshFromStores(): void {
    this.editor.reset(this.compose());
  }

  get draft(): AdminParams {
    return this.editor.draft;
  }

  get liveParams(): AdminParams {
    return this.editor.live;
  }

  get validationReport(): ValidationReport | null {
    return this.report;
  }

  get saveState(): SaveState {
    return this.saveStateRef;
  }

  /** ADM-302 — 저장 실패 복구 화면에 서 있는가 (P-13) */
  get isSaveFailedPrompt(): boolean {
    return this.saveFailedPrompt;
  }

  get currentPath(): readonly string[] {
    return [...this.path];
  }

  /** 테스트·씬이 경로를 직접 지정한다 (증거 절차의 8그룹 순회) */
  goTo(path: readonly string[]): boolean {
    if (findNode(path) === null) return false;
    this.path = [...path];
    this.cellIndex = 0;
    this.cursor.reset(this.rows());
    return true;
  }

  get cursorIndex(): number {
    return this.cursor.index;
  }

  get activeCell(): number {
    return this.cellIndex;
  }

  private changeSummary(): string {
    return this.changeSummaryOf(this.editor.draft);
  }

  private changeSummaryOf(p: AdminParams): string {
    const specs = this.editor.dirtySpecs();
    if (specs.length === 0) return '변경 없음';
    return specs.map((spec) => `${spec.label}=${formatFieldValue(spec, p)}`).join(' · ');
  }

  /** admin §4.2 — 성공 2.5초 · 경고 3초 · 오류는 확인할 때까지 유지 */
  private toast(text: string, level: ToastLevel): void {
    this.toastRef = { text, level, untilMs: this.deps.clock.now() + TOAST_MS[level] };
  }

  private audit(
    kind: AuditEvent['kind'],
    extra: { target?: string; before?: string; after?: string; result?: string; detail?: string }
  ): void {
    const sink: AuditSink = this.deps.audit;
    sink({
      kind,
      at: this.deps.nowIso(),
      detail: extra.detail ?? extra.target ?? '',
      ...(extra.target === undefined ? {} : { target: extra.target }),
      ...(extra.before === undefined ? {} : { before: extra.before }),
      ...(extra.after === undefined ? {} : { after: extra.after }),
      result: extra.result ?? 'ok',
    });
  }

  /** 진단 화면이 쓰는 현재 구간 목록 (테스트가 전수 확인한다) */
  static readonly tiers: readonly ParamTier[] = PARAM_TIERS;
}
