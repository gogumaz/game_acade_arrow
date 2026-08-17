// 어트랙트 + 시작 화면 (§4.6 · §4.7 · §8.4)
//
// 15초 루프를 3패널로 나눠 조작 1문장·가격 / 오늘의 1위 / TOP 10을 전부 노출한다 (작업 계획 P-9).
// 자동 플레이 데모 영상은 연출 소관이라 WU-07로 이월했다.

import type { FlowSnapshot } from '../game/flow';
import { CSS, FONT_FAMILY, FONT_SIZE, LAYOUT, PALETTE } from '../game/render/boardView';
import { TextPanel, attractPanel, paidBlockedLine, readyPanel } from '../game/render/panels';
import { ArrowScene } from './ArrowScene';

export class AttractScene extends ArrowScene {
  private panel!: TextPanel;
  private footer!: Phaser.GameObjects.Text;
  private demo!: Phaser.GameObjects.Graphics;

  constructor() {
    super('Attract');
  }

  protected build(): void {
    this.demo = this.add.graphics();
    this.panel = new TextPanel(this);
    this.footer = this.add
      .text(LAYOUT.centerX, 960, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.body}px`,
        color: CSS.dim,
      })
      .setOrigin(0.5);
  }

  protected paint(snap: FlowSnapshot): void {
    this.drawDemo(this.app.clock.now());
    const price = this.app.credits.coinsPerPlay;
    // §12.4 — 차단 중이면 START 대신 사유를 낸다. 코인 적립은 그대로다 (P-5)
    const blocked = paidBlockedLine(snap);
    this.panel.set(
      snap.screen === 'READY' ? readyPanel(price, blocked) : attractPanel(snap, price)
    );
    this.footer.setText(
      blocked !== null
        ? blocked
        : snap.screen === 'READY'
          ? `CREDIT ${snap.credits.paid + snap.credits.event}`
          : '코인을 넣어 주세요'
    );
  }

  /** §4.6 — 15초 어트랙트 동안 규칙을 암시하는 독자 제작 절차형 사슬 데모. */
  private drawDemo(nowMs: number): void {
    const g = this.demo;
    g.clear();
    const reduced = this.app.fx.motionReduced;
    const drift = reduced ? 0 : ((nowMs % 4000) / 4000) * 120;
    const rows = [210, 390, 690, 870];
    for (let i = 0; i < rows.length; i += 1) {
      const left = i % 2 === 0;
      const baseX = left ? 100 + drift : 1820 - drift;
      const direction = left ? 1 : -1;
      const color = i === 1 ? PALETTE.hint : i === 2 ? PALETTE.blocked : PALETTE.focus;
      g.lineStyle(10, color, 0.35);
      g.beginPath();
      g.moveTo(baseX, rows[i]);
      g.lineTo(baseX + direction * 180, rows[i]);
      g.lineTo(baseX + direction * 180, rows[i] + 70);
      g.lineTo(baseX + direction * 300, rows[i] + 70);
      g.strokePath();
      const tipX = baseX + direction * 320;
      g.fillStyle(color, 0.42);
      g.fillTriangle(
        tipX,
        rows[i] + 70,
        tipX - direction * 28,
        rows[i] + 52,
        tipX - direction * 28,
        rows[i] + 88
      );
    }
  }
}
