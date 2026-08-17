// 인게임 (§8.1 레이아웃 · §8.2 정보 우선순위 · §9.2 연출)
//
// 보드 영역에는 HUD·오버레이를 그리지 않는다 (§8.1). 유일한 예외는 실패·클리어 중앙 문구다.

import type { FlowSnapshot } from '../game/flow';
import { CSS, FONT_FAMILY, FONT_SIZE, LAYOUT } from '../game/render/boardView';
import { BoardPainter } from '../game/render/chainView';
import { Hud } from '../game/render/hud';
import { FxOverlay } from '../game/render/fxOverlay';
import { blockedMessage, clearMessage, safePauseMessage } from '../game/render/panels';
import { BLOCK_SHAKE_MS } from '../game/timing';
import { ArrowScene } from './ArrowScene';

/** 막힘 문구는 진동보다 조금 더 오래 남겨 읽을 시간을 준다 (§8.4 "원인과 다음 행동") */
const MESSAGE_HOLD_MS = BLOCK_SHAKE_MS * 4;

export class PlayScene extends ArrowScene {
  private board!: BoardPainter;
  private hud!: Hud;
  private effects!: FxOverlay;
  private center!: Phaser.GameObjects.Text;

  constructor() {
    super('Play');
  }

  protected build(): void {
    this.board = new BoardPainter(this);
    this.hud = new Hud(this);
    this.effects = new FxOverlay(this);
    this.center = this.add
      .text(LAYOUT.centerX, LAYOUT.centerY, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.label}px`,
        color: CSS.blocked,
      })
      .setOrigin(0.5);
  }

  protected paint(snap: FlowSnapshot): void {
    const run = snap.run;
    if (run === null) return;
    const now = this.app.clock.now();
    const performanceSimplified = this.app.fx.report().simplified;
    this.board.draw(run, now, {
      motionReduced: this.app.fx.motionReduced,
      performanceSimplified,
    });
    this.hud.update(snap, run, now);
    this.effects.update(run, now, {
      motionReduced: this.app.fx.motionReduced,
      simplified: performanceSimplified,
    });

    // §12.3 SAFE PAUSE — 정지·재개 카운트다운은 다른 어떤 중앙 문구보다 우선한다 (P-7)
    if (snap.safePause.state !== 'idle') {
      this.center.setColor(CSS.hint);
      this.center.setText(safePauseMessage(snap));
      return;
    }

    // §8.1 — 보드 위 중앙 문구는 클리어·퍼펙트·실패 3종만 허용된다
    const clear = run.lastClear;
    if (run.transitioning && clear !== null) {
      this.center.setColor(clear.perfect ? CSS.hint : CSS.focus);
      this.center.setText(clearMessage(clear.perfect, clear.bonus));
      return;
    }
    const block = run.lastBlock;
    const showBlock = block !== null && now - block.atMs < MESSAGE_HOLD_MS;
    this.center.setColor(CSS.blocked);
    this.center.setText(showBlock ? blockedMessage() : '');
  }
}
