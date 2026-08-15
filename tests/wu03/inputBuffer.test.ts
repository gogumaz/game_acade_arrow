// §2.6 입력 버퍼·판정 잠금 — CTL-007 · CTL-008 · CTL-010 (작업 계획 §5)
//
// 취소 경로는 "`pull` 미호출"이 아니라 **`session.state.hearts` 불변**으로 단언한다
// (구현 우회 방지 — 작업 계획 §11.2-3). 스파이 호출 수는 보조 단언이다.

import { describe, it, expect } from 'vitest';
import { createChain } from '../../src/core/chain';
import { Board } from '../../src/core/puzzle';
import { RunSession, type PullResult } from '../../src/core/session';
import type { ChainId, GridPoint, InputAction } from '../../src/core/types';
import {
  BUFFER_CAPACITY,
  PullBuffer,
  filterSimultaneous,
  type BufferedPull,
  type PullBufferStats,
  type PullTarget,
} from '../../src/game/inputBuffer';
import { TestClock, openBoard, startedSession } from './harness';

/** 길이 2 사슬의 슬라이드 아웃 = `180 + 1 × 22 = 202`ms (§3.4 · 공장값) */
const SLIDE_MS = 202;

function p(x: number, y: number): GridPoint {
  return { x, y };
}

interface Rig {
  readonly board: Board;
  readonly session: RunSession;
  readonly clock: TestClock;
  readonly buffer: PullBuffer;
  readonly pulls: ChainId[];
  readonly results: PullResult[];
  focus: ChainId | null;
}

function rigOf(board: Board): Rig {
  const clock = new TestClock(0);
  const session = startedSession(board, clock);
  const pulls: ChainId[] = [];
  const results: PullResult[] = [];
  const rig = {
    board,
    session,
    clock,
    pulls,
    results,
    focus: board.activeChains()[0].id as ChainId | null,
  } as Rig;

  const target: PullTarget = {
    isLocked: () => session.isLocked(),
    pull: (id) => {
      pulls.push(id);
      return session.pull(id);
    },
    onUnlock: (fn) => session.onUnlock(fn),
  };
  const alive = (id: ChainId): boolean => {
    if (board.chain(id) === undefined) return false;
    const state = board.stateOf(id);
    return state === 'normal' || state === 'blocked';
  };
  (rig as { buffer: PullBuffer }).buffer = new PullBuffer(
    target,
    () => rig.focus,
    alive,
    (r) => results.push(r)
  );
  return rig;
}

/** 안전 사슬 1개 + 「막힌 사슬 ↔ 블로커」 쌍 — 실패 경로 재진입 시나리오용 (§5.3) */
const SAFE_LOCKER: ChainId = 5;
const ALWAYS_BLOCKED: ChainId = 1;
const WALL: ChainId = 2;

function failBoard(): Board {
  return new Board({
    chains: [
      createChain(ALWAYS_BLOCKED, [p(1, 9), p(2, 9)], 1),
      createChain(WALL, [p(6, 8), p(6, 9), p(6, 10)], 0),
      createChain(SAFE_LOCKER, [p(11, 0), p(12, 0)], 0),
    ],
    boardNumber: 1,
    seed: 'fail',
  });
}

describe('press — 즉시 판정과 적재의 분기 (§2.6)', () => {
  it('잠겨 있지 않으면 즉시 판정한다', () => {
    const rig = rigOf(openBoard(4));
    expect(rig.buffer.press(0)).toBe('EXECUTED');
    expect(rig.pulls).toEqual([1]);
  });

  it('포커스가 없으면 아무것도 하지 않는다', () => {
    const rig = rigOf(openBoard(4));
    rig.focus = null;
    expect(rig.buffer.press(0)).toBe('NO_FOCUS');
    expect(rig.pulls).toEqual([]);
  });

  it('판정 중이면 적재한다', () => {
    const rig = rigOf(openBoard(4));
    rig.buffer.press(0);
    rig.focus = 2;
    expect(rig.buffer.press(10)).toBe('BUFFERED');
    expect(rig.pulls).toEqual([1]);
  });

  it('버퍼는 입력 시점의 사슬 ID와 시각을 기억한다 (§2.6 버퍼 대상)', () => {
    const rig = rigOf(openBoard(4));
    rig.buffer.press(0);
    rig.focus = 3;
    rig.buffer.press(77);
    const expected: readonly BufferedPull[] = [{ chainId: 3, atMs: 77 }];
    expect(rig.buffer.pending).toEqual(expected);
  });

  it('pending은 복사본이라 외부에서 큐를 못 바꾼다', () => {
    const rig = rigOf(openBoard(4));
    rig.buffer.press(0);
    rig.focus = 2;
    rig.buffer.press(10);
    const snapshot = rig.buffer.pending;
    expect(rig.buffer.pending).not.toBe(snapshot); // 매번 새 배열
    (snapshot as unknown as unknown[]).length = 0;
    expect(rig.buffer.pending.length).toBe(1);
  });
});

describe('CTL-007 — 판정 중 입력이 최대 2개까지 쌓이고 3번째는 버려진다', () => {
  it('BUFFERED · BUFFERED · DROPPED 순으로 응답한다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1); // 버퍼를 거치지 않고 잠금만 만든다
    rig.focus = 2;
    expect(rig.buffer.press(1)).toBe('BUFFERED');
    expect(rig.buffer.press(2)).toBe('BUFFERED');
    expect(rig.buffer.press(3)).toBe('DROPPED');
    expect(rig.buffer.pending.length).toBe(BUFFER_CAPACITY);
  });

  it('버려진 입력은 통계로만 남고 판정되지 않는다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.buffer.press(2);
    rig.buffer.press(3);
    rig.buffer.press(4);
    const stats: PullBufferStats = rig.buffer.stats;
    expect(stats.dropped).toBe(2);
    expect(stats.buffered).toBe(2);
    expect(rig.pulls).toEqual([]);
  });

  it('버퍼 용량은 정확히 2다', () => {
    expect(BUFFER_CAPACITY).toBe(2);
  });
});

describe('순차 판정 — 앞선 제거가 완료된 시점의 보드 상태로 (§2.6)', () => {
  it('잠금이 풀리면 앞에서부터 하나씩 판정한다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.buffer.press(2);

    rig.clock.advance(SLIDE_MS);
    rig.session.tick(); // ⑥⑦⑧⑨ → 소진 시작
    expect(rig.pulls).toEqual([2]); // 첫 항목만 실행되고 다시 잠긴다
    expect(rig.buffer.pending.length).toBe(1);
  });

  it('두 번째 항목은 다음 잠금 해제에서 처리된다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.buffer.press(2);

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.buffer.pending.length).toBe(0);
  });
});

describe('CTL-008 — 불리한 상태 변경에서 취소하고 하트를 차감하지 않는다', () => {
  it('대상 사슬이 이미 제거됐으면 취소한다 (하트 불변)', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.buffer.press(2); // 둘 다 사슬 2를 겨눈다

    rig.clock.advance(SLIDE_MS);
    rig.session.tick(); // 첫 항목이 사슬 2를 제거 개시
    rig.clock.advance(SLIDE_MS);
    rig.session.tick(); // 사슬 2 제거 완료 → 두 번째 항목은 대상이 사라졌다

    expect(rig.buffer.stats.cancelled).toBe(1);
    expect(rig.pulls).toEqual([2]); // 취소된 입력에서는 pull 자체를 부르지 않는다
    expect(rig.session.state.hearts).toBe(3);
  });

  it('제거 중(removing)인 사슬도 취소 대상이다', () => {
    const rig = rigOf(openBoard(4));
    rig.buffer.press(0); // 사슬 1 제거 개시 (removing)
    rig.focus = 1; // 버퍼 대상도 사슬 1
    rig.buffer.press(1);

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.buffer.stats.cancelled).toBe(1);
    expect(rig.session.state.hearts).toBe(3);
  });

  it('취소돼도 다음 항목은 정상 판정된다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 1; // 이미 제거 중인 사슬을 겨눈 항목
    rig.buffer.press(1);
    rig.buffer.press(2);

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.buffer.stats.cancelled).toBe(2);
    expect(rig.session.state.hearts).toBe(3);
  });
});

describe('CTL-008b — 레버로 포커스를 옮기면 버퍼 입력이 취소된다 (작업 계획 Q-1)', () => {
  it('판정 시점의 포커스가 버퍼 대상과 다르면 취소하고 하트를 차감하지 않는다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.focus = 3; // 레버는 잠금과 무관하게 즉시 반영된다 (§2.6 포커스 이동)

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.buffer.stats.cancelled).toBe(1);
    expect(rig.pulls).toEqual([]);
    expect(rig.session.state.hearts).toBe(3);
  });

  it('포커스를 원래대로 되돌려 놓으면 취소되지 않는다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.focus = 3;
    rig.focus = 2;

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.buffer.stats.cancelled).toBe(0);
    expect(rig.pulls).toEqual([2]);
  });
});

describe('§5.3 실패 경로 재진입 — onUnlock이 호출 스택 안에서 발화한다', () => {
  it('버퍼 2개가 모두 실패 사슬을 가리켜도 재귀 없이 순차 처리된다', () => {
    const rig = rigOf(failBoard());
    rig.focus = SAFE_LOCKER;
    rig.buffer.press(0); // 안전 사슬을 당겨 잠금을 만든다
    rig.focus = ALWAYS_BLOCKED;
    rig.buffer.press(1);
    rig.buffer.press(2);

    rig.clock.advance(SLIDE_MS);
    rig.session.tick(); // 잠금 해제 → 실패 2건이 스택 안에서 연달아 발생한다

    expect(rig.pulls).toEqual([SAFE_LOCKER, ALWAYS_BLOCKED, ALWAYS_BLOCKED]);
    expect(rig.buffer.pending.length).toBe(0);
    expect(rig.buffer.stats.executed).toBe(3);
  });

  it('반복 실패 보호가 살아 있어 하트는 1개만 줄어든다 (§3.5)', () => {
    const rig = rigOf(failBoard());
    rig.focus = SAFE_LOCKER;
    rig.buffer.press(0);
    rig.focus = ALWAYS_BLOCKED;
    rig.buffer.press(1);
    rig.buffer.press(2);

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.session.state.hearts).toBe(2);
    expect(rig.results.filter((r) => r.protectedRepeat === true).length).toBe(1);
  });

  it('실패 결과가 호출자에게 그대로 전달된다 (막힘 연출 입력)', () => {
    const rig = rigOf(failBoard());
    rig.focus = ALWAYS_BLOCKED;
    rig.buffer.press(0);
    expect(rig.results.length).toBe(1);
    expect(rig.results[0].safe).toBe(false);
    expect(rig.results[0].blockers).toEqual([WALL]);
  });
});

describe('clear · dispose', () => {
  it('clear는 대기 입력을 버린다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.buffer.clear();
    expect(rig.buffer.pending.length).toBe(0);
  });

  it('dispose 후에는 잠금이 풀려도 소진하지 않는다', () => {
    const rig = rigOf(openBoard(4));
    rig.session.pull(1);
    rig.focus = 2;
    rig.buffer.press(1);
    rig.buffer.dispose();

    rig.clock.advance(SLIDE_MS);
    rig.session.tick();
    expect(rig.pulls).toEqual([]);
  });

  it('dispose를 두 번 불러도 안전하다', () => {
    const rig = rigOf(openBoard(4));
    rig.buffer.dispose();
    expect(() => rig.buffer.dispose()).not.toThrow();
  });
});

describe('CTL-010 — 같은 프레임 동시 입력에서 BUTTON1만 소비된다 (§2.4)', () => {
  const cases: readonly (readonly [readonly InputAction[], readonly InputAction[]])[] = [
    [['BUTTON1', 'BUTTON2'], ['BUTTON1']],
    [['BUTTON2', 'BUTTON1'], ['BUTTON1']],
    [['BUTTON2', 'BUTTON1', 'BUTTON2'], ['BUTTON1']],
    [['BUTTON2'], ['BUTTON2']],
    [
      ['BUTTON1', 'BUTTON1'],
      ['BUTTON1', 'BUTTON1'],
    ],
    [
      ['UP', 'BUTTON2'],
      ['UP', 'BUTTON2'],
    ],
    [
      ['UP', 'BUTTON1', 'BUTTON2', 'DOWN'],
      ['UP', 'BUTTON1', 'DOWN'],
    ],
    [[], []],
  ];

  it.each(cases)('%j → %j', (input, expected) => {
    expect(filterSimultaneous(input)).toEqual(expected);
  });

  it('입력 배열을 제자리에서 고치지 않는다', () => {
    const input: InputAction[] = ['BUTTON1', 'BUTTON2'];
    filterSimultaneous(input);
    expect(input).toEqual(['BUTTON1', 'BUTTON2']);
  });
});
