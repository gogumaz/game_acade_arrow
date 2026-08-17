// 유료 플레이 차단 게이트 (§12.4 — 작업 계획 P-5)
//
// §12.4는 다섯 가지 상황에서 **유료 플레이를 차단하고 이미 들어온 크레딧은 유지**하라고 한다.
// 그 다섯 신호는 서로 다른 계층(입력 어댑터 · 저장 계층 · 메인 프로세스 · 크레딧 서비스 ·
// 부팅 복구)에 흩어져 있다. 여기 하나로 모으는 이유는 두 가지다.
//
//   ① `flow.startPaidRun()`에 훅이 **1개**만 붙는다 → 우회 경로가 생길 자리가 없다 (C2)
//   ② 다섯 조건 각각을 Phaser·IPC 없이 단위 판정할 수 있다
//
// 차단은 START만 막는다. COIN 적립·관리자 진입·테스트 플레이는 영향받지 않는다 (§12.4 · §5).

import type { SaveFileName } from '../persist/csv';
import { FILES } from '../persist/csv';
import type { BootOutcome, BootReportEntry } from '../persist/storage';
import type { HealthReport } from './health';

/** §12.4 차단 5조건. 배열 순서가 곧 표시 우선순위다 (P-5) */
export const BLOCK_REASONS = [
  'io_disconnected',
  'storage_unavailable',
  'fatal_repeat',
  'credit_log_write',
  'params_unrecoverable',
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number];

/** §12.4 — 연속 저장 실패 임계 (착수 Q3-b · 가정 (다) — 크레딧 로그와 같은 3회) */
export const SAVE_FAIL_STREAK_LIMIT = 3;

/**
 * §12.3 — 문구는 **문제 · 영향 · 다음 행동** 3요소다.
 * 연출·색은 WU-07 소관이라 여기서는 텍스트만 확정한다.
 */
export const BLOCK_TEXT: Readonly<Record<BlockReason, string>> = {
  io_disconnected: 'I/O DISCONNECTED · 코인/조작 불가',
  storage_unavailable: 'STORAGE UNAVAILABLE · 기록이 남지 않습니다',
  fatal_repeat: 'SERVICE REQUIRED · 반복 오류로 자동 재실행 중지',
  credit_log_write: 'CREDIT LOG WRITE FAILED · 크레딧 기록 불가',
  params_unrecoverable: 'PARAM DATA UNRECOVERABLE · 설정 복구 실패',
};

/** 어트랙트·READY가 그대로 그리는 한 줄 (§12.3 · §12.4) */
export function paidBlockedMessage(reason: BlockReason): string {
  return `PAID PLAY BLOCKED · ${BLOCK_TEXT[reason]} · SERVICE 호출`;
}

/** `flow`가 보는 유일한 표면 — 구현이 무엇이든 이 한 메서드만 쓴다 */
export interface PaidPlayGate {
  /** 유료 시작을 막는 사유. `null`이면 통과 */
  reason(): BlockReason | null;
}

/** 항상 통과하는 게이트 — WU-03 동작 그대로다 (기본값) */
export function openPaidPlayGate(): PaidPlayGate {
  return { reason: () => null };
}

/** 저장 계층에서 필요한 부분만 (테스트가 가짜를 넣을 수 있게 최소화) */
export interface SafetyStoragePort {
  readonly backendKind: 'electron' | 'localStorage' | 'memory';
  readonly saveFailStreak: number;
  bootOutcomeOf(file: SaveFileName): BootReportEntry | null;
}

export interface SafetyCreditsPort {
  readonly blockReason: 'credit_log_write' | null;
}

export interface SafetyMonitorDeps {
  readonly storage: SafetyStoragePort;
  readonly credits: SafetyCreditsPort;
  /** 메인 프로세스 상태. 브라우저 모드는 항상 null (P-8) */
  readonly health?: () => HealthReport | null;
  /**
   * 실기 판정만 차단할지 여부. 개발 브라우저는 `localStorage` 백엔드라 저장이 되지만
   * 메모리 강등은 어디서나 차단 사유다 (§12.4).
   */
  readonly ioConnected?: boolean;
}

/** §12.3 — OVERVIEW가 부팅당 **한 번** 보여 주는 경고 */
export interface BootNotice {
  readonly code:
    | 'BACKUP RESTORED'
    | 'FACTORY DATA LOADED'
    | 'PARAM DATA VERSION'
    | 'STORAGE LOW'
    | 'SERVICE REQUIRED';
  readonly text: string;
}

const OUTCOME_TEXT: Readonly<Partial<Record<BootOutcome, BootNotice['code']>>> = {
  backup_restored: 'BACKUP RESTORED',
  factory: 'FACTORY DATA LOADED',
  version_backup: 'PARAM DATA VERSION',
};

const NOTICE_DETAIL: Readonly<Record<BootNotice['code'], string>> = {
  'BACKUP RESTORED': '마지막 정상 설정을 불러왔습니다',
  'FACTORY DATA LOADED': '저장 파일을 읽지 못해 공장값으로 시작했습니다',
  'PARAM DATA VERSION': '불일치 · 날짜 백업 후 공장값 적용',
  'STORAGE LOW': '남은 공간 200MB 미만 · 저장 경로 확인',
  'SERVICE REQUIRED': '반복 치명 오류로 자동 재실행이 중지됐습니다',
};

/**
 * 다섯 조건을 한 곳에서 판정한다. 상태를 **소유하지 않고** 매 호출마다 소스를 다시 읽으므로,
 * 조건이 사라지면 다음 호출에서 곧바로 해제된다 (§12.4 "해제 시 복귀" · C2).
 */
export class SafetyMonitor implements PaidPlayGate {
  private readonly deps: SafetyMonitorDeps;
  private io: boolean;
  private healthRef: HealthReport | null = null;
  private notices: BootNotice[] | null = null;
  /** 부팅 경고를 이미 넘겼는가 — **부팅당 1회**가 이 플래그로 성립한다 (P-12) */
  private consumed = false;

  constructor(deps: SafetyMonitorDeps) {
    this.deps = deps;
    this.io = deps.ioConnected ?? true;
  }

  /** §17 `[보류]` #1 — Serial 실물이 붙으면 어댑터가 이 플래그를 뒤집는다 */
  setIoConnected(connected: boolean): void {
    this.io = connected;
  }

  get ioConnected(): boolean {
    return this.io;
  }

  /** 부팅·관리자 진입에서 갱신한다 (가정 (라)) */
  setHealth(report: HealthReport | null): void {
    this.healthRef = report;
    this.notices = null; // STORAGE LOW·SERVICE REQUIRED가 바뀌었을 수 있다
  }

  get health(): HealthReport | null {
    return this.healthRef ?? this.deps.health?.() ?? null;
  }

  /** §12.4 — 다섯 조건을 우선순위대로. `null`이면 유료 시작을 허용한다 */
  reason(): BlockReason | null {
    if (!this.io) return 'io_disconnected';
    if (this.storageUnavailable()) return 'storage_unavailable';
    if (this.health?.serviceRequired === true) return 'fatal_repeat';
    if (this.deps.credits.blockReason !== null) return 'credit_log_write';
    if (this.paramsUnrecoverable()) return 'params_unrecoverable';
    return null;
  }

  get blocked(): boolean {
    return this.reason() !== null;
  }

  /** 어트랙트·READY 문구. 차단이 아니면 null */
  message(): string | null {
    const reason = this.reason();
    return reason === null ? null : paidBlockedMessage(reason);
  }

  /**
   * ② 저장 불가 — 메모리 강등(어떤 백엔드에도 못 씀) **또는** 연속 저장 실패 3회.
   * 저장 1회 성공이 `saveFailStreak`을 0으로 만들어 자동 해제된다.
   */
  private storageUnavailable(): boolean {
    if (this.deps.storage.backendKind === 'memory') return true;
    return this.deps.storage.saveFailStreak >= SAVE_FAIL_STREAK_LIMIT;
  }

  /**
   * ⑤ params 복구 불능 — 가정 (가): 본·백업 모두 무효(`factory`)이고 **공장값 재기록까지
   * 실패**했을 때만이다. 재기록이 성공했다면 다음 부팅은 정상이므로 경고로 충분하다.
   */
  private paramsUnrecoverable(): boolean {
    const entry = this.deps.storage.bootOutcomeOf(FILES.params);
    return entry !== null && entry.outcome === 'factory' && entry.rewriteFailed;
  }

  /**
   * §12.3 — 부팅 경고 목록. **두 번째 호출부터는 빈 목록**이다 (OVERVIEW 1회 표시 · P-12).
   *
   * `setHealth()`가 목록을 다시 만들어도 이 플래그는 풀리지 않는다 — 관리자에 드나들 때마다
   * 같은 경고가 되살아나면 "1회"가 아니게 된다.
   */
  consumeBootNotices(): readonly BootNotice[] {
    if (this.consumed) return [];
    this.consumed = true;
    return this.bootNotices();
  }

  /** 소비하지 않고 들여다본다 (테스트·상태 표시) */
  peekBootNotices(): readonly BootNotice[] {
    return this.bootNotices();
  }

  private bootNotices(): readonly BootNotice[] {
    const cached = this.notices;
    if (cached !== null) return cached;
    const out: BootNotice[] = [];
    for (const file of [FILES.settings, FILES.params, FILES.stats, FILES.ranking]) {
      const entry = this.deps.storage.bootOutcomeOf(file);
      if (entry === null) continue;
      const code = OUTCOME_TEXT[entry.outcome];
      if (code === undefined) continue;
      out.push({ code, text: `${code} · ${file} · ${NOTICE_DETAIL[code]}` });
    }
    const health = this.health;
    if (health?.storageLow === true) {
      out.push({ code: 'STORAGE LOW', text: `STORAGE LOW · ${NOTICE_DETAIL['STORAGE LOW']}` });
    }
    if (health?.serviceRequired === true) {
      out.push({
        code: 'SERVICE REQUIRED',
        text: `SERVICE REQUIRED · ${NOTICE_DETAIL['SERVICE REQUIRED']}`,
      });
    }
    this.notices = out;
    return out;
  }
}
