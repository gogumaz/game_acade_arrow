// 화면 흐름 상태기계 (§4.1 · §4.7 · §2.7) — SES-210/211/212 · CTL-009/011 · CRD-601
// (작업 계획 §7 · §7.2 정책표 전 칸)

import { describe, it, expect } from 'vitest';
import { createChain } from '../../src/core/chain';
import { FACTORY_PARAMS, type CoreParams } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import type { GridPoint, InputAction } from '../../src/core/types';
import type { BoardRequest, BoardSource } from '../../src/game/boardSource';
import {
  FlowMachine,
  type FlowDeps,
  type NameEntryView,
  type ResultSummary,
  type Screen,
} from '../../src/game/flow';
import { RankingStore } from '../../src/game/rankingStore';
import { createSilentSfx, type SilentSfx } from '../../src/game/sfx';
import {
  ATTRACT_LOOP_MS,
  ATTRACT_PANELS,
  ATTRACT_PANEL_MS,
  NAME_ENTRY_MS,
  RESULT_AUTO_MS,
  RUN_IDLE_END_MS,
  TUTORIAL_IDLE_MS,
  TUTORIAL_MAX_PLAYS,
} from '../../src/game/timing';
import { TestClock, creditsSpy, openBoard, type CreditsSpy } from './harness';

const SLIDE_MS = 202;
const CONTINUE_MS = FACTORY_PARAMS.continuePromptTimeSec * 1000;
const ISO = '2026-08-16T10:00:00.000Z';

function p(x: number, y: number): GridPoint {
  return { x, y };
}

/** 막힌 사슬(대표점 x=2)이 초기 포커스 — BUTTON1 한 번이면 하트가 준다 */
function blockedBoardOf(n: number): Board {
  return new Board({
    chains: [
      createChain(1, [p(1, 9), p(2, 9)], 1),
      createChain(2, [p(6, 8), p(6, 9), p(6, 10)], 0),
    ],
    boardNumber: n,
    seed: `flow-blocked-${n}`,
  });
}

/** 점수를 낼 안전 사슬(대표점 x=12) + 막힌 쌍 */
function scoringBoardOf(n: number): Board {
  return new Board({
    chains: [
      createChain(1, [p(1, 9), p(2, 9)], 1),
      createChain(2, [p(6, 8), p(6, 9), p(6, 10)], 0),
      createChain(3, [p(11, 0), p(12, 0)], 0),
    ],
    boardNumber: n,
    seed: `flow-scoring-${n}`,
  });
}

interface FlowRig {
  readonly flow: FlowMachine;
  readonly clock: TestClock;
  readonly credits: CreditsSpy;
  readonly ranking: RankingStore;
  readonly sfx: SilentSfx;
  readonly screens: string[];
}

interface FlowOptions {
  boards?: (n: number) => Board;
  params?: Partial<CoreParams>;
  coinsPerPlay?: number;
  continueCoins?: number;
}

function makeFlow(opts: FlowOptions = {}): FlowRig {
  const clock = new TestClock(0);
  const credits = creditsSpy({
    coinsPerPlay: opts.coinsPerPlay ?? 1,
    continueCoins: opts.continueCoins ?? 1,
  });
  const ranking = new RankingStore();
  const sfx = createSilentSfx();
  const make = opts.boards ?? ((): Board => openBoard(2));
  const boardSource: BoardSource = { next: (req: BoardRequest) => make(req.boardNumber) };
  const screens: string[] = [];
  const deps: FlowDeps = {
    clock,
    credits,
    boardSource,
    ranking,
    params: { ...FACTORY_PARAMS, ...opts.params },
    sfx,
    nowIso: () => ISO,
  };
  const flow = new FlowMachine(deps);
  flow.onScreenChange((to, from) => screens.push(`${from}>${to}`));
  return { flow, clock, credits, ranking, sfx, screens };
}

/**
 * 버튼 1회 = **실기 1프레임**. §2.4 동시 입력 규칙 때문에 `BUTTON2`는 프레임이 끝나야 확정되므로,
 * 실기와 같게 입력 뒤 `tick()`으로 프레임을 닫는다 (씬은 매 프레임 `flow.tick()`을 부른다).
 */
function press(flow: FlowMachine, action: InputAction): void {
  flow.handle(action);
  flow.tick();
}

/** 코인 → START → (튜토리얼이면 10초 무입력으로 통과) → RUN */
function toRun(rig: FlowRig): void {
  rig.flow.handle('COIN');
  rig.flow.handle('START');
  if (rig.flow.screen === 'TUTORIAL') {
    rig.clock.advance(TUTORIAL_IDLE_MS);
    rig.flow.tick();
  }
}

/** 안전 사슬 1개를 빼 점수를 만든 뒤 막힌 사슬을 당겨 하트를 소진한다 */
function playToDeathWithScore(rig: FlowRig): void {
  toRun(rig);
  rig.flow.handle('RIGHT');
  rig.flow.handle('RIGHT'); // 대표점 x=12 사슬로
  rig.flow.handle('BUTTON1');
  rig.clock.advance(SLIDE_MS);
  rig.flow.tick();
  rig.flow.handle('LEFT'); // 막힌 사슬로
  rig.flow.handle('BUTTON1');
  rig.flow.tick();
}

const ALL_SCREENS: readonly Screen[] = [
  'ATTRACT',
  'READY',
  'TUTORIAL',
  'RUN',
  'CONTINUE',
  'RESULT',
  'NAME_ENTRY',
  'ADMIN',
];

/** 각 화면에 실제로 도달시킨다 (정책표 전 칸을 같은 방법으로 훑기 위한 공통 진입) */
function atScreen(screen: Screen): FlowRig {
  const rig = makeFlow({ boards: scoringBoardOf, params: { initialHearts: 1 } });
  switch (screen) {
    case 'ATTRACT':
      break;
    case 'ADMIN':
      rig.flow.handle('SERVICE');
      break;
    case 'READY':
      rig.flow.handle('COIN');
      break;
    case 'TUTORIAL':
      rig.flow.handle('COIN');
      rig.flow.handle('START');
      break;
    case 'RUN':
      toRun(rig);
      break;
    case 'CONTINUE':
      playToDeathWithScore(rig);
      break;
    case 'RESULT':
      playToDeathWithScore(rig);
      press(rig.flow, 'BUTTON2');
      break;
    case 'NAME_ENTRY':
      playToDeathWithScore(rig);
      press(rig.flow, 'BUTTON2');
      rig.flow.handle('BUTTON1');
      break;
  }
  expect(rig.flow.screen).toBe(screen);
  return rig;
}

describe('초기 상태와 전이 기록', () => {
  it('부팅 화면은 ATTRACT다', () => {
    const rig = makeFlow();
    expect(rig.flow.screen).toBe('ATTRACT');
    expect(rig.flow.trace).toEqual([]);
  });

  it('전이가 trace에 문자열로 남는다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    expect(rig.flow.trace).toEqual(['ATTRACT→READY']);
  });

  it('화면 변경 구독자가 to·from을 함께 받는다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    expect(rig.screens).toEqual(['ATTRACT>READY']);
  });

  it('구독 해제가 동작한다', () => {
    const rig = makeFlow();
    const seen: string[] = [];
    const off = rig.flow.onScreenChange((to) => seen.push(to));
    off();
    rig.flow.handle('COIN');
    expect(seen).toEqual([]);
  });
});

describe('CTL-011 — COIN은 어떤 화면에서도 항상 적립된다 (§2.7)', () => {
  it.each(ALL_SCREENS)('%s 화면에서 코인이 적립된다', (screen) => {
    const rig = atScreen(screen);
    const before = rig.flow.snapshot().credits.paid;
    rig.flow.handle('COIN');
    expect(rig.flow.snapshot().credits.paid).toBe(before + 1);
  });

  it('상한을 넘는 코인은 거부 표시가 난다 (§10.3)', () => {
    const rig = makeFlow();
    for (let i = 0; i < 99; i += 1) rig.flow.handle('COIN');
    rig.sfx.clear();
    rig.flow.handle('COIN');
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.flow.snapshot().credits.paid).toBe(99);
  });

  it('어트랙트에서 코인이 들어오면 즉시 시작 화면으로 간다 (§4.7)', () => {
    const rig = makeFlow({ coinsPerPlay: 2 });
    rig.flow.handle('COIN');
    expect(rig.flow.screen).toBe('ATTRACT'); // 아직 C 미만
    rig.flow.handle('COIN');
    expect(rig.flow.screen).toBe('READY');
  });
});

describe('CTL-011 — SERVICE는 어트랙트·시작 화면에서만 (§2.7)', () => {
  it.each<[Screen, boolean]>([
    ['ATTRACT', true],
    ['READY', true],
    ['TUTORIAL', false],
    ['RUN', false],
    ['CONTINUE', false],
    ['RESULT', false],
    ['NAME_ENTRY', false],
  ])('%s에서 SERVICE 진입 허용 = %s', (screen, allowed) => {
    const rig = atScreen(screen);
    rig.flow.handle('SERVICE');
    expect(rig.flow.screen === 'ADMIN').toBe(allowed);
  });

  it('관리자에서 SERVICE를 다시 누르면 복귀한다', () => {
    const rig = atScreen('ADMIN');
    rig.flow.handle('SERVICE');
    expect(rig.flow.screen).toBe('ATTRACT');
  });

  it('관리자에서 BUTTON2로 복귀한다 (`admin_page.md` §4.1 취소/뒤로)', () => {
    const rig = atScreen('ADMIN');
    press(rig.flow, 'BUTTON2');
    expect(rig.flow.screen).toBe('ATTRACT');
  });

  it('관리자에서 적립한 코인은 복귀 후 시작 화면으로 이어진다', () => {
    const rig = atScreen('ADMIN');
    rig.flow.handle('COIN');
    press(rig.flow, 'BUTTON2');
    expect(rig.flow.screen).toBe('READY');
  });
});

describe('CTL-001 — P2 입력은 게임에 영향을 주지 않는다 (§2.1)', () => {
  it('P2 코인도 적립하지 않는다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN', 2);
    expect(rig.flow.snapshot().credits.paid).toBe(0);
    expect(rig.flow.screen).toBe('ATTRACT');
  });

  it('P2 START는 런을 시작하지 않는다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START', 2);
    expect(rig.flow.screen).toBe('READY');
  });

  it('RESERVED 슬롯은 아무 일도 하지 않는다 (§2.1 10행)', () => {
    const rig = makeFlow();
    rig.flow.handle('RESERVED');
    expect(rig.flow.screen).toBe('ATTRACT');
    expect(rig.flow.trace).toEqual([]);
  });
});

describe('CRD-601 — 차감 시점 (§10.2)', () => {
  it('START 유효 판정 직후, 미니 튜토리얼 진입 전에 차감된다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    expect(rig.credits.calls.chargeStart).toBe(0);
    rig.flow.handle('START');
    expect(rig.credits.calls.chargeStart).toBe(1);
    expect(rig.flow.screen).toBe('TUTORIAL');
    expect(rig.flow.snapshot().credits.paid).toBe(0);
  });

  it('크레딧이 부족하면 차감하지 않고 거부음만 난다', () => {
    const rig = makeFlow({ coinsPerPlay: 2 });
    rig.flow.handle('COIN');
    rig.flow.handle('START'); // ATTRACT에서 크레딧 부족
    expect(rig.credits.calls.chargeStart).toBe(0);
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.flow.screen).toBe('ATTRACT');
  });

  it('차감은 런 1회당 정확히 1번이다', () => {
    const rig = makeFlow();
    toRun(rig);
    expect(rig.credits.calls.chargeStart).toBe(1);
  });

  it('컨티뉴는 확정 입력 직후·복귀 전에 차감된다', () => {
    const rig = atScreen('CONTINUE');
    rig.flow.handle('COIN');
    expect(rig.credits.calls.chargeContinue).toBe(0);
    rig.flow.handle('BUTTON1');
    expect(rig.credits.calls.chargeContinue).toBe(1);
    expect(rig.flow.screen).toBe('RUN');
  });
});

describe('SES-210 — 미니 튜토리얼 (§4.7 · 작업 계획 Q-4·Q-5)', () => {
  it('첫 유료 런은 튜토리얼로 들어간다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    expect(rig.flow.screen).toBe('TUTORIAL');
    expect(rig.flow.snapshot().run?.tutorial).toBe(true);
  });

  it('튜토리얼 중 런 타이머가 정지한다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    const before = rig.flow.snapshot().run?.timeRemainingMs;
    rig.clock.advance(5000);
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.timeRemainingMs).toBe(before);
  });

  it('10초 무입력이면 자동 진행한다 (경계값)', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    rig.clock.advance(TUTORIAL_IDLE_MS - 1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('TUTORIAL');
    rig.clock.advance(1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
  });

  it('입력이 있으면 무입력 타이머가 다시 시작된다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    rig.clock.advance(TUTORIAL_IDLE_MS - 1);
    rig.flow.handle('RIGHT');
    rig.clock.advance(2);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('TUTORIAL');
  });

  it('지정 안전수를 당겨 성공하면 곧바로 런으로 넘어간다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    rig.flow.handle('BUTTON1');
    rig.clock.advance(300);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
  });

  it('본 런은 보드 1부터 시작하고 타이머가 가득 차 있다', () => {
    const rig = makeFlow();
    toRun(rig);
    const run = rig.flow.snapshot().run;
    expect(run?.boardNumber).toBe(1);
    expect(run?.timeRemainingMs).toBe(FACTORY_PARAMS.sessionTimeSec * 1000);
  });

  it('튜토리얼 성공이 본 런의 콤보를 오염시키지 않는다 (R7)', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    rig.flow.handle('BUTTON1');
    rig.clock.advance(300);
    rig.flow.tick(); // 튜토리얼 성공 → RUN
    rig.flow.handle('BUTTON1'); // 본 런 첫 성공
    expect(rig.flow.snapshot().run?.comboCentis).toBe(100);
  });

  it('4회차부터는 튜토리얼을 건너뛴다 (Q-4 메모리 카운터)', () => {
    const rig = makeFlow();
    for (let play = 1; play <= TUTORIAL_MAX_PLAYS; play += 1) {
      rig.flow.handle('COIN');
      rig.flow.handle('START');
      expect(rig.flow.screen).toBe('TUTORIAL');
      rig.clock.advance(TUTORIAL_IDLE_MS);
      rig.flow.tick();
      rig.flow.handle('COIN');
      rig.flow.handle('COIN'); // 결과 화면 통과용 크레딧 확보
      rig.flow.handle('SERVICE'); // 무시된다 (런 중)
      // 런을 강제 종료해 다음 판으로
      rig.clock.advance(FACTORY_PARAMS.sessionTimeSec * 1000);
      rig.flow.tick();
      press(rig.flow, 'BUTTON2'); // CONTINUE → RESULT
      rig.flow.handle('BUTTON1'); // RESULT → 다음
    }
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    expect(rig.flow.screen).toBe('RUN');
    expect(rig.flow.paidPlays).toBe(TUTORIAL_MAX_PLAYS + 1);
  });

  it('튜토리얼에서 BUTTON2는 무효다 (§2.4)', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    press(rig.flow, 'BUTTON2');
    expect(rig.sfx.count('hint')).toBe(0);
  });

  it('튜토리얼에서 START는 무효다', () => {
    const rig = makeFlow();
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    expect(rig.credits.calls.chargeStart).toBe(1);
    expect(rig.flow.screen).toBe('TUTORIAL');
  });
});

describe('SES-211 — 화면 시간 정책 (§4.7)', () => {
  it('CONTINUE는 10초 카운트다운이다 (경계값)', () => {
    const rig = atScreen('CONTINUE');
    rig.clock.advance(CONTINUE_MS - 1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('CONTINUE');
    rig.clock.advance(1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RESULT');
  });

  it('CONTINUE 중에는 런 타이머가 정지한다', () => {
    const rig = atScreen('CONTINUE');
    const before = rig.flow.snapshot().run?.timeRemainingMs;
    rig.clock.advance(5000);
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.timeRemainingMs).toBe(before);
  });

  it('결과 화면은 8초 자동 종료다 (경계값)', () => {
    const rig = atScreen('RESULT');
    rig.clock.advance(RESULT_AUTO_MS - 1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RESULT');
    rig.clock.advance(1);
    rig.flow.tick();
    expect(rig.flow.screen).not.toBe('RESULT');
  });

  it('이름 입력은 15초 제한이다 (경계값)', () => {
    const rig = atScreen('NAME_ENTRY');
    rig.clock.advance(NAME_ENTRY_MS - 1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('NAME_ENTRY');
    rig.clock.advance(1);
    rig.flow.tick();
    expect(rig.flow.screen).not.toBe('NAME_ENTRY');
  });

  it('카운트다운 잔여 시간이 스냅샷에 실린다', () => {
    const rig = atScreen('CONTINUE');
    expect(rig.flow.snapshot().countdownMs).toBe(CONTINUE_MS);
    rig.clock.advance(4000);
    expect(rig.flow.snapshot().countdownMs).toBe(CONTINUE_MS - 4000);
  });

  it('결과 화면에서 START는 "즉시 다음"이다 (§2.7)', () => {
    const rig = atScreen('RESULT');
    rig.flow.handle('START');
    expect(rig.flow.screen).not.toBe('RESULT');
  });
});

describe('SES-212 — 인게임 5분 무입력 (§2.7)', () => {
  it('런이 종료되고 CONTINUE를 건너뛰어 결과로 간다', () => {
    // 세션 시간이 5분보다 짧으면 타이머 종료가 먼저 성립하므로 긴 세션으로 분기를 연다
    const rig = makeFlow({ params: { sessionTimeSec: 600 } });
    toRun(rig);
    rig.clock.advance(RUN_IDLE_END_MS);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RESULT');
    expect(rig.flow.snapshot().result?.endReason).toBe('external');
  });

  it('5분 직전에는 종료되지 않는다 (경계값)', () => {
    const rig = makeFlow({ params: { sessionTimeSec: 600 } });
    toRun(rig);
    rig.clock.advance(RUN_IDLE_END_MS - 1);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
  });

  it('입력이 있으면 무입력 시계가 다시 시작된다', () => {
    const rig = makeFlow({ params: { sessionTimeSec: 600 } });
    toRun(rig);
    rig.clock.advance(RUN_IDLE_END_MS - 1000);
    rig.flow.handle('RIGHT');
    rig.clock.advance(2000);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
  });

  it('남은 크레딧이 유지된다', () => {
    const rig = makeFlow({ params: { sessionTimeSec: 600 } });
    toRun(rig);
    rig.flow.handle('COIN');
    rig.flow.handle('COIN');
    rig.clock.advance(RUN_IDLE_END_MS);
    rig.flow.tick();
    expect(rig.flow.snapshot().credits.paid).toBe(2);
  });
});

describe('CONTINUE 분기 (§4.5 · 작업 계획 Q-6)', () => {
  it('크레딧이 없으면 BUTTON1이 거부된다', () => {
    const rig = atScreen('CONTINUE');
    rig.sfx.clear();
    rig.flow.handle('BUTTON1');
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.flow.screen).toBe('CONTINUE');
    expect(rig.credits.calls.chargeContinue).toBe(0);
  });

  it('코인만 넣어서는 자동 복귀하지 않는다 (확정은 BUTTON1)', () => {
    const rig = atScreen('CONTINUE');
    rig.flow.handle('COIN');
    expect(rig.flow.screen).toBe('CONTINUE');
    expect(rig.credits.calls.chargeContinue).toBe(0);
  });

  it('코인 + BUTTON1이면 같은 보드로 복귀한다 (SES-208)', () => {
    const rig = atScreen('CONTINUE');
    const before = rig.flow.snapshot().run?.chainsLeft;
    rig.flow.handle('COIN');
    rig.flow.handle('BUTTON1');
    expect(rig.flow.screen).toBe('RUN');
    expect(rig.flow.snapshot().run?.chainsLeft).toBe(before);
    expect(rig.flow.snapshot().run?.hearts).toBe(FACTORY_PARAMS.continueHeartRecover);
    expect(rig.flow.snapshot().run?.continueCount).toBe(1);
  });

  it('BUTTON2는 종료 선택이다', () => {
    const rig = atScreen('CONTINUE');
    press(rig.flow, 'BUTTON2');
    expect(rig.flow.screen).toBe('RESULT');
  });

  it('CONTINUE 화면에서도 종료 사유를 읽을 수 있다 (§8.4 TIME UP / HEART OUT 구분)', () => {
    const rig = atScreen('CONTINUE');
    expect(rig.flow.snapshot().result).toBeNull(); // 결과 요약은 아직 없다
    expect(rig.flow.snapshot().endReason).toBe('hearts');
  });

  it('런 전에는 종료 사유가 없다', () => {
    expect(makeFlow().flow.snapshot().endReason).toBeNull();
  });

  it('CONTINUE에서 레버·START는 무효다 (§7.2 정책표)', () => {
    const rig = atScreen('CONTINUE');
    rig.flow.handle('COIN');
    rig.flow.handle('UP');
    rig.flow.handle('START');
    expect(rig.flow.screen).toBe('CONTINUE');
    expect(rig.credits.calls.chargeStart).toBe(1); // 런 시작 때의 1회 그대로
  });
});

describe('결과 화면과 랭킹 등록 (§5.5 · §5.7)', () => {
  it('점수·등급·도달 보드·컨티뉴가 요약에 담긴다', () => {
    const rig = atScreen('RESULT');
    const result: ResultSummary | null = rig.flow.snapshot().result;
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThan(0);
    expect(result?.grade).toBe('C');
    expect(result?.boardReached).toBe(1);
    expect(result?.continues).toBe(0);
    expect(result?.endReason).toBe('hearts');
  });

  it('실패 원인에 맞는 개선 팁이 선택된다 (§8.4)', () => {
    expect(atScreen('RESULT').flow.snapshot().result?.tip).toBe('hearts');
  });

  it('TOP 10에 들면 이름 입력으로 간다', () => {
    const rig = atScreen('RESULT');
    expect(rig.flow.snapshot().result?.qualifies).toBe(true);
    rig.flow.handle('BUTTON1');
    expect(rig.flow.screen).toBe('NAME_ENTRY');
  });

  it('0점이면 이름 입력을 건너뛴다 (작업 계획 P-7)', () => {
    const rig = makeFlow({ boards: blockedBoardOf, params: { initialHearts: 1 } });
    toRun(rig);
    rig.flow.handle('BUTTON1'); // 즉시 하트 소진
    rig.flow.tick();
    press(rig.flow, 'BUTTON2'); // CONTINUE → RESULT
    expect(rig.flow.snapshot().result?.score).toBe(0);
    rig.flow.handle('BUTTON1');
    expect(rig.flow.screen).toBe('ATTRACT');
  });

  it('이름을 확정하면 랭킹에 등록된다', () => {
    const rig = atScreen('NAME_ENTRY');
    const score = rig.flow.snapshot().result?.score ?? 0;
    rig.flow.handle('UP'); // A
    rig.flow.handle('BUTTON1');
    rig.flow.handle('BUTTON1');
    rig.flow.handle('BUTTON1'); // 확정
    expect(rig.ranking.top().length).toBe(1);
    expect(rig.ranking.top()[0].initials).toBe('A  ');
    expect(rig.ranking.top()[0].score).toBe(score);
    expect(rig.ranking.top()[0].registeredAt).toBe(ISO);
  });

  it('15초가 지나면 현재 값으로 자동 등록된다 (빈 값은 AAA)', () => {
    const rig = atScreen('NAME_ENTRY');
    const view: NameEntryView | null = rig.flow.snapshot().nameEntry;
    expect(view?.value).toBe('   ');
    rig.clock.advance(NAME_ENTRY_MS);
    rig.flow.tick();
    expect(rig.ranking.top()[0].initials).toBe('AAA');
  });

  it('등록 후 크레딧이 남아 있으면 시작 화면으로 간다 (§2.7)', () => {
    const rig = atScreen('NAME_ENTRY');
    rig.flow.handle('COIN');
    rig.clock.advance(NAME_ENTRY_MS);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('READY');
  });

  it('크레딧이 없으면 어트랙트로 돌아간다', () => {
    const rig = atScreen('NAME_ENTRY');
    rig.clock.advance(NAME_ENTRY_MS);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('ATTRACT');
  });

  it('랭킹 변경 훅이 등록 시 호출된다', () => {
    const clock = new TestClock(0);
    let saves = 0;
    const flow = new FlowMachine({
      clock,
      credits: creditsSpy(),
      boardSource: { next: (req: BoardRequest) => scoringBoardOf(req.boardNumber) },
      ranking: new RankingStore(),
      params: { ...FACTORY_PARAMS, initialHearts: 1 },
      sfx: createSilentSfx(),
      nowIso: () => ISO,
      onRankingChanged: () => {
        saves += 1;
      },
    });
    const rig: FlowRig = {
      flow,
      clock,
      credits: creditsSpy(),
      ranking: new RankingStore(),
      sfx: createSilentSfx(),
      screens: [],
    };
    playToDeathWithScore(rig);
    press(flow, 'BUTTON2');
    flow.handle('BUTTON1');
    clock.advance(NAME_ENTRY_MS);
    flow.tick();
    expect(saves).toBe(1);
  });
});

describe('§7.2 정책표 — 무효 입력', () => {
  it('ATTRACT에서 버튼 2종은 아무 일도 하지 않는다', () => {
    const rig = makeFlow();
    rig.flow.handle('BUTTON1');
    press(rig.flow, 'BUTTON2');
    expect(rig.flow.screen).toBe('ATTRACT');
    expect(rig.flow.trace).toEqual([]);
  });

  it('READY에서 레버·버튼은 무효다', () => {
    const rig = atScreen('READY');
    for (const a of ['UP', 'DOWN', 'LEFT', 'RIGHT', 'BUTTON1', 'BUTTON2'] as const) {
      rig.flow.handle(a);
    }
    expect(rig.flow.screen).toBe('READY');
  });

  it('RUN에서 START는 무효다 (§2.7 "런 진행 중에는 무효")', () => {
    const rig = makeFlow();
    toRun(rig);
    rig.flow.handle('COIN');
    rig.flow.handle('START');
    expect(rig.flow.screen).toBe('RUN');
    expect(rig.credits.calls.chargeStart).toBe(1);
  });

  it('RESULT에서 레버는 무효다', () => {
    const rig = atScreen('RESULT');
    rig.flow.handle('UP');
    expect(rig.flow.screen).toBe('RESULT');
  });
});

describe('어트랙트 3패널 순환 (§4.6 · 작업 계획 P-9)', () => {
  it('패널 3장이 §4.7의 15초 루프를 정확히 나눈다', () => {
    expect(ATTRACT_PANEL_MS * ATTRACT_PANELS).toBe(ATTRACT_LOOP_MS);
    expect(ATTRACT_LOOP_MS).toBe(15000);
  });

  it('5초마다 패널이 바뀐다', () => {
    const rig = makeFlow();
    expect(rig.flow.snapshot().attractPanel).toBe(0);
    rig.clock.advance(5000);
    expect(rig.flow.snapshot().attractPanel).toBe(1);
    rig.clock.advance(5000);
    expect(rig.flow.snapshot().attractPanel).toBe(2);
    rig.clock.advance(5000);
    expect(rig.flow.snapshot().attractPanel).toBe(0);
  });

  it('레버로 수동으로 넘길 수 있다', () => {
    const rig = makeFlow();
    rig.flow.handle('RIGHT');
    expect(rig.flow.snapshot().attractPanel).toBe(1);
    rig.flow.handle('LEFT');
    rig.flow.handle('LEFT');
    expect(rig.flow.snapshot().attractPanel).toBe(2);
  });

  it('어트랙트가 아니면 패널 번호가 0이다', () => {
    expect(atScreen('READY').flow.snapshot().attractPanel).toBe(0);
  });

  it('오늘의 1위가 스냅샷에 실린다 (§4.6)', () => {
    const rig = makeFlow();
    rig.ranking.submit({
      initials: 'ABC',
      score: 5000,
      board: 3,
      maxComboCentis: 150,
      continues: 0,
      registeredAt: ISO,
    });
    expect(rig.flow.snapshot().bestToday?.initials).toBe('ABC');
  });
});

describe('CTL-009 — 인게임 버튼 역할 (§2.4)', () => {
  it('BUTTON1은 당기기, BUTTON2는 힌트다', () => {
    const rig = makeFlow();
    toRun(rig);
    press(rig.flow, 'BUTTON2');
    expect(rig.sfx.count('hint')).toBe(1);
    expect(rig.flow.snapshot().run?.chainsLeft).toBe(2); // 힌트는 제거하지 않는다
    rig.flow.handle('BUTTON1');
    expect(rig.flow.snapshot().run?.removing.length).toBe(1);
  });
});

describe('CTL-010 — 같은 프레임 동시 입력은 BUTTON1만 소비한다 (§2.4 런타임 배선)', () => {
  /**
   * 순수 함수 `filterSimultaneous()` 단위 테스트만으로는 이 인수를 지킬 수 없다 —
   * 함수가 배선되지 않아도 그 테스트는 통과하기 때문이다. 여기서는 **실제 `FlowMachine`을
   * 통과시켜** 힌트가 소비되지 않았음을 코어 카운터(`hintUsesThisBoard`)로 확인한다.
   */
  function inRun(): FlowRig {
    const rig = makeFlow();
    toRun(rig);
    rig.sfx.clear();
    return rig;
  }

  it('BUTTON2 → BUTTON1 순서: 당기기만 실행되고 힌트는 소비되지 않는다', () => {
    const rig = inRun();
    rig.flow.handle('BUTTON2');
    rig.flow.handle('BUTTON1');
    rig.flow.tick(); // 프레임 마감

    expect(rig.flow.snapshot().run?.hintUses).toBe(0);
    expect(rig.sfx.log).not.toContain('hint');
    expect(rig.flow.snapshot().run?.hint.state).toBe('READY');
    expect(rig.flow.snapshot().run?.removing.length).toBe(1); // 당기기는 실행됐다
  });

  it('BUTTON1 → BUTTON2 순서: 실패 경로가 잠금을 풀어도 힌트가 통과하지 않는다', () => {
    // 당기기가 **실패**하면 ⑨가 호출 스택 안에서 잠금을 풀어 뒤이은 힌트가 새어 나간다 —
    // 검증자가 재현한 바로 그 경로다
    const rig = makeFlow({ boards: scoringBoardOf });
    toRun(rig);
    rig.sfx.clear();
    expect(rig.flow.snapshot().run?.focusId).toBe(1); // 초기 포커스 = 막힌 사슬

    rig.flow.handle('BUTTON1');
    rig.flow.handle('BUTTON2');
    rig.flow.tick();

    expect(rig.flow.snapshot().run?.hearts).toBe(2); // 당기기는 실행돼 실패했다
    expect(rig.flow.snapshot().run?.hintUses).toBe(0);
    expect(rig.sfx.log).not.toContain('hint');
    expect(rig.flow.snapshot().run?.hint.state).toBe('READY');
  });

  it('BUTTON2 단독이면 프레임 마감에 정상 소비된다', () => {
    const rig = inRun();
    rig.flow.handle('BUTTON2');
    expect(rig.flow.snapshot().run?.hintUses).toBe(0); // 아직 프레임이 안 끝났다
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.hintUses).toBe(1);
    expect(rig.sfx.log).toContain('hint');
  });

  it('BUTTON1 단독은 프레임 지연 없이 즉시 실행된다 (§16.3 응답 예산)', () => {
    const rig = inRun();
    rig.flow.handle('BUTTON1');
    expect(rig.flow.snapshot().run?.removing.length).toBe(1); // tick 없이도 이미 실행
  });

  it('다른 프레임에 나눠 누르면 둘 다 소비된다', () => {
    const rig = inRun();
    rig.flow.handle('BUTTON2');
    rig.flow.tick();
    rig.flow.handle('BUTTON1');
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.hintUses).toBe(1);
    expect(rig.flow.snapshot().run?.removing.length).toBe(1);
  });

  it('같은 프레임의 BUTTON1 2회는 둘 다 소비된다 (§2.6 버퍼가 받는다)', () => {
    const rig = inRun();
    rig.flow.handle('BUTTON1'); // 즉시 실행 → 잠금
    rig.flow.handle('BUTTON1'); // 잠금 중이라 버퍼로
    rig.flow.tick();
    expect(rig.flow.snapshot().run?.chainsLeft).toBe(2);
    rig.clock.advance(SLIDE_MS);
    rig.flow.tick(); // 첫 제거 완료 → ⑨에서 버퍼 소진
    expect(rig.flow.snapshot().run?.chainsLeft).toBe(1);
    expect(rig.flow.snapshot().run?.removing.length).toBe(1); // 두 번째가 진행 중
  });

  it('CONTINUE 화면에서도 동시 입력은 BUTTON1(이어하기)이 이긴다', () => {
    const rig = atScreen('CONTINUE');
    rig.flow.handle('COIN');
    rig.flow.handle('BUTTON2'); // 종료 선택
    rig.flow.handle('BUTTON1'); // 이어하기 확정
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
    expect(rig.credits.calls.chargeContinue).toBe(1);
  });

  it('레버·START·COIN·SERVICE는 프레임 수집에 영향받지 않는다', () => {
    const rig = inRun();
    const before = rig.flow.snapshot().run?.focusId;
    rig.flow.handle('UP'); // 레버는 즉시 반영 (§2.6)
    expect(rig.flow.snapshot().run?.focusId).not.toBe(before);
    rig.flow.handle('COIN'); // 코인도 즉시 적립 (§2.7)
    expect(rig.flow.snapshot().credits.paid).toBe(1);
  });

  it('BUTTON2를 붙잡아 두어도 무입력 시계는 누른 시점에 갱신된다 (§2.7)', () => {
    const rig = makeFlow({ params: { sessionTimeSec: 600 } });
    toRun(rig);
    rig.clock.advance(RUN_IDLE_END_MS - 1000);
    rig.flow.handle('BUTTON2');
    rig.clock.advance(2000);
    rig.flow.tick();
    expect(rig.flow.screen).toBe('RUN');
  });
});
