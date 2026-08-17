// 인게임 HUD (§8.1 배치 · §8.2 정보 우선순위 · §8.3 가독성 · §9.4 모션 안전)
//
// 좌우 HUD는 **보드와 겹치지 않는다** (§8.1). 버튼 안내는 물리 버튼과 같은 쪽에 둔다 —
// 힌트(좌측 버튼)는 좌 HUD 하단, 당기기(우측 버튼)는 우 HUD 하단.

import Phaser from 'phaser';
import type { FlowSnapshot } from '../flow';
import type { RunSnapshot } from '../runController';
import { TIME_PULSE_MS, TIME_PULSE_THRESHOLD_MS } from '../timing';
import {
  BOARD_ORIGIN,
  BOARD_WIDTH,
  CSS,
  FONT_FAMILY,
  FONT_SIZE,
  LAYOUT,
  PALETTE,
  formatCombo,
  formatScore,
  formatTime,
} from './boardView';

const HEART_RADIUS = 16;
const HEART_GAP = 46;
const RING_RADIUS = 20;

function label(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size: number,
  color: string
): Phaser.GameObjects.Text {
  return scene.add.text(x, y, '', { fontFamily: FONT_FAMILY, fontSize: `${size}px`, color });
}

export class Hud {
  private readonly time: Phaser.GameObjects.Text;
  private readonly score: Phaser.GameObjects.Text;
  private readonly combo: Phaser.GameObjects.Text;
  private readonly best: Phaser.GameObjects.Text;
  private readonly hint: Phaser.GameObjects.Text;
  private readonly board: Phaser.GameObjects.Text;
  private readonly next: Phaser.GameObjects.Text;
  private readonly credit: Phaser.GameObjects.Text;
  private readonly pull: Phaser.GameObjects.Text;
  private readonly chains: Phaser.GameObjects.Text;
  private readonly hearts: Phaser.GameObjects.Graphics;
  private readonly ring: Phaser.GameObjects.Graphics;
  private readonly items: Phaser.GameObjects.GameObject[];

  constructor(scene: Phaser.Scene) {
    const L = LAYOUT.leftHudX;
    const R = LAYOUT.rightHudX;
    const line = LAYOUT.hudLineHeight;

    this.time = label(scene, LAYOUT.centerX, LAYOUT.timeY, FONT_SIZE.time, CSS.text).setOrigin(
      0.5,
      0.2
    );
    this.score = label(scene, L, LAYOUT.hudTopY, FONT_SIZE.score, CSS.text);
    this.combo = label(scene, L, LAYOUT.hudTopY + line * 1.4, FONT_SIZE.label, CSS.focus);
    this.best = label(scene, L, LAYOUT.hudTopY + line * 2.4, FONT_SIZE.body, CSS.dim);
    this.hint = label(scene, L, 940, FONT_SIZE.label, CSS.hint);
    this.hearts = scene.add.graphics();
    this.board = label(scene, R, LAYOUT.hudTopY + line, FONT_SIZE.label, CSS.text);
    this.next = label(scene, R, LAYOUT.hudTopY + line * 2, FONT_SIZE.body, CSS.dim);
    this.credit = label(scene, R, LAYOUT.hudTopY + line * 3, FONT_SIZE.label, CSS.dim);
    this.pull = label(scene, R, 940, FONT_SIZE.label, CSS.focus);
    this.chains = label(scene, LAYOUT.centerX + 40, LAYOUT.bottomY, FONT_SIZE.label, CSS.dim);
    this.ring = scene.add.graphics();

    this.items = [
      this.time,
      this.score,
      this.combo,
      this.best,
      this.hint,
      this.board,
      this.next,
      this.credit,
      this.pull,
      this.chains,
      this.hearts,
      this.ring,
    ];
  }

  setVisible(visible: boolean): void {
    for (const item of this.items) {
      (item as unknown as { setVisible(v: boolean): void }).setVisible(visible);
    }
  }

  destroy(): void {
    for (const item of this.items) item.destroy();
  }

  update(snap: FlowSnapshot, run: RunSnapshot, now: number): void {
    // 1단 — 남은 시간. 10초 이하에서 **1Hz** 박동 (§9.4 3Hz 초과 점멸 금지)
    this.time.setText(formatTime(run.timeRemainingMs));
    if (run.timeRemainingMs <= TIME_PULSE_THRESHOLD_MS) {
      const phase = (now % TIME_PULSE_MS) / TIME_PULSE_MS;
      this.time.setColor(CSS.blocked);
      this.time.setAlpha(0.55 + 0.45 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2)));
    } else {
      this.time.setColor(CSS.text);
      this.time.setAlpha(1);
    }

    // 4단 — 점수 7자리 0 패딩, 콤보는 ×2.0 이상일 때만 크게 (§8.2)
    this.score.setText(`SCORE  ${formatScore(run.displayScore)}`);
    this.combo.setText(`COMBO  ${formatCombo(run.comboCentis)}`);
    this.combo.setFontSize(run.comboCentis >= 200 ? FONT_SIZE.score : FONT_SIZE.label);
    const best = snap.bestToday;
    this.best.setText(best === null ? 'BEST TODAY  —' : `BEST TODAY  ${formatScore(best.score)}`);

    // 6단 — 힌트 상태 (좌측 버튼과 같은 쪽)
    this.hint.setText(`[G] HINT  ${hintLabel(run)}`);

    // 3단 — 하트: 채운 하트 → 빈 윤곽 (색으로만 전달하지 않는다)
    this.drawHearts(run.hearts);

    this.board.setText(`BOARD ${pad2(run.boardNumber)} · ${run.tierLabel}`);
    this.next.setText('NEXT  생성 완료');
    this.credit.setText(`CREDIT ${snap.credits.paid + snap.credits.event}`);
    this.pull.setText('[H] PULL');

    // 5단 — 남은 사슬 `남은 / 전체` + 진행 링
    this.chains.setText(`CHAINS ${run.chainsLeft} / ${run.chainsTotal}`);
    this.drawRing(run.chainsLeft, run.chainsTotal);
  }

  private drawHearts(hearts: number): void {
    const g = this.hearts;
    g.clear();
    const shown = Math.max(hearts, 3);
    for (let i = 0; i < shown; i += 1) {
      const x = LAYOUT.rightHudX + HEART_RADIUS + i * HEART_GAP;
      const y = LAYOUT.hudTopY + 10;
      if (i < hearts) {
        g.fillStyle(PALETTE.heartFull, 1);
        g.fillCircle(x, y, HEART_RADIUS);
      } else {
        g.lineStyle(3, PALETTE.heartEmpty, 1);
        g.strokeCircle(x, y, HEART_RADIUS - 2);
      }
    }
  }

  private drawRing(left: number, total: number): void {
    const g = this.ring;
    g.clear();
    if (total <= 0) return;
    const cx = BOARD_ORIGIN.x + BOARD_WIDTH / 2 - 60;
    const cy = LAYOUT.bottomY + 14;
    const done = (total - left) / total;
    g.lineStyle(6, PALETTE.grid, 1);
    g.strokeCircle(cx, cy, RING_RADIUS);
    if (done <= 0) return;
    g.lineStyle(6, PALETTE.focus, 1);
    g.beginPath();
    g.arc(cx, cy, RING_RADIUS, -Math.PI / 2, -Math.PI / 2 + done * Math.PI * 2, false);
    g.strokePath();
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

/**
 * §8.2 6단 — `READY` / `쿨다운 n초` / `이 보드 −20n%`.
 * 이미 힌트를 쓴 보드에서는 **누적 감점을 먼저 보여 준다** — 그것이 플레이어가 다음 결정을
 * 내릴 때 필요한 정보다(§7.2 N5a 누적, 하한 −60%).
 */
function hintLabel(run: RunSnapshot): string {
  const view = run.hint;
  if (view.state === 'SHOWING') return '표시 중';
  if (run.hintUses > 0) {
    const penalty = Math.min(20 * run.hintUses, 60);
    const tail =
      view.state === 'COOLDOWN' ? ` · 쿨다운 ${Math.ceil(view.cooldownLeftMs / 1000)}초` : '';
    return `이 보드 −${penalty}%${tail}`;
  }
  if (view.state === 'COOLDOWN') return `쿨다운 ${Math.ceil(view.cooldownLeftMs / 1000)}초`;
  return 'READY';
}
