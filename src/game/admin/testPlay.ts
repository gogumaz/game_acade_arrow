// 관리자 테스트 플레이 (§11.6 · admin §9.5 — 작업 계획 §10)
//
// 무료 실행·무집계는 **WU-04가 이미 만들어 둔 `'free'` 경로**를 그대로 쓴다 (CRD-607):
// `setTestPlay(true)` → `canStart()=true` · `chargeStart()='free'` · `canContinue()=false`이고
// 지갑·통계·`credit_log.csv`가 한 줄도 움직이지 않는다. 여기서는 **관찰**만 한다.
//
// 결과 5항목(§11.6): 도달 보드 · 보드별 클리어 시간 · 오입력 수 · 최종 점수 · 등급.
// 오입력은 `RunSnapshot.lastBlock`의 `(chainId, atMs)` 전이를 세어 얻는다 — core·flow에
// 카운터 API를 새로 뚫지 않는다.

import type { ParamTier } from '../../core/adminParams';
import { tierOfBoard } from '../../core/adminParams';
import type { BoardRequest, BoardSource, Tier } from '../boardSource';
import type { Grade } from '../grade';
import type { RunSnapshot } from '../runController';

/** §6.6 — 구간·시드를 직접 지정해 완전 재현한다 */
export interface TestPlaySpec {
  readonly tier: ParamTier;
  readonly seed: number;
}

export const TEST_PLAY_DEFAULT: TestPlaySpec = { tier: 'WARMUP', seed: 1 };

/** 각 구간의 대표 보드 번호 — 지정 구간을 강제할 때 이 번호로 사상한다 */
export const TIER_REPRESENTATIVE_BOARD: Readonly<Record<ParamTier, number>> = {
  WARMUP: 1,
  RHYTHM: 4,
  PRESSURE: 7,
  MASTER: 10,
  ENDLESS: 13,
};

/**
 * 지정 구간·시드로 보드를 공급하는 래퍼. 보드 번호는 그대로 두고 **구간만** 고정하므로
 * 진행 중에도 같은 구간이 반복된다 (§11.6 "구간·시드를 직접 지정해 완전 재현").
 */
export function testPlayBoardSource(base: BoardSource, spec: TestPlaySpec): BoardSource {
  return {
    next(req: BoardRequest) {
      const mapped = TIER_REPRESENTATIVE_BOARD[spec.tier] + (req.boardNumber - 1);
      return base.next({
        boardNumber: mapped,
        seed: `testplay-${spec.tier}-${String(spec.seed)}-${String(req.boardNumber)}`,
      });
    },
  };
}

interface BoardTime {
  readonly board: number;
  readonly ms: number;
}

interface TestPlayReport {
  readonly spec: TestPlaySpec;
  readonly boardReached: number;
  readonly boardTimes: readonly BoardTime[];
  /** 막힘 판정 횟수 = 오입력 수 (§11.6) */
  readonly mistakes: number;
  readonly score: number;
  readonly grade: Grade | null;
  readonly totalMs: number;
}

/**
 * 테스트 런 1회의 관찰자. `observe()`를 프레임마다 부르면 보드 전환·막힘을 센다.
 */
export class TestPlaySession {
  private spec: TestPlaySpec = TEST_PLAY_DEFAULT;
  private running = false;
  private startedAtMs = 0;
  private boardFromMs = 0;
  private currentBoard = 0;
  private highestBoard = 0;
  private mistakeCount = 0;
  private lastBlockKey: string | null = null;
  private readonly times: BoardTime[] = [];
  private finished: TestPlayReport | null = null;

  get active(): boolean {
    return this.running;
  }

  get lastReport(): TestPlayReport | null {
    return this.finished;
  }

  get currentSpec(): TestPlaySpec {
    return this.spec;
  }

  begin(spec: TestPlaySpec, nowMs: number): void {
    this.spec = spec;
    this.running = true;
    this.startedAtMs = nowMs;
    this.boardFromMs = nowMs;
    this.currentBoard = 0;
    this.highestBoard = 0;
    this.mistakeCount = 0;
    this.lastBlockKey = null;
    this.times.length = 0;
    this.finished = null;
  }

  observe(snap: RunSnapshot | null, nowMs: number): void {
    if (!this.running || snap === null) return;
    if (snap.boardNumber !== this.currentBoard) {
      if (this.currentBoard > 0) {
        this.times.push({ board: this.currentBoard, ms: Math.max(0, nowMs - this.boardFromMs) });
      }
      this.currentBoard = snap.boardNumber;
      this.boardFromMs = nowMs;
    }
    if (snap.boardNumber > this.highestBoard) this.highestBoard = snap.boardNumber;

    const block = snap.lastBlock;
    const key = block === null ? null : `${String(block.chainId)}@${String(block.atMs)}`;
    if (key !== null && key !== this.lastBlockKey) this.mistakeCount += 1;
    this.lastBlockKey = key;
  }

  /** 클리어·런 종료·`G` 2초 홀드 — 결과 5항목을 확정한다 */
  end(result: { score: number; grade: Grade | null }, nowMs: number): TestPlayReport {
    if (this.currentBoard > 0) {
      this.times.push({ board: this.currentBoard, ms: Math.max(0, nowMs - this.boardFromMs) });
    }
    this.running = false;
    this.finished = {
      spec: this.spec,
      boardReached: this.highestBoard,
      boardTimes: [...this.times],
      mistakes: this.mistakeCount,
      score: result.score,
      grade: result.grade,
      totalMs: Math.max(0, nowMs - this.startedAtMs),
    };
    return this.finished;
  }
}

/** `ParamTier`와 `boardSource.Tier`가 어긋나지 않게 하는 컴파일 시각 다리 */
export function asBoardTier(tier: ParamTier): Tier {
  return tier;
}

/** 보드 번호 → 구간 (코어 정의를 그대로 쓴다) */
export { tierOfBoard };
