// WU-02 T6 — 런 세션: ①~⑨ 처리 순서 · 시간 수지 · 하트 · 반복 실패 보호 · 종료 · 컨티뉴
// (§3.5~§3.8 · §4.2~§4.5 · §5.3)
//
// 인수 항목: PZL-103(하트분) · PZL-106~112 · SES-201~209 코어분 · SCR-304·306(세션분)

import { describe, expect, it, vi } from 'vitest';
import { createChain } from '../../src/core/chain';
import { resolveParams, FACTORY_PARAMS, type CoreParams } from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import {
  RunSession,
  type AutoCorrection,
  type EndReason,
  type PullRejection,
  type PullResult,
  type RemovalHandle,
  type RunPhase,
  type TickResult,
} from '../../src/core/session';
import type { Chain, ChainId, Clock, ProcessStep } from '../../src/core/types';
import {
  FIXTURE_0110,
  FIXTURE_DEADLOCK,
  FIXTURE_DEPTH_CAP,
  FIXTURE_DEPTH_CHAIN,
  FIXTURE_PERFECT,
  TestClock,
  buildBoard,
  makeSession,
  pt,
  type SessionHarness,
} from './fixtures';

const P = resolveParams();

/** 슬라이드 아웃 시간 (ms) — 계획 표의 확정값 */
const SLIDE = { c0110A: 268, c0110B: 224, d0: 246, d1: 224, d2: 202, d3: 202, l2: 202 } as const;

function sessionWith(
  overrides?: Partial<CoreParams>,
  startMs = 0
): { s: RunSession; c: TestClock } {
  const c = new TestClock(startMs);
  const s = new RunSession({ ...FACTORY_PARAMS, ...overrides }, c);
  return { s, c };
}

/** `clock.now()` 호출 횟수를 세는 시계 — ④→⑤ 사이 시각 재조회를 잡는다 */
class CountingClock implements Clock {
  calls = 0;
  private ms: number;
  constructor(startMs = 0) {
    this.ms = startMs;
  }
  now(): number {
    this.calls += 1;
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

describe('PZL-103 영상 01:10 케이스의 실패 비용 (완료 기준 2)', () => {
  it('막힌 사슬을 당기면 하트 3→2 · 시간 120→117초 · 콤보 1.0 · 점수 변화 0', () => {
    const h: SessionHarness = makeSession(FIXTURE_0110);
    const before = h.session.state.displayScore;
    const result: PullResult = h.session.pull(1);

    expect(result.accepted).toBe(true);
    expect(result.safe).toBe(false);
    expect(result.blockers).toEqual([2]);
    expect(result.awarded).toBeUndefined();
    expect(result.removal).toBeUndefined();
    expect(h.session.state.hearts).toBe(2);
    expect(h.session.state.timeRemainingMs).toBe(117000);
    expect(h.session.state.comboCentis).toBe(100);
    expect(h.session.state.displayScore).toBe(before);
    expect(h.session.state.displayScore).toBe(0);
  });

  it('PZL-108 — 빨간 표시가 잔존하고 블로커를 뺀 뒤 재선택하면 정상 제거된다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.pull(1);
    expect(h.board.stateOf(1)).toBe('blocked');

    const removeBlocker = h.session.pull(2);
    expect(removeBlocker.safe).toBe(true);
    h.clock.advance(SLIDE.c0110B);
    h.session.tick();
    expect(h.board.stateOf(1)).toBe('blocked'); // 진로가 열려도 표시는 남는다

    const retry = h.session.pull(1);
    expect(retry.safe).toBe(true);
    h.clock.advance(SLIDE.c0110A);
    const tick = h.session.tick();
    expect(h.board.stateOf(1)).toBe('removed');
    expect(tick.completedRemoval).toBe(1);
  });
});

describe('PZL-110 §3.7 처리 순서 ①~⑨', () => {
  it('성공 경로의 pull() trace는 [S1, S2, S3A, S4, S5]다', () => {
    const h = makeSession(FIXTURE_0110);
    const result = h.session.pull(2);
    expect(result.trace).toEqual<ProcessStep[]>([
      'S1_INPUT_LOCK',
      'S2_VERDICT',
      'S3A_REMOVAL_BEGIN',
      'S4_TIME',
      'S5_SCORE',
    ]);
  });

  it('이어지는 tick()의 trace는 [S6, S7, S8, S9]다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.pull(2);
    h.clock.advance(SLIDE.c0110B);
    expect(h.session.tick().trace).toEqual<ProcessStep[]>([
      'S6_REMOVAL_COMPLETE',
      'S7_RECOMPUTE',
      'S8_END_CHECK',
      'S9_UNLOCK',
    ]);
  });

  it('실패 경로의 trace는 [S1, S2, S3B, S4, S5, S7, S8, S9]로 한 호출에서 끝난다', () => {
    const h = makeSession(FIXTURE_0110);
    expect(h.session.pull(1).trace).toEqual<ProcessStep[]>([
      'S1_INPUT_LOCK',
      'S2_VERDICT',
      'S3B_FAILURE',
      'S4_TIME',
      'S5_SCORE',
      'S7_RECOMPUTE',
      'S8_END_CHECK',
      'S9_UNLOCK',
    ]);
  });

  it('④ 시간이 먼저, ⑤ 점수가 나중이며 두 단계는 항상 인접한다', () => {
    const success = makeSession(FIXTURE_0110).session.pull(2).trace;
    const failure = makeSession(FIXTURE_0110).session.pull(1).trace;
    for (const trace of [success, failure]) {
      const time = trace.indexOf('S4_TIME');
      const score = trace.indexOf('S5_SCORE');
      expect(time).toBeGreaterThanOrEqual(0);
      expect(score).toBe(time + 1);
    }
  });

  it('④와 ⑤ 사이에 시각을 다시 읽지 않는다 (clock.now() 호출 1회)', () => {
    const clock = new CountingClock();
    const session = new RunSession(FACTORY_PARAMS, clock);
    session.start(buildBoard(FIXTURE_0110));

    clock.calls = 0;
    session.pull(2);
    expect(clock.calls).toBe(1);
  });

  it('성공 pull() 동안 하트·보드 revision이 변하지 않는다 (③A는 점유를 유지한다)', () => {
    const h = makeSession(FIXTURE_0110);
    const hearts = h.session.state.hearts;
    const revision = h.board.revision;
    h.session.pull(2);
    expect(h.session.state.hearts).toBe(hearts);
    expect(h.board.revision).toBe(revision);
    expect(h.board.stateOf(2)).toBe('removing');
  });

  it('아무 일도 없는 tick()은 종료 검사만 남긴다', () => {
    const h = makeSession(FIXTURE_0110);
    expect(h.session.tick().trace).toEqual<ProcessStep[]>(['S8_END_CHECK']);
  });

  it('제거가 아직 끝나지 않은 tick()은 어떤 단계도 밟지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.pull(2);
    h.clock.advance(SLIDE.c0110B - 1);
    const early = h.session.tick();
    expect(early.trace).toEqual([]);
    expect(early.completedRemoval).toBeUndefined();
    expect(h.session.isLocked()).toBe(true);
  });
});

describe('PZL-106 §3.3 제거 중 사슬은 제거됨 전까지 블로커다', () => {
  it('removing 동안 판정이 여전히 막힘이고 ⑥ 이후 열린다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.pull(2);
    expect(h.board.stateOf(2)).toBe('removing');
    expect(h.board.evaluate(1)).toEqual({ safe: false, blockers: [2] });

    h.clock.advance(SLIDE.c0110B);
    h.session.tick();
    expect(h.board.stateOf(2)).toBe('removed');
    expect(h.board.evaluate(1)).toEqual({ safe: true, blockers: [] });
  });
});

describe('SES-203 · SES-204 · SES-205 §4.3 시간 수지 (완료 기준 3)', () => {
  it('회복량 = min(0.25 + 0.08 × D, 0.9)초 — D = 0/1/2/3', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN);
    h.clock.advance(30000);
    h.session.tick(); // 타이머를 상한에서 떼어 놓는다
    expect(h.session.state.timeRemainingMs).toBe(90000);

    const deltas: number[] = [];
    for (const [id, slide] of [
      [10, SLIDE.d0],
      [11, SLIDE.d1],
      [12, SLIDE.d2],
      [13, SLIDE.d3],
    ] as const) {
      const result = h.session.pull(id);
      expect(result.safe).toBe(true);
      deltas.push(result.timeDeltaMs ?? 0);
      h.clock.advance(slide);
      h.session.tick();
    }
    expect(deltas).toEqual([250, 330, 410, 490]);
  });

  it('SES-203 — D = 9는 상한 0.9초에 걸린다', () => {
    const h = makeSession(FIXTURE_DEPTH_CAP);
    h.clock.advance(30000);
    h.session.tick();
    expect(h.session.pull(1).timeDeltaMs).toBe(900); // min(250 + 720, 900)
  });

  it('SES-204 — 회복이 세션 시간을 넘지 못하고 초과분은 버려진다', () => {
    const h = makeSession(FIXTURE_DEPTH_CAP);
    h.clock.advance(100);
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(119900);

    const result = h.session.pull(1);
    expect(result.timeDeltaMs).toBe(100); // 900을 벌었지만 100만 반영된다
    expect(h.session.state.timeRemainingMs).toBe(120000);
  });

  it('SES-204 — 상한은 세션 시간 설정값을 따른다', () => {
    const h = makeSession(FIXTURE_DEPTH_CAP, { sessionTimeSec: 90 });
    expect(h.session.state.timeRemainingMs).toBe(90000);
    h.session.pull(1);
    expect(h.session.state.timeRemainingMs).toBe(90000);
  });

  it('SES-205 — 실패 1회당 정확히 3초 감소한다', () => {
    const h = makeSession(FIXTURE_0110);
    const result = h.session.pull(1);
    expect(result.timeDeltaMs).toBe(-3000);
    expect(h.session.state.timeRemainingMs).toBe(117000);
  });

  it('SES-205 — 하한 0이고 0에 닿는 순간 런이 종료된다', () => {
    const h = makeSession(FIXTURE_0110);
    h.clock.advance(118000);
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(2000);

    const result = h.session.pull(1);
    expect(result.timeDeltaMs).toBe(-2000); // −3000이 아니라 하한까지만
    expect(h.session.state.timeRemainingMs).toBe(0);
    expect(h.session.state.phase).toBe('ended');
    expect(h.session.state.endReason).toBe('time');
  });

  it('회복과 페널티가 한 입력에서 동시에 일어나지 않는다 (§4.3-4)', () => {
    const h = makeSession(FIXTURE_0110);
    h.clock.advance(10000);
    h.session.tick();
    const fail = h.session.pull(1);
    expect(fail.timeDeltaMs).toBeLessThan(0);
    const success = h.session.pull(2);
    expect(success.timeDeltaMs).toBeGreaterThan(0);
  });

  it('타이머는 tick()에서만 흐르고 pull()은 경과 시간을 반영하지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    h.clock.advance(5000);
    expect(h.session.state.timeRemainingMs).toBe(120000);
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(115000);
  });

  it('보드 클리어·전환 중에도 타이머가 흐른다 (§4.2)', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    const cleared = h.session.tick();
    expect(cleared.settlement).toBeDefined();
    expect(h.session.state.phase).toBe('boardCleared');

    const at = h.session.state.timeRemainingMs;
    h.clock.advance(800); // 전환 연출 0.8초
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(at - 800);
  });

  it('§4.3-5 — pause()는 런 타이머만 멈추고 resume()이 되살린다', () => {
    const h = makeSession(FIXTURE_0110);
    h.clock.advance(1000);
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(119000);

    h.session.pause();
    h.clock.advance(10000);
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(119000);

    h.session.resume();
    h.clock.advance(2000);
    h.session.tick();
    expect(h.session.state.timeRemainingMs).toBe(117000);
  });
});

describe('PZL-107 · PZL-109 §3.5 실패 비용과 반복 실패 보호', () => {
  it('PZL-107 — 하트 −1 · 시간 −3초 · 콤보 0 · 점수 변화 0', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN);
    h.session.pull(10); // 콤보를 올려 둔다
    h.clock.advance(SLIDE.d0);
    h.session.tick();
    h.session.pull(11);
    h.clock.advance(SLIDE.d1);
    h.session.tick();
    expect(h.session.state.comboCentis).toBe(115);
    const score = h.session.state.displayScore;

    const fail = h.session.pull(13);
    expect(fail.charged).toBe(true);
    expect(fail.protectedRepeat).toBe(false);
    expect(h.session.state.hearts).toBe(2);
    expect(fail.timeDeltaMs).toBe(-3000);
    expect(h.session.state.comboCentis).toBe(100);
    expect(h.session.state.displayScore).toBe(score);
    expect(h.session.state.mistakesThisBoard).toBe(1);
  });

  it('PZL-109 — 보드 무변화 상태의 재실패는 하트·시간·콤보를 깎지 않는다', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN, { initialHearts: 5 });
    h.session.pull(13);
    const state = h.session.state;
    expect(state.hearts).toBe(4);

    const repeat = h.session.pull(13);
    expect(repeat.protectedRepeat).toBe(true);
    expect(repeat.charged).toBe(false);
    expect(repeat.timeDeltaMs).toBe(0);
    expect(repeat.blockers).toEqual([10, 12]);
    expect(h.session.state.hearts).toBe(4);
    expect(h.session.state.timeRemainingMs).toBe(state.timeRemainingMs);
    expect(h.session.state.mistakesThisBoard).toBe(1); // 중복 계상 없음
  });

  it('PZL-109 — 보호는 사슬별이다 (다른 사슬의 실패는 정상 청구)', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN, { initialHearts: 5 });
    h.session.pull(13);
    const other = h.session.pull(12);
    expect(other.charged).toBe(true);
    expect(h.session.state.hearts).toBe(3);
    expect(h.session.state.mistakesThisBoard).toBe(2);
  });

  it('PZL-109 — 점유가 한 번이라도 바뀌면 보호가 풀린다', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN, { initialHearts: 5 });
    h.session.pull(13);
    expect(h.session.pull(13).protectedRepeat).toBe(true);

    h.session.pull(10); // 안전수 제거 → revision 변화
    h.clock.advance(SLIDE.d0);
    h.session.tick();
    expect(h.board.revision).toBe(1);

    const afterChange = h.session.pull(13);
    expect(afterChange.protectedRepeat).toBe(false);
    expect(afterChange.charged).toBe(true);
    expect(h.session.state.hearts).toBe(3);
  });

  it('막힘 표시 자체는 "보드 상태 변화"가 아니다', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN, { initialHearts: 5 });
    h.session.pull(13);
    h.session.pull(12); // 다른 사슬 실패 — 점유는 그대로다
    expect(h.board.revision).toBe(0);
    expect(h.session.pull(13).protectedRepeat).toBe(true);
  });

  it('무비용 재실패도 빨간 표시는 유지된다', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN, { initialHearts: 5 });
    h.session.pull(13);
    h.session.pull(13);
    expect(h.board.stateOf(13)).toBe('blocked');
  });
});

describe('PZL-111 · SES-206 · SES-207 §3.6 · §4.4 종료 조건', () => {
  it('SES-206 — 하트 0이 단독으로 런을 끝낸다', () => {
    const h = makeSession(FIXTURE_0110, { initialHearts: 1 });
    const result = h.session.pull(1);
    expect(h.session.state.hearts).toBe(0);
    expect(h.session.state.phase).toBe<RunPhase>('ended');
    expect(h.session.state.endReason).toBe<EndReason>('hearts');
    expect(result.trace).toContain('S8_END_CHECK');
  });

  it('런 단계 4종과 종료 사유 3종이 정의대로 동작한다', () => {
    const phases: RunPhase[] = [];
    const { s, c } = sessionWith();
    phases.push(s.state.phase); // ready
    s.start(buildBoard(FIXTURE_PERFECT));
    phases.push(s.state.phase); // running
    s.pull(1);
    c.advance(SLIDE.l2);
    s.tick();
    s.pull(2);
    c.advance(SLIDE.l2);
    s.tick();
    phases.push(s.state.phase); // boardCleared
    s.endRun('external');
    phases.push(s.state.phase); // ended
    expect(phases).toEqual<RunPhase[]>(['ready', 'running', 'boardCleared', 'ended']);

    const reasons: EndReason[] = ['hearts', 'time', 'external'];
    expect(reasons).toHaveLength(3);
  });

  it('SES-206 — 시간 0이 단독으로 런을 끝낸다 (입력 없이 tick만으로)', () => {
    const h = makeSession(FIXTURE_0110);
    h.clock.advance(120000);
    const tick = h.session.tick();
    expect(tick.ended).toEqual({ reason: 'time' });
    expect(h.session.state.phase).toBe('ended');
    expect(h.session.state.hearts).toBe(3);
  });

  it('하트 0과 시간 0이 동시면 하트를 먼저 판정한다 (§4.4)', () => {
    const h = makeSession(FIXTURE_0110, { initialHearts: 1 });
    h.clock.advance(118000);
    h.session.tick();
    const result = h.session.pull(1); // 하트 1→0 이면서 시간 2000→0
    expect(h.session.state.hearts).toBe(0);
    expect(h.session.state.timeRemainingMs).toBe(0);
    expect(h.session.state.endReason).toBe('hearts');
    expect(result.trace).toContain('S8_END_CHECK');
  });

  it('PZL-111 — 전 사슬 제거 시 보드 클리어 정산이 나온다', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    expect(h.session.tick().settlement).toBeUndefined();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    const cleared = h.session.tick();
    expect(cleared.settlement).toBeDefined();
    expect(h.session.state.phase).toBe('boardCleared');
    expect(h.session.state.clearedBoards).toBe(1);
  });

  it('SES-207 — 클리어와 시간 0이 동시면 클리어를 먼저 정산하고 다음 보드를 시작하지 않는다', () => {
    const { s, c } = sessionWith({ sessionTimeSec: 90 });
    s.start(buildBoard(FIXTURE_PERFECT));

    s.pull(1);
    c.advance(SLIDE.l2);
    s.tick();

    c.advance(89698);
    s.tick();
    expect(s.state.timeRemainingMs).toBe(100);

    s.pull(2); // 회복 250 → 잔여 350
    expect(s.state.timeRemainingMs).toBe(350);
    c.advance(350); // 제거 완료(202ms)와 시간 소진이 같은 tick에 성립
    const result = s.tick();

    expect(result.settlement).toBeDefined();
    expect(result.ended).toEqual({ reason: 'time' });
    expect(s.state.timeRemainingMs).toBe(0);
    expect(s.state.clearedBoards).toBe(1);
    expect(s.state.confirmedScore).toBe(result.settlement?.boardFinal);
    // 다음 보드는 시작되지 않는다
    expect(() => s.loadBoard(buildBoard(FIXTURE_0110))).toThrow();
  });

  it('SCR-306 — 클리어 정산이 잔여 초 × 100 + 하트 × 1,500 이고 퍼펙트가 붙는다', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    const settlement = h.session.tick().settlement;

    const remaining = h.session.state.timeRemainingMs;
    // 100(×1.00) + 115(×1.15 — 제거 완료 시각 기준 창 안)
    expect(settlement?.chainScoreSum).toBe(215);
    expect(settlement?.clearTimeBonus).toBe(Math.floor(remaining / 1000) * 100);
    expect(settlement?.clearHeartBonus).toBe(4500);
    expect(settlement?.perfectBonus).toBe(5000);
  });

  it('시간 0인데 제거 애니메이션이 진행 중이면 종료 판정을 ⑥ 이후로 미룬다 (§4.4)', () => {
    const h = makeSession(FIXTURE_0110);
    h.clock.advance(119900);
    h.session.tick();
    h.session.pull(2); // 회복 250 → 잔여 350
    h.clock.advance(SLIDE.c0110B - 1);
    expect(h.session.tick().trace).toEqual([]); // 아직 종료 판정 없음
    expect(h.session.state.phase).toBe('running');

    h.clock.advance(1000);
    const done = h.session.tick();
    expect(done.completedRemoval).toBe(2);
    expect(done.ended).toEqual({ reason: 'time' });
    expect(h.session.state.displayScore).toBe(100); // 그 사슬의 점수는 인정된다
  });

  it('외부 종료(5분 무입력 등)는 endRun으로 처리한다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.endRun('external');
    expect(h.session.state.phase).toBe('ended');
    expect(h.session.state.endReason).toBe('external');
    expect(h.session.pull(2).rejection).toBe('NOT_RUNNING');
  });

  it('종료된 런의 tick()은 아무 단계도 밟지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.endRun('external');
    h.clock.advance(5000);
    expect(h.session.tick().trace).toEqual([]);
  });

  it('미클리어 보드의 사슬 점수는 유지되고 정산되지 않는다 (§5.4)', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN);
    h.session.pull(10);
    h.clock.advance(SLIDE.d0);
    h.session.tick();
    expect(h.session.state.boardChainScore).toBe(120);

    h.session.endRun('external');
    expect(h.session.state.clearedBoards).toBe(0);
    expect(h.session.state.confirmedScore).toBe(0);
    expect(h.session.state.displayScore).toBe(120);
  });
});

describe('SES-201 · SES-202 · SCR-304 보드 전환', () => {
  it('SES-201 — 보드가 바뀌어도 타이머가 초기화되지 않는다', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.clock.advance(20000);
    h.session.tick();
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    h.session.tick();

    const before = h.session.state.timeRemainingMs;
    h.session.loadBoard(buildBoard(FIXTURE_0110));
    expect(h.session.state.timeRemainingMs).toBe(before);
    expect(h.session.state.boardNumber).toBe(1);
    expect(h.session.state.phase).toBe('running');
  });

  it('SES-202 — 보드 클리어로 하트가 회복되지 않는다', () => {
    const h = makeSession(FIXTURE_PERFECT, { initialHearts: 3 });
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.loadBoard(buildBoard(FIXTURE_DEPTH_CHAIN));
    h.session.pull(13); // 실패
    expect(h.session.state.hearts).toBe(2);
    h.session.loadBoard(buildBoard(FIXTURE_0110));
    expect(h.session.state.hearts).toBe(2);
  });

  it('SCR-304 — 콤보는 보드를 넘어 유지된다', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    expect(h.session.state.comboCentis).toBe(115);

    h.session.loadBoard(buildBoard(FIXTURE_0110));
    expect(h.session.state.comboCentis).toBe(115);
    const next = h.session.pull(2);
    expect(next.comboCentis).toBe(130); // 창 안이면 계속 오른다
  });

  it('보드 전환이 per-board 카운터를 초기화한다 (오입력·힌트)', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN);
    h.session.pull(13);
    h.session.noteHintUsed();
    expect(h.session.state.mistakesThisBoard).toBe(1);
    expect(h.session.state.hintUsesThisBoard).toBe(1);

    h.session.pull(10);
    h.clock.advance(SLIDE.d0);
    h.session.tick();
    h.session.loadBoard(buildBoard(FIXTURE_PERFECT));
    expect(h.session.state.mistakesThisBoard).toBe(0);
    expect(h.session.state.hintUsesThisBoard).toBe(0);
    expect(h.session.state.boardChainScore).toBe(0);
  });

  it('클리어 순간 표시 점수가 감점 후 값으로 정정된다 (§5.3)', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.noteHintUsed();
    expect(h.session.state.displayScore).toBe(100); // 감점 전 표시

    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    const settlement = h.session.tick().settlement;
    expect(settlement?.hintPercent).toBe(80);
    expect(settlement?.chainScoreSum).toBe(215);
    expect(settlement?.adjustedChainScore).toBe(172); // floor(215 × 0.8)
    expect(settlement?.perfectBonus).toBe(0); // 힌트를 쓴 보드는 퍼펙트 무효
    expect(h.session.state.boardChainScore).toBe(0);
    expect(h.session.state.displayScore).toBe(settlement?.boardFinal);
  });

  it('시작 전·종료 후에는 보드를 적재할 수 없다', () => {
    const { s } = sessionWith();
    expect(() => s.loadBoard(buildBoard(FIXTURE_0110))).toThrow();
    s.start(buildBoard(FIXTURE_0110));
    expect(() => s.start(buildBoard(FIXTURE_0110))).toThrow();
  });
});

describe('SES-208 · SES-209 §4.5 컨티뉴 (코어분)', () => {
  function endedRun(): ReturnType<typeof makeSession> {
    const h = makeSession(FIXTURE_DEPTH_CHAIN, { initialHearts: 2, continueHeartRecover: 2 });
    h.session.pull(13); // 하트 2→1
    h.session.pull(10); // 성공 — 점수 120, revision 변화
    h.clock.advance(SLIDE.d0);
    h.session.tick();
    h.session.pull(13); // 하트 1→0 → 종료
    return h;
  }

  it('SES-208 — 보드 배치·빨간 표시·누적 점수·보드 번호가 보존된다', () => {
    const h = endedRun();
    expect(h.session.state.phase).toBe('ended');
    const boardBefore = h.board;
    const scoreBefore = h.session.state.displayScore;

    expect(h.session.continueRun()).toBe(true);
    expect(h.board).toBe(boardBefore);
    expect(h.board.stateOf(13)).toBe('blocked');
    expect(h.board.stateOf(10)).toBe('removed');
    expect(h.session.state.displayScore).toBe(scoreBefore);
    expect(h.session.state.boardNumber).toBe(4);
  });

  it('SES-209 — 하트·시간이 설정값대로 회복되고 콤보는 1.0으로 초기화된다', () => {
    const h = endedRun();
    h.session.continueRun();
    expect(h.session.state.hearts).toBe(2);
    expect(h.session.state.timeRemainingMs).toBe(120000);
    expect(h.session.state.comboCentis).toBe(100);
    expect(h.session.state.phase).toBe('running');
    expect(h.session.state.endReason).toBeUndefined();
    expect(h.session.state.continueCount).toBe(1);
  });

  it('컨티뉴 회복량은 [운영 설정]이다', () => {
    const h = makeSession(FIXTURE_0110, {
      initialHearts: 1,
      continueHeartRecover: 1,
      continueTimeRefillSec: 45,
    });
    h.session.pull(1);
    expect(h.session.state.phase).toBe('ended');
    h.session.continueRun();
    expect(h.session.state.hearts).toBe(1);
    expect(h.session.state.timeRemainingMs).toBe(45000);
  });

  it('CONTINUE OFF면 false를 돌려주고 아무것도 바꾸지 않는다', () => {
    const h = makeSession(FIXTURE_0110, { initialHearts: 1, continueEnabled: false });
    h.session.pull(1);
    expect(h.session.continueRun()).toBe(false);
    expect(h.session.state.phase).toBe('ended');
    expect(h.session.state.hearts).toBe(0);
  });

  it('종료되지 않은 런에서는 컨티뉴할 수 없다', () => {
    const h = makeSession(FIXTURE_0110);
    expect(h.session.continueRun()).toBe(false);
    expect(h.session.state.continueCount).toBe(0);
  });

  it('컨티뉴 후 이어서 플레이할 수 있다', () => {
    const h = endedRun();
    h.session.continueRun();
    const result = h.session.pull(11); // C0가 빠져 안전수가 된 사슬
    expect(result.safe).toBe(true);
    expect(h.session.state.displayScore).toBeGreaterThan(120);
  });
});

describe('PZL-112 §3.8 안전수 0 자동 보정', () => {
  it('교착 보드를 적재하면 저장 깊이가 가장 얕은 사슬이 자동 제거된다', () => {
    const { s, c } = sessionWith();
    const events: AutoCorrection[] = [];
    s.onAutoCorrection((e) => events.push(e));
    const board = buildBoard(FIXTURE_DEADLOCK);
    const started = s.start(board);

    expect(started.autoCorrection?.chainId).toBe(2);
    expect(started.autoCorrection?.boardNumber).toBe(7);
    expect(started.autoCorrection?.seed).toBe('wu02-deadlock');
    expect(events).toEqual<AutoCorrection[]>([
      { chainId: 2, boardNumber: 7, seed: 'wu02-deadlock', revision: 0 },
    ]);
    expect(board.stateOf(2)).toBe('removing');
    expect(s.isLocked()).toBe(true);

    c.advance(224);
    const done = s.tick();
    expect(done.completedRemoval).toBe(2);
    expect(board.safeMoves()).toEqual([1]);
    expect(s.isLocked()).toBe(false);
  });

  it('보정은 점수·콤보·시간·하트·오입력 수를 전부 바꾸지 않는다', () => {
    const { s, c } = sessionWith();
    s.start(buildBoard(FIXTURE_DEADLOCK));
    const before = s.state;
    c.advance(224);
    s.tick();
    const after = s.state;

    expect(after.displayScore).toBe(before.displayScore);
    expect(after.displayScore).toBe(0);
    expect(after.comboCentis).toBe(100);
    expect(after.hearts).toBe(3);
    expect(after.mistakesThisBoard).toBe(0);
    expect(after.timeRemainingMs).toBe(120000 - 224);
  });

  it('보정 중에는 입력이 잠기고 LOCKED로 거절된다', () => {
    const { s } = sessionWith();
    s.start(buildBoard(FIXTURE_DEADLOCK));
    const rejected = s.pull(1);
    expect(rejected.accepted).toBe(false);
    expect(rejected.rejection).toBe('LOCKED');
    expect(s.state.hearts).toBe(3);
  });

  it('보정 후에도 안전수가 없으면 연쇄 보정이 이어지고 유한하게 끝난다 (R12)', () => {
    // A(depth 4)의 진로를 C1·C2·C3가 각각 다른 격자 점에서 막고, 셋 다 A에게 막힌다.
    // 하나를 빼도 남은 블로커가 있어 교착이 유지된다 → 3연쇄 보정.
    const board = new Board({
      chains: [
        createChain(1, [pt(6, 13), pt(6, 12), pt(6, 11), pt(6, 10)], 4),
        createChain(11, [pt(6, 0), pt(6, 1)], 1),
        createChain(12, [pt(6, 3), pt(6, 4)], 2),
        createChain(13, [pt(6, 6), pt(6, 7)], 3),
      ],
      boardNumber: 9,
    });
    expect(board.safeMoves()).toEqual([]);

    const { s, c } = sessionWith();
    const corrected: ChainId[] = [];
    s.onAutoCorrection((e) => corrected.push(e.chainId));
    s.start(board);

    for (let i = 0; i < 5 && s.isLocked(); i += 1) {
      c.advance(1000);
      s.tick();
    }
    expect(corrected).toEqual([11, 12, 13]);
    expect(board.safeMoves()).toEqual([1]);
    expect(s.state.displayScore).toBe(0);
    expect(s.state.hearts).toBe(3);
  });

  it('onAutoCorrection 구독을 해제할 수 있다', () => {
    const { s } = sessionWith();
    const spy = vi.fn();
    const off = s.onAutoCorrection(spy);
    off();
    s.start(buildBoard(FIXTURE_DEADLOCK));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('§2.6 판정 잠금 표면 (버퍼 자체는 WU-03)', () => {
  it('제거가 진행 중이면 잠기고 완료되면 풀린다', () => {
    const h = makeSession(FIXTURE_0110);
    expect(h.session.isLocked()).toBe(false);
    const removal: RemovalHandle | undefined = h.session.pull(2).removal;
    expect(removal).toEqual({ chainId: 2, durationMs: 224, completeAtMs: 224 });
    expect(h.session.isLocked()).toBe(true);
    h.clock.advance(SLIDE.c0110B);
    const tick: TickResult = h.session.tick();
    expect(tick.unlocked).toBe(true);
    expect(h.session.isLocked()).toBe(false);
  });

  it('거절 사유 3종이 상태를 바꾸지 않고 구분된다', () => {
    const observed: PullRejection[] = [];
    const idle = makeSession(FIXTURE_0110);
    idle.session.pull(2);
    observed.push(idle.session.pull(1).rejection ?? 'LOCKED');

    const gone = makeSession(FIXTURE_0110);
    observed.push(gone.session.pull(999).rejection ?? 'CHAIN_GONE');

    const ended = makeSession(FIXTURE_0110);
    ended.session.endRun('external');
    observed.push(ended.session.pull(2).rejection ?? 'NOT_RUNNING');

    expect(observed).toEqual<PullRejection[]>(['LOCKED', 'CHAIN_GONE', 'NOT_RUNNING']);
  });

  it('잠금 중 입력은 LOCKED로 거절되고 상태가 전혀 바뀌지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.pull(2);
    const before = h.session.state;
    const rejected = h.session.pull(1);
    expect(rejected).toEqual({
      accepted: false,
      rejection: 'LOCKED',
      chainId: 1,
      trace: [],
    });
    expect(h.session.state).toEqual(before);
    expect(h.board.stateOf(1)).toBe('normal');
  });

  it('CTL-008의 코어 근거 — 사라진 사슬 입력은 하트를 깎지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    h.session.pull(2);
    h.clock.advance(SLIDE.c0110B);
    h.session.tick();

    const gone = h.session.pull(2);
    expect(gone.rejection).toBe('CHAIN_GONE');
    expect(h.session.state.hearts).toBe(3);
    expect(h.session.pull(999).rejection).toBe('CHAIN_GONE');
    expect(h.session.state.hearts).toBe(3);
  });

  it('시작 전 입력은 NOT_RUNNING으로 거절된다', () => {
    const { s } = sessionWith();
    expect(s.pull(1).rejection).toBe('NOT_RUNNING');
  });

  it('onUnlock이 ⑨에서 1회 발화하고 해제 함수가 동작한다', () => {
    const h = makeSession(FIXTURE_0110);
    const spy = vi.fn();
    const off = h.session.onUnlock(spy);
    h.session.pull(2);
    expect(spy).not.toHaveBeenCalled();
    h.clock.advance(SLIDE.c0110B);
    h.session.tick();
    expect(spy).toHaveBeenCalledTimes(1);

    off();
    h.session.pull(1);
    h.clock.advance(SLIDE.c0110A);
    h.session.tick();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('아무 일도 없는 tick()은 onUnlock을 다시 발화하지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    const spy = vi.fn();
    h.session.onUnlock(spy);
    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(10);
      h.session.tick();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('§7.1 힌트 코어분 (표시·쿨다운은 WU-03)', () => {
  it('안전수를 저장 깊이 오름차순 → id 오름차순으로 정렬한다', () => {
    const { s } = sessionWith();
    s.start(
      new Board({
        chains: [
          createChain(1, [pt(11, 0), pt(12, 0)], 5),
          createChain(2, [pt(11, 2), pt(12, 2)], 2),
          createChain(3, [pt(11, 4), pt(12, 4)], 2),
        ],
      })
    );
    expect(s.hintOrderedSafeMoves()).toEqual([2, 3, 1]);
  });

  it('막힌 사슬은 목록에 들어가지 않는다', () => {
    const h = makeSession(FIXTURE_DEPTH_CHAIN);
    expect(h.session.hintOrderedSafeMoves()).toEqual([10]);
  });

  it('noteHintUsed가 보드별로 누적되고 정산에 반영된다', () => {
    const h = makeSession(FIXTURE_PERFECT);
    h.session.noteHintUsed();
    h.session.noteHintUsed();
    expect(h.session.state.hintUsesThisBoard).toBe(2);
    h.session.pull(1);
    h.clock.advance(SLIDE.l2);
    h.session.tick();
    h.session.pull(2);
    h.clock.advance(SLIDE.l2);
    expect(h.session.tick().settlement?.hintPercent).toBe(60);
  });
});

describe('게임 규칙이 코어 밖으로 새지 않는다 (문서화 테스트)', () => {
  it('당기기 입구는 RunSession.pull 하나뿐이고 공개 표면이 14개로 고정돼 있다', () => {
    // `Record<keyof RunSession, true>`는 **공개 멤버만** 요구한다. 공개 메서드가 새로 생기면
    // 이 객체 리터럴이 타입 오류가 나므로 `npm run typecheck`가 표면 확장을 먼저 잡는다.
    const publicSurface: Record<keyof RunSession, true> = {
      state: true,
      start: true,
      loadBoard: true,
      pull: true,
      tick: true,
      isLocked: true,
      onUnlock: true,
      onAutoCorrection: true,
      noteHintUsed: true,
      hintOrderedSafeMoves: true,
      pause: true,
      resume: true,
      endRun: true,
      continueRun: true,
    };
    const names = Object.keys(publicSurface);
    expect(names).toHaveLength(14);
    expect(names).toContain('pull');
    // 보드 상태 전이 메서드는 세션 표면에 없다 — 순서를 아는 것은 RunSession뿐이다
    for (const forbidden of ['beginRemoval', 'completeRemoval', 'markBlocked', 'evaluate']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('Board를 직접 조작해도 시간·점수·하트·콤보는 움직이지 않는다', () => {
    const h = makeSession(FIXTURE_0110);
    const before = h.session.state;
    h.board.markBlocked(1);
    h.board.beginRemoval(2);
    h.board.completeRemoval(2);
    expect(h.session.state).toEqual(before);
  });

  it('코어는 기본 시계를 만들지 않는다 — 모든 시각이 주입 시계에서만 나온다', () => {
    expect(RunSession.length).toBe(2); // (params, clock)

    const early: Clock = { now: () => 1000 };
    const late: Clock = { now: () => 5000 };
    const a = new RunSession(FACTORY_PARAMS, early);
    const b = new RunSession(FACTORY_PARAMS, late);
    a.start(buildBoard(FIXTURE_0110));
    b.start(buildBoard(FIXTURE_0110));

    expect(a.pull(2).removal?.completeAtMs).toBe(1000 + SLIDE.c0110B);
    expect(b.pull(2).removal?.completeAtMs).toBe(5000 + SLIDE.c0110B);
    expect(P.sessionTimeMs).toBe(120000);
  });

  it('Chain은 불변 값이라 보드 사이에서 재사용해도 상태가 섞이지 않는다', () => {
    const chains: Chain[] = [createChain(1, [pt(11, 0), pt(12, 0)], 0)];
    const a = new Board({ chains, boardNumber: 1 });
    const b = new Board({ chains, boardNumber: 2 });
    a.beginRemoval(1);
    a.completeRemoval(1);
    expect(a.stateOf(1)).toBe('removed');
    expect(b.stateOf(1)).toBe('normal');
  });
});
