// 관리자 뷰 모델과 문구 (admin §4.2 공통 레이아웃 · 부록 A 운영 문구 — 작업 계획 P-1 · P-10)
//
// **관리자 문구는 이 파일 1곳에만 있다.** 씬은 여기서 만든 `AdminView`를 그대로 그리고
// 문자열을 만들지 않는다 (WU-03 `render/panels.ts` 선례).
//
// 뷰 모델이 1종인 이유: admin §4.2의 공통 레이아웃(헤더·행 목록·상세 패널·푸터·토스트)이
// **모든 화면에서 같다.** 그룹마다 씬을 두면 화면 수만큼 Phaser 결선이 늘고 테스트가
// 불가능해진다 (P-1).

import type { ValidationIssue } from '../../core/adminParams';
import type { RiskLevel } from './danger';
import type { OverallStatus } from './diagnostics';
import { OVERALL_GLYPH } from './diagnostics';

/** admin §4.3 — 색맹 대응 기호. 정상 `●` 경고 `▲` 오류 `×` 읽기 전용 `—` */
type RowMarker = '●' | '▲' | '×' | '—' | ' ';

export const MARKER = {
  normal: '●',
  warn: '▲',
  error: '×',
  readOnly: '—',
  none: ' ',
} as const;

export type ToastLevel = 'ok' | 'warn' | 'error';

/** admin §4.2 — 성공 2.5초, 경고 3초, 오류는 확인할 때까지 유지 */
export const TOAST_MS: Readonly<Record<ToastLevel, number>> = {
  ok: 2500,
  warn: 3000,
  error: Number.POSITIVE_INFINITY,
};

export interface AdminToast {
  readonly text: string;
  readonly level: ToastLevel;
}

export interface AdminRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly marker: RowMarker;
  /** 읽기 전용 행은 커서가 건너뛴다 (admin §4.1) */
  readonly selectable: boolean;
  /** `[WU-07 대기]` · `[WU-08 대기]` · `[보류]` */
  readonly badge?: string;
  /** admin §4.3 반영 시점 표기 */
  readonly applyTiming?: string;
  /** 여러 셀 행(구간표 MIN~MAX · NIGHT MUTE)의 활성 셀 */
  readonly cellCount?: number;
  readonly cellIndex?: number;
}

export interface DangerView {
  readonly label: string;
  readonly summary: string;
  readonly level: RiskLevel;
  /** 필요한 홀드 시간(ms). 0이면 `H` 1회 확정 */
  readonly requiredHoldMs: number;
  readonly progress01: number;
  readonly executing: boolean;
  readonly autoCancelLeftMs: number;
  readonly balanceWarning?: string;
  readonly rejected: boolean;
}

export interface AdminView {
  readonly breadcrumb: string;
  readonly clock: string;
  /** `● READY` / `▲ CHECK` / `× SERVICE REQUIRED` */
  readonly status: string;
  readonly rows: readonly AdminRow[];
  readonly cursor: number;
  /** 우측 40% 상세 패널 (설명·범위·기본값·현재 영향) */
  readonly detail: readonly string[];
  readonly footer: string;
  /** `SAVED · 2026-08-17 09:12:03` / `SAVING... DO NOT POWER OFF` / `UNSAVED` */
  readonly saveState: string;
  readonly toast: AdminToast | null;
  readonly danger: DangerView | null;
  /** §11.5 — 오류는 **전체 목록**을 보여 준다 (첫 항목 토스트로 끝내지 않는다) */
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  /** 솔버 게이트 배지 — 스텁이면 `[WU-08 대기] SKIPPED` */
  readonly solverBadge: string;
}

// ── 문구 (admin 부록 A) ───────────────────────────────────────────────────

export const ADMIN_TEXT = {
  saved: (stamp: string): string => `SAVED · ${stamp}`,
  saving: 'SAVING... DO NOT POWER OFF',
  unsaved: 'UNSAVED',
  saveFailed: 'SAVE FAILED · 변경 미적용 · H 재시도 / G 취소',
  savePathHint: 'SAVE FAILED · 저장 경로 확인',
  holdToSave: (sec: number): string => `경고 ${String(sec)}초 홀드로 저장`,
  holdRejected: 'H를 더 오래 유지하세요',
  resetConfirm: (target: string, count: number): string =>
    `${target} ${String(count)}개 항목을 0으로 만듭니다 · H 2초 유지`,
  restoreConfirm: (target: string): string =>
    `${target}을(를) 공장값으로 복원합니다 · 되돌리려면 백업 필요`,
  rankingResetConfirm: (count: number): string =>
    `랭킹 ${String(count)}건을 삭제합니다 · H 2초 유지`,
  paidCreditMax: 'PAID CREDIT MAX 99',
  eventCreditMax: 'EVENT CREDIT MAX 5',
  stuckInput: (label: string): string => `STUCK INPUT · ${label} · 배선/스위치 확인`,
  serialError: 'I/O DISCONNECTED · 코인/조작 불가 · SERVICE REQUIRED',
  backupRestored: 'BACKUP RESTORED · 마지막 정상 설정을 불러왔습니다',
  testPlayBanner: 'TEST PLAY · NO CREDIT / NO RANKING / NO STATS',
  unsavedChoice: '미저장 변경이 있습니다 — SAVE / DISCARD / CANCEL',
  idleBlocked: '미저장 변경이 있어 자동 복귀하지 않습니다',
  discarded: '작업 사본을 폐기했습니다',
  blockedByErrors: (n: number): string => `오류 ${String(n)}건 — 저장·테스트 불가`,
  solverPending: '[WU-08 대기] SKIPPED',
  solverOk: (boards: number, ms: number): string => `ok (${String(boards)}보드 / ${String(ms)}ms)`,
  solverFailed: (n: number): string => `실패 ${String(n)}건`,
  pendingBadge: (unit: string): string => `[${unit} 대기]`,
  holdBadge: '[보류]',
} as const;

/** admin §4.2 푸터 — 현재 화면에서 유효한 조작만 */
export const FOOTER = {
  menu: 'W/S 이동 · H 열기 · G 뒤로',
  fields: 'W/S 이동 · A/D 변경 · H 셀 전환 · G 뒤로',
  danger: 'H 유지 = 실행 · G 취소',
  info: 'W/S 이동 · G 뒤로',
  root: 'W/S 이동 · H 열기 · G 종료',
} as const;

export function statusText(status: OverallStatus): string {
  const label = status === 'SERVICE_REQUIRED' ? 'SERVICE REQUIRED' : status;
  return `${OVERALL_GLYPH[status]} ${label}`;
}

/** §11.5 — 오류·경고 1건을 한 줄로 */
function issueLine(issue: ValidationIssue): string {
  return `${issue.label} — ${issue.detail}`;
}

export function issueLines(issues: readonly ValidationIssue[]): readonly string[] {
  return issues.map(issueLine);
}

/** admin §1.2 — 관리자 화면 통계는 천 단위 구분자를 쓴다 (랭킹의 0 패딩이 아니다) */
export function formatCount(n: number): string {
  return Math.trunc(n).toLocaleString('en-US');
}

export function formatMoney(won: number | null): string {
  return won === null ? '— 미설정' : `${formatCount(won)} 원`;
}

/** `2026-08-17 09:12:03` — 헤더 시각과 `SAVED` 스탬프가 같은 형식을 쓴다 */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDurationMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m)}분 ${String(s).padStart(2, '0')}초`;
}

/** 읽기 전용 정보 행 */
export function infoRow(id: string, label: string, value: string, badge?: string): AdminRow {
  return {
    id,
    label,
    value,
    marker: MARKER.readOnly,
    selectable: false,
    ...(badge === undefined ? {} : { badge }),
  };
}

/** 선택 가능한 메뉴·명령 행 */
export function menuRow(id: string, label: string, value = ''): AdminRow {
  return { id, label, value, marker: MARKER.none, selectable: true };
}
