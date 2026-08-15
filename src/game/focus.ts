// 사슬 순환 선택 (§2.2 · §2.3 — 작업 계획 §4)
//
// 포커스는 **항상 정확히 1개 사슬**이며 자유 커서는 없다. 이 모듈은 `Board`를 읽기만 하고
// 아무것도 바꾸지 않는다 — 포커스 자체는 WU-03의 변수 1개(`ChainId | null`)이고 코어의
// `ChainState.focused`는 끝까지 세팅하지 않는다 (WU-02 P-2.4 가).
//
// **안전수는 타이브레이크에 쓰지 않는다** (§2.2). 안전수 우선 순환은 포커스 이동만으로 정답을
// 노출시켜 퍼즐을 무효화한다. 이 파일 어디에서도 `evaluate()`·`safeMoves()`를 부르지 않는다.

import { headOf } from '../core/chain';
import { DIRECTIONS } from '../core/grid';
import type { Board } from '../core/puzzle';
import type { ChainId, Direction, GridPoint } from '../core/types';

/** 대표점 `x`가 같은 사슬 묶음. `ids`는 `y` 오름차순 (§2.2 열 구조) */
export interface FocusColumn {
  readonly x: number;
  readonly ids: readonly ChainId[];
}

/**
 * 포커스 가능 사슬 = 활성 사슬 중 상태가 `normal` 또는 `blocked`인 것 (작업 계획 P-2).
 *
 * `removing`을 빼는 이유: 코어 `pull()`이 `removing`을 `CHAIN_GONE`으로 거부하므로(session.ts),
 * 슬라이드 아웃 0.18~0.75초 동안 포커스를 죽은 사슬에 묶어 두면 §2.6 "레버는 잠금과 무관하게
 * 즉시"가 무의미해진다. 제외 전이는 ③A(제거 개시) 시점에 일어난다.
 */
export function focusableChains(board: Board): readonly ChainId[] {
  const out: ChainId[] = [];
  for (const chain of board.activeChains()) {
    const state = board.stateOf(chain.id);
    if (state === 'normal' || state === 'blocked') out.push(chain.id);
  }
  return out;
}

// ── 내부 인덱스 ────────────────────────────────────────────────────────────
//
// 열 구성은 `moveFocus` 한 번마다 다시 만들 만큼 싸지 않다(CTL-004 계측은 BFS를 사슬 수²번
// 돌린다). 공개 함수는 이 인덱스를 1회 만들어 재사용한다.

interface FocusIndex {
  readonly columns: readonly FocusColumn[];
  /** 사슬 → 열 인덱스 */
  readonly colOf: ReadonlyMap<ChainId, number>;
  /** 사슬 → 열 안 인덱스 */
  readonly rowOf: ReadonlyMap<ChainId, number>;
  readonly headOf: ReadonlyMap<ChainId, GridPoint>;
  /** id 오름차순 */
  readonly ids: readonly ChainId[];
}

function buildIndex(board: Board): FocusIndex {
  const ids = focusableChains(board);
  const heads = new Map<ChainId, GridPoint>();
  const byX = new Map<number, ChainId[]>();
  for (const id of ids) {
    const chain = board.chain(id);
    if (chain === undefined) throw new Error(`focus: 없는 사슬 ${id}`);
    const head = headOf(chain);
    heads.set(id, head);
    const list = byX.get(head.x);
    if (list === undefined) byX.set(head.x, [id]);
    else list.push(id);
  }

  const colOf = new Map<ChainId, number>();
  const rowOf = new Map<ChainId, number>();
  const columns: FocusColumn[] = [];
  const xs = [...byX.keys()].sort((a, b) => a - b);
  for (const x of xs) {
    const list = byX.get(x);
    if (list === undefined) throw new Error(`focus: 열 ${x}이(가) 비었다`);
    // 한 열 안에서 y는 유일하다 — 같은 (x,y)는 격자 점 공유이므로 §3.1 교차 금지에 걸려
    // Board 생성자가 이미 거부한다. 따라서 정렬에 동률이 없고 결정성이 구조적으로 보장된다 (CTL-002).
    const sorted = [...list].sort((a, b) => requirePoint(heads, a).y - requirePoint(heads, b).y);
    const colIndex = columns.length;
    sorted.forEach((id, row) => {
      colOf.set(id, colIndex);
      rowOf.set(id, row);
    });
    columns.push({ x, ids: sorted });
  }
  return { columns, colOf, rowOf, headOf: heads, ids };
}

function requirePoint(heads: ReadonlyMap<ChainId, GridPoint>, id: ChainId): GridPoint {
  const p = heads.get(id);
  if (p === undefined) throw new Error(`focus: 대표점이 없는 사슬 ${id}`);
  return p;
}

/** 새 열에서 `y` 최근접 — 동률이면 **위쪽(`y`가 작은 쪽)** (§2.2 타이브레이크) */
function nearestInColumn(index: FocusIndex, column: FocusColumn, y: number): ChainId {
  let best = column.ids[0];
  let bestDist = Math.abs(requirePoint(index.headOf, best).y - y);
  for (let i = 1; i < column.ids.length; i += 1) {
    const id = column.ids[i];
    const dist = Math.abs(requirePoint(index.headOf, id).y - y);
    // ids가 y 오름차순이라 `<`(엄격 부등호)만 쓰면 동률에서 먼저 온 위쪽이 남는다
    if (dist < bestDist) {
      best = id;
      bestDist = dist;
    }
  }
  return best;
}

/** 평시 레버 이동 — **순환**한다 (§2.2). 못 움직이면 `null`(거부음) */
function moveIn(index: FocusIndex, from: ChainId, dir: Direction): ChainId | null {
  const col = index.colOf.get(from);
  const row = index.rowOf.get(from);
  if (col === undefined || row === undefined) return null;

  if (dir === 'UP' || dir === 'DOWN') {
    const ids = index.columns[col].ids;
    const n = ids.length;
    if (n === 1) return null; // §2.2 "열에 사슬이 1개뿐이면 이동하지 않고 거부음"
    const next = dir === 'UP' ? (row - 1 + n) % n : (row + 1) % n;
    return ids[next];
  }

  const m = index.columns.length;
  const nextCol = dir === 'LEFT' ? (col - 1 + m) % m : (col + 1) % m;
  const picked = nearestInColumn(index, index.columns[nextCol], requirePoint(index.headOf, from).y);
  // 열이 1개뿐이면 결과가 자기 자신이다 → 이동하지 않고 거부음 (작업 계획 P-10)
  return picked === from ? null : picked;
}

// ── 공개 API ───────────────────────────────────────────────────────────────

/** `x` 오름차순 열 목록. 각 열의 `ids`는 `y` 오름차순 */
export function focusColumns(board: Board): readonly FocusColumn[] {
  return buildIndex(board).columns;
}

/** 보드 시작 포커스 = **가장 왼쪽 열의 가장 아래(`y` 최대)** 사슬 (§2.2 · CTL-005) */
export function initialFocus(board: Board): ChainId | null {
  const index = buildIndex(board);
  if (index.columns.length === 0) return null;
  const first = index.columns[0].ids;
  return first[first.length - 1];
}

/** 레버 1회 이동. 양끝 순환, 못 움직이면 `null` (§2.2 · CTL-003) */
export function moveFocus(board: Board, from: ChainId, dir: Direction): ChainId | null {
  return moveIn(buildIndex(board), from, dir);
}

/**
 * 제거 직후 포커스 (§2.2 · CTL-005 — 작업 계획 Q-2 **비순환**).
 *
 * 마지막 레버 방향으로 한 번 옮기고, 그 방향에 사슬이 없으면 `RIGHT` → `DOWN` 순으로 대체한다.
 * **여기서만 비순환**인 이유: 순환이면 `RIGHT`가 절대 실패하지 않아 문서가 규정한 `DOWN` 대체가
 * 도달 불가능한 죽은 규칙이 된다. 평시 이동(`moveFocus`)과 함수를 분리해 규칙이 서로 섞이지 않게 한다.
 */
export function focusAfterRemoval(
  board: Board,
  removed: ChainId,
  lastDir: Direction | null
): ChainId | null {
  const index = buildIndex(board);
  if (index.ids.length === 0) return null;
  if (index.ids.length === 1) return index.ids[0]; // §2.2 "사슬이 1개 남으면 그 사슬"

  const chain = board.chain(removed);
  if (chain === undefined) throw new Error(`focusAfterRemoval: 없는 사슬 ${removed}`);
  const origin = headOf(chain);

  const order: Direction[] = [];
  for (const d of [lastDir, 'RIGHT' as const, 'DOWN' as const]) {
    if (d !== null && !order.includes(d)) order.push(d);
  }
  for (const d of order) {
    const found = stepNoWrap(index, origin, d);
    if (found !== null) return found;
  }
  return nearestTo(index, origin);
}

/** 비순환 1칸 이동 — 그 방향에 사슬이 없으면 `null` */
function stepNoWrap(index: FocusIndex, origin: GridPoint, dir: Direction): ChainId | null {
  if (dir === 'UP' || dir === 'DOWN') {
    const column = index.columns.find((c) => c.x === origin.x);
    if (column === undefined) return null;
    if (dir === 'UP') {
      let best: ChainId | null = null;
      for (const id of column.ids) {
        if (requirePoint(index.headOf, id).y < origin.y) best = id; // ids가 y 오름차순 → 마지막이 최대
      }
      return best;
    }
    for (const id of column.ids) {
      if (requirePoint(index.headOf, id).y > origin.y) return id; // 첫 번째가 최소
    }
    return null;
  }

  let target: FocusColumn | null = null;
  for (const column of index.columns) {
    if (dir === 'LEFT') {
      if (column.x < origin.x) target = column; // x 오름차순 → 마지막이 최대
    } else if (column.x > origin.x && target === null) {
      target = column; // 첫 번째가 최소
    }
  }
  return target === null ? null : nearestInColumn(index, target, origin.y);
}

/** 문서 미규정 폴백 — 맨해튼 최근접 → `y` 작은 쪽 → id 작은 쪽 */
function nearestTo(index: FocusIndex, origin: GridPoint): ChainId | null {
  let best: ChainId | null = null;
  let bestKey: readonly [number, number, number] | null = null;
  for (const id of index.ids) {
    const p = requirePoint(index.headOf, id);
    const key = [Math.abs(p.x - origin.x) + Math.abs(p.y - origin.y), p.y, id] as const;
    if (bestKey === null || compareKey(key, bestKey) < 0) {
      best = id;
      bestKey = key;
    }
  }
  return best;
}

function compareKey(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/**
 * `from` → `to`의 최소 레버 조작 수 (§6.1 축 6 "평균 조작 수"의 정량 정의).
 * 4방향 이동을 간선으로 하는 그래프의 BFS 최단 거리. 도달 불가면 `Infinity`.
 */
export function focusDistance(board: Board, from: ChainId, to: ChainId): number {
  return distanceIn(buildIndex(board), from, to);
}

function distanceIn(index: FocusIndex, from: ChainId, to: ChainId): number {
  if (from === to) return 0;
  if (!index.colOf.has(from) || !index.colOf.has(to)) return Number.POSITIVE_INFINITY;
  const seen = new Set<ChainId>([from]);
  let frontier: ChainId[] = [from];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: ChainId[] = [];
    for (const id of frontier) {
      for (const dir of DIRECTIONS) {
        const step = moveIn(index, id, dir);
        if (step === null || seen.has(step)) continue;
        if (step === to) return depth;
        seen.add(step);
        next.push(step);
      }
    }
    frontier = next;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * **최악 조작 수** (CTL-004) — 임의 사슬 → 임의 사슬 최단 조작 수의 최댓값.
 * 사슬이 1개 이하면 0이다. §2.2가 상한 10, 출시 차단선 12로 규정한 그 값이다.
 */
export function worstCaseMoves(board: Board): number {
  const index = buildIndex(board);
  if (index.ids.length <= 1) return 0;
  let worst = 0;
  for (const from of index.ids) {
    for (const to of index.ids) {
      const d = distanceIn(index, from, to);
      if (d > worst) worst = d;
    }
  }
  return worst;
}

/**
 * §2.2가 상한 10을 유도한 구조 공식 — `⌊열 수 / 2⌋ + ⌊최대 열 크기 / 2⌋`.
 * 양방향 순환이므로 좌우는 최악 `⌊m/2⌋`, 상하는 최악 `⌊n/2⌋`다. 실측 `worstCaseMoves`가
 * 이 값을 넘으면 순환 구현이 규칙을 벗어난 것이다.
 */
export function structuralMoveBound(board: Board): number {
  const columns = buildIndex(board).columns;
  if (columns.length === 0) return 0;
  let maxSize = 0;
  for (const column of columns) if (column.ids.length > maxSize) maxSize = column.ids.length;
  return Math.floor(columns.length / 2) + Math.floor(maxSize / 2);
}
