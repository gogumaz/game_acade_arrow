// CONTINUE (§4.5 · §4.7) — 10초 카운트다운 동안 런 타이머는 정지하고 보드는 그대로 보존된다.
// 코인은 적립만 하고 **확정은 우측 버튼**이다 (작업 계획 Q-6 · §10.2 "확정 입력 직후" 차감).

import type { FlowSnapshot } from '../game/flow';
import { PALETTE, SCREEN_HEIGHT, SCREEN_WIDTH } from '../game/render/boardView';
import { BoardPainter } from '../game/render/chainView';
import { TextPanel, continuePanel } from '../game/render/panels';
import { ArrowScene } from './ArrowScene';

export class ContinueScene extends ArrowScene {
  private board!: BoardPainter;
  private panel!: TextPanel;

  constructor() {
    super('Continue');
  }

  protected build(): void {
    this.board = new BoardPainter(this);
    // 런 종료 문구는 보드 위에 뜨는 것이 §8.1이 허용한 예외지만, 사슬 위에 겹쳐 읽히면
    // §8.3 가독성 기준을 못 맞춘다. 배경을 눌러 문구를 분리한다
    this.add
      .graphics()
      .fillStyle(PALETTE.background, 0.82)
      .fillRect(0, 0, SCREEN_WIDTH, SCREEN_HEIGHT);
    this.panel = new TextPanel(this);
  }

  protected paint(snap: FlowSnapshot): void {
    const run = snap.run;
    if (run !== null)
      this.board.draw(run, this.app.clock.now(), {
        motionReduced: this.app.fx.motionReduced,
        performanceSimplified: this.app.fx.report().simplified,
      });
    this.panel.set(continuePanel(snap));
  }
}
