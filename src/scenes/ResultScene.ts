// 결과 (§4.7 8초 자동 종료 · §5.5 등급 · §8.4 개선 팁 1문장)

import type { FlowSnapshot } from '../game/flow';
import { CSS, FONT_FAMILY, FONT_SIZE, LAYOUT } from '../game/render/boardView';
import { TextPanel, resultPanel } from '../game/render/panels';
import { ArrowScene } from './ArrowScene';

export class ResultScene extends ArrowScene {
  private panel!: TextPanel;
  private countdown!: Phaser.GameObjects.Text;

  constructor() {
    super('Result');
  }

  protected build(): void {
    this.panel = new TextPanel(this);
    this.countdown = this.add
      .text(LAYOUT.centerX, 960, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.body}px`,
        color: CSS.dim,
      })
      .setOrigin(0.5);
  }

  protected paint(snap: FlowSnapshot): void {
    this.panel.set(resultPanel(snap));
    this.countdown.setText(`${Math.ceil(snap.countdownMs / 1000)}초 · 우측 버튼으로 다음`);
  }
}
