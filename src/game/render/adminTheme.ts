// 관리자 서비스 톤 (admin §1.2 — 작업 계획 §3.5)
//
// 게임 팔레트(`boardView.ts`)와 **독립**이다. 네온 연출을 최소화하고 어두운 회색 서비스 메뉴
// 톤을 쓴다. 정상 청록 · 주의 노랑 · 오류·파괴 빨강 · 읽기 전용 회색이며, 색맹 대응을 위해
// `● ▲ × —` 기호를 항상 함께 쓴다(기호는 `admin/view.ts`가 만든다).
//
// 지속 애니메이션은 선택 커서와 연결 상태 표시만 허용한다.

export const ADMIN_CSS = {
  background: '#141719',
  panel: '#1B1F22',
  headerBar: '#22272B',
  text: '#E6E9EC',
  dim: '#9AA3AA',
  ok: '#2FD8C6',
  warn: '#F2C14E',
  error: '#F2545B',
  readOnly: '#6E767D',
  cursor: '#2FD8C6',
  cursorText: '#0C0F11',
} as const;

export const ADMIN_HEX = {
  background: 0x141719,
  headerBar: 0x22272b,
  cursor: 0x2fd8c6,
  rule: 0x2c3237,
} as const;

/** admin §1.1 10-foot 가독성 — 1920×1080을 선 채로 읽는 크기 */
export const ADMIN_FONT = {
  family: 'monospace',
  header: 26,
  row: 28,
  detail: 22,
  footer: 22,
  toast: 30,
  danger: 40,
} as const;

/** admin §4.2 — 메뉴 좌측 60% · 상세 패널 우측 40% */
export const ADMIN_LAYOUT = {
  headerY: 40,
  ruleTopY: 84,
  rowX: 60,
  rowValueX: 760,
  rowFirstY: 132,
  rowGap: 40,
  rowsPerPage: 20,
  detailX: 1200,
  detailY: 132,
  detailGap: 34,
  footerY: 1020,
  toastY: 960,
  dangerY: 470,
  screenWidth: 1920,
  screenHeight: 1080,
} as const;

/** 기호별 색 — 행 마커와 같은 규칙을 값에도 쓴다 */
export function colorOfMarker(marker: string): string {
  switch (marker) {
    case '●':
      return ADMIN_CSS.ok;
    case '▲':
      return ADMIN_CSS.warn;
    case '×':
      return ADMIN_CSS.error;
    case '—':
      return ADMIN_CSS.readOnly;
    default:
      return ADMIN_CSS.text;
  }
}

export function colorOfToast(level: 'ok' | 'warn' | 'error'): string {
  return level === 'ok' ? ADMIN_CSS.ok : level === 'warn' ? ADMIN_CSS.warn : ADMIN_CSS.error;
}
