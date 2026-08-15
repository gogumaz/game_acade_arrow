// 엔트리 포인트 — Phaser 게임 부팅 (§1.4: 논리 해상도 1920×1080 · Scale.FIT · CENTER_BOTH)
//
// WU-01 범위는 빈 Boot/Main 씬 부팅까지다. 전역 코인 입력(§2.5)·저장 초기화(§9.2)·
// 사운드·크레딧 연결은 이후 유닛에서 붙인다.
//
// Esc 종료 바인딩은 두지 않는다 — §13 G8이 키오스크 탈출 경로 제거를 요구한다.
// 종료는 WU-06의 관리자 3초 홀드가 preload의 quit() 채널로 수행한다.

import Phaser from 'phaser';
import { BootScene } from './scenes/BootScene';
import { MainScene } from './scenes/MainScene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 1920,
  height: 1080,
  backgroundColor: '#0A0E27',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, MainScene],
});

// 개발 검증용 훅 (프로덕션 빌드 제외)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__debug = { game };
}
