// 관리자 플레이스홀더 (§11 — 실체는 WU-05).
// 진입 중에도 코인은 적립된다 (§2.7 · `admin_page.md` §2.2 재사용).

import type { FlowSnapshot } from '../game/flow';
import { CSS, FONT_FAMILY, FONT_SIZE, LAYOUT } from '../game/render/boardView';
import { TextPanel, adminPanel } from '../game/render/panels';
import { ArrowScene } from './ArrowScene';

export class AdminStubScene extends ArrowScene {
  private panel!: TextPanel;
  private credit!: Phaser.GameObjects.Text;

  constructor() {
    super('AdminStub');
  }

  protected build(): void {
    this.panel = new TextPanel(this, LAYOUT.centerY - 120, FONT_SIZE.score);
    this.credit = this.add
      .text(LAYOUT.centerX, 900, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.body}px`,
        color: CSS.dim,
      })
      .setOrigin(0.5);
  }

  protected paint(snap: FlowSnapshot): void {
    this.panel.set(adminPanel());
    this.credit.setText(`CREDIT ${snap.credits.paid + snap.credits.event}`);
  }
}
