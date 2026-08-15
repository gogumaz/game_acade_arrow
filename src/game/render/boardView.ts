// 좌표 변환과 최소 팔레트 (§8.1 레이아웃 · §9.1 오락실 팔레트)
//
// 이 파일은 **Phaser를 import 하지 않는다** — 좌표 계산은 순수 산술이라 그리기 계층과 분리해 둔다.
// 색·굵기 최종값과 `theme.ts` 이전은 WU-07 소관이며, 여기 있는 값은 §9.1 표의 전사다.

import type { GridPoint } from '../../core/types';

/** §8.1 — 보드는 화면 중앙 640×960, 좌상단이 (640, 60) */
export const BOARD_ORIGIN = { x: 640, y: 60 } as const;
export const BOARD_WIDTH = 640;
export const BOARD_HEIGHT = 960;

/** 격자 칸 크기. §8.1의 "53px"은 이 값의 반올림 표기다 (640 / 12 = 53.333…) */
const CELL = BOARD_WIDTH / 12;

export const SCREEN_WIDTH = 1920;
export const SCREEN_HEIGHT = 1080;

/** §8.1 좌 HUD x 0~620 · 우 HUD x 1300~1920 · 상단 시간 y 0~60 · 하단 사슬 수 y 1020~1080 */
export const LAYOUT = {
  leftHudX: 40,
  rightHudX: 1320,
  hudTopY: 120,
  hudLineHeight: 56,
  timeY: 30,
  bottomY: 1046,
  centerX: SCREEN_WIDTH / 2,
  centerY: SCREEN_HEIGHT / 2,
} as const;

/**
 * 격자 좌표 → 화면 좌표. 정수 격자 점과 소수 좌표(슬라이드 아웃 중간 위치)를 같은 식으로 다룬다.
 */
export function toScreenXY(x: number, y: number): { x: number; y: number } {
  return { x: BOARD_ORIGIN.x + CELL * x, y: BOARD_ORIGIN.y + CELL * y };
}

/** §9.1 오락실 팔레트 — 어두운 배경 + 밝은 사슬 (D-1 Q9) */
export const PALETTE = {
  background: 0x0b1020,
  grid: 0x1e2a44,
  chain: 0xe8edf7,
  chainCore: 0xffffff,
  focus: 0x35e0ff,
  blocked: 0xff4d5e,
  hint: 0xffd24a,
  heartFull: 0xff6b8a,
  heartEmpty: 0x40485c,
  text: 0xf2f5fa,
} as const;

/** CSS 표기 — `add.text`가 문자열 색을 받는다 */
export const CSS = {
  background: '#0B1020',
  text: '#F2F5FA',
  dim: '#8C96AE',
  focus: '#35E0FF',
  blocked: '#FF4D5E',
  hint: '#FFD24A',
  heart: '#FF6B8A',
} as const;

/** §9.1 — 기본 12px · 포커스 16.8px(1.4배) · 외곽 2px · 화살촉 1.6배 */
export const LINE = {
  base: 12,
  focus: 12 * 1.4,
  outline: 2,
  arrowScale: 1.6,
} as const;

/** §8.3 최소 글자 크기 — 남은 시간 72 · 점수 48 · 라벨 28 · 보조 22 */
export const FONT_FAMILY = 'monospace';
export const FONT_SIZE = {
  time: 72,
  score: 48,
  label: 28,
  body: 22,
  headline: 96,
} as const;

/** 점수는 7자리 0 패딩 (§8.2 4단) */
export function formatScore(score: number): string {
  return Math.max(0, Math.floor(score)).toString().padStart(7, '0');
}

/** 콤보 배율 표기 — centis(100 = ×1.00) */
export function formatCombo(centis: number): string {
  return `×${(centis / 100).toFixed(1)}`;
}

/** 남은 시간 — 초 단위 올림 표기(0.1초까지). 10초 이하에서 소수 첫째 자리를 보여 준다 */
export function formatTime(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds <= 10 ? seconds.toFixed(1) : Math.ceil(seconds).toString();
}

/** 카운트다운 — 남은 초를 올림해서 항상 1 이상으로 보인다 (§8.4 "남은 초를 항상 표시") */
export function formatCountdown(ms: number): string {
  return Math.max(0, Math.ceil(ms / 1000)).toString();
}

/** 두 점 사이를 선형 보간한 격자 좌표 — 슬라이드 아웃의 중간 위치 계산 */
export function lerpPath(path: readonly GridPoint[], at: number): { x: number; y: number } {
  if (path.length === 0) return { x: 0, y: 0 };
  const clamped = Math.max(0, Math.min(at, path.length - 1));
  const i = Math.floor(clamped);
  const j = Math.min(i + 1, path.length - 1);
  const t = clamped - i;
  return { x: path[i].x + (path[j].x - path[i].x) * t, y: path[i].y + (path[j].y - path[i].y) * t };
}
