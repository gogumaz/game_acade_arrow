// 전 경로 시나리오 (작업 계획 §13.1-1) — 순수 모듈만으로 화면 흐름 전량을 통과시킨다.
//
// 여기서 단언하는 `flow.trace` 배열이 완료 기준 3("화면 흐름 전 경로 도달 가능")의 자동 증거이고,
// 같은 경로를 실기(dev·desktop)에서 재현한 것이 §13.1-3·4의 수동 증거다.

import { describe, it, expect } from 'vitest';
import { createChain } from '../../src/core/chain';
import { FACTORY_PARAMS, type CoreParams } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import type { GridPoint } from '../../src/core/types';
import type { BoardRequest, BoardSource } from '../../src/game/boardSource';
import { FlowMachine } from '../../src/game/flow';
import { RankingStore } from '../../src/game/rankingStore';
import { createSilentSfx } from '../../src/game/sfx';
import { BOARD_TRANSITION_MS, NAME_ENTRY_MS, TUTORIAL_IDLE_MS } from '../../src/game/timing';
import { TestClock, creditsSpy, openBoard } from './harness';

const SLIDE_MS = 202;
const SESSION_MS = FACTORY_PARAMS.sessionTimeSec * 1000;
const CONTINUE_MS = FACTORY_PARAMS.continuePromptTimeSec * 1000;
const ISO = '2026-08-16T12:34:56.000Z';

function p(x: number, y: number): GridPoint {
  return { x, y };
}

/** 안전 사슬 1개(대표점 x=12) + 막힌 쌍 — 점수를 내고 하트를 잃는 최소 보드 */
function walkBoard(n: number): Board {
  return new Board({
    chains: [
      createChain(1, [p(1, 9), p(2, 9)], 1),
      createChain(2, [p(6, 8), p(6, 9), p(6, 10)], 0),
      createChain(3, [p(11, 0), p(12, 0)], 0),
    ],
    boardNumber: n,
    seed: `walk-${n}`,
  });
}

function makeWalk(make: (n: number) => Board, params: Partial<CoreParams> = {}) {
  const clock = new TestClock(0);
  const credits = creditsSpy();
  const ranking = new RankingStore();
  const sfx = createSilentSfx();
  const boardSource: BoardSource = { next: (req: BoardRequest) => make(req.boardNumber) };
  const flow = new FlowMachine({
    clock,
    credits,
    boardSource,
    ranking,
    params: { ...FACTORY_PARAMS, ...params },
    sfx,
    nowIso: () => ISO,
  });
  return { flow, clock, credits, ranking, sfx };
}

describe('전 경로 워크스루 (§4.1)', () => {
  it('ATTRACT → READY → TUTORIAL → RUN → CONTINUE(코인 O) → RUN → CONTINUE(코인 X) → RESULT → NAME_ENTRY → ATTRACT', () => {
    const w = makeWalk(walkBoard, { initialHearts: 1, continueHeartRecover: 1 });

    // ① 어트랙트 → 결제 → 미니 튜토리얼
    expect(w.flow.screen).toBe('ATTRACT');
    w.flow.handle('COIN');
    expect(w.flow.screen).toBe('READY');
    w.flow.handle('START');
    expect(w.flow.screen).toBe('TUTORIAL');
    expect(w.credits.calls.chargeStart).toBe(1);

    // ② 10초 무입력 자동 진행 → 본 런
    w.clock.advance(TUTORIAL_IDLE_MS);
    w.flow.tick();
    expect(w.flow.screen).toBe('RUN');

    // ③ 안전수 1개를 빼 점수를 만들고
    w.flow.handle('RIGHT');
    w.flow.handle('RIGHT');
    w.flow.handle('BUTTON1');
    w.clock.advance(SLIDE_MS);
    w.flow.tick();
    expect(w.flow.snapshot().run?.displayScore).toBeGreaterThan(0);

    // ④ 막힌 사슬을 당겨 하트를 소진한다 → CONTINUE
    w.flow.handle('LEFT');
    w.flow.handle('BUTTON1');
    w.flow.tick();
    expect(w.flow.screen).toBe('CONTINUE');

    // ⑤ 코인 O — 확정 입력(BUTTON1)으로 같은 보드 복귀 (Q-6)
    w.flow.handle('COIN');
    w.flow.handle('BUTTON1');
    expect(w.flow.screen).toBe('RUN');
    expect(w.credits.calls.chargeContinue).toBe(1);
    expect(w.flow.snapshot().run?.continueCount).toBe(1);

    // ⑥ 이번에는 시간으로 종료 → CONTINUE
    w.clock.advance(SESSION_MS);
    w.flow.tick();
    expect(w.flow.screen).toBe('CONTINUE');

    // ⑦ 코인 X — 10초 만료 → 결과
    w.clock.advance(CONTINUE_MS);
    w.flow.tick();
    expect(w.flow.screen).toBe('RESULT');
    expect(w.flow.snapshot().result?.endReason).toBe('time');

    // ⑧ TOP 10 진입 → 이름 입력 → 15초 자동 등록 → 어트랙트
    expect(w.flow.snapshot().result?.qualifies).toBe(true);
    w.flow.handle('BUTTON1');
    expect(w.flow.screen).toBe('NAME_ENTRY');
    w.clock.advance(NAME_ENTRY_MS);
    w.flow.tick();
    expect(w.flow.screen).toBe('ATTRACT');

    expect(w.flow.trace).toEqual([
      'ATTRACT→READY',
      'READY→TUTORIAL',
      'TUTORIAL→RUN',
      'RUN→CONTINUE',
      'CONTINUE→RUN',
      'RUN→CONTINUE',
      'CONTINUE→RESULT',
      'RESULT→NAME_ENTRY',
      'NAME_ENTRY→ATTRACT',
    ]);
  });

  it('등록된 기록이 어트랙트의 오늘의 1위·TOP 10에 그대로 노출된다 (§4.6)', () => {
    const w = makeWalk(walkBoard, { initialHearts: 1 });
    w.flow.handle('COIN');
    w.flow.handle('START');
    w.clock.advance(TUTORIAL_IDLE_MS);
    w.flow.tick();
    w.flow.handle('RIGHT');
    w.flow.handle('RIGHT');
    w.flow.handle('BUTTON1');
    w.clock.advance(SLIDE_MS);
    w.flow.tick();
    w.flow.handle('LEFT');
    w.flow.handle('BUTTON1');
    w.flow.tick();
    w.flow.handle('BUTTON2');
    w.flow.tick(); // §2.4 — BUTTON2는 프레임 마감에 확정된다 // 컨티뉴 포기
    w.flow.handle('BUTTON1'); // 결과 → 이름 입력
    w.clock.advance(NAME_ENTRY_MS);
    w.flow.tick();

    const snap = w.flow.snapshot();
    expect(snap.screen).toBe('ATTRACT');
    expect(snap.ranking.length).toBe(1);
    expect(snap.bestToday?.initials).toBe('AAA');
    expect(snap.ranking[0].continues).toBe(0);
  });

  it('컨티뉴 없이 종료하면 결과 → 어트랙트로 곧장 간다 (0점 경로)', () => {
    const w = makeWalk(() => blockedOnly(), { initialHearts: 1 });
    w.flow.handle('COIN');
    w.flow.handle('START');
    w.clock.advance(TUTORIAL_IDLE_MS);
    w.flow.tick();
    w.flow.handle('BUTTON1'); // 초기 포커스가 막힌 사슬
    w.flow.tick();
    w.flow.handle('BUTTON2');
    w.flow.tick(); // §2.4 — BUTTON2는 프레임 마감에 확정된다
    w.flow.handle('BUTTON1');
    expect(w.flow.trace).toEqual([
      'ATTRACT→READY',
      'READY→TUTORIAL',
      'TUTORIAL→RUN',
      'RUN→CONTINUE',
      'CONTINUE→RESULT',
      'RESULT→ATTRACT',
    ]);
  });

  it('4회차 유료 런은 튜토리얼을 건너뛰고 곧바로 인게임이다 (Q-4)', () => {
    const w = makeWalk(() => blockedOnly(), { initialHearts: 1 });
    for (let play = 0; play < 3; play += 1) {
      w.flow.handle('COIN');
      w.flow.handle('START');
      w.clock.advance(TUTORIAL_IDLE_MS);
      w.flow.tick();
      w.flow.handle('BUTTON1');
      w.flow.tick();
      w.flow.handle('BUTTON2');
      w.flow.tick(); // §2.4 — BUTTON2는 프레임 마감에 확정된다
      w.flow.handle('BUTTON1');
    }
    w.flow.handle('COIN');
    w.flow.handle('START');
    expect(w.flow.screen).toBe('RUN');
    expect(w.flow.trace.slice(-1)).toEqual(['READY→RUN']);
  });

  it('보드를 비우면 화면 전환 없이 다음 보드로 이어진다 (§4.2)', () => {
    const w = makeWalk(() => openBoard(1));
    w.flow.handle('COIN');
    w.flow.handle('START');
    w.clock.advance(TUTORIAL_IDLE_MS);
    w.flow.tick();
    expect(w.flow.snapshot().run?.boardNumber).toBe(1);

    w.flow.handle('BUTTON1');
    w.clock.advance(SLIDE_MS);
    w.flow.tick(); // 클리어 정산
    w.clock.advance(BOARD_TRANSITION_MS);
    w.flow.tick(); // 다음 보드 적재

    expect(w.flow.screen).toBe('RUN');
    expect(w.flow.snapshot().run?.boardNumber).toBe(2);
    expect(w.flow.trace).toEqual(['ATTRACT→READY', 'READY→TUTORIAL', 'TUTORIAL→RUN']);
  });

  it('관리자 스텁을 들렀다 와도 흐름이 이어진다 (§2.7)', () => {
    const w = makeWalk(() => openBoard(2));
    w.flow.handle('SERVICE');
    expect(w.flow.screen).toBe('ADMIN');
    w.flow.handle('COIN');
    w.flow.handle('BUTTON2');
    w.flow.tick(); // §2.4 — BUTTON2는 프레임 마감에 확정된다
    expect(w.flow.screen).toBe('READY');
    w.flow.handle('START');
    expect(w.flow.screen).toBe('TUTORIAL');
    expect(w.flow.trace).toEqual(['ATTRACT→ADMIN', 'ADMIN→READY', 'READY→TUTORIAL']);
  });

  it('전 경로에서 크레딧 수지가 맞는다 (시작 1 + 컨티뉴 1 = 코인 2)', () => {
    const w = makeWalk(walkBoard, { initialHearts: 1, continueHeartRecover: 1 });
    w.flow.handle('COIN');
    w.flow.handle('COIN');
    w.flow.handle('START');
    w.clock.advance(TUTORIAL_IDLE_MS);
    w.flow.tick();
    w.flow.handle('BUTTON1'); // 막힌 사슬 → 하트 소진
    w.flow.tick();
    expect(w.flow.screen).toBe('CONTINUE');
    w.flow.handle('BUTTON1'); // 남은 크레딧 1로 컨티뉴
    expect(w.flow.screen).toBe('RUN');
    expect(w.flow.snapshot().credits.paid).toBe(0);
    expect(w.credits.calls.chargeStart).toBe(1);
    expect(w.credits.calls.chargeContinue).toBe(1);
  });

  it('같은 시나리오를 두 번 돌리면 전이 기록이 완전히 같다 (결정성)', () => {
    const runOnce = (): readonly string[] => {
      const w = makeWalk(walkBoard, { initialHearts: 1 });
      w.flow.handle('COIN');
      w.flow.handle('START');
      w.clock.advance(TUTORIAL_IDLE_MS);
      w.flow.tick();
      w.flow.handle('RIGHT');
      w.flow.handle('RIGHT');
      w.flow.handle('BUTTON1');
      w.clock.advance(SLIDE_MS);
      w.flow.tick();
      w.flow.handle('LEFT');
      w.flow.handle('BUTTON1');
      w.flow.tick();
      w.flow.handle('BUTTON2');
      w.flow.tick(); // §2.4 — BUTTON2는 프레임 마감에 확정된다
      w.flow.handle('BUTTON1');
      w.clock.advance(NAME_ENTRY_MS);
      w.flow.tick();
      return w.flow.trace;
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

/** 막힌 사슬 1개 + 블로커 1개 — 점수 0으로 끝나는 경로용 */
function blockedOnly(): Board {
  return new Board({
    chains: [
      createChain(1, [p(1, 9), p(2, 9)], 1),
      createChain(2, [p(6, 8), p(6, 9), p(6, 10)], 0),
    ],
    boardNumber: 1,
    seed: 'walk-blocked',
  });
}
