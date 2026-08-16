// 감사 로그 `audit_log.csv` (§11.7 · admin §11.2 — 작업 계획 §5.3 · 실측 제약 F-c)
//
// **헤더 줄을 붙이지 않는다.** `tests/wu01/storage.test.ts:99`가 `append(auditLog, 'admin_enter')`
// 뒤에 읽은 내용이 정확히 `'admin_enter'`라고 단언한다. `storage.headerFor()`는 그대로 둔다.
//
// 컬럼 6열 — `timestamp,action,target,before,after,result`
// admin §11.2 권장 9열에서 `machineId`·`operatorRole`·`appVersion` 3열을 뺐다 (계획 Q-6):
// `machine.json`은 WU-06 소관이고, 역할 분리는 §11.1이 미채택(`[2차]`)이며, 앱 버전은 빌드
// 상수 도입이 필요하다. 뺀 3열은 §18 이월 6에 기록돼 있다.
//
// 개인정보: **랭킹 이니셜을 넣지 않는다** (§5.7 · admin §11.6). `RESET RANKING`은 건수만 남긴다.
//
// WU-04가 이미 쏘던 `AuditSink`와 **같은 경로**를 쓴다. 관리자 화면도 `AuditEvent`를 쏘고
// 이 모듈이 한 곳에서 CSV 행으로 옮긴다 — WU-04 P-12가 비워 둔 자리의 완결이다.

import type { AuditEvent, AuditKind } from '../../core/stats';
import { FILES, sanitizeField } from '../../persist/csv';

export const AUDIT_COLUMNS = [
  'timestamp',
  'action',
  'target',
  'before',
  'after',
  'result',
] as const;

/** §11.7 · 계획 §5.3 표 — `AuditKind` 13종을 CSV `action` 문자열로 옮긴다 */
export const AUDIT_ACTION: Readonly<Record<AuditKind, string>> = {
  CLOCK_CHANGED: 'clock_changed',
  CREDIT_RECOVERED: 'credit_recovered',
  STATS_RESET: 'stats_reset',
  EVENT_GRANT: 'event_grant',
  CREDIT_LOG_FAILURE: 'credit_log_failure',
  ADMIN_ENTER: 'admin_enter',
  ADMIN_EXIT: 'admin_exit',
  SETTING_CHANGE: 'setting_change',
  PARAM_SAVE: 'param_save',
  PARAM_RESTORE: 'param_restore',
  RANKING_RESET: 'ranking_reset',
  SYSTEM_ACTION: 'system_action',
  TEST_PLAY: 'test_play',
};

interface AuditRecord {
  readonly timestamp: string;
  readonly action: string;
  readonly target: string;
  readonly before: string;
  readonly after: string;
  readonly result: string;
}

/** `AuditEvent` → 6열 레코드. `detail`은 `target`이 비어 있을 때만 쓰는 자유 칸이다 */
export function auditRecordOf(e: AuditEvent): AuditRecord {
  return {
    timestamp: e.at,
    action: AUDIT_ACTION[e.kind],
    target: e.target ?? e.detail,
    before: e.before ?? '',
    after: e.after ?? '',
    result: e.result ?? 'ok',
  };
}

/** 값에 쉼표·개행을 넣지 않는다 (§9.1) */
export function auditLine(rec: AuditRecord): string {
  return [
    sanitizeField(rec.timestamp),
    sanitizeField(rec.action),
    sanitizeField(rec.target),
    sanitizeField(rec.before),
    sanitizeField(rec.after),
    sanitizeField(rec.result),
  ].join(',');
}

/** 손상 행이면 null — 진단 화면이 최근 감사 기록을 읽을 때 쓴다 */
export function parseAuditLine(line: string): AuditRecord | null {
  const c = line.split(',');
  if (c.length < AUDIT_COLUMNS.length) return null;
  if (c[0].trim() === '' || c[1].trim() === '') return null;
  return {
    timestamp: c[0],
    action: c[1],
    target: c[2],
    before: c[3],
    after: c[4],
    result: c[5],
  };
}

interface AuditLoggerDeps {
  /** `Storage.appendLine(FILES.auditLog, line)` */
  readonly append: (file: typeof FILES.auditLog, line: string) => void;
}

/** `AuditSink`를 그대로 파일 1줄로 옮긴다 */
export class AuditLogger {
  private readonly lines: string[] = [];

  constructor(private readonly deps: AuditLoggerDeps) {}

  write(e: AuditEvent): void {
    const line = auditLine(auditRecordOf(e));
    this.lines.push(line);
    this.deps.append(FILES.auditLog, line);
  }

  /** 이 세션에서 기록한 줄 (진단·테스트용) */
  get written(): readonly string[] {
    return [...this.lines];
  }
}
