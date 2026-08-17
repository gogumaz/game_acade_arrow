// 로그 보존 정리 (§12.1 · SAV-706 — 착수 Q2(a) · 작업 계획 P-6)
//
// `credit_log.csv`·`audit_log.csv`는 **12개월** 보존한다. 파일을 나누지 않고 단일 파일을 유지한
// 채 부팅 시 1회 오래된 행만 걷어 낸다 — 그래야 WU-04·WU-05의 소비자(잔액 복원·감사 조회)가
// 스키마도 경로도 그대로 쓸 수 있다.
//
// `error_YYYY-MM-DD.log` 90일은 파일 단위 삭제라 메인 프로세스(`main.cjs`)가 담당한다.
//
// **순수 함수다.** 시각도 파일도 모른다 — 호출자가 cutoff를 만들어 넣는다.

/** §12.1 — 크레딧·감사 로그 보존 기간 */
export const RETENTION_MONTHS = 12;

/**
 * `nowIso` 기준 `months`개월 전 ISO 문자열. 월 경계는 `Date`의 UTC 산술을 그대로 쓴다.
 * (2월 31일 같은 값은 `Date`가 다음 달로 정규화한다 — 보존 경계에서는 무해하다.)
 */
export function cutoffIso(nowIso: string, months = RETENTION_MONTHS): string {
  const d = new Date(nowIso);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

/**
 * 첫 열이 ISO 타임스탬프인 추가 전용 CSV에서 `cutoff`보다 오래된 행을 제거한다.
 *
 * 세 가지를 **보존**한다 (SAV-706 "다른 행 손실 0").
 *   ① 헤더 줄 (첫 줄이 타임스탬프로 읽히지 않으면 헤더로 본다)
 *   ② 타임스탬프를 해석할 수 없는 행 — 손상 행을 보존 정리가 삼키면 안 된다
 *   ③ cutoff 이상인 행 전부
 *
 * `cutoff`가 빈 문자열이면 아무것도 지우지 않는다 (측정 불가 = 보존).
 */
export function pruneByAge(csv: string, cutoff: string): string {
  if (cutoff === '') return csv;
  const cutoffMs = Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) return csv;

  const lines = csv.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      // 마지막 빈 줄(파일 끝 개행)은 그대로 유지한다
      out.push(line);
      continue;
    }
    const stamp = Date.parse(line.split(',')[0].trim());
    if (Number.isNaN(stamp)) {
      out.push(line); // ① 헤더 · ② 손상 행
      continue;
    }
    if (stamp >= cutoffMs) out.push(line); // ③
  }
  return out.join('\n');
}

/** 정리 결과 — 호출자는 `changed`일 때만 파일을 다시 쓴다 (불필요한 쓰기 금지) */
export interface PruneResult {
  readonly next: string;
  readonly changed: boolean;
  readonly removed: number;
}

export function pruneLog(csv: string, cutoff: string): PruneResult {
  const next = pruneByAge(csv, cutoff);
  const countRows = (s: string): number => s.split('\n').filter((l) => l.trim() !== '').length;
  return {
    next,
    changed: next !== csv,
    removed: Math.max(0, countRows(csv) - countRows(next)),
  };
}
