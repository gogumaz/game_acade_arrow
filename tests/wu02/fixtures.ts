// WU-02 퍼즐 코어 — 수제 픽스처 5종 + 테스트 도구.
//
// 이 파일은 `*.test.ts`가 아니므로 Vitest가 수집하지 않는다(테스트 0건).
// 좌표표는 작업 계획 §4.3·§5의 기계 검증본을 그대로 전사한 것이며, 값이 바뀌면
// `puzzle.test.ts`의 픽스처 정합 테스트가 즉시 잡는다 (R11).
//
// 절차 생성기(WU-08)가 없는 유닛이므로 보드는 전부 손으로 적는다.

import { createChain } from '../../src/core/chain';
import {
  FACTORY_PARAMS,
  resolveParams,
  type CoreParams,
  type ResolvedParams,
} from '../../src/core/params';
import { Board } from '../../src/core/puzzle';
import { RunSession } from '../../src/core/session';
import type { Chain, ChainId, Clock, GridPoint } from '../../src/core/types';

/** `[x, y]` 축약 표기 — 좌표표를 표 그대로 읽히게 한다 */
export type PointTuple = readonly [number, number];

export interface FixtureChain {
  readonly id: ChainId;
  /** `P0 → 머리` 순서 */
  readonly points: readonly PointTuple[];
  /** 생성 확정 의존 깊이 (§6.1 · §5.1) */
  readonly depth: number;
}

export interface Fixture {
  readonly name: string;
  readonly boardNumber: number;
  readonly seed: string;
  readonly chains: readonly FixtureChain[];
  /**
   * `dependencyDepths(초기 보드)`가 표의 저장 `depth`와 일치해야 하는가.
   * `FIXTURE_DEPTH_CAP`(합성 깊이 9)과 `FIXTURE_DEADLOCK`(순환이라 실시간 깊이 미정의)은
   * 일부러 어긋나 있어 정합 검사 대상이 아니다.
   */
  readonly depthConsistent: boolean;
}

export function pt(x: number, y: number): GridPoint {
  return { x, y };
}

/**
 * 영상 01:10 케이스 (§3.3 · PZL-103 · 완료 기준 2).
 *
 * | 사슬 | id | 격자 점 (P0 → 머리) | L | B | 머리 방향 | depth |
 * |---|---:|---|---:|---:|---|---:|
 * | A (ㄱ자, 화살촉 `←`) | 1 | (8,7) (8,8) (8,9) (7,9) (6,9) | 5 | 1 | LEFT | 1 |
 * | B (세로 사슬)        | 2 | (3,7) (3,8) (3,9)             | 3 | 0 | DOWN | 0 |
 *
 * `R(A)`는 행 9의 수평 진로이고 B는 x=3의 **세로** 사슬이다. 공유 선분은 0개이고 격자 점
 * (3,9) 하나에서만 겹친다 — 선분만 검사하는 구현은 이 배치를 "안전수"로 오판한다.
 */
export const FIXTURE_0110: Fixture = {
  name: 'FIXTURE_0110',
  boardNumber: 1,
  seed: 'wu02-0110',
  depthConsistent: true,
  chains: [
    {
      id: 1,
      points: [
        [8, 7],
        [8, 8],
        [8, 9],
        [7, 9],
        [6, 9],
      ],
      depth: 1,
    },
    {
      id: 2,
      points: [
        [3, 7],
        [3, 8],
        [3, 9],
      ],
      depth: 0,
    },
  ],
};

/**
 * 의존 깊이 0·1·2·3과 "블로커 2개 중 최댓값" 분기 (§6.1 축 2).
 *
 * | 사슬 | id | 격자 점 | L | B | 방향 | 블로커 | depth |
 * |---|---:|---|---:|---:|---|---|---:|
 * | C0 | 10 | (5,0) (5,1) (5,2) (5,3) | 4 | 0 | DOWN  | 없음          | 0 |
 * | C1 | 11 | (1,1) (2,1) (3,1)       | 3 | 0 | RIGHT | C0            | 1 |
 * | C2 | 12 | (2,4) (2,3)             | 2 | 0 | UP    | C1            | 2 |
 * | C3 | 13 | (0,3) (1,3)             | 2 | 0 | RIGHT | C2, C0        | 3 |
 *
 * 네 블로킹 관계가 **전부 격자 점 단독**이라(공유 선분 0) 점 인덱스 제거 돌연변이를 이 픽스처도
 * 잡는다. 해법 순서는 `C0 → C1 → C2 → C3` 하나뿐이고 초기 안전수는 1개다.
 */
export const FIXTURE_DEPTH_CHAIN: Fixture = {
  name: 'FIXTURE_DEPTH_CHAIN',
  boardNumber: 4,
  seed: 'wu02-depth',
  depthConsistent: true,
  chains: [
    {
      id: 10,
      points: [
        [5, 0],
        [5, 1],
        [5, 2],
        [5, 3],
      ],
      depth: 0,
    },
    {
      id: 11,
      points: [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      depth: 1,
    },
    {
      id: 12,
      points: [
        [2, 4],
        [2, 3],
      ],
      depth: 2,
    },
    {
      id: 13,
      points: [
        [0, 3],
        [1, 3],
      ],
      depth: 3,
    },
  ],
};

/**
 * 2사슬 순환 교착 (§3.8 · PZL-112). 안전수 0 · `cyclic = {1, 2}` · `boardDepth = -1`.
 * 저장 깊이가 얕은 B(id 2)가 자동 보정 대상이 된다 (작업 계획 Q-3 규칙 ②).
 */
export const FIXTURE_DEADLOCK: Fixture = {
  name: 'FIXTURE_DEADLOCK',
  boardNumber: 7,
  seed: 'wu02-deadlock',
  depthConsistent: false,
  chains: [
    {
      id: 1,
      points: [
        [2, 8],
        [3, 8],
        [4, 8],
        [5, 8],
        [6, 8],
        [6, 7],
        [6, 6],
      ],
      depth: 2,
    },
    {
      id: 2,
      points: [
        [6, 1],
        [6, 2],
        [6, 3],
      ],
      depth: 1,
    },
  ],
};

/**
 * 회복 상한 확인용 합성 보드 (SES-204 · C3).
 * 머리가 경계에 있고 방향이 바깥이라 `R(S) = ∅` — 언제나 안전수다.
 * 저장 깊이 9라 회복은 `min(250 + 80×9, 900) = 900`ms에 걸린다.
 */
export const FIXTURE_DEPTH_CAP: Fixture = {
  name: 'FIXTURE_DEPTH_CAP',
  boardNumber: 10,
  seed: 'wu02-cap',
  depthConsistent: false,
  chains: [
    {
      id: 1,
      points: [
        [11, 17],
        [12, 17],
      ],
      depth: 9,
    },
  ],
};

/**
 * 2수 클리어 정산·퍼펙트·힌트 계수용 합성 보드 (SCR-305~307 · SES-207).
 * 두 사슬 모두 머리가 오른쪽 경계라 진로가 공집합이고 서로 간섭하지 않는다.
 */
export const FIXTURE_PERFECT: Fixture = {
  name: 'FIXTURE_PERFECT',
  boardNumber: 2,
  seed: 'wu02-perfect',
  depthConsistent: true,
  chains: [
    {
      id: 1,
      points: [
        [11, 0],
        [12, 0],
      ],
      depth: 0,
    },
    {
      id: 2,
      points: [
        [11, 2],
        [12, 2],
      ],
      depth: 0,
    },
  ],
};

export const ALL_FIXTURES: readonly Fixture[] = [
  FIXTURE_0110,
  FIXTURE_DEPTH_CHAIN,
  FIXTURE_DEADLOCK,
  FIXTURE_DEPTH_CAP,
  FIXTURE_PERFECT,
];

export function chainsOf(fixture: Fixture): Chain[] {
  return fixture.chains.map((spec) =>
    createChain(
      spec.id,
      spec.points.map(([x, y]) => pt(x, y)),
      spec.depth
    )
  );
}

/** 매번 새 `Board`를 만든다 — `Board`는 가변이라 테스트끼리 공유하면 안 된다 */
export function buildBoard(fixture: Fixture): Board {
  return new Board({
    chains: chainsOf(fixture),
    boardNumber: fixture.boardNumber,
    seed: fixture.seed,
  });
}

/** 주입 시계 — 코어의 유일한 시간 입구다 (§6.6). 테스트가 시각을 100% 통제한다 */
export class TestClock implements Clock {
  private ms: number;

  constructor(startMs = 0) {
    this.ms = startMs;
  }

  now(): number {
    return this.ms;
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }
}

export interface SessionHarness {
  readonly session: RunSession;
  readonly board: Board;
  readonly clock: TestClock;
  readonly params: ResolvedParams;
}

/** `start()`까지 마친 세션 하네스 */
export function makeSession(
  fixture: Fixture,
  overrides?: Partial<CoreParams>,
  startMs = 0
): SessionHarness {
  const clock = new TestClock(startMs);
  const params: CoreParams = { ...FACTORY_PARAMS, ...overrides };
  const session = new RunSession(params, clock);
  const board = buildBoard(fixture);
  session.start(board);
  return { session, board, clock, params: resolveParams(params) };
}

/**
 * 고정 시드 선형 합동 난수 — 등가·재현성 테스트가 같은 순서를 두 번 만들 수 있어야 한다.
 * 코어는 난수를 쓰지 않는다. 이 함수는 **테스트 시나리오 생성기**일 뿐이다.
 */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
