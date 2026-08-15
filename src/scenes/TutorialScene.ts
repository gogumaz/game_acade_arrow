// 미니 튜토리얼 (§4.7) — 런 타이머가 정지한 상태에서 안전수 1개를 직접 빼 보게 한다.

import type { FlowSnapshot } from '../game/flow';
import { CSS, FONT_FAMILY, FONT_SIZE, LAYOUT } from '../game/render/boardView';
import { BoardPainter } from '../game/render/chainView';
import { tutorialPanel } from '../game/render/panels';
import { ArrowScene } from './ArrowScene';

export class TutorialScene extends ArrowScene {
  private board!: BoardPainter;
  private message!: Phaser.GameObjects.Text;
  private countdown!: Phaser.GameObjects.Text;

  constructor() {
    super('Tutorial');
  }

  protected build(): void {
    this.board = new BoardPainter(this);
    this.message = this.add
      .text(LAYOUT.centerX, 30, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.label}px`,
        color: CSS.hint,
      })
      .setOrigin(0.5, 0);
    this.countdown = this.add
      .text(LAYOUT.centerX, LAYOUT.bottomY, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.body}px`,
        color: CSS.dim,
      })
      .setOrigin(0.5);
  }

  protected paint(snap: FlowSnapshot): void {
    const run = snap.run;
    if (run === null) return;
    this.board.draw(run, this.app.clock.now());
    this.message.setText(tutorialPanel().lines[0]);
    this.countdown.setText(`${Math.ceil(snap.countdownMs / 1000)}초 뒤 자동 진행`);
  }
}
