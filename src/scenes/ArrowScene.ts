// 씬 공통 골격 (작업 계획 P-1 · R6)
//
// **씬은 상태를 만들지 않는다.** 하는 일은 셋뿐이다:
//   ① `update()`에서 `flow.tick()` 호출
//   ② `flow.snapshot()`을 그리기
//   ③ `flow.onScreenChange`에 반응해 `scene.start()`
// 씬 파일에 `if`로 게임 규칙을 쓰지 않는다 — 규칙은 전부 `src/game/*`의 순수 모듈에 있다.

import Phaser from 'phaser';
import { APP_REGISTRY_KEY, type AppContext } from '../game/app';
import type { Tier } from '../game/boardSource';
import type { FlowSnapshot, Screen } from '../game/flow';
import { CSS } from '../game/render/boardView';

/** 화면 8종 → 씬 7개. ATTRACT·READY는 §2.7이 둘 다 SERVICE를 허용하므로 한 씬이 맡는다 */
const SCENE_FOR_SCREEN: Readonly<Record<Screen, string>> = {
  ATTRACT: 'Attract',
  READY: 'Attract',
  TUTORIAL: 'Tutorial',
  RUN: 'Play',
  CONTINUE: 'Continue',
  RESULT: 'Result',
  NAME_ENTRY: 'NameEntry',
  ADMIN: 'Admin',
};

export abstract class ArrowScene extends Phaser.Scene {
  protected app!: AppContext;
  private unsubscribe: (() => void) | null = null;

  create(): void {
    const app = this.registry.get(APP_REGISTRY_KEY) as AppContext | undefined;
    if (app === undefined) throw new Error(`${this.scene.key}: AppContext가 등록되지 않았다`);
    this.app = app;
    this.cameras.main.setBackgroundColor(CSS.background);
    this.build();
    this.unsubscribe = app.flow.onScreenChange((to) => this.route(to));
    this.events.once('shutdown', () => {
      this.unsubscribe?.();
      this.unsubscribe = null;
    });
    this.paint(app.flow.snapshot());
  }

  update(): void {
    const now = this.app.clock.now();
    this.app.fx.frame(now);
    const flow = this.app.flow;
    flow.tick();
    // 관리자 컨트롤러의 시계는 **화면과 무관하게** 흐른다 — 테스트 플레이 관찰(§11.6 결과 5항목)은
    // 관리자 씬이 내려가 있는 동안 일어나기 때문이다
    this.app.admin.tick();
    const snap = flow.snapshot();
    // 전이 직후 한 프레임은 아직 이전 씬이 살아 있다 — 남의 화면을 그리지 않는다
    if (SCENE_FOR_SCREEN[snap.screen] !== this.scene.key) return;
    this.paint(snap);
    this.app.fx.present(now);
    this.app.sfx.update?.({
      screen: snap.screen,
      nowMs: now,
      tierIndex: tierIndex(snap.run?.tier),
      timeRemainingMs: snap.run?.timeRemainingMs ?? null,
    });
  }

  /** 화면 객체 생성 — `create()`에서 1회 */
  protected abstract build(): void;

  /** 스냅샷 반영 — 매 프레임 */
  protected abstract paint(snap: FlowSnapshot): void;

  private route(to: Screen): void {
    const key = SCENE_FOR_SCREEN[to];
    if (key === this.scene.key) return;
    this.scene.start(key);
  }
}

function tierIndex(tier: Tier | undefined): number {
  if (tier === 'RHYTHM') return 1;
  if (tier === 'PRESSURE') return 2;
  if (tier === 'MASTER' || tier === 'ENDLESS') return 3;
  return 0;
}
