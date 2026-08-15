// WU-03 테스트 하네스 — 조작 명세 전용 보드 + 시계·난수 재수출 + 가짜 포트.
//
// 이 파일은 `*.test.ts`가 아니므로 Vitest가 수집하지 않는다(테스트 0건).
// 좌표표는 작업 계획 §4.4의 F-A~F-D를 그대로 전사한 것이며, 값이 바뀌면 `focus.test.ts`가 잡는다.
//
// 픽스처 **보드 세트**(B0~B6)는 제품 코드(`src/game/boardSource.ts`)가 소유한다. 여기서는
// 순환 선택 규칙만 겨냥한 최소 보드를 따로 둔다 — 규칙 테스트가 난이도 튜닝에 흔들리지 않게.

import { createChain } from '../../src/core/chain';
import { Board } from '../../src/core/puzzle';
import { RunSession } from '../../src/core/session';
import type { Chain, ChainId, Clock, GridPoint } from '../../src/core/types';
import type { CoreParams } from '../../src/core/params';
import { FACTORY_PARAMS } from '../../src/core/params';
import type { CreditsPort, ChargeSource, CreditBalance } from '../../src/game/creditsStub';
import { createCreditsStub } from '../../src/game/creditsStub';
import { memoryBackend, Storage, type StorageTimers } from '../../src/persist/storage';

export { TestClock, lcg } from '../wu02/fixtures';

function p(x: number, y: number): GridPoint {
  return { x, y };
}

/** `[id, 꼬리x, 꼬리y, 머리x, 머리y, depth]` 축약 — 대표점(머리)을 표 그대로 읽히게 한다 */
type Bar = readonly [ChainId, number, number, number, number, number];

/** 길이 2 수평 사슬 — 대표점(= 머리)만 지정하면 꼬리는 그 왼쪽 칸이다 */
function bar(id: ChainId, headX: number, headY: number, depth: number): Bar {
  return [id, headX - 1, headY, headX, headY, depth];
}

function boardOf(bars: readonly Bar[], name: string): Board {
  const chains: Chain[] = bars.map(([id, tx, ty, hx, hy, depth]) =>
    createChain(id, [p(tx, ty), p(hx, hy)], depth)
  );
  return new Board({ chains, boardNumber: 1, seed: name });
}

/**
 * **F-A 「열 3개 · 행 3개」** (작업 계획 §4.4) — 대표점
 * `(1,2) (3,2) (5,2) / (1,5) (3,5) (5,5) / (1,8) (3,8) (5,8)`.
 * id는 `boardSource`의 사다리 규약과 같은 `10(i+1)+j`를 쓴다.
 */
export function focusBoardA(): Board {
  return boardOf(
    [
      bar(10, 1, 2, 2),
      bar(11, 3, 2, 1),
      bar(12, 5, 2, 0),
      bar(20, 1, 5, 2),
      bar(21, 3, 5, 1),
      bar(22, 5, 5, 0),
      bar(30, 1, 8, 2),
      bar(31, 3, 8, 1),
      bar(32, 5, 8, 0),
    ],
    'focus-A'
  );
}

/**
 * **F-B 「y 동률 타이브레이크」** — 대표점 `(2,4) (2,10)` / `(6,7)`.
 * `(6,7)`에서 `LEFT`면 두 후보가 거리 3으로 동률이라 **위쪽 `(2,4)`** 를 잡아야 한다 (CTL-003).
 */
export const FB_TOP: ChainId = 1;
export const FB_BOTTOM: ChainId = 2;
export const FB_RIGHT: ChainId = 3;

export function focusBoardB(): Board {
  return boardOf(
    [bar(FB_TOP, 2, 4, 0), bar(FB_BOTTOM, 2, 10, 0), bar(FB_RIGHT, 6, 7, 0)],
    'focus-B'
  );
}

/** **F-C 「열에 1개」** — 대표점 `(4,6)` 하나뿐. 4방향 전부 거부다 (P-10) */
export const FC_ONLY: ChainId = 7;

export function focusBoardC(): Board {
  return boardOf([bar(FC_ONLY, 4, 6, 0)], 'focus-C');
}

/** 열 2개 × 각 1개 — `UP`/`DOWN`은 거부, `LEFT`/`RIGHT`는 이동한다 */
export const FC2_LEFT: ChainId = 1;
export const FC2_RIGHT: ChainId = 2;

export function focusBoardC2(): Board {
  return boardOf([bar(FC2_LEFT, 3, 6, 0), bar(FC2_RIGHT, 8, 6, 0)], 'focus-C2');
}

/** **F-D 「제거 후 포커스」** — 대표점 `(3,4) (3,9) (7,4) (11,4)` */
export const FD_A: ChainId = 1; // (3,4)
export const FD_B: ChainId = 2; // (3,9)
export const FD_C: ChainId = 3; // (7,4)
export const FD_D: ChainId = 4; // (11,4)

export function focusBoardD(): Board {
  return boardOf(
    [bar(FD_A, 3, 4, 2), bar(FD_B, 3, 9, 0), bar(FD_C, 7, 4, 1), bar(FD_D, 11, 4, 0)],
    'focus-D'
  );
}

/**
 * 당기기 결선용 보드 — 모든 사슬의 머리가 오른쪽 경계라 **진로가 공집합**이다.
 * 즉 전부 안전수이고 서로 간섭하지 않아, 버퍼·잠금 시나리오가 판정 결과에 흔들리지 않는다.
 */
export function openBoard(count: number): Board {
  const chains: Chain[] = [];
  for (let i = 0; i < count; i += 1) {
    chains.push(createChain(i + 1, [p(11, i * 2), p(12, i * 2)], 0));
  }
  return new Board({ chains, boardNumber: 1, seed: `open-${count}` });
}

/** `start()`까지 마친 세션 */
export function startedSession(
  board: Board,
  clock: Clock,
  overrides?: Partial<CoreParams>
): RunSession {
  const session = new RunSession({ ...FACTORY_PARAMS, ...overrides }, clock);
  session.start(board);
  return session;
}

// ── 가짜 포트 ──────────────────────────────────────────────────────────────

/** 호출 횟수까지 세는 크레딧 스파이 (CRD-601은 "몇 번" 차감했는지가 판정 대상이다) */
export interface CreditsSpy extends CreditsPort {
  readonly calls: {
    insertCoin: number;
    chargeStart: number;
    chargeContinue: number;
    refund: number;
  };
}

export function creditsSpy(cfg?: { coinsPerPlay?: number; continueCoins?: number }): CreditsSpy {
  const inner = createCreditsStub(cfg);
  const calls = { insertCoin: 0, chargeStart: 0, chargeContinue: 0, refund: 0 };
  return {
    calls,
    coinsPerPlay: inner.coinsPerPlay,
    continueCoins: inner.continueCoins,
    insertCoin(): boolean {
      calls.insertCoin += 1;
      return inner.insertCoin();
    },
    balance(): CreditBalance {
      return inner.balance();
    },
    canStart(): boolean {
      return inner.canStart();
    },
    canContinue(): boolean {
      return inner.canContinue();
    },
    chargeStart(): ChargeSource {
      calls.chargeStart += 1;
      return inner.chargeStart();
    },
    chargeContinue(): ChargeSource {
      calls.chargeContinue += 1;
      return inner.chargeContinue();
    },
    refund(amount: number, source: ChargeSource, reason: string): void {
      calls.refund += 1;
      inner.refund(amount, source, reason);
    },
  };
}

/** 코인을 n회 넣는다 — 화면 흐름 테스트의 준비 단계 상투구 */
export function insertCoins(credits: CreditsPort, n: number): void {
  for (let i = 0; i < n; i += 1) credits.insertCoin();
}

/** 디바운스를 테스트가 통제하는 저장 계층 (메모리 백엔드) */
interface StorageHarness {
  readonly storage: Storage;
  /** 예약된 저장을 즉시 실행한다 */
  flush(): void;
}

export function memoryStorage(): StorageHarness {
  let pending: (() => void) | null = null;
  const timers: StorageTimers = {
    setTimeout: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeout: () => {
      pending = null;
    },
  };
  const storage = new Storage({ backend: memoryBackend(), timers, onError: () => undefined });
  return {
    storage,
    flush(): void {
      const fn = pending;
      pending = null;
      if (fn !== null) fn();
    },
  };
}
