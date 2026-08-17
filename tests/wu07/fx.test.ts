// WU-07 — EFX-801~809 순수 연출·접근성·성능 계약

import { describe, expect, it } from 'vitest';
import {
  EffectBudget,
  FULL_SCREEN_FLASH_MAX_HZ,
  FX_TIMING,
  FxRuntime,
  LARGE_AREA_FLASH_MIN_INTERVAL_MS,
  LARGE_AREA_THRESHOLD,
  MAX_FULL_EFFECTS,
  STATE_CUES,
  contrastRatio,
  simulateColorVision,
  type ColorVisionMode,
} from '../../src/game/fx';
import {
  FONT_SIZE,
  PALETTE,
  REGIONS,
  estimatedTextWidth,
  fitFontSizeForWidth,
} from '../../src/game/render/boardView';

describe('EFX-801 — HUD와 보드 영역', () => {
  it('좌·우 HUD와 시간 영역이 보드 본문을 침범하지 않는다', () => {
    expect(overlap(REGIONS.leftHud, REGIONS.board)).toBe(false);
    expect(overlap(REGIONS.rightHud, REGIONS.board)).toBe(false);
    expect(overlap(REGIONS.time, REGIONS.board)).toBe(false);
    expect(REGIONS.boardFooter.y).toBe(REGIONS.board.y + REGIONS.board.height);
  });

  it('가독성 최소 글자 크기를 지킨다', () => {
    expect(FONT_SIZE.time).toBeGreaterThanOrEqual(72);
    expect(FONT_SIZE.score).toBeGreaterThanOrEqual(48);
    expect(FONT_SIZE.label).toBeGreaterThanOrEqual(28);
    expect(FONT_SIZE.body).toBeGreaterThanOrEqual(22);
  });
});

describe('EFX-803~805 — 대비·색각·상태 4종', () => {
  it.each([
    ['base', PALETTE.chain],
    ['focus', PALETTE.focus],
    ['blocked', PALETTE.blocked],
    ['hint', PALETTE.hint],
  ] as const)('%s 사슬은 배경 대비 4.5:1 이상이다', (_state, color) => {
    expect(contrastRatio(color, PALETTE.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('상태는 정확히 4종이고 각각 색 외 단서가 3개 이상이다', () => {
    expect(Object.keys(STATE_CUES)).toEqual(['base', 'focus', 'blocked', 'hint']);
    for (const cues of Object.values(STATE_CUES)) expect(cues.length).toBeGreaterThanOrEqual(3);
  });

  it.each(['protanopia', 'deuteranopia', 'tritanopia'] as const)(
    '%s 시뮬레이션에서도 값이 유효하고 비색상 단서 계약이 유지된다',
    (mode: ColorVisionMode) => {
      for (const color of [PALETTE.focus, PALETTE.blocked, PALETTE.hint]) {
        expect(simulateColorVision(color, mode)).toBeGreaterThanOrEqual(0);
        expect(simulateColorVision(color, mode)).toBeLessThanOrEqual(0xffffff);
      }
      expect(STATE_CUES.focus).toContain('dashed route');
      expect(STATE_CUES.blocked).toContain('horizontal shake');
      expect(STATE_CUES.hint).toContain('1.2s breath');
    }
  );
});

describe('EFX-806~809 — 타이밍·효과 예산·광과민·입력 지연', () => {
  it('0~100ms / 100~500ms / 완료 구간 상수가 기획값과 일치한다', () => {
    expect(FX_TIMING.focusMs).toBeLessThanOrEqual(60);
    expect(FX_TIMING.immediateMaxMs).toBe(100);
    expect(FX_TIMING.bodyMaxMs).toBe(500);
    expect(FX_TIMING.boardTransitionMs).toBe(800);
    expect(FX_TIMING.finaleMaxMs).toBeLessThanOrEqual(800);
  });

  it('동시 6개까지 full, 7번째부터 simplified다', () => {
    const budget = new EffectBudget();
    for (let i = 0; i < MAX_FULL_EFFECTS; i += 1) {
      expect(budget.start(`fx-${String(i)}`, 0, 500).detail).toBe('full');
    }
    expect(budget.start('fx-7', 0, 500).detail).toBe('simplified');
    expect(budget.count(500)).toBe(0);
  });

  it('MOTION REDUCE는 새 효과를 static으로 만든다', () => {
    const budget = new EffectBudget();
    budget.configure({ motionReduce: true });
    expect(budget.start('wave', 0, 500).detail).toBe('static');
  });

  it('MOTION REDUCE changes apply to the next run', () => {
    const runtime = new FxRuntime();
    runtime.configure({ motionReduce: false });
    runtime.beginRun();
    runtime.configure({ motionReduce: true });
    expect(runtime.motionReduced).toBe(false);

    runtime.endRun();
    runtime.beginRun();
    expect(runtime.motionReduced).toBe(true);
  });

  it('1Hz 시간 박동과 전면 3Hz 상한·대면적 간격을 지킨다', () => {
    expect(FX_TIMING.timePulseMs).toBe(1000);
    expect(1000 / FX_TIMING.timePulseMs).toBeLessThanOrEqual(FULL_SCREEN_FLASH_MAX_HZ);
    expect(LARGE_AREA_THRESHOLD).toBe(0.25);
    expect(LARGE_AREA_FLASH_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(500);
  });

  it('60Hz 프레임과 입력 피드백 p95를 계측한다', () => {
    const runtime = new FxRuntime();
    for (let i = 0; i <= 180; i += 1) runtime.frame(i * (1000 / 60));
    for (let i = 0; i < 40; i += 1) {
      runtime.noteInput(i * 100);
      runtime.present(i * 100 + 16);
    }
    const report = runtime.report();
    expect(report.averageFps).toBeCloseTo(60, 1);
    expect(report.frameP95Ms).toBeLessThan(18);
    expect(report.inputP95Ms).toBeLessThanOrEqual(80);
    expect(report.simplified).toBe(false);
  });

  it('지속 프레임 저하는 자동 단순화를 켠다', () => {
    const runtime = new FxRuntime();
    for (let i = 0; i <= 120; i += 1) runtime.frame(i * 20);
    expect(runtime.report().simplified).toBe(true);
  });
});

describe('EFX-811 — 문자열 잘림 방지', () => {
  it('긴 이름 입력 제목도 1760px 안으로 줄이고 22px 하한을 지킨다', () => {
    const text = 'TOP 10 진입! 이름을 입력하세요 · 15';
    const size = fitFontSizeForWidth(text, FONT_SIZE.headline, 1760);
    expect(size).toBeGreaterThanOrEqual(FONT_SIZE.body);
    expect(estimatedTextWidth(text, size)).toBeLessThanOrEqual(1760);
  });
});

function overlap(
  a: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  b: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
