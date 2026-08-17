// 보드 공급 (§6.2 구간표 — 작업 계획 §9 · P-5. **WU-08 생성기가 `BoardSource` 구현만 교체**한다)
//
// 아래 결정적 패턴은 WU-03 회귀·미니 튜토리얼 전용으로 보존한다. 실서비스 공급원은 파일 아래의
// `proceduralBoardSource()`이며 WU-08 생성·복구·적응 파이프라인을 사용한다.

import { createChain } from '../core/chain';
import type { AdminParams } from '../core/adminParams';
import { FACTORY_ADMIN_PARAMS } from '../core/adminParams';
import {
  AdaptiveDifficulty,
  GenerationPipeline,
  type BoardBundle,
  type RecoveryReport,
} from '../core/generator';
import { Board } from '../core/puzzle';
import type { Chain, ChainId, GridPoint } from '../core/types';

// ── §6.2 난이도 구간 ───────────────────────────────────────────────────────

export type Tier = 'WARMUP' | 'RHYTHM' | 'PRESSURE' | 'MASTER' | 'ENDLESS';

/** §6.2 — 1~3 / 4~6 / 7~9 / 10~12 / 13+ */
export function tierOf(boardNumber: number): Tier {
  if (boardNumber <= 3) return 'WARMUP';
  if (boardNumber <= 6) return 'RHYTHM';
  if (boardNumber <= 9) return 'PRESSURE';
  if (boardNumber <= 12) return 'MASTER';
  return 'ENDLESS';
}

/** §8.1 우 HUD `BOARD 07 · 압박` 표기 */
export function tierLabel(tier: Tier): string {
  switch (tier) {
    case 'WARMUP':
      return '워밍업';
    case 'RHYTHM':
      return '리듬';
    case 'PRESSURE':
      return '압박';
    case 'MASTER':
      return '마스터';
    case 'ENDLESS':
      return '엔드리스';
  }
}

/** §6.2 구간별 허용 범위 — 픽스처 정합 테스트가 이 표와 실측을 대조한다 */
export interface TierRange {
  readonly chains: readonly [number, number];
  readonly safeMoves: readonly [number, number];
  readonly depth: readonly [number, number];
}

export const TIER_RANGES: Readonly<Record<Tier, TierRange>> = {
  WARMUP: { chains: [6, 12], safeMoves: [3, 5], depth: [2, 4] },
  RHYTHM: { chains: [12, 18], safeMoves: [2, 4], depth: [4, 7] },
  PRESSURE: { chains: [18, 25], safeMoves: [2, 3], depth: [7, 11] },
  MASTER: { chains: [24, 34], safeMoves: [1, 2], depth: [10, 16] },
  ENDLESS: { chains: [28, 40], safeMoves: [1, 3], depth: [12, 20] },
};

// ── 패턴 P 「행 사다리 + 세로 연결자」 (작업 계획 §9.1) ────────────────────
//
//   가로 사슬 (행 i, 열 j) : (2j, y_i) → (2j+1, y_i), 머리 RIGHT, 대표점 x = 2j+1
//                            id = 10(i+1) + j
//   세로 연결자 (행 i)     : (cx, y_i−1) → (cx, y_i) → (cx, y_i+1), 머리 DOWN
//                            id = 90 + i
//   y_i = firstY + rowGap·i
//
// 성립 근거
//   ① 교차 금지 — 가로는 x ≤ 2k−1, 연결자는 x = cx > 2k−1이라 점을 공유하지 않는다.
//      행 간격 3 ≥ 연결자 세로 폭 3이라 연결자끼리도 점을 공유하지 않는다.
//   ② 막힘 관계 — 가로 (i,j)의 진로는 행 y_i의 x > 2j+1 전 구간이므로 같은 행의 오른쪽
//      가로 전부와, 그 행에 연결자가 있으면 연결자 (cx, y_i)가 블로커다.
//   ③ 연결자 사다리 — 연결자의 진로는 x = cx를 따라 내려가며 아래 연결자 전부를 만난다.
//      따라서 가장 아래 연결자가 깊이 0, 위로 갈수록 +1이다.
//   ④ 깊이 공식 — base_i = (연결자 있으면 depth(V_i)+1, 없으면 0),
//      depth(i, j) = base_i + (k − 1 − j).  (아래 `ladderDepth`가 이 닫힌 형태다)
//   ⑤ 해법 존재 — 의존 그래프가 DAG이므로 깊이 오름차순 제거가 유효한 해법이다.
//   ⑥ 최악 조작 수 — 열 수 m = k(+연결자 열), 최대 열 크기 n = R(연결자 열은 연결자 수)이므로
//      worstCaseMoves ≤ ⌊m/2⌋ + ⌊n/2⌋다.

export interface LadderSpec {
  /** 행 수 R */
  readonly rows: number;
  /** 행당 가로 사슬 수 k */
  readonly perRow: number;
  /** 첫 행의 y */
  readonly firstY: number;
  /** 행 간격 (연결자 세로 폭 3 이상) */
  readonly rowGap: number;
  /** 연결자를 붙일 **행 인덱스** 목록 — 오름차순 */
  readonly connectorRows: readonly number[];
  /** 연결자 열의 x */
  readonly connectorX: number;
}

export function ladderRowY(spec: LadderSpec, row: number): number {
  return spec.firstY + spec.rowGap * row;
}

/** 연결자 V_i의 깊이 = **자기보다 아래에 있는 연결자 수** (근거 ③) */
export function connectorDepth(spec: LadderSpec, row: number): number {
  const index = spec.connectorRows.indexOf(row);
  if (index < 0) throw new Error(`connectorDepth: 행 ${row}에는 연결자가 없다`);
  return spec.connectorRows.length - 1 - index;
}

/** 닫힌 형태 깊이 공식 (근거 ④). 테스트가 이 값과 `dependencyDepths()` 실측을 대조한다 */
export function ladderDepth(spec: LadderSpec, row: number, col: number): number {
  const base = spec.connectorRows.includes(row) ? connectorDepth(spec, row) + 1 : 0;
  return base + (spec.perRow - 1 - col);
}

export function ladderChainId(row: number, col: number): ChainId {
  return 10 * (row + 1) + col;
}

export function connectorChainId(row: number): ChainId {
  return 90 + row;
}

function p(x: number, y: number): GridPoint {
  return { x, y };
}

/** 패턴 P로 사슬 전량을 만든다 — 가로(행·열 순) 다음 연결자(행 순) */
export function buildLadderChains(spec: LadderSpec): Chain[] {
  const chains: Chain[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    const y = ladderRowY(spec, row);
    for (let col = 0; col < spec.perRow; col += 1) {
      chains.push(
        createChain(
          ladderChainId(row, col),
          [p(2 * col, y), p(2 * col + 1, y)],
          ladderDepth(spec, row, col)
        )
      );
    }
  }
  for (const row of spec.connectorRows) {
    const y = ladderRowY(spec, row);
    const cx = spec.connectorX;
    chains.push(
      createChain(
        connectorChainId(row),
        [p(cx, y - 1), p(cx, y), p(cx, y + 1)],
        connectorDepth(spec, row)
      )
    );
  }
  return chains;
}

// ── 픽스처 보드 세트 (작업 계획 §9.2) ──────────────────────────────────────

export interface FixtureBoardSpec {
  readonly name: string;
  /** 이 보드가 대표하는 §6.2 구간. `null`이면 구간 대조 대상이 아니다(계측 전용 보드) */
  readonly tier: Tier | null;
  /** 패턴 P 사양. `chains`가 있으면 비운다 */
  readonly ladder?: LadderSpec;
  /** 패턴에 맞지 않는 수제 보드(튜토리얼) */
  readonly chains?: readonly Chain[];
  /** 순환 공급 대상인가 — 계측 전용 보드는 런에 나오지 않는다 */
  readonly rotates: boolean;
}

/** B0 — 미니 튜토리얼 전용 (§4.7). 안전수 1개(B)와 막힌 사슬 1개(A)를 한 화면에 둔다 */
export const TUTORIAL_CHAIN_SAFE: ChainId = 2;
export const TUTORIAL_CHAIN_BLOCKED: ChainId = 1;

function tutorialChains(): Chain[] {
  return [
    // A — 머리 RIGHT. 진로가 B의 점 (6,9)에서 막힌다
    createChain(TUTORIAL_CHAIN_BLOCKED, [p(2, 9), p(3, 9)], 1),
    // B — 머리 DOWN. 진로가 비어 있어 **유일한 안전수**다
    createChain(TUTORIAL_CHAIN_SAFE, [p(6, 8), p(6, 9), p(6, 10)], 0),
  ];
}

export const B0_TUTORIAL: FixtureBoardSpec = {
  name: 'B0_TUTORIAL',
  tier: null,
  chains: tutorialChains(),
  rotates: false,
};

export const B1_WARMUP: FixtureBoardSpec = {
  name: 'B1_WARMUP',
  tier: 'WARMUP',
  ladder: { rows: 3, perRow: 3, firstY: 2, rowGap: 3, connectorRows: [], connectorX: 11 },
  rotates: true,
};

export const B2_WARMUP: FixtureBoardSpec = {
  name: 'B2_WARMUP',
  tier: 'WARMUP',
  ladder: { rows: 3, perRow: 4, firstY: 2, rowGap: 3, connectorRows: [], connectorX: 11 },
  rotates: true,
};

export const B3_RHYTHM: FixtureBoardSpec = {
  name: 'B3_RHYTHM',
  tier: 'RHYTHM',
  ladder: { rows: 3, perRow: 5, firstY: 2, rowGap: 3, connectorRows: [], connectorX: 11 },
  rotates: true,
};

export const B4_RHYTHM: FixtureBoardSpec = {
  name: 'B4_RHYTHM',
  tier: 'RHYTHM',
  ladder: { rows: 4, perRow: 4, firstY: 2, rowGap: 3, connectorRows: [0, 1], connectorX: 11 },
  rotates: true,
};

export const B5_PRESSURE: FixtureBoardSpec = {
  name: 'B5_PRESSURE',
  tier: 'PRESSURE',
  ladder: { rows: 4, perRow: 5, firstY: 2, rowGap: 3, connectorRows: [0, 1, 2], connectorX: 11 },
  rotates: true,
};

/**
 * B6 — **CTL-004 계측 전용 밀집 보드**. 사슬 40개(§6.2 상한)·열 7개·최대 열 크기 6으로
 * §2.2가 상한 10을 유도한 구조를 축소 재현한다. 어떤 §6.2 구간에도 속하지 않으므로
 * 순환 공급에서 제외한다(깊이 9는 ENDLESS 하한 12에 못 미친다 — 스텁의 한계이며 WU-08 소관).
 */
export const B6_DENSE: FixtureBoardSpec = {
  name: 'B6_DENSE',
  tier: null,
  ladder: { rows: 6, perRow: 6, firstY: 1, rowGap: 3, connectorRows: [0, 1, 2, 3], connectorX: 12 },
  rotates: false,
};

export const WU03_FIXTURES: readonly FixtureBoardSpec[] = [
  B0_TUTORIAL,
  B1_WARMUP,
  B2_WARMUP,
  B3_RHYTHM,
  B4_RHYTHM,
  B5_PRESSURE,
  B6_DENSE,
];

/** 런에 실제로 나오는 보드 — 보드 번호 순으로 순환 공급된다 */
export const ROTATION: readonly FixtureBoardSpec[] = WU03_FIXTURES.filter((f) => f.rotates);

export function chainsOfSpec(spec: FixtureBoardSpec): Chain[] {
  if (spec.ladder !== undefined) return buildLadderChains(spec.ladder);
  if (spec.chains !== undefined) return spec.chains.map((c) => ({ ...c }));
  throw new Error(`chainsOfSpec: ${spec.name}에 ladder도 chains도 없다`);
}

/** **매번 새 `Board`를 만든다** — `Board`는 가변이라 재사용하면 유령 버그가 난다 (R9) */
export function buildFixtureBoard(
  spec: FixtureBoardSpec,
  boardNumber: number,
  seed: string
): Board {
  return new Board({ chains: chainsOfSpec(spec), boardNumber, seed });
}

// ── BoardSource 인계면 ─────────────────────────────────────────────────────

export interface BoardRequest {
  readonly boardNumber: number;
  readonly seed: string;
}

export interface BoardResult {
  readonly boardNumber: number;
  readonly elapsedMs: number;
  readonly mistakes: number;
}

export interface BoardSource {
  next(req: BoardRequest): Board;
  /** 전환 시작과 동시에 다음 보드를 만들어 둔다. 동기 코어이므로 호출 자체가 0.8초 예산 안에 끝난다. */
  prepare?(req: BoardRequest): void;
  /** 저장된 관리자 파라미터를 다음 생성부터 적용한다. */
  configure?(params: AdminParams): void;
  /** 적응 난이도 최근 창에 클리어 결과를 보고한다. */
  report?(result: BoardResult): void;
  bundle?(boardNumber: number): BoardBundle | null;
}

/** 재현성 시드 — WU-08 생성기가 같은 문자열로 같은 배치를 만들게 된다 (§6.6) */
export function seedFor(boardNumber: number, runSeed = 'wu03'): string {
  return `${runSeed}-b${boardNumber}`;
}

/** 보드 번호 → 순환 픽스처. WU-08 도착 시 이 함수 본문만 바뀐다 */
export function fixtureBoardSource(): BoardSource {
  return {
    next(req: BoardRequest): Board {
      const spec = ROTATION[(Math.max(1, req.boardNumber) - 1) % ROTATION.length];
      return buildFixtureBoard(spec, req.boardNumber, req.seed);
    },
  };
}

export interface ProceduralBoardSourceOptions {
  readonly params?: AdminParams;
  readonly now?: () => number;
  readonly onFallback?: (message: string) => void;
}

/** WU-08 실서비스 공급원 — 생성·복구·선행 캐시·적응 결과를 한 수명주기로 묶는다. */
export function proceduralBoardSource(options: ProceduralBoardSourceOptions = {}): BoardSource {
  let params = options.params ?? FACTORY_ADMIN_PARAMS;
  const adaptive = new AdaptiveDifficulty(params);
  const pipeline = new GenerationPipeline({
    params,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onFallback === undefined ? {} : { onFallback: options.onFallback }),
  });
  const prepared = new Map<string, RecoveryReport>();
  const bundles = new Map<number, BoardBundle>();

  const keyOf = (req: BoardRequest): string =>
    `${String(req.boardNumber)}|${req.seed}|${String(adaptive.level)}`;
  const make = (req: BoardRequest): RecoveryReport =>
    pipeline.generate(req.boardNumber, req.seed, adaptive.level);

  return {
    next(req): Board {
      const key = keyOf(req);
      const generated = prepared.get(key) ?? make(req);
      prepared.delete(key);
      bundles.set(req.boardNumber, generated.bundle);
      return generated.board;
    },
    prepare(req): void {
      const key = keyOf(req);
      if (!prepared.has(key)) prepared.set(key, make(req));
    },
    configure(next): void {
      params = next;
      adaptive.configure(params);
      pipeline.configure(params);
      prepared.clear();
    },
    report(result): void {
      const bundle = bundles.get(result.boardNumber);
      if (bundle === undefined) return;
      adaptive.record({
        ...result,
        targetMs: bundle.vector.targetMs,
      });
      // 난이도 단계가 바뀌면 이전 단계로 만든 선행 캐시는 소비하지 않는다.
      prepared.clear();
    },
    bundle(boardNumber): BoardBundle | null {
      return bundles.get(boardNumber) ?? null;
    },
  };
}

/** 미니 튜토리얼 보드 (§4.7) — 순환 공급과 분리된 전용 보드다 */
export function tutorialBoard(): Board {
  return buildFixtureBoard(B0_TUTORIAL, 0, 'wu03-tutorial');
}
