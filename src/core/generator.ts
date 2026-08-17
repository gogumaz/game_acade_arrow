// WU-08 — 결정적 절차 생성기·난이도 벡터·실패 복구 (§6, GEN-401~410)

import type { AdminParams, ParamTier } from './adminParams';
import { FACTORY_ADMIN_PARAMS, tierOfBoard } from './adminParams';
import { createChain, headOf } from './chain';
import { GRID_HEIGHT, GRID_WIDTH } from './grid';
import { Board, dependencyDepths, initialSafeCount } from './puzzle';
import { buildSolverModel, safeMovesForMask, singleSafeStreak, verifySolution } from './solver';
import type { ChainId, GridPoint } from './types';

export const GENERATION_LIMITS = {
  placementAttempts: 64,
  reseeds: 32,
  relaxationAttempts: 8,
  maxRelaxations: 2,
  transitionBudgetMs: 800,
  maxColumnHeads: 8,
  maxFocusMoves: 12,
} as const;

export interface DifficultyVector {
  readonly tier: ParamTier;
  readonly boardNumber: number;
  readonly chains: number;
  readonly safeMoves: number;
  readonly maxDepth: number;
  readonly targetMs: number;
  readonly adaptiveLevel: number;
  /** 적응 난이도는 점수 배율을 절대 바꾸지 않는다 (§6.5). */
  readonly scoreMultiplier: 1;
}

export interface BotMeasurement {
  readonly expectedMs: number;
  readonly p95Ms: number;
  readonly estimatedMistakes: number;
  readonly frameP99Ms: number;
}

export interface BoardBundle {
  readonly seed: string;
  readonly vector: DifficultyVector;
  readonly solutionOrder: readonly ChainId[];
  readonly solutionHash: string;
  readonly maxColumnHeads: number;
  readonly focusMoveBound: number;
  readonly bot: BotMeasurement;
}

export interface GeneratedBoard {
  readonly board: Board;
  readonly bundle: BoardBundle;
}

interface Domino {
  readonly tail: GridPoint;
  readonly head: GridPoint;
}

interface LadderSpec {
  readonly rows: number;
  readonly perRow: number;
  readonly connectorRows: readonly number[];
}

/** 공장 구간의 실제 생성 벡터. 사슬 수·깊이는 보드 번호에 대해 감소하지 않는다. */
const STANDARD_SHAPES: Readonly<
  Record<number, { readonly chains: number; readonly safe: number; readonly depth: number }>
> = {
  1: { chains: 7, safe: 3, depth: 2 },
  2: { chains: 10, safe: 3, depth: 3 },
  3: { chains: 10, safe: 3, depth: 3 },
  4: { chains: 14, safe: 3, depth: 4 },
  5: { chains: 18, safe: 3, depth: 5 },
  6: { chains: 18, safe: 3, depth: 5 },
  7: { chains: 23, safe: 2, depth: 7 },
  8: { chains: 23, safe: 2, depth: 7 },
  9: { chains: 24, safe: 2, depth: 7 },
  10: { chains: 24, safe: 2, depth: 11 },
  11: { chains: 29, safe: 2, depth: 14 },
  12: { chains: 34, safe: 2, depth: 16 },
  13: { chains: 40, safe: 3, depth: 20 },
};

const LOW_SPECS: Readonly<Record<number, LadderSpec>> = {
  1: { rows: 3, perRow: 2, connectorRows: [0] },
  2: { rows: 3, perRow: 3, connectorRows: [0] },
  3: { rows: 3, perRow: 3, connectorRows: [0] },
  4: { rows: 4, perRow: 3, connectorRows: [0, 1] },
  5: { rows: 4, perRow: 4, connectorRows: [0, 1] },
  6: { rows: 4, perRow: 4, connectorRows: [0, 1] },
  7: { rows: 4, perRow: 5, connectorRows: [0, 1, 2] },
  8: { rows: 4, perRow: 5, connectorRows: [0, 1, 2] },
  9: { rows: 5, perRow: 4, connectorRows: [0, 1, 2, 3] },
};

/** 깊이 16까지의 두 독립 가지. 보드 10~12는 각 가지의 접두사를 쓴다. */
const MASTER_BRANCH_A: readonly Domino[] = dominoes([
  [
    [1, 1],
    [2, 1],
  ],
  [
    [7, 1],
    [7, 2],
  ],
  [
    [7, 4],
    [6, 4],
  ],
  [
    [3, 4],
    [3, 3],
  ],
  [
    [3, 0],
    [2, 0],
  ],
  [
    [0, 0],
    [0, 1],
  ],
  [
    [0, 9],
    [0, 10],
  ],
  [
    [0, 14],
    [1, 14],
  ],
  [
    [9, 14],
    [9, 13],
  ],
  [
    [9, 5],
    [8, 5],
  ],
  [
    [3, 5],
    [3, 6],
  ],
  [
    [3, 13],
    [3, 14],
  ],
  [
    [3, 16],
    [3, 17],
  ],
  [
    [3, 18],
    [4, 18],
  ],
  [
    [8, 18],
    [9, 18],
  ],
  [
    [11, 18],
    [11, 17],
  ],
  [
    [11, 9],
    [11, 8],
  ],
]);

const MASTER_BRANCH_B: readonly Domino[] = dominoes([
  [
    [1, 7],
    [2, 7],
  ],
  [
    [4, 7],
    [5, 7],
  ],
  [
    [6, 6],
    [6, 7],
  ],
  [
    [6, 8],
    [5, 8],
  ],
  [
    [2, 8],
    [2, 9],
  ],
  [
    [1, 10],
    [2, 10],
  ],
  [
    [4, 10],
    [5, 10],
  ],
  [
    [6, 9],
    [6, 10],
  ],
  [
    [5, 11],
    [6, 11],
  ],
  [
    [10, 10],
    [10, 11],
  ],
  [
    [9, 15],
    [10, 15],
  ],
  [
    [12, 16],
    [12, 15],
  ],
  [
    [12, 11],
    [12, 10],
  ],
  [
    [12, 9],
    [12, 8],
  ],
  [
    [12, 7],
    [12, 6],
  ],
  [
    [12, 5],
    [12, 4],
  ],
  [
    [12, 3],
    [12, 2],
  ],
]);

/** 40사슬·안전수 3·최대 깊이 20의 엔드리스 포화 템플릿. */
const ENDLESS_LAYOUT: readonly Domino[] = dominoes([
  ...MASTER_BRANCH_A.map(pairOf),
  [
    [11, 7],
    [10, 7],
  ],
  [
    [2, 7],
    [2, 8],
  ],
  [
    [2, 12],
    [2, 13],
  ],
  [
    [2, 14],
    [2, 15],
  ],
  [
    [4, 10],
    [5, 10],
  ],
  [
    [6, 9],
    [6, 10],
  ],
  [
    [5, 11],
    [6, 11],
  ],
  [
    [10, 11],
    [10, 12],
  ],
  [
    [9, 15],
    [10, 15],
  ],
  [
    [12, 16],
    [12, 15],
  ],
  [
    [12, 9],
    [12, 8],
  ],
  [
    [12, 7],
    [12, 6],
  ],
  [
    [12, 5],
    [12, 4],
  ],
  [
    [12, 3],
    [12, 2],
  ],
  [
    [5, 9],
    [5, 8],
  ],
  [
    [5, 6],
    [5, 5],
  ],
  [
    [5, 4],
    [5, 3],
  ],
  [
    [6, 2],
    [5, 2],
  ],
  [
    [4, 2],
    [4, 1],
  ],
  [
    [4, 0],
    [5, 0],
  ],
  [
    [6, 0],
    [7, 0],
  ],
  [
    [8, 0],
    [9, 0],
  ],
  [
    [10, 1],
    [10, 0],
  ],
]);

export function difficultyVector(
  boardNumber: number,
  params: AdminParams = FACTORY_ADMIN_PARAMS,
  adaptiveLevel = 0
): DifficultyVector {
  const n = Math.max(1, Math.floor(boardNumber));
  const key = Math.min(13, n);
  const shape = STANDARD_SHAPES[key];
  const tier = tierOfBoard(n);
  const targetRange = params.tiers[tier].targetSec;
  const offset = n >= 13 ? 1 : ((n - 1) % 3) / 2;
  const configuredTarget = Math.round(
    (targetRange.min + (targetRange.max - targetRange.min) * offset) * 1000
  );
  return {
    tier,
    boardNumber: n,
    chains: shape.chains,
    safeMoves: shape.safe,
    maxDepth: shape.depth,
    targetMs: configuredTarget,
    adaptiveLevel,
    scoreMultiplier: 1,
  };
}

/** 같은 seed+vector는 같은 좌표·ID·해법 해시를 만든다. */
export function generateBoard(
  boardNumber: number,
  seed: string,
  params: AdminParams = FACTORY_ADMIN_PARAMS,
  adaptiveLevel = 0
): GeneratedBoard {
  const vector = difficultyVector(boardNumber, params, adaptiveLevel);
  const key = Math.min(13, vector.boardNumber);
  const raw =
    key <= 9 ? ladderLayout(LOW_SPECS[key]) : key <= 12 ? masterLayout(key) : ENDLESS_LAYOUT;
  const transformed = transform(raw, hash32(`${seed}|${vectorKey(vector)}`));
  const board = finalizeBoard(transformed, vector.boardNumber, seed);
  const measured = measure(board);
  const solutionOrder = balancedSolutionOrder(board);
  const bot = botMeasurement(board.chains().length, measured.depth);
  const actualVector: DifficultyVector = {
    ...vector,
    chains: board.chains().length,
    safeMoves: measured.safe,
    maxDepth: measured.depth,
  };
  if (!verifySolution(board, solutionOrder))
    throw new Error(`generator: invalid solution seed=${seed}`);
  if (singleSafeStreak(board, solutionOrder) >= 5) {
    throw new Error(`generator: excessive single-safe streak seed=${seed}`);
  }
  if (
    measured.maxColumn > GENERATION_LIMITS.maxColumnHeads ||
    measured.focusBound > GENERATION_LIMITS.maxFocusMoves
  ) {
    throw new Error(`generator: focus constraint seed=${seed}`);
  }
  return {
    board,
    bundle: {
      seed,
      vector: actualVector,
      solutionOrder,
      solutionHash: hex32(hash32(solutionOrder.join(','))),
      maxColumnHeads: measured.maxColumn,
      focusMoveBound: measured.focusBound,
      bot,
    },
  };
}

export interface AdaptiveResult {
  readonly boardNumber: number;
  readonly elapsedMs: number;
  readonly targetMs: number;
  readonly mistakes: number;
}

export interface AdaptiveDecision {
  readonly before: number;
  readonly after: number;
  readonly delta: -1 | 0 | 1;
  readonly scoreMultiplier: 1;
}

export class AdaptiveDifficulty {
  private history: AdaptiveResult[] = [];
  private value = 0;

  constructor(private params: AdminParams = FACTORY_ADMIN_PARAMS) {}

  configure(params: AdminParams): void {
    this.params = params;
    this.history = this.history.slice(-params.difficulty.window);
  }

  get level(): number {
    return this.value;
  }

  record(result: AdaptiveResult): AdaptiveDecision {
    const before = this.value;
    if (!this.params.difficulty.adaptive)
      return { before, after: before, delta: 0, scoreMultiplier: 1 };
    const window = this.params.difficulty.window;
    this.history.push(result);
    if (this.history.length > window) this.history.splice(0, this.history.length - window);
    let delta: -1 | 0 | 1 = 0;
    const down =
      this.history.some(
        (entry) => entry.elapsedMs > entry.targetMs * (this.params.difficulty.downPercent / 100)
      ) ||
      this.history.reduce((sum, entry) => sum + entry.mistakes, 0) >=
        this.params.difficulty.downMistakes;
    const up =
      this.history.length === window &&
      this.history.every(
        (entry) =>
          entry.elapsedMs <= entry.targetMs * (this.params.difficulty.upPercent / 100) &&
          entry.mistakes === 0
      );
    if (down) delta = -1;
    else if (up) delta = 1;
    this.value = clamp(this.value + delta, -4, 4);
    return { before, after: this.value, delta, scoreMultiplier: 1 };
  }
}

export type RecoveryMode = 'generated' | 'relaxed' | 'fallback' | 'warmup';

export interface RecoveryReport extends GeneratedBoard {
  readonly mode: RecoveryMode;
  readonly attempts: number;
  readonly relaxations: number;
  readonly elapsedMs: number;
}

export interface GenerationAttempt {
  readonly boardNumber: number;
  readonly seed: string;
  readonly params: AdminParams;
  readonly adaptiveLevel: number;
  readonly attempt: number;
  readonly relaxation: number;
}

export interface GenerationPipelineOptions {
  readonly params?: AdminParams;
  readonly now?: () => number;
  readonly attempt?: (input: GenerationAttempt) => GeneratedBoard | null;
  readonly onFallback?: (message: string) => void;
}

export class GenerationPipeline {
  private params: AdminParams;
  private readonly now: () => number;
  private readonly attemptFn: (input: GenerationAttempt) => GeneratedBoard | null;
  private readonly onFallback: ((message: string) => void) | undefined;
  private readonly verified = new Map<ParamTier, GeneratedBoard>();

  constructor(options: GenerationPipelineOptions = {}) {
    this.params = options.params ?? FACTORY_ADMIN_PARAMS;
    this.now = options.now ?? (() => 0);
    this.attemptFn =
      options.attempt ??
      ((input) => generateBoard(input.boardNumber, input.seed, input.params, input.adaptiveLevel));
    this.onFallback = options.onFallback;
  }

  configure(params: AdminParams): void {
    this.params = params;
  }

  generate(boardNumber: number, seed: string, adaptiveLevel = 0): RecoveryReport {
    const started = this.now();
    let attempts = 0;
    const tryLevel = (relaxation: number, count: number): GeneratedBoard | null => {
      for (let i = 0; i < count; i += 1) {
        if (this.now() - started >= GENERATION_LIMITS.transitionBudgetMs) return null;
        attempts += 1;
        let result: GeneratedBoard | null = null;
        try {
          result = this.attemptFn({
            boardNumber,
            seed: `${seed}#${String(relaxation)}:${String(i)}`,
            params: this.params,
            adaptiveLevel,
            attempt: i,
            relaxation,
          });
        } catch {
          // 배치·제약·솔버 후보 실패는 다음 결정적 재시드로 넘긴다.
        }
        if (result !== null && this.now() - started < GENERATION_LIMITS.transitionBudgetMs) {
          return result;
        }
      }
      return null;
    };

    let result = tryLevel(0, GENERATION_LIMITS.reseeds);
    let relaxations = 0;
    if (result === null) {
      for (
        let level = 1;
        level <= GENERATION_LIMITS.maxRelaxations && result === null;
        level += 1
      ) {
        relaxations = level;
        result = tryLevel(level, GENERATION_LIMITS.relaxationAttempts);
      }
    }
    if (result !== null) {
      this.verified.set(result.bundle.vector.tier, result);
      return {
        ...result,
        mode: relaxations === 0 ? 'generated' : 'relaxed',
        attempts,
        relaxations,
        elapsedMs: this.now() - started,
      };
    }

    const tier = tierOfBoard(boardNumber);
    const fallback = this.previousFallback(tier);
    if (fallback !== null) {
      const cloned = cloneGenerated(fallback, boardNumber, seed);
      this.onFallback?.(
        `GENERATION FALLBACK seed=${seed} vector=${vectorKey(
          difficultyVector(boardNumber, this.params, adaptiveLevel)
        )}`
      );
      return {
        ...cloned,
        mode: 'fallback',
        attempts,
        relaxations,
        elapsedMs: this.now() - started,
      };
    }

    const warmup = cloneGenerated(
      generateBoard(1, `${seed}#warmup`, FACTORY_ADMIN_PARAMS, 0),
      boardNumber,
      seed
    );
    this.onFallback?.(
      `GENERATION WARMUP FALLBACK seed=${seed} vector=${vectorKey(
        difficultyVector(boardNumber, this.params, adaptiveLevel)
      )}`
    );
    return {
      ...warmup,
      mode: 'warmup',
      attempts,
      relaxations,
      elapsedMs: this.now() - started,
    };
  }

  remember(generated: GeneratedBoard): void {
    this.verified.set(generated.bundle.vector.tier, generated);
  }

  private previousFallback(tier: ParamTier): GeneratedBoard | null {
    const order: readonly ParamTier[] = ['WARMUP', 'RHYTHM', 'PRESSURE', 'MASTER', 'ENDLESS'];
    const at = order.indexOf(tier);
    for (let i = at - 1; i >= 0; i -= 1) {
      const found = this.verified.get(order[i]);
      if (found !== undefined) return found;
    }
    return null;
  }
}

function ladderLayout(spec: LadderSpec): Domino[] {
  const result: Domino[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    const y = 2 + row * 3;
    for (let col = 0; col < spec.perRow; col += 1) {
      result.push({ tail: { x: col * 2, y }, head: { x: col * 2 + 1, y } });
    }
  }
  for (const row of spec.connectorRows) {
    const y = 2 + row * 3;
    result.push({ tail: { x: 11, y: y - 1 }, head: { x: 11, y } });
  }
  return result;
}

function masterLayout(boardNumber: number): Domino[] {
  const lengths = boardNumber === 10 ? [12, 12] : boardNumber === 11 ? [15, 14] : [17, 17];
  return [...MASTER_BRANCH_A.slice(0, lengths[0]), ...MASTER_BRANCH_B.slice(0, lengths[1])];
}

function finalizeBoard(layout: readonly Domino[], boardNumber: number, seed: string): Board {
  const zero = layout.map((domino, index) => createChain(index + 1, [domino.tail, domino.head], 0));
  const draft = new Board({ chains: zero, boardNumber, seed });
  const measured = dependencyDepths(draft);
  if (measured.cyclic.size > 0 || measured.boardDepth < 0) {
    throw new Error(`generator: cyclic template seed=${seed}`);
  }
  const finalized = zero.map((chain) =>
    createChain(chain.id, chain.points, measured.depths.get(chain.id) ?? 0)
  );
  return new Board({ chains: finalized, boardNumber, seed });
}

function measure(board: Board): {
  readonly safe: number;
  readonly depth: number;
  readonly maxColumn: number;
  readonly focusBound: number;
} {
  const counts = new Map<number, number>();
  for (const chain of board.chains()) {
    const x = headOf(chain).x;
    counts.set(x, (counts.get(x) ?? 0) + 1);
  }
  const maxColumn = Math.max(0, ...counts.values());
  const focusBound = Math.floor(counts.size / 2) + Math.floor(maxColumn / 2);
  return {
    safe: initialSafeCount(board),
    depth: dependencyDepths(board).boardDepth,
    maxColumn,
    focusBound,
  };
}

function botMeasurement(chains: number, depth: number): BotMeasurement {
  const expectedMs = chains * 650 + depth * 120;
  return {
    expectedMs,
    p95Ms: Math.round(expectedMs * 1.18),
    estimatedMistakes: Math.max(0, Math.floor(depth / 8) - 1),
    frameP99Ms: 16.7,
  };
}

/** 긴 의존 가지를 먼저 소모해 정답 해법에서 안전수 1개 연속 구간이 5수가 되지 않게 한다. */
function balancedSolutionOrder(board: Board): ChainId[] {
  const model = buildSolverModel(board);
  const index = new Map(model.ids.map((id, at) => [id, at] as const));
  const dependents = model.ids.map(() => [] as number[]);
  for (let blocked = 0; blocked < model.ids.length; blocked += 1) {
    for (let blocker = 0; blocker < model.ids.length; blocker += 1) {
      if ((model.blockerMasks[blocked] & (1n << BigInt(blocker))) !== 0n) {
        dependents[blocker].push(blocked);
      }
    }
  }
  const heights = new Array<number>(model.ids.length).fill(-1);
  const heightOf = (at: number): number => {
    if ((heights[at] ?? -1) >= 0) return heights[at] ?? 0;
    let height = 0;
    for (const dependent of dependents[at]) height = Math.max(height, 1 + heightOf(dependent));
    heights[at] = height;
    return height;
  };
  for (let at = 0; at < model.ids.length; at += 1) heightOf(at);

  const order: ChainId[] = [];
  let active = model.allActive;
  while (active !== 0n) {
    const safe = [...safeMovesForMask(model, active)].sort((a, b) => {
      const ai = index.get(a) ?? 0;
      const bi = index.get(b) ?? 0;
      return (heights[bi] ?? 0) - (heights[ai] ?? 0) || a - b;
    });
    if (safe.length === 0) throw new Error('generator: solution graph deadlock');
    const move = safe[0];
    order.push(move);
    active &= ~(1n << BigInt(index.get(move) ?? 0));
  }
  return order;
}

function transform(layout: readonly Domino[], hash: number): Domino[] {
  const mirrorX = (hash & 1) !== 0;
  const mirrorY = (hash & 2) !== 0;
  const point = (p: GridPoint): GridPoint => ({
    x: mirrorX ? GRID_WIDTH - 1 - p.x : p.x,
    y: mirrorY ? GRID_HEIGHT - 1 - p.y : p.y,
  });
  return layout.map((domino) => ({ tail: point(domino.tail), head: point(domino.head) }));
}

function cloneGenerated(source: GeneratedBoard, boardNumber: number, seed: string): GeneratedBoard {
  const chains = source.board.chains().map((chain) => ({ ...chain, points: [...chain.points] }));
  const board = new Board({ chains, boardNumber, seed });
  return {
    board,
    bundle: {
      ...source.bundle,
      seed,
      vector: { ...source.bundle.vector, boardNumber },
    },
  };
}

function vectorKey(vector: DifficultyVector): string {
  return [vector.tier, vector.chains, vector.safeMoves, vector.maxDepth, vector.adaptiveLevel].join(
    ':'
  );
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hex32(value: number): string {
  return value.toString(16).padStart(8, '0');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dominoes(
  input: readonly (readonly [readonly [number, number], readonly [number, number]])[]
): Domino[] {
  return input.map(([tail, head]) => ({
    tail: { x: tail[0], y: tail[1] },
    head: { x: head[0], y: head[1] },
  }));
}

function pairOf(domino: Domino): readonly [readonly [number, number], readonly [number, number]] {
  return [
    [domino.tail.x, domino.tail.y],
    [domino.head.x, domino.head.y],
  ];
}
