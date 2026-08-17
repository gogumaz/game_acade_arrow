// 엔트리 포인트 — Phaser 게임 부팅 (§1.4: 논리 해상도 1920×1080 · Scale.FIT · CENTER_BOTH)
//
// 조립은 `game/app.ts`가 하고 여기서는 씬 등록과 레지스트리 주입만 한다.
// Esc 종료 바인딩은 두지 않는다 — §13 G8이 키오스크 탈출 경로 제거를 요구한다.
// 종료는 WU-06의 관리자 3초 홀드가 preload의 quit() 채널로 수행한다.

import Phaser from 'phaser';
import { APP_REGISTRY_KEY, createApp } from './game/app';
import { keyboard } from './game/input';
import { PALETTE } from './game/render/boardView';
import { createWebAudioSfx } from './game/sfx';
import { AdminScene } from './scenes/AdminScene';
import { AttractScene } from './scenes/AttractScene';
import { BootScene } from './scenes/BootScene';
import { ContinueScene } from './scenes/ContinueScene';
import { NameEntryScene } from './scenes/NameEntryScene';
import { PlayScene } from './scenes/PlayScene';
import { ResultScene } from './scenes/ResultScene';
import { TutorialScene } from './scenes/TutorialScene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 1920,
  height: 1080,
  backgroundColor: PALETTE.background,
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [
    BootScene,
    AttractScene,
    TutorialScene,
    PlayScene,
    ContinueScene,
    ResultScene,
    NameEntryScene,
    AdminScene,
  ],
});

// ADM-003 — 개발 플래그가 없으면 `F9`로 관리자에 들어갈 수 없다. 출시 기기는 물리 SERVICE 키만
keyboard.setServiceKeyEnabled(import.meta.env.DEV);

/** §17 `[보류]` #3 — REBOOT·SHUTDOWN은 OS 권한 구성이 필요해 보류를 돌려준다 (WU-06) */
const gameFS = (globalThis as { gameFS?: { restart?: () => Promise<void> } }).gameFS;

// 씬은 이 값을 레지스트리에서 읽는다. `Phaser.Game` 생성 직후는 아직 부팅 전이라
// Boot 씬의 create()보다 먼저 실행된다.
const app = createApp({
  sfx: createWebAudioSfx(),
  system: {
    restart: async (): Promise<string> => {
      if (gameFS?.restart === undefined) return '[보류]';
      await gameFS.restart();
      return 'ok';
    },
    reboot: () => Promise.resolve('[보류]'),
    shutdown: () => Promise.resolve('[보류]'),
  },
});
game.registry.set(APP_REGISTRY_KEY, app);

// 개발 검증용 훅 (프로덕션 빌드 제외)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__debug = {
    game,
    app,
    snapshot: () => app.flow.snapshot(),
    trace: () => app.flow.trace,
    performance: () => app.fx.report(),
  };
}
