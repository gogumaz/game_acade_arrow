// BOOT 씬 — 배경색과 씬 식별 텍스트만 두고 어트랙트로 자동 전환한다.
// 로고·제작사 표시 등 실제 연출은 WU-07 범위다 (§4.1).

import Phaser from 'phaser';
import { CSS, FONT_FAMILY, FONT_SIZE } from '../game/render/boardView';
import { GAME_TITLE } from '../core/types';

/** Boot → Attract 자동 전환 지연 (ms) */
const BOOT_HOLD_MS = 800;

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor(CSS.background);

    this.add
      .text(width / 2, height / 2, GAME_TITLE, {
        fontFamily: FONT_FAMILY,
        fontSize: `${FONT_SIZE.headline}px`,
        color: CSS.focus,
      })
      .setOrigin(0.5);

    this.time.delayedCall(BOOT_HOLD_MS, () => this.scene.start('Attract'));
  }
}
