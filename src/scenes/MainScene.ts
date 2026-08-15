// MAIN 씬 — WU-01 골격. 배경색과 씬 식별 텍스트 2줄만 둔다.
// 크레딧 표시·"아무 키나 누르면 시작"·어트랙트 전환·관리자 진입은 WU-03 이후 범위다
// (§4.1 화면 흐름 · §2.5 코인·관리자 입력 예외).

import Phaser from 'phaser';

const BG_COLOR = '#0A0E27';
const TEXT_COLOR = '#00E5FF';
const TEXT_DIM = '#6B77A8';
const FONT = 'monospace';

export class MainScene extends Phaser.Scene {
  constructor() {
    super('Main');
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor(BG_COLOR);

    this.add
      .text(width / 2, height / 2 - 40, 'MAIN', {
        fontFamily: FONT,
        fontSize: '64px',
        color: TEXT_COLOR,
      })
      .setOrigin(0.5);

    this.add
      .text(width / 2, height / 2 + 50, 'WU-01 SCAFFOLD', {
        fontFamily: FONT,
        fontSize: '24px',
        color: TEXT_DIM,
      })
      .setOrigin(0.5);
  }
}
