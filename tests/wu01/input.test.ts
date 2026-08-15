// WU-01 T3 — 입력 어댑터 (§2.1 · §2.2 · §2.3 · §2.5 · §13 G1 · §18.5)
// 시간 의존 항목은 vi.useFakeTimers()로 결정론적으로 판정한다.
// 상태기계가 DOM에 의존하지 않으므로 jsdom 없이 Node 환경에서 실행된다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INPUT_ACTIONS, type InputAction } from '../../src/core/types';
import {
  KEYMAP,
  KEYMAP_BY_KEY,
  KeyboardInputAdapter,
  type InputAdapter,
  type InputStatus,
  InputStateMachine,
  type KeyEventLike,
  type KeyEventTarget,
  type PlayerAction,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
  STUCK_HOLD_MS,
  lookup,
  sourceIdOf,
} from '../../src/game/input';

/** window 대체 — jsdom 없이 keydown/keyup/blur를 직접 발화한다 */
class FakeKeyTarget implements KeyEventTarget {
  private readonly listeners = new Map<string, ((e: KeyEventLike) => void)[]>();

  addEventListener(type: string, listener: (event: KeyEventLike) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: (event: KeyEventLike) => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((f) => f !== listener)
    );
  }

  emit(type: string, event: KeyEventLike = { key: '' }): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

function attachAdapter(): { target: FakeKeyTarget; adapter: KeyboardInputAdapter } {
  const target = new FakeKeyTarget();
  const adapter = new KeyboardInputAdapter({ target });
  adapter.attach();
  return { target, adapter };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 3-1 ───────────────────────────────────────────────────────────────────

describe('3-1 추상 입력 10종 (§2.1)', () => {
  it('정확히 10종이며 §2.1 표와 이름이 일치한다', () => {
    expect(INPUT_ACTIONS).toHaveLength(10);
    expect([...INPUT_ACTIONS]).toEqual([
      'UP',
      'DOWN',
      'LEFT',
      'RIGHT',
      'BUTTON1',
      'BUTTON2',
      'START',
      'COIN',
      'SERVICE',
      'RESERVED',
    ]);
    expect(new Set(INPUT_ACTIONS).size).toBe(10);
  });

  it('키맵이 10종 밖의 액션을 만들지 않는다', () => {
    const valid = new Set<string>(INPUT_ACTIONS);
    for (const map of [KEYMAP, KEYMAP_BY_KEY]) {
      for (const pa of Object.values(map)) {
        expect(valid.has(pa.action)).toBe(true);
        expect([1, 2]).toContain(pa.player);
      }
    }
  });
});

// ── 3-2 · 3-3 ─────────────────────────────────────────────────────────────

/**
 * §2.1 표 1~9행. 10행 `RESERVED`는 어떤 물리 입력에도 연결하지 않으므로 이 표에 없다.
 * `Esc`(앱 종료)도 매핑하지 않는다 — 키오스크 탈출 경로를 두지 않는다.
 */
const SPEC_TABLE: {
  row: number;
  label: string;
  action: InputAction;
  p1Code: string;
  p1Key: string;
  p2Code?: string;
  p2Key?: string;
}[] = [
  { row: 1, label: '위', action: 'UP', p1Code: 'KeyW', p1Key: 'w', p2Code: 'Numpad8', p2Key: '8' },
  {
    row: 2,
    label: '아래',
    action: 'DOWN',
    p1Code: 'KeyS',
    p1Key: 's',
    p2Code: 'Numpad5',
    p2Key: '5',
  },
  {
    row: 3,
    label: '왼쪽',
    action: 'LEFT',
    p1Code: 'KeyA',
    p1Key: 'a',
    p2Code: 'Numpad4',
    p2Key: '4',
  },
  {
    row: 4,
    label: '오른쪽',
    action: 'RIGHT',
    p1Code: 'KeyD',
    p1Key: 'd',
    p2Code: 'Numpad6',
    p2Key: '6',
  },
  {
    row: 5,
    label: '당기기(우측 버튼)',
    action: 'BUTTON1',
    p1Code: 'KeyH',
    p1Key: 'h',
    p2Code: 'KeyL',
    p2Key: 'l',
  },
  {
    row: 6,
    label: '힌트(좌측 버튼)',
    action: 'BUTTON2',
    p1Code: 'KeyG',
    p1Key: 'g',
    p2Code: 'KeyK',
    p2Key: 'k',
  },
  { row: 7, label: 'START', action: 'START', p1Code: 'F1', p1Key: 'F1', p2Code: 'F2', p2Key: 'F2' },
  { row: 8, label: '코인 투입', action: 'COIN', p1Code: 'F10', p1Key: 'F10' },
  { row: 9, label: 'SERVICE(관리자 진입)', action: 'SERVICE', p1Code: 'F9', p1Key: 'F9' },
];

describe('3-2 §2.2 표 매핑 (§13 G1)', () => {
  it.each(SPEC_TABLE)('$row행 $label — e.code 매핑이 1:1이다', (row) => {
    expect(lookup({ code: row.p1Code, key: '' })).toEqual({ player: 1, action: row.action });
    if (row.p2Code) {
      expect(lookup({ code: row.p2Code, key: '' })).toEqual({ player: 2, action: row.action });
    }
  });

  it('표 1~9행이 어댑터에서 실제 액션으로 발화한다', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    const expected: PlayerAction[] = [];
    for (const row of SPEC_TABLE) {
      target.emit('keydown', { code: row.p1Code, key: '' });
      target.emit('keyup', { code: row.p1Code, key: '' });
      expected.push({ player: 1, action: row.action });
      if (row.p2Code) {
        target.emit('keydown', { code: row.p2Code, key: '' });
        target.emit('keyup', { code: row.p2Code, key: '' });
        expected.push({ player: 2, action: row.action });
      }
    }
    expect(seen).toEqual(expected);
  });

  it('표에 없는 키는 어떤 액션도 만들지 않는다', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    for (const code of ['KeyQ', 'KeyZ', 'Enter', 'Space', 'F5', 'ShiftLeft', 'Numpad0']) {
      target.emit('keydown', { code, key: '' });
      target.emit('keyup', { code, key: '' });
    }
    expect(seen).toEqual([]);
  });

  it('Esc(앱 종료)는 매핑하지 않는다 — 키오스크 탈출 경로 제거', () => {
    expect(lookup({ code: 'Escape', key: 'Escape' })).toBeUndefined();
    expect(KEYMAP.Escape).toBeUndefined();
    expect(KEYMAP_BY_KEY.Escape).toBeUndefined();
  });

  it('RESERVED는 어떤 물리 키에도 연결되지 않는다 (§2.1 10행)', () => {
    for (const map of [KEYMAP, KEYMAP_BY_KEY]) {
      expect(Object.values(map).map((pa) => pa.action)).not.toContain('RESERVED');
      // P1 7 + P2 7 + 공통 2 = 16. RESERVED에 키를 붙이면 여기서 먼저 깨진다.
      expect(Object.keys(map)).toHaveLength(16);
    }
  });

  it('P2 매핑이 유지되고 어댑터가 player 2로 보고한다 (§1.4 P2 배선 유지)', () => {
    // P2 입력을 무시하는 것은 게임 계층(WU-03)의 책임이다. 어댑터는 계속 발화하고
    // 관리자 INPUT TEST가 이 신호를 표시한다 (§11.7).
    expect(Object.values(KEYMAP).filter((pa) => pa.player === 2)).toHaveLength(7);

    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    for (const code of ['Numpad8', 'Numpad5', 'Numpad4', 'Numpad6', 'KeyL', 'KeyK', 'F2']) {
      target.emit('keydown', { code, key: '' });
      target.emit('keyup', { code, key: '' });
    }
    expect(seen).toEqual([
      { player: 2, action: 'UP' },
      { player: 2, action: 'DOWN' },
      { player: 2, action: 'LEFT' },
      { player: 2, action: 'RIGHT' },
      { player: 2, action: 'BUTTON1' },
      { player: 2, action: 'BUTTON2' },
      { player: 2, action: 'START' },
    ]);
  });
});

describe('3-3 e.code 우선 · e.key 폴백 (§2.2 · §13 G1)', () => {
  it.each(SPEC_TABLE)('$row행 $label — e.code를 비우면 e.key로 같은 결과가 나온다', (row) => {
    expect(lookup({ code: '', key: row.p1Key })).toEqual({ player: 1, action: row.action });
    if (row.p2Key) {
      expect(lookup({ code: '', key: row.p2Key })).toEqual({ player: 2, action: row.action });
    }
  });

  it('한 글자 키는 대문자로 와도 소문자로 조회한다', () => {
    expect(lookup({ code: '', key: 'W' })).toEqual({ player: 1, action: 'UP' });
  });

  it('e.code가 있으면 e.key 폴백을 쓰지 않는다', () => {
    // code는 표에 없고 key만 표에 있는 합성 이벤트 — code 우선이므로 매핑되지 않아야 한다
    expect(lookup({ code: 'KeyQ', key: 'w' })).toBeUndefined();
  });

  it('sourceId가 code 우선, 없으면 key 기반이다', () => {
    expect(sourceIdOf({ code: 'KeyW', key: 'w' })).toBe('KeyW');
    expect(sourceIdOf({ code: '', key: 'w' })).toBe('key:w');
  });
});

// ── 3-4 · 3-5 · 3-6 ───────────────────────────────────────────────────────

describe('3-4 방향 반복 타이밍 (§2.3)', () => {
  it('즉시 1회 → 250ms 후 1회 → 이후 100ms 간격', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    target.emit('keydown', { code: 'KeyA', key: '' });
    expect(seen).toHaveLength(1); // 1단계: 즉시 1칸

    vi.advanceTimersByTime(REPEAT_DELAY_MS - 1);
    expect(seen).toHaveLength(1); // 250ms 전에는 추가 발화 없음

    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1); // 지연 만료 시점에는 아직 간격 타이머만 등록

    vi.advanceTimersByTime(REPEAT_INTERVAL_MS);
    expect(seen).toHaveLength(2); // 2단계: 연속 이동 시작

    vi.advanceTimersByTime(REPEAT_INTERVAL_MS * 3);
    expect(seen).toHaveLength(5); // 3단계: 100ms 간격

    expect(seen.every((pa) => pa.action === 'LEFT' && pa.player === 1)).toBe(true);

    target.emit('keyup', { code: 'KeyA', key: '' });
    vi.advanceTimersByTime(1000);
    expect(seen).toHaveLength(5); // 뗀 뒤에는 더 발화하지 않는다
  });

  it('방향 4종 전부 반복하고 다른 액션은 반복하지 않는다', () => {
    for (const [code, repeats] of [
      ['KeyW', true],
      ['KeyS', true],
      ['KeyA', true],
      ['KeyD', true],
      ['KeyH', false],
      ['KeyG', false],
      ['F1', false],
      ['F10', false],
      ['F9', false],
    ] as [string, boolean][]) {
      const { target, adapter } = attachAdapter();
      const seen: PlayerAction[] = [];
      adapter.onAction((pa) => seen.push(pa));
      target.emit('keydown', { code, key: '' });
      vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 5);
      expect(seen.length > 1, `${code} repeats=${String(repeats)}`).toBe(repeats);
      adapter.detach();
    }
  });
});

describe('3-5 버튼은 홀드해도 1회만 (§2.3)', () => {
  it.each(['KeyH', 'KeyG', 'F1', 'KeyL', 'KeyK', 'F2'])(
    '%s는 OS 키 리피트를 무시하고 1회만 발화한다',
    (code) => {
      const { target, adapter } = attachAdapter();
      const seen: PlayerAction[] = [];
      adapter.onAction((pa) => seen.push(pa));

      target.emit('keydown', { code, key: '' });
      for (let i = 0; i < 20; i++) {
        target.emit('keydown', { code, key: '', repeat: true });
      }
      vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 10);
      expect(seen).toHaveLength(1);
    }
  );

  it('방향키도 e.repeat 이벤트로는 추가 발화하지 않는다', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    target.emit('keydown', { code: 'KeyD', key: '' });
    for (let i = 0; i < 10; i++) {
      target.emit('keydown', { code: 'KeyD', key: '', repeat: true });
    }
    expect(seen).toHaveLength(1);
  });
});

describe('3-6 blur에서 반복 타이머 즉시 해제 (§2.3 · §13 G1)', () => {
  it('방향키를 누른 채 포커스를 잃으면 더 이상 이동하지 않는다', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    target.emit('keydown', { code: 'KeyD', key: '' });
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 2);
    const before = seen.length;
    expect(before).toBeGreaterThan(1);

    target.emit('blur');
    vi.advanceTimersByTime(REPEAT_INTERVAL_MS * 50);
    expect(seen).toHaveLength(before);
  });

  it('여러 방향키를 동시에 눌러도 blur 한 번에 전부 해제된다', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    target.emit('keydown', { code: 'KeyA', key: '' });
    target.emit('keydown', { code: 'Numpad6', key: '' });
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 2);
    const before = seen.length;

    target.emit('blur');
    vi.advanceTimersByTime(REPEAT_INTERVAL_MS * 50);
    expect(seen).toHaveLength(before);
  });
});

// ── 3-7 ───────────────────────────────────────────────────────────────────

describe('3-7 "아무 키" 판정 제외 (§2.5)', () => {
  it('COIN·SERVICE는 아무 키 리스너를 호출하지 않는다', () => {
    const { target, adapter } = attachAdapter();
    let anyKey = 0;
    adapter.onAnyKey(() => anyKey++);

    for (const code of ['F10', 'F9']) {
      target.emit('keydown', { code, key: '' });
      target.emit('keyup', { code, key: '' });
    }
    expect(anyKey).toBe(0);
  });

  it('그 외 키는 매핑 여부와 무관하게 아무 키 리스너를 호출한다', () => {
    const { target, adapter } = attachAdapter();
    let anyKey = 0;
    adapter.onAnyKey(() => anyKey++);

    target.emit('keydown', { code: 'KeyW', key: '' }); // 매핑된 키
    target.emit('keydown', { code: 'KeyQ', key: '' }); // 매핑 없는 키
    target.emit('keydown', { code: 'Escape', key: 'Escape' }); // 매핑하지 않은 Esc
    expect(anyKey).toBe(3);
  });
});

// ── 3-8 · 3-9 ─────────────────────────────────────────────────────────────

describe('3-8 · 3-9 어댑터 3상태 전이 (§18.5 · DIA-005 · MNT-001)', () => {
  it('disconnected → connected — attach 시', () => {
    const target = new FakeKeyTarget();
    const adapter = new KeyboardInputAdapter({ target });
    const seen: InputStatus[] = [];
    adapter.onStatusChange((s) => seen.push(s));

    expect(adapter.status).toBe('disconnected');
    adapter.attach();
    expect(adapter.status).toBe('connected');
    expect(seen).toEqual(['connected']);
  });

  it('connected → disconnected — detach 시', () => {
    const { adapter } = attachAdapter();
    const seen: InputStatus[] = [];
    adapter.onStatusChange((s) => seen.push(s));

    adapter.detach();
    expect(adapter.status).toBe('disconnected');
    expect(seen).toEqual(['disconnected']);
  });

  it('connected → stuck — 같은 입력을 5초 이상 유지', () => {
    const { target, adapter } = attachAdapter();
    const seen: InputStatus[] = [];
    adapter.onStatusChange((s) => seen.push(s));

    target.emit('keydown', { code: 'KeyW', key: '' });
    vi.advanceTimersByTime(STUCK_HOLD_MS - 1);
    expect(adapter.status).toBe('connected');

    vi.advanceTimersByTime(1);
    expect(adapter.status).toBe('stuck');
    expect(seen).toEqual(['stuck']);
  });

  it('stuck → connected — 입력 해제', () => {
    const { target, adapter } = attachAdapter();
    target.emit('keydown', { code: 'F10', key: '' });
    vi.advanceTimersByTime(STUCK_HOLD_MS);
    expect(adapter.status).toBe('stuck');

    const seen: InputStatus[] = [];
    adapter.onStatusChange((s) => seen.push(s));
    target.emit('keyup', { code: 'F10', key: '' });
    expect(adapter.status).toBe('connected');
    expect(seen).toEqual(['connected']);
  });

  it('stuck 상태에서 detach하면 disconnected가 된다', () => {
    const { target, adapter } = attachAdapter();
    target.emit('keydown', { code: 'KeyW', key: '' });
    vi.advanceTimersByTime(STUCK_HOLD_MS);
    expect(adapter.status).toBe('stuck');

    adapter.detach();
    expect(adapter.status).toBe('disconnected');
  });

  it('disconnected 상태에서는 입력이 액션을 만들지 않는다', () => {
    const { target, adapter } = attachAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    adapter.detach();
    target.emit('keydown', { code: 'KeyW', key: '' });
    expect(seen).toEqual([]);
  });

  it('재연결(detach → attach)로 connected로 돌아오고 입력이 되살아난다', () => {
    const { target, adapter } = attachAdapter();
    const statuses: InputStatus[] = [];
    adapter.onStatusChange((s) => statuses.push(s));
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));

    adapter.detach();
    adapter.attach();
    expect(statuses).toEqual(['disconnected', 'connected']);
    expect(adapter.status).toBe('connected');

    target.emit('keydown', { code: 'KeyW', key: '' });
    expect(seen).toEqual([{ player: 1, action: 'UP' }]);
  });

  it('상태가 실제로 바뀔 때만 통지한다', () => {
    const { adapter } = attachAdapter();
    const seen: InputStatus[] = [];
    adapter.onStatusChange((s) => seen.push(s));

    adapter.attach(); // 이미 connected
    adapter.attach();
    expect(seen).toEqual([]);
  });

  it('detach가 이벤트 리스너를 실제로 떼어낸다', () => {
    const { target, adapter } = attachAdapter();
    expect(target.count('keydown')).toBe(1);
    adapter.detach();
    expect(target.count('keydown')).toBe(0);
  });

  it('구독 해제 함수가 동작한다', () => {
    const { target, adapter } = attachAdapter();
    let n = 0;
    const off = adapter.onAction(() => n++);
    target.emit('keydown', { code: 'KeyW', key: '' });
    off();
    target.emit('keydown', { code: 'KeyS', key: '' });
    expect(n).toBe(1);
  });
});

// ── 3-10 ──────────────────────────────────────────────────────────────────

describe('3-10 어댑터 인터페이스 분리 (§18.5 · §13 G2)', () => {
  it('KeyboardInputAdapter가 InputAdapter 계약을 만족한다', () => {
    const adapter: InputAdapter = new KeyboardInputAdapter({ target: new FakeKeyTarget() });
    expect(adapter.id).toBe('keyboard');
    expect(typeof adapter.attach).toBe('function');
    expect(typeof adapter.detach).toBe('function');
    expect(typeof adapter.onAction).toBe('function');
    expect(typeof adapter.onAnyKey).toBe('function');
    expect(typeof adapter.onStatusChange).toBe('function');
    expect(adapter.status).toBe('disconnected');
  });

  it('DOM 없이 같은 계약의 다른 구현체를 끼울 수 있다 (Serial 자리)', () => {
    // Serial 실물 연동은 [보류]다. 여기서는 계약이 DOM에 묶여 있지 않다는 것만 증명한다.
    class StubSerialAdapter implements InputAdapter {
      readonly id = 'serial-stub';
      private readonly core = new InputStateMachine();
      get status(): InputStatus {
        return this.core.status;
      }
      attach(): void {
        this.core.setConnected(true);
      }
      detach(): void {
        this.core.setConnected(false);
      }
      onAction(fn: (pa: PlayerAction) => void): () => void {
        return this.core.onAction(fn);
      }
      onAnyKey(fn: () => void): () => void {
        return this.core.onAnyKey(fn);
      }
      onStatusChange(fn: (s: InputStatus) => void): () => void {
        return this.core.onStatusChange(fn);
      }
      /** 물리 신호 → 추상 입력. 실제 패킷 상수는 [보류] (§18.5) */
      signal(pa: PlayerAction): void {
        this.core.press(`serial:${pa.player}:${pa.action}`, pa);
      }
    }

    const adapter = new StubSerialAdapter();
    const seen: PlayerAction[] = [];
    adapter.onAction((pa) => seen.push(pa));
    adapter.attach();
    adapter.signal({ player: 1, action: 'SERVICE' });
    expect(adapter.status).toBe('connected');
    expect(seen).toEqual([{ player: 1, action: 'SERVICE' }]);
  });

  it('타이머를 주입하면 전역 타이머를 쓰지 않는다', () => {
    let created = 0;
    const core = new InputStateMachine({
      setTimeout: (fn, ms) => {
        created++;
        return setTimeout(fn, ms);
      },
      clearTimeout: (h) => {
        clearTimeout(h as Parameters<typeof clearTimeout>[0]);
      },
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => {
        clearInterval(h as Parameters<typeof clearInterval>[0]);
      },
    });
    core.setConnected(true);
    core.press('KeyW', { player: 1, action: 'UP' });
    // 반복 지연 타이머 + 고착 감시 타이머
    expect(created).toBe(2);
  });
});
