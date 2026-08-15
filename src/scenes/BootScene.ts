// BOOT 씬 — WU-01 골격. 배경색과 씬 식별 텍스트만 두고 Main으로 자동 전환한다.
// 로고·제작사 표시 등 실제 연출은 WU-03 이후 범위다 (§4.1).
// 색·폰트 상수는 game/theme.ts(WU-07)가 생기면 그쪽으로 옮긴다.

import Phaser from 'phaser';

const BG_COLOR = '#0A0E27';
const TEXT_COLOR = '#00E5FF';
const FONT = 'monospace';

/** Boot → Main 자동 전환 지연 (ms) */
const BOOT_HOLD_MS = 800;

export class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor(BG_COLOR);

    this.add
      .text(width / 2, height / 2, 'BOOT', {
        fontFamily: FONT,
        fontSize: '64px',
        color: TEXT_COLOR,
      })
      .setOrigin(0.5);

    this.time.delayedCall(BOOT_HOLD_MS, () => this.scene.start('Main'));
  }
}
