// WU-07 — HUD 팝업과 보드 클리어 파동 (§8.2 · §9.2)

import Phaser from 'phaser';
import type { RunSnapshot } from '../runController';
import { FX_TIMING } from '../fx';
import {
  BOARD_HEIGHT,
  BOARD_ORIGIN,
  BOARD_WIDTH,
  CSS,
  FONT_FAMILY,
  FONT_SIZE,
  LAYOUT,
  PALETTE,
} from './boardView';

const POPUP_MS = 500;

interface PopupState {
  text: string;
  untilMs: number;
}

export class FxOverlay {
  private readonly wave: Phaser.GameObjects.Graphics;
  private readonly score: Phaser.GameObjects.Text;
  private readonly time: Phaser.GameObjects.Text;
  private readonly combo: Phaser.GameObjects.Text;
  private previousScore: number | null = null;
  private previousTime: number | null = null;
  private previousCombo = 100;
  private transitionSeen = false;
  private waveStartedAt: number | null = null;
  private scoreState: PopupState | null = null;
  private timeState: PopupState | null = null;
  private comboState: PopupState | null = null;

  constructor(scene: Phaser.Scene) {
    this.wave = scene.add.graphics();
    this.score = scene.add
      .text(LAYOUT.leftHudX, 360, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.label}px`,
        color: CSS.successTrail,
      })
      .setVisible(false);
    this.time = scene.add
      .text(LAYOUT.centerX + 72, LAYOUT.timeY + 6, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.label}px`,
        color: CSS.focus,
      })
      .setVisible(false);
    this.combo = scene.add
      .text(LAYOUT.leftHudX, 300, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.score}px`,
        color: CSS.focus,
      })
      .setVisible(false);
  }

  update(
    run: RunSnapshot,
    nowMs: number,
    options: { readonly motionReduced: boolean; readonly simplified: boolean }
  ): void {
    this.detect(run, nowMs);
    this.drawPopup(this.score, this.scoreState, nowMs, options.motionReduced);
    this.drawPopup(this.time, this.timeState, nowMs, options.motionReduced);
    this.drawPopup(this.combo, this.comboState, nowMs, options.motionReduced);
    this.drawWave(
      nowMs,
      options.motionReduced || options.simplified,
      run.lastClear?.perfect === true
    );
  }

  destroy(): void {
    this.wave.destroy();
    this.score.destroy();
    this.time.destroy();
    this.combo.destroy();
  }

  private detect(run: RunSnapshot, nowMs: number): void {
    if (this.previousScore !== null && run.displayScore > this.previousScore) {
      this.scoreState = {
        text: `+${String(run.displayScore - this.previousScore)}`,
        untilMs: nowMs + POPUP_MS,
      };
    }
    if (this.previousTime !== null) {
      // 정상 틱 감산보다 50ms 이상 증가했을 때만 회복 팝업이다.
      const gained = run.timeRemainingMs - this.previousTime;
      if (gained > 50) {
        this.timeState = { text: `+${(gained / 1000).toFixed(1)}`, untilMs: nowMs + POPUP_MS };
      }
    }
    if (run.comboCentis >= 200 && run.comboCentis > this.previousCombo) {
      this.comboState = {
        text: `×${(run.comboCentis / 100).toFixed(1)}`,
        untilMs: nowMs + POPUP_MS,
      };
    }
    if (run.transitioning && !this.transitionSeen) this.waveStartedAt = nowMs;
    this.transitionSeen = run.transitioning;
    this.previousScore = run.displayScore;
    this.previousTime = run.timeRemainingMs;
    this.previousCombo = run.comboCentis;
  }

  private drawPopup(
    target: Phaser.GameObjects.Text,
    state: PopupState | null,
    nowMs: number,
    motionReduced: boolean
  ): void {
    if (state === null || nowMs >= state.untilMs) {
      target.setVisible(false);
      return;
    }
    const progress = 1 - (state.untilMs - nowMs) / POPUP_MS;
    target
      .setText(state.text)
      .setVisible(true)
      .setAlpha(1 - progress * 0.35);
    target.setScale(
      motionReduced ? 1 : 0.9 + Math.sin(Math.min(1, progress * 2) * Math.PI * 0.5) * 0.25
    );
  }

  private drawWave(nowMs: number, reduced: boolean, perfect: boolean): void {
    this.wave.clear();
    if (reduced || this.waveStartedAt === null) return;
    const elapsed = nowMs - this.waveStartedAt;
    if (elapsed < 0 || elapsed >= FX_TIMING.boardWaveMs) {
      this.waveStartedAt = null;
      return;
    }
    const progress = elapsed / FX_TIMING.boardWaveMs;
    const radius = Math.max(20, Math.hypot(BOARD_WIDTH, BOARD_HEIGHT) * 0.5 * progress);
    this.wave.lineStyle(8, perfect ? PALETTE.hint : PALETTE.focus, 1 - progress);
    this.wave.strokeCircle(
      BOARD_ORIGIN.x + BOARD_WIDTH / 2,
      BOARD_ORIGIN.y + BOARD_HEIGHT / 2,
      radius
    );
  }
}
