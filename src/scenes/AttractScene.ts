// 어트랙트 + 시작 화면 (§4.6 · §4.7 · §8.4)
//
// 15초 루프를 3패널로 나눠 조작 1문장·가격 / 오늘의 1위 / TOP 10을 전부 노출한다 (작업 계획 P-9).
// 자동 플레이 데모 영상은 연출 소관이라 WU-07로 이월했다.

import type { FlowSnapshot } from '../game/flow';
import { CSS, FONT_FAMILY, FONT_SIZE, LAYOUT } from '../game/render/boardView';
import { TextPanel, attractPanel, readyPanel } from '../game/render/panels';
import { ArrowScene } from './ArrowScene';

export class AttractScene extends ArrowScene {
  private panel!: TextPanel;
  private footer!: Phaser.GameObjects.Text;

  constructor() {
    super('Attract');
  }

  protected build(): void {
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
    const price = this.app.credits.coinsPerPlay;
    this.panel.set(snap.screen === 'READY' ? readyPanel(price) : attractPanel(snap, price));
    this.footer.setText(
      snap.screen === 'READY'
        ? `CREDIT ${snap.credits.paid + snap.credits.event}`
        : '코인을 넣어 주세요'
    );
  }
}
