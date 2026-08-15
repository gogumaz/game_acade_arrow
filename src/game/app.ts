// 조립 지점 (Composition Root) — 작업 계획 P-1
//
// **Phaser 타입을 쓰지 않는다.** 씬은 여기서 만든 `AppContext`를 레지스트리에서 읽기만 한다.
// 입력 구독도 여기 **1곳**뿐이다 — 씬마다 키를 다시 붙이면 중복 구독·해제 누락이 생기고,
// 그것이 아케이드에서 가장 흔한 입력 버그다.
//
// `performance.now()`·`new Date()`를 직접 부르는 곳도 이 파일뿐이다. 순수 계층은 주입된
// `Clock`과 `nowIso()`만 본다 (§6.6 재현성).

import { FACTORY_PARAMS, type CoreParams } from '../core/params';
import type { Clock } from '../core/types';
import { browserEnvironment, Storage } from '../persist/storage';
import { fixtureBoardSource, type BoardSource } from './boardSource';
import { createCreditsStub, type CreditsPort } from './creditsStub';
import { FlowMachine } from './flow';
import { keyboard } from './input';
import type { InputAdapter } from './input';
import { RankingStore } from './rankingStore';
import { createSilentSfx, type Sfx } from './sfx';

export const APP_REGISTRY_KEY = 'arrowOutApp';

export interface AppContext {
  readonly flow: FlowMachine;
  readonly ranking: RankingStore;
  readonly credits: CreditsPort;
  readonly storage: Storage;
  readonly sfx: Sfx;
  readonly clock: Clock;
  dispose(): void;
}

export interface AppOptions {
  readonly params?: CoreParams;
  readonly input?: InputAdapter;
  readonly boardSource?: BoardSource;
  readonly clock?: Clock;
  readonly storage?: Storage;
  readonly sfx?: Sfx;
  readonly nowIso?: () => string;
}

/** 단조 시계 — `performance.now()`가 없으면 월클럭으로 강등한다 */
function systemClock(): Clock {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf === undefined ? { now: () => Date.now() } : { now: () => perf.now() };
}

export function createApp(options: AppOptions = {}): AppContext {
  const clock = options.clock ?? systemClock();
  const params = options.params ?? FACTORY_PARAMS;
  const sfx = options.sfx ?? createSilentSfx();
  const credits = createCreditsStub({
    coinsPerPlay: 1, // §10.1 N11a — 운영 설정 연결은 WU-05
    continueCoins: 1, // §10.1 N11b
  });
  const ranking = new RankingStore();
  const storage = options.storage ?? new Storage({ env: browserEnvironment() });
  storage.register(ranking.asSaveDocument());
  void storage.init();

  const flow = new FlowMachine({
    clock,
    credits,
    boardSource: options.boardSource ?? fixtureBoardSource(),
    ranking,
    params,
    sfx,
    nowIso: options.nowIso ?? ((): string => new Date().toISOString()),
    onRankingChanged: () => storage.scheduleSave(),
  });

  const input = options.input ?? keyboard;
  input.attach();
  const unsubscribe = input.onAction((pa) => flow.handle(pa.action, pa.player));

  return {
    flow,
    ranking,
    credits,
    storage,
    sfx,
    clock,
    dispose(): void {
      unsubscribe();
      input.detach();
    },
  };
}
