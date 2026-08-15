// §7.1·§7.2 힌트 — HNT-501~506 (작업 계획 §6)
//
// 감점 **값** 판정(×0.8 / ×0.6 / ×0.4)은 코어 소관이라 WU-02 `score.test.ts`가 이미 고정했다.
// 여기서는 WU-03 분담분만 본다: 대상 선정·표시 수명·쿨다운·소비 횟수·하트/시간 불변.

import { describe, it, expect } from 'vitest';
import {
  HintController,
  pickHintTarget,
  type HintContext,
  type HintOptions,
  type HintRejection,
  type HintRequestResult,
  type HintState,
} from '../../src/game/hint';
import { HINT_COOLDOWN_MS, HINT_DISPLAY_MS } from '../../src/game/timing';
import type { ChainId } from '../../src/core/types';
import { TestClock, openBoard, startedSession } from './harness';

interface Candidate {
  readonly id: ChainId;
  readonly depth: number;
  readonly distance: number;
}

function ctxOf(candidates: readonly Candidate[], locked = false): HintContext {
  // 코어 계약대로 **깊이 오름차순 → id 오름차순**으로 정렬해서 넘긴다
  const sorted = [...candidates].sort((a, b) =>
    a.depth === b.depth ? a.id - b.id : a.depth - b.depth
  );
  const byId = new Map(sorted.map((c) => [c.id, c]));
  const need = (id: ChainId): Candidate => {
    const c = byId.get(id);
    if (c === undefined) throw new Error(`후보 아님: ${id}`);
    return c;
  };
  return {
    candidates: sorted.map((c) => c.id),
    locked,
    depthOf: (id) => need(id).depth,
    distanceTo: (id) => need(id).distance,
  };
}

const NONE = ctxOf([]);

describe('HNT-501 — 표시 대상 선정 (§7.1)', () => {
  it('안전수 중 의존 깊이가 가장 얕은 사슬을 고른다', () => {
    const target = pickHintTarget(
      ctxOf([
        { id: 1, depth: 3, distance: 0 },
        { id: 2, depth: 0, distance: 4 },
        { id: 3, depth: 1, distance: 0 },
      ])
    );
    expect(target).toBe(2);
  });

  it('깊이가 동률이면 포커스에서 조작 수가 가장 적은 사슬을 고른다 (Q-3)', () => {
    const target = pickHintTarget(
      ctxOf([
        { id: 1, depth: 0, distance: 3 },
        { id: 2, depth: 0, distance: 1 },
        { id: 3, depth: 0, distance: 2 },
      ])
    );
    expect(target).toBe(2);
  });

  it('깊이와 조작 수가 모두 동률이면 id가 작은 사슬을 고른다', () => {
    const target = pickHintTarget(
      ctxOf([
        { id: 9, depth: 0, distance: 2 },
        { id: 4, depth: 0, distance: 2 },
        { id: 7, depth: 0, distance: 2 },
      ])
    );
    expect(target).toBe(4);
  });

  it('후보가 없으면 null이다', () => {
    expect(pickHintTarget(NONE)).toBeNull();
  });

  it('같은 후보 집합을 20회 물어도 같은 답이 나온다 (결정성)', () => {
    const ctx = ctxOf([
      { id: 5, depth: 1, distance: 1 },
      { id: 6, depth: 1, distance: 1 },
      { id: 8, depth: 0, distance: 6 },
    ]);
    for (let i = 0; i < 20; i += 1) expect(pickHintTarget(ctx)).toBe(8);
  });
});

describe('HNT-502 — 표시 시간과 조기 해제', () => {
  it('소비 직후 SHOWING이고 대상이 보인다', () => {
    const hint = new HintController();
    const res: HintRequestResult = hint.request(1000, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(res).toEqual({ used: true, targetId: 3 });
    expect(hint.view(1000).state).toBe<HintState>('SHOWING');
    expect(hint.view(1000)).toEqual({
      state: 'SHOWING',
      targetId: 3,
      cooldownLeftMs: HINT_COOLDOWN_MS,
    });
  });

  it('2.5초 직전까지는 계속 보인다', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(hint.view(HINT_DISPLAY_MS - 1).state).toBe('SHOWING');
  });

  it('2.5초에 정확히 해제된다 (경계값)', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(hint.view(HINT_DISPLAY_MS).state).toBe('COOLDOWN');
    expect(hint.view(HINT_DISPLAY_MS).targetId).toBeNull();
  });

  it('tick이 만료를 확정한다', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    hint.tick(HINT_DISPLAY_MS, new Set([3]));
    expect(hint.view(HINT_DISPLAY_MS).targetId).toBeNull();
  });

  it('대상 사슬이 사라지면 표시 시간이 남아 있어도 즉시 해제된다', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    hint.tick(500, new Set([1, 2]));
    expect(hint.view(500).state).toBe('COOLDOWN');
    expect(hint.view(500).targetId).toBeNull();
  });

  it('조기 해제해도 쿨다운은 소비 시점 기준 5초를 유지한다 (§7.2 N5d)', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    hint.tick(500, new Set());
    expect(hint.view(500).cooldownLeftMs).toBe(HINT_COOLDOWN_MS - 500);
    expect(hint.view(HINT_COOLDOWN_MS).state).toBe('READY');
  });

  it('표시 대상이 없을 때 tick은 아무 일도 하지 않는다', () => {
    const hint = new HintController();
    expect(() => hint.tick(100, new Set())).not.toThrow();
    expect(hint.view(100).state).toBe('READY');
  });
});

describe('HNT-504 — 쿨다운 (§7.2 N5d)', () => {
  it('표시가 끝나도 5초까지는 COOLDOWN이다', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(hint.view(HINT_COOLDOWN_MS - 1).state).toBe('COOLDOWN');
    expect(hint.view(HINT_COOLDOWN_MS - 1).cooldownLeftMs).toBe(1);
  });

  it('5초에 정확히 READY로 돌아온다 (경계값)', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(hint.view(HINT_COOLDOWN_MS).state).toBe('READY');
    expect(hint.view(HINT_COOLDOWN_MS).cooldownLeftMs).toBe(0);
  });

  it('쿨다운 중 입력은 소비되지 않고 쿨다운을 늘리지도 않는다', () => {
    const hint = new HintController();
    const ctx = ctxOf([{ id: 3, depth: 0, distance: 0 }]);
    hint.request(0, ctx);
    const res = hint.request(3000, ctx);
    expect(res.used).toBe(false);
    expect(res.rejection).toBe<HintRejection>('COOLDOWN');
    expect(hint.view(3000).cooldownLeftMs).toBe(HINT_COOLDOWN_MS - 3000);
    expect(hint.useCount).toBe(1);
  });

  it('표시 중 재입력은 새로 소비하지 않는다 (§7.1)', () => {
    const hint = new HintController();
    const ctx = ctxOf([{ id: 3, depth: 0, distance: 0 }]);
    hint.request(0, ctx);
    const res = hint.request(1000, ctx);
    expect(res.rejection).toBe<HintRejection>('ALREADY_SHOWING');
    expect(hint.useCount).toBe(1);
  });

  it('쿨다운이 끝나면 다시 소비된다', () => {
    const hint = new HintController();
    const ctx = ctxOf([{ id: 3, depth: 0, distance: 0 }]);
    hint.request(0, ctx);
    expect(hint.request(HINT_COOLDOWN_MS, ctx).used).toBe(true);
    expect(hint.useCount).toBe(2);
  });

  it('옵션으로 표시·쿨다운 시간을 바꿀 수 있다 (§11.4 운영 설정 대비)', () => {
    const opts: HintOptions = { displayMs: 1000, cooldownMs: 2000 };
    const hint = new HintController(opts);
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(hint.view(1000).state).toBe('COOLDOWN');
    expect(hint.view(2000).state).toBe('READY');
  });

  it('reset은 표시와 쿨다운을 함께 비운다 (보드 전환)', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    hint.reset();
    expect(hint.view(0)).toEqual({ state: 'READY', targetId: null, cooldownLeftMs: 0 });
  });
});

describe('HNT-506 — 안전수 0 · 잠금 중 입력', () => {
  it('안전수가 없으면 소비하지 않는다', () => {
    const hint = new HintController();
    const res = hint.request(0, NONE);
    expect(res.used).toBe(false);
    expect(res.rejection).toBe<HintRejection>('NO_SAFE_MOVE');
    expect(hint.useCount).toBe(0);
    expect(hint.view(0).state).toBe('READY');
  });

  it('판정 잠금 중 입력은 버려지고 쿨다운도 소비하지 않는다 (§2.6)', () => {
    const hint = new HintController();
    const res = hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }], true));
    expect(res.rejection).toBe<HintRejection>('LOCKED');
    expect(hint.view(0).state).toBe('READY');
  });

  it('잠금 판정이 표시 중 판정보다 먼저다', () => {
    const hint = new HintController();
    hint.request(0, ctxOf([{ id: 3, depth: 0, distance: 0 }]));
    expect(hint.request(100, ctxOf([{ id: 3, depth: 0, distance: 0 }], true)).rejection).toBe(
      'LOCKED'
    );
  });
});

describe('HNT-503 (WU-03 분담분) — 하트·시간·점수가 변하지 않는다', () => {
  it('힌트 소비가 세션 상태를 건드리지 않고 사용 횟수만 1 올린다', () => {
    const clock = new TestClock(0);
    const session = startedSession(openBoard(3), clock);
    const before = session.state;

    const hint = new HintController();
    const res = hint.request(0, ctxOf([{ id: 1, depth: 0, distance: 0 }]));
    if (res.used) session.noteHintUsed();

    const after = session.state;
    expect(after.hearts).toBe(before.hearts);
    expect(after.timeRemainingMs).toBe(before.timeRemainingMs);
    expect(after.displayScore).toBe(before.displayScore);
    expect(after.comboCentis).toBe(before.comboCentis);
    expect(after.hintUsesThisBoard).toBe(1);
  });

  it('거부된 힌트는 사용 횟수를 올리지 않는다', () => {
    const clock = new TestClock(0);
    const session = startedSession(openBoard(3), clock);
    const hint = new HintController();
    const res = hint.request(0, NONE);
    if (res.used) session.noteHintUsed();
    expect(session.state.hintUsesThisBoard).toBe(0);
  });

  it('소비 횟수와 noteHintUsed 호출 횟수가 같다 (3회 시나리오)', () => {
    const clock = new TestClock(0);
    const session = startedSession(openBoard(3), clock);
    const hint = new HintController();
    const ctx = ctxOf([{ id: 1, depth: 0, distance: 0 }]);
    let now = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = hint.request(now, ctx);
      if (res.used) session.noteHintUsed();
      now += HINT_COOLDOWN_MS / 2; // 절반은 쿨다운에 걸린다
    }
    expect(hint.useCount).toBe(3);
    expect(session.state.hintUsesThisBoard).toBe(hint.useCount);
  });
});

describe('HNT-505 — 힌트는 포커스를 옮기거나 사슬을 제거하지 않는다', () => {
  it('HintController는 포커스를 읽기만 하고 쓰지 않는다 (표면에 setter가 없다)', () => {
    const hint = new HintController();
    expect(Object.keys(hint)).not.toContain('focus');
    expect('setFocus' in hint).toBe(false);
  });

  it('힌트를 소비해도 보드 사슬 수가 그대로다', () => {
    const clock = new TestClock(0);
    const board = openBoard(3);
    const session = startedSession(board, clock);
    const hint = new HintController();
    const res = hint.request(0, ctxOf([{ id: 1, depth: 0, distance: 0 }]));
    if (res.used) session.noteHintUsed();
    expect(board.activeChains().length).toBe(3);
    expect(board.stateOf(1)).toBe('normal');
  });
});
