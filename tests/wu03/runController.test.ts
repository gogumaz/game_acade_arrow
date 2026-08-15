// 조작 계층 통합 — 포커스 + 버퍼 + 힌트 + `RunSession` 결선 (작업 계획 T6)
//
// CTL-009(인게임 `BUTTON2`가 사슬을 제거하지 않는다) · §4.2 보드 전환 0.8초 ·
// §3.8 자동 보정 표시 · §4.7 미니 튜토리얼 제한 모드를 여기서 판정한다.

import { describe, it, expect } from 'vitest';
import { createChain } from '../../src/core/chain';
import { FACTORY_PARAMS } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import { RunSession } from '../../src/core/session';
import type { ChainId, GridPoint } from '../../src/core/types';
import {
  TUTORIAL_CHAIN_BLOCKED,
  TUTORIAL_CHAIN_SAFE,
  tutorialBoard,
  type BoardRequest,
  type BoardSource,
} from '../../src/game/boardSource';
import {
  RunController,
  type BlockView,
  type RemovalView,
  type RunControllerDeps,
  type RunTickReport,
} from '../../src/game/runController';
import { SFX_NAMES, createSilentSfx, type SfxName, type SilentSfx } from '../../src/game/sfx';
import { BOARD_TRANSITION_MS } from '../../src/game/timing';
import { TestClock, openBoard } from './harness';

const SLIDE_MS = 202; // 길이 2 사슬: 180 + 1 × 22 (§3.4 공장값)

function p(x: number, y: number): GridPoint {
  return { x, y };
}

interface Rig {
  readonly controller: RunController;
  readonly session: RunSession;
  readonly clock: TestClock;
  readonly sfx: SilentSfx;
  readonly served: number[];
}

/** 미리 만들어 둔 보드를 순서대로 내주는 공급자 — 전환 시나리오를 완전히 통제한다 */
function makeRun(boards: readonly Board[]): Rig {
  const clock = new TestClock(0);
  const sfx = createSilentSfx();
  const session = new RunSession(FACTORY_PARAMS, clock);
  const served: number[] = [];
  let index = 0;
  const boardSource: BoardSource = {
    next(req: BoardRequest): Board {
      served.push(req.boardNumber);
      const board = boards[Math.min(index, boards.length - 1)];
      index += 1;
      return board;
    },
  };
  const deps: RunControllerDeps = { session, boardSource, clock, sfx, params: FACTORY_PARAMS };
  const controller = new RunController(deps);
  return { controller, session, clock, sfx, served };
}

/** 서로를 막는 2사슬 — §3.8 자동 보정이 `start()`의 ⑦에서 곧바로 발동한다 */
function deadlockBoard(): Board {
  return new Board({
    chains: [
      createChain(1, [p(2, 8), p(3, 8), p(4, 8), p(5, 8), p(6, 8), p(6, 7), p(6, 6)], 2),
      createChain(2, [p(6, 1), p(6, 2), p(6, 3)], 1),
    ],
    boardNumber: 1,
    seed: 'deadlock',
  });
}

describe('start · snapshot', () => {
  it('보드 번호와 구간 라벨이 스냅샷에 실린다 (§8.1 우 HUD)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(7);
    const snap = rig.controller.snapshot();
    expect(snap.boardNumber).toBe(7);
    expect(snap.tier).toBe('PRESSURE');
    expect(snap.tierLabel).toBe('압박');
  });

  it('초기 포커스가 §2.2 규칙대로 잡힌다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    // openBoard는 한 열(x=12)에 y=0,2,4 — 가장 아래는 3번이다
    expect(rig.controller.focus).toBe(3);
    expect(rig.controller.snapshot().chains.find((c) => c.isFocus)?.id).toBe(3);
  });

  it('남은 사슬 수와 전체 수가 함께 나온다 (§8.2 5단)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    expect(rig.controller.snapshot().chainsLeft).toBe(3);
    expect(rig.controller.snapshot().chainsTotal).toBe(3);
  });

  it('시드는 보드 번호에서 파생된다 (§6.6 재현성 인계면)', () => {
    const rig = makeRun([openBoard(2)]);
    rig.controller.start(3);
    expect(rig.served).toEqual([3]);
  });

  it('start 전에 snapshot을 부르면 던진다', () => {
    const rig = makeRun([openBoard(2)]);
    expect(() => rig.controller.snapshot()).toThrow();
  });

  it('머리가 경계에 있으면 진로 프리뷰가 비어 있다 (§2.3)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    expect(rig.controller.snapshot().focusPath).toEqual([]);
  });

  it('진로 프리뷰는 머리 다음 칸부터 경계까지다', () => {
    const board = new Board({
      chains: [createChain(1, [p(0, 5), p(1, 5)], 0)],
      boardNumber: 1,
      seed: 'preview',
    });
    const rig = makeRun([board]);
    rig.controller.start(1);
    const path = rig.controller.snapshot().focusPath;
    expect(path[0]).toEqual({ x: 2, y: 5 });
    expect(path[path.length - 1]).toEqual({ x: 12, y: 5 });
  });
});

describe('레버 — 잠금과 무관하게 즉시 반영 (§2.6)', () => {
  it('포커스가 이동하고 선택음이 난다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('UP');
    expect(rig.controller.focus).toBe(2);
    expect(rig.sfx.count('select')).toBe(1);
  });

  it('판정 잠금 중에도 포커스가 움직인다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1'); // 제거 개시 → 잠금
    expect(rig.session.isLocked()).toBe(true);
    rig.controller.handle('UP');
    expect(rig.controller.focus).toBe(1);
  });

  it('이동할 수 없으면 거부음만 난다', () => {
    const rig = makeRun([openBoard(1)]);
    rig.controller.start(1);
    rig.controller.handle('LEFT');
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.sfx.count('select')).toBe(0);
  });
});

describe('BUTTON1 — 당기기와 제거 연출 (§3.4)', () => {
  it('성공하면 removing 목록에 코어 지속 시간이 실린다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    const removing: readonly RemovalView[] = rig.controller.snapshot().removing;
    expect(removing.length).toBe(1);
    expect(removing[0].chainId).toBe(3);
    expect(removing[0].durationMs).toBe(SLIDE_MS);
    expect(removing[0].exitPath.length).toBeGreaterThan(0);
  });

  it('제거가 완료되면 목록에서 빠진다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick();
    expect(rig.controller.snapshot().removing).toEqual([]);
    expect(rig.controller.snapshot().chainsLeft).toBe(2);
  });

  it('제거 개시 즉시 포커스가 §2.2 규칙대로 옮겨진다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('UP'); // 마지막 레버 방향 = UP, 포커스 2
    rig.controller.handle('BUTTON1');
    // (12,2) 제거 → UP 방향 비순환 이동 → (12,0) = 사슬 1
    expect(rig.controller.focus).toBe(1);
  });

  it('막히면 막힘 정보와 사운드가 남는다 (§9.2 실패)', () => {
    const rig = makeRun([blockedRig()]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1'); // 초기 포커스 = 막힌 사슬
    const block: BlockView | null = rig.controller.snapshot().lastBlock;
    expect(block?.chainId).toBe(1);
    expect(block?.blockers).toEqual([2]);
    expect(rig.sfx.count('block')).toBe(1);
    expect(rig.sfx.count('heart')).toBe(1);
    expect(rig.session.state.hearts).toBe(2);
  });

  it('막힘 표시는 그 사슬이 제거될 때까지 잔존한다 (§3.5 · PZL-108)', () => {
    const rig = makeRun([blockedRig()]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(1000);
    rig.controller.tick();
    expect(rig.controller.snapshot().lastBlock).not.toBeNull();
    expect(rig.controller.snapshot().chains.find((c) => c.id === 1)?.state).toBe('blocked');
  });

  it('포커스가 없으면 거부음이 난다', () => {
    const rig = makeRun([openBoard(1)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick(); // 보드가 비어 포커스가 사라진다
    rig.sfx.clear();
    rig.controller.handle('BUTTON1');
    expect(rig.sfx.count('reject')).toBe(1);
  });
});

describe('§4.2 보드 전환 0.8초 — 그동안에도 타이머가 흐른다', () => {
  function clearedRig(): Rig {
    const rig = makeRun([openBoard(1), openBoard(2)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick(); // 클리어 정산 + 전환 시작
    return rig;
  }

  it('클리어 정산이 보고되고 전환 상태로 들어간다', () => {
    const rig = makeRun([openBoard(1), openBoard(2)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    const report: RunTickReport = rig.controller.tick();
    expect(report.settlement).toBeDefined();
    expect(rig.controller.snapshot().transitioning).toBe(true);
  });

  it('오입력·힌트 0 보드는 퍼펙트 사운드가 난다 (§5.4)', () => {
    const rig = clearedRig();
    expect(rig.sfx.count('perfect')).toBe(1);
    expect(rig.sfx.count('clear')).toBe(0);
  });

  it('0.8초 직전에는 아직 다음 보드로 넘어가지 않는다 (경계값)', () => {
    const rig = clearedRig();
    rig.clock.advance(BOARD_TRANSITION_MS - 1);
    expect(rig.controller.tick().boardAdvancedTo).toBeUndefined();
    expect(rig.controller.snapshot().boardNumber).toBe(1);
  });

  it('0.8초에 다음 보드를 적재한다 (경계값)', () => {
    const rig = clearedRig();
    rig.clock.advance(BOARD_TRANSITION_MS);
    expect(rig.controller.tick().boardAdvancedTo).toBe(2);
    expect(rig.controller.snapshot().boardNumber).toBe(2);
    expect(rig.controller.snapshot().transitioning).toBe(false);
  });

  it('전환 0.8초 동안 런 타이머가 정확히 800ms 줄어든다', () => {
    const rig = clearedRig();
    const before = rig.controller.snapshot().timeRemainingMs;
    rig.clock.advance(BOARD_TRANSITION_MS);
    rig.controller.tick();
    expect(before - rig.controller.snapshot().timeRemainingMs).toBe(BOARD_TRANSITION_MS);
  });

  it('전환 중 당기기는 코어가 NOT_RUNNING으로 거부해 상태가 깨지지 않는다', () => {
    const rig = clearedRig();
    rig.controller.handle('BUTTON1');
    expect(rig.session.state.hearts).toBe(3);
    expect(rig.controller.snapshot().removing).toEqual([]);
  });

  it('새 보드에서 포커스·힌트·버퍼가 초기화된다', () => {
    const rig = clearedRig();
    rig.clock.advance(BOARD_TRANSITION_MS);
    rig.controller.tick();
    expect(rig.controller.focus).toBe(2); // openBoard(2)의 가장 아래
    expect(rig.controller.snapshot().hint.state).toBe('READY');
    expect(rig.controller.snapshot().lastBlock).toBeNull();
  });

  it('타이머·하트·콤보는 보드가 바뀌어도 유지된다 (SES-201·202 회귀 확인)', () => {
    const rig = clearedRig();
    const before = rig.controller.snapshot();
    rig.clock.advance(BOARD_TRANSITION_MS);
    rig.controller.tick();
    const after = rig.controller.snapshot();
    expect(after.hearts).toBe(before.hearts);
    expect(after.timeRemainingMs).toBeLessThan(before.timeRemainingMs);
  });
});

describe('§3.8 자동 보정 — 화면 상태가 깨지지 않는다', () => {
  it('교착 보드에서 보정 대상이 removing 목록에 나타난다', () => {
    const rig = makeRun([deadlockBoard()]);
    rig.controller.start(1);
    const snap = rig.controller.snapshot();
    expect(snap.removing.length).toBe(1);
    expect(snap.removing[0].chainId).toBe(2); // 저장 깊이가 얕은 쪽
  });

  it('보정 대상은 포커스에서 빠지고 남은 사슬이 포커스가 된다', () => {
    const rig = makeRun([deadlockBoard()]);
    rig.controller.start(1);
    expect(rig.controller.focus).toBe(1);
  });

  it('보정 제거가 완료돼도 점수·하트가 변하지 않는다', () => {
    const rig = makeRun([deadlockBoard()]);
    rig.controller.start(1);
    const before = rig.session.state;
    rig.clock.advance(1000);
    rig.controller.tick();
    const after = rig.session.state;
    expect(after.hearts).toBe(before.hearts);
    expect(after.displayScore).toBe(before.displayScore);
    expect(rig.controller.snapshot().removing).toEqual([]);
  });
});

describe('BUTTON2 — 힌트 (CTL-009 · HNT-506)', () => {
  it('힌트가 소비되면 코어 사용 횟수가 1 오르고 사슬은 그대로다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON2');
    expect(rig.session.state.hintUsesThisBoard).toBe(1);
    expect(rig.sfx.count('hint')).toBe(1);
    expect(rig.controller.snapshot().chainsLeft).toBe(3); // 힌트는 사슬을 제거하지 않는다
  });

  it('힌트 대상이 스냅샷에 표시된다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON2');
    expect(rig.controller.snapshot().chains.filter((c) => c.isHint).length).toBe(1);
  });

  it('힌트는 포커스를 옮기지 않는다 (HNT-505)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    const before = rig.controller.focus;
    rig.controller.handle('BUTTON2');
    expect(rig.controller.focus).toBe(before);
  });

  it('쿨다운 중 재입력은 소비되지 않는다 (HNT-504)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON2');
    rig.clock.advance(3000);
    rig.controller.tick();
    rig.controller.handle('BUTTON2');
    expect(rig.session.state.hintUsesThisBoard).toBe(1);
  });

  it('안전수가 없으면 소비하지 않고 거부음만 난다 (HNT-506)', () => {
    // 보드가 비고 잠금이 풀린 전환 구간이 "안전수 0 · 미잠금"의 실제 도달 지점이다
    const rig = makeRun([openBoard(1), openBoard(2)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick();
    rig.sfx.clear();
    rig.controller.handle('BUTTON2');
    expect(rig.sfx.count('reject')).toBe(1);
    expect(rig.session.state.hintUsesThisBoard).toBe(0);
  });
});

describe('§4.7 미니 튜토리얼 제한 모드', () => {
  function tutorialRig(): Rig {
    const rig = makeRun([tutorialBoard()]);
    rig.controller.start(0, tutorialBoard());
    rig.controller.setTutorial({ onlyChain: TUTORIAL_CHAIN_SAFE });
    return rig;
  }

  it('지정 안전수가 포커스 상태로 시작한다', () => {
    const rig = tutorialRig();
    expect(rig.controller.focus).toBe(TUTORIAL_CHAIN_SAFE);
    expect(rig.controller.isTutorial).toBe(true);
    expect(rig.controller.snapshot().tutorial).toBe(true);
  });

  it('지정 사슬에 대한 BUTTON1은 정상 성공한다', () => {
    const rig = tutorialRig();
    rig.controller.handle('BUTTON1');
    expect(rig.controller.snapshot().removing.length).toBe(1);
  });

  it('그 밖의 사슬에 대한 BUTTON1은 아무 반응도 하지 않는다 (하트 불변)', () => {
    const rig = tutorialRig();
    rig.controller.handle('LEFT'); // 막힌 사슬로 포커스 이동
    expect(rig.controller.focus).toBe(TUTORIAL_CHAIN_BLOCKED);
    rig.controller.handle('BUTTON1');
    expect(rig.session.state.hearts).toBe(3);
    expect(rig.controller.snapshot().removing).toEqual([]);
  });

  it('BUTTON2는 무효다 (§2.4)', () => {
    const rig = tutorialRig();
    rig.controller.handle('BUTTON2');
    expect(rig.session.state.hintUsesThisBoard).toBe(0);
    expect(rig.sfx.count('hint')).toBe(0);
  });

  it('pause 중에는 런 타이머가 멈춘다 (SES-210)', () => {
    const rig = tutorialRig();
    rig.controller.pause();
    const before = rig.controller.snapshot().timeRemainingMs;
    rig.clock.advance(5000);
    rig.controller.tick();
    expect(rig.controller.snapshot().timeRemainingMs).toBe(before);
    rig.controller.resume();
    rig.clock.advance(1000);
    rig.controller.tick();
    expect(rig.controller.snapshot().timeRemainingMs).toBe(before - 1000);
  });
});

describe('런 종료와 컨티뉴', () => {
  it('외부 종료가 즉시 반영된다 (§2.7 5분 무입력)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.endRun('external');
    expect(rig.controller.ended).toEqual({ reason: 'external' });
  });

  it('이미 끝난 런은 다시 끝나지 않는다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.endRun('external');
    rig.controller.endRun('time');
    expect(rig.controller.ended).toEqual({ reason: 'external' });
  });

  it('컨티뉴하면 하트·시간이 회복되고 종료 상태가 풀린다 (§4.5)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.clock.advance(30000);
    rig.controller.tick();
    rig.controller.endRun('external');
    expect(rig.controller.continueRun()).toBe(true);
    expect(rig.controller.ended).toBeNull();
    expect(rig.controller.snapshot().hearts).toBe(3);
    expect(rig.controller.snapshot().timeRemainingMs).toBe(120000);
    expect(rig.controller.snapshot().continueCount).toBe(1);
  });

  it('보드 배치가 그대로 보존된다 (SES-208)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick();
    rig.controller.endRun('external');
    rig.controller.continueRun();
    expect(rig.controller.snapshot().chainsLeft).toBe(2);
  });

  it('종료 상태에서는 보드가 넘어가지 않는다', () => {
    const rig = makeRun([openBoard(1), openBoard(2)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick(); // 클리어 + 전환 시작
    rig.controller.endRun('external');
    rig.clock.advance(BOARD_TRANSITION_MS);
    expect(rig.controller.tick().boardAdvancedTo).toBeUndefined();
  });

  it('dispose 후에는 버퍼가 코어를 건드리지 않는다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.dispose();
    expect(() => rig.controller.dispose()).not.toThrow();
  });
});

/** 초기 포커스가 막힌 사슬이 되도록 배치한 보드 (대표점 x가 더 작다) */
function blockedRig(): Board {
  return new Board({
    chains: [
      createChain(1, [p(1, 9), p(2, 9)], 1),
      createChain(2, [p(6, 8), p(6, 9), p(6, 10)], 0),
    ],
    boardNumber: 1,
    seed: 'blocked-rig',
  });
}

describe('§9.3 사운드 큐 — 무음 스텁이 이름 목록 안에서만 발화한다 (작업 계획 P-8)', () => {
  it('한 판에서 난 소리가 전부 SFX_NAMES에 있다', () => {
    const rig = makeRun([blockedRig(), openBoard(2)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1'); // 막힘
    rig.controller.handle('RIGHT');
    rig.controller.handle('BUTTON2'); // 힌트
    rig.controller.handle('BUTTON1'); // 성공
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick();
    const played: readonly SfxName[] = rig.sfx.log;
    expect(played.length).toBeGreaterThan(0);
    for (const name of played) expect(SFX_NAMES).toContain(name);
  });
});

describe('제거 후 포커스 · 버퍼 통합', () => {
  it('버퍼에 쌓인 입력이 잠금 해제 시 순차 판정된다', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1'); // 사슬 3 제거 개시 → 포커스는 §2.2 규칙대로 이동
    const focusAfter = rig.controller.focus;
    rig.controller.handle('BUTTON1'); // 버퍼 적재 (대상 = 이동한 포커스)
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick();
    expect(rig.controller.snapshot().removing[0]?.chainId).toBe(focusAfter);
  });

  it('버퍼 적재 후 레버로 포커스를 옮기면 취소되고 하트가 그대로다 (Q-1)', () => {
    const rig = makeRun([openBoard(3)]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1');
    rig.controller.handle('BUTTON1');
    rig.controller.handle('UP'); // 포커스 변경 → 버퍼 취소
    rig.clock.advance(SLIDE_MS);
    rig.controller.tick();
    expect(rig.controller.snapshot().removing).toEqual([]);
    expect(rig.session.state.hearts).toBe(3);
  });
});

describe('사슬 상태가 스냅샷에 그대로 실린다 (§9.1 상태색 4종)', () => {
  it('normal · blocked · removing이 구분된다', () => {
    const rig = makeRun([blockedRig()]);
    rig.controller.start(1);
    rig.controller.handle('BUTTON1'); // 사슬 1 막힘
    const states = new Map<ChainId, string>(
      rig.controller.snapshot().chains.map((c) => [c.id, c.state])
    );
    expect(states.get(1)).toBe('blocked');
    expect(states.get(2)).toBe('normal');
    rig.controller.handle('RIGHT');
    rig.controller.handle('BUTTON1');
    expect(rig.controller.snapshot().chains.find((c) => c.id === 2)?.state).toBe('removing');
  });
});
