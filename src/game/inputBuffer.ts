// 입력 버퍼와 판정 잠금 (§2.6 · §2.4 동시 입력 — 작업 계획 §5)
//
// 코어와의 결선은 **3개 표면뿐**이다: `isLocked()`가 즉시 실행/적재를 가르고, `onUnlock()`이
// 소진을 깨우고, `pull()`이 유일한 당기기 입구다. 취소된 입력에서는 `pull()`을 **부르지 않는다** —
// 그것이 "하트를 차감하지 않는다"(§2.6 · CTL-008)의 실현 방식이다.
//
// ── 구현 함정 (반드시 방어) ───────────────────────────────────────────────
// `RunSession.pull()`의 **실패 경로는 ①②③B④⑤⑦⑧⑨가 전부 동기**로 끝나고, ⑨에서
// `onUnlock` 리스너를 **호출 스택 안에서** 발화한다. 즉 `drain()` 안에서 부른 `pull()`이
// 실패하면 `onUnlock → drain()`이 재귀 호출된다. `draining` 플래그로 재진입을 끊고 소진은
// 아래 `while` 루프 한 곳에서만 돈다.

import type { ChainId, InputAction } from '../core/types';
import type { PullResult } from '../core/session';

/** §2.6 — 최대 2입력. 초과분은 조용히 버린다 */
export const BUFFER_CAPACITY = 2;

export type PullOutcome = 'EXECUTED' | 'BUFFERED' | 'DROPPED' | 'NO_FOCUS';

export interface BufferedPull {
  /** **입력 시점**의 포커스 사슬 — 판정 시점의 포커스가 아니다 (§2.6 버퍼 대상) */
  readonly chainId: ChainId;
  readonly atMs: number;
}

/** `RunSession`이 구조적으로 만족하는 최소 표면 (테스트가 가짜를 끼울 수 있게 좁혀 둔다) */
export interface PullTarget {
  isLocked(): boolean;
  pull(id: ChainId): PullResult;
  onUnlock(fn: () => void): () => void;
}

export interface PullBufferStats {
  readonly executed: number;
  readonly buffered: number;
  readonly dropped: number;
  readonly cancelled: number;
}

export class PullBuffer {
  private readonly queue: BufferedPull[] = [];
  private readonly unsubscribe: () => void;
  private draining = false;
  private disposed = false;
  private executed = 0;
  private buffered = 0;
  private dropped = 0;
  private cancelled = 0;

  /**
   * @param target     당기기 대상 (`RunSession`)
   * @param focusOf    현재 포커스 조회 — 취소 판정(Q-1)과 대상 확정에 쓴다
   * @param chainAlive 그 사슬이 아직 당길 수 있는 상태인가 (`normal`·`blocked`)
   * @param onResult   실제 `pull()` 결과 통지 (연출·사운드용). 취소된 입력에서는 부르지 않는다
   */
  constructor(
    private readonly target: PullTarget,
    private readonly focusOf: () => ChainId | null,
    private readonly chainAlive: (id: ChainId) => boolean,
    private readonly onResult?: (result: PullResult) => void
  ) {
    this.unsubscribe = target.onUnlock(() => {
      if (this.draining) return; // ⑨가 drain() 안에서 발화한 경우 — 루프가 계속 돈다
      this.drain();
    });
  }

  /** `BUTTON1` 1회. 잠겨 있지 않으면 즉시 판정, 잠겨 있으면 적재(초과 폐기) */
  press(atMs: number): PullOutcome {
    const chainId = this.focusOf();
    if (chainId === null) return 'NO_FOCUS';
    if (!this.target.isLocked()) {
      this.execute(chainId);
      return 'EXECUTED';
    }
    if (this.queue.length >= BUFFER_CAPACITY) {
      this.dropped += 1;
      return 'DROPPED';
    }
    this.queue.push({ chainId, atMs });
    this.buffered += 1;
    return 'BUFFERED';
  }

  get pending(): readonly BufferedPull[] {
    return [...this.queue];
  }

  get stats(): PullBufferStats {
    return {
      executed: this.executed,
      buffered: this.buffered,
      dropped: this.dropped,
      cancelled: this.cancelled,
    };
  }

  /** 보드 전환·런 종료에서 남은 대기 입력을 버린다 (다음 보드로 새지 않게) */
  clear(): void {
    this.queue.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue.length = 0;
    this.unsubscribe();
  }

  /**
   * ⑨ 이후 순차 소진.
   *
   * 취소 조건은 둘이다 (작업 계획 Q-1):
   *   ① 대상 사슬이 이미 제거됐거나 제거 중 → §2.6 "이미 제거됐다면"
   *   ② 현재 포커스 ≠ 버퍼 대상        → §2.6 "포커스 대상이 바뀌었다면"
   * 어느 쪽이든 `pull()`을 부르지 않으므로 **하트가 차감되지 않는다**.
   */
  private drain(): void {
    if (this.draining || this.disposed) return;
    this.draining = true;
    try {
      while (this.queue.length > 0 && !this.target.isLocked()) {
        const entry = this.queue.shift();
        if (entry === undefined) break;
        if (!this.chainAlive(entry.chainId) || this.focusOf() !== entry.chainId) {
          this.cancelled += 1;
          continue;
        }
        this.execute(entry.chainId);
      }
    } finally {
      this.draining = false;
    }
  }

  private execute(chainId: ChainId): void {
    this.executed += 1;
    const result = this.target.pull(chainId);
    this.onResult?.(result);
  }
}

/**
 * §2.4 · CTL-010 — 같은 프레임에 두 버튼이 눌리면 `BUTTON1`만 소비하고 `BUTTON2`는 버린다.
 * 그 밖의 액션은 순서 그대로 통과시킨다.
 */
export function filterSimultaneous(actions: readonly InputAction[]): readonly InputAction[] {
  if (!actions.includes('BUTTON1')) return [...actions];
  return actions.filter((a) => a !== 'BUTTON2');
}
