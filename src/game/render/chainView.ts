// 보드 그리기 — 격자·사슬·포커스·진로 프리뷰·슬라이드 아웃·막힘 진동 (§2.3 · §9.1 · §9.2)
//
// **기능적 최소 연출만** 한다: 색·굵기·점선·이동·진동. 파티클·잔상 꼬리·파동·슬로모션은 WU-07이다.
// 슬라이드 아웃 시간은 코어가 준 `RemovalView.durationMs`를 그대로 쓴다 — 직접 계산하지 않는다(§3.4).

import Phaser from 'phaser';
import { headDirection } from '../../core/chain';
import { DIRECTION_VECTORS } from '../../core/grid';
import type { Chain, Direction, GridPoint } from '../../core/types';
import type { ChainView, RunSnapshot } from '../runController';
import { BLOCK_SHAKE_MS, HINT_BREATH_MS } from '../timing';
import { FX_TIMING, MAX_FULL_EFFECTS, type ChainVisualState } from '../fx';
import {
  BOARD_HEIGHT,
  BOARD_ORIGIN,
  BOARD_WIDTH,
  LINE,
  PALETTE,
  lerpPath,
  toScreenXY,
} from './boardView';

/** 막힘 진동 ±6px 2회 (§9.2 실패 100~500ms 구간) */
const SHAKE_PX = 6;
const SHAKE_CYCLES = 2;

/** 진로 프리뷰 점선의 한 칸당 점 개수 */
const DASH_PER_CELL = 3;

export class BoardPainter {
  private readonly grid: Phaser.GameObjects.Graphics;
  private readonly chains: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene) {
    this.grid = scene.add.graphics();
    this.chains = scene.add.graphics();
    this.drawGrid();
  }

  destroy(): void {
    this.grid.destroy();
    this.chains.destroy();
  }

  setVisible(visible: boolean): void {
    this.grid.setVisible(visible);
    this.chains.setVisible(visible);
  }

  /** 매 프레임 전체 다시 그린다 — 사슬 40개 규모라 부분 갱신이 필요 없다 */
  draw(
    run: RunSnapshot,
    now: number,
    options: { readonly motionReduced?: boolean; readonly performanceSimplified?: boolean } = {}
  ): void {
    const g = this.chains;
    g.clear();
    const motionReduced = options.motionReduced === true;
    const simplifyEveryEffect = motionReduced || options.performanceSimplified === true;

    const removing = new Set(run.removing.map((r) => r.chainId));
    // ① 진로 프리뷰(가장 아래) — 막힘 여부는 표시하지 않는다 (§2.3)
    this.drawPathPreview(g, run.focusPath);

    // ② 정지 상태 사슬
    for (const chain of run.chains) {
      if (chain.state === 'removed' || removing.has(chain.id)) continue;
      this.drawChain(g, chain, run, now, motionReduced);
    }

    this.drawBlockerFlash(g, run, now, motionReduced);

    // ③ 슬라이드 아웃 중인 사슬 (경로 추종)
    for (const [removalIndex, removal] of run.removing.entries()) {
      // EFX-807: 앞선 6개는 본 연출을 유지하고 7번째부터 잔상만 생략한다.
      const simplified = simplifyEveryEffect || removalIndex >= MAX_FULL_EFFECTS;
      const travel = Math.max(0, removal.exitPath.length);
      const progress = Math.min(1, Math.max(0, (now - removal.startedAtMs) / removal.durationMs));
      const combined = [...removal.points, ...removal.exitPath];
      const offset = progress * travel;
      const moved = removal.points.map((_, i) => lerpPath(combined, i + offset));
      if (!simplified) {
        // 성공 궤적: 바이올렛 → 시안 길이 비례 잔상. 단일 Graphics라 객체 수가 늘지 않는다.
        for (let trail = 3; trail >= 1; trail -= 1) {
          const trailOffset = Math.max(0, offset - trail * 0.16);
          const trailMoved = removal.points.map((_, i) => lerpPath(combined, i + trailOffset));
          const color = trail >= 2 ? PALETTE.successTrail : PALETTE.focus;
          this.strokePolyline(
            g,
            trailMoved,
            LINE.base + trail,
            color,
            (0.2 / trail) * (1 - progress)
          );
        }
      }
      this.strokePolyline(
        g,
        moved,
        LINE.base,
        simplified ? PALETTE.focus : PALETTE.successTrail,
        1 - progress * 0.4
      );
    }
  }

  private drawChain(
    g: Phaser.GameObjects.Graphics,
    chain: ChainView,
    run: RunSnapshot,
    now: number,
    motionReduced: boolean
  ): void {
    const blocked = chain.state === 'blocked';
    const focused = chain.isFocus;
    const visualState: ChainVisualState = chain.isHint
      ? 'hint'
      : blocked
        ? 'blocked'
        : focused
          ? 'focus'
          : 'base';
    const color =
      visualState === 'hint'
        ? PALETTE.hint
        : visualState === 'blocked'
          ? PALETTE.blocked
          : visualState === 'focus'
            ? PALETTE.focus
            : PALETTE.chain;
    const width = visualState === 'focus' ? LINE.focus : LINE.base;

    // §9.2 실패 — 좌우 진동 ±6px 2회
    let shakeX = 0;
    const block = run.lastBlock;
    if (block !== null && block.chainId === chain.id) {
      const elapsed = now - block.atMs;
      if (!motionReduced && elapsed >= 0 && elapsed < BLOCK_SHAKE_MS) {
        const phase = (elapsed / BLOCK_SHAKE_MS) * SHAKE_CYCLES * Math.PI * 2;
        shakeX = Math.sin(phase) * SHAKE_PX;
      }
    }

    const pts = chain.points.map((p) => ({ x: p.x, y: p.y }));
    // 외곽 2px 테두리 — 배경·인접 사슬과 분리한다 (§2.3 · §9.1)
    this.strokePolyline(g, pts, width + LINE.outline * 2, PALETTE.background, 1, shakeX);
    this.strokePolyline(g, pts, width, color, 1, shakeX);
    // 중심광 — 색각 대응으로 색 외 단서를 하나 더 얹는다 (§8.3)
    this.strokePolyline(g, pts, Math.max(2, width * 0.25), PALETTE.chainCore, 0.5, shakeX);

    // §7.1 힌트 — 앰버 호흡형 외곽선 (주기 1200ms)
    if (chain.isHint) {
      const breath = motionReduced
        ? 0.9
        : 0.45 + 0.45 * (0.5 + 0.5 * Math.sin((now / HINT_BREATH_MS) * Math.PI * 2));
      this.strokePolyline(g, pts, width + LINE.outline * 4, PALETTE.hint, breath, shakeX);
    }

    this.drawArrowHead(g, chain, color, width, shakeX);
  }

  /** §9.2 실패 100~500ms — 막힌 사슬에서 첫 블로커 방향으로 1회 선형 플래시. */
  private drawBlockerFlash(
    g: Phaser.GameObjects.Graphics,
    run: RunSnapshot,
    now: number,
    motionReduced: boolean
  ): void {
    const block = run.lastBlock;
    if (block === null || block.blockers.length === 0) return;
    const elapsed = now - block.atMs;
    if (elapsed < 0 || elapsed >= FX_TIMING.bodyMaxMs) return;
    const from = run.chains.find((chain) => chain.id === block.chainId);
    const to = run.chains.find((chain) => chain.id === block.blockers[0]);
    if (from === undefined || to === undefined) return;
    const a = toScreenXY(
      from.points[from.points.length - 1].x,
      from.points[from.points.length - 1].y
    );
    const b = toScreenXY(to.points[to.points.length - 1].x, to.points[to.points.length - 1].y);
    const alpha = motionReduced ? 0.7 : 1 - elapsed / FX_TIMING.bodyMaxMs;
    g.lineStyle(5, PALETTE.blocked, alpha);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.strokePath();
    g.fillStyle(PALETTE.blocked, alpha);
    g.fillCircle(b.x, b.y, 10);
  }

  /** §2.3 대표점 마커 — 화살촉 위 삼각형(본체 1.6배)으로 빠질 방향을 읽게 한다 */
  private drawArrowHead(
    g: Phaser.GameObjects.Graphics,
    chain: ChainView,
    color: number,
    width: number,
    shakeX: number
  ): void {
    const dir = headDirectionOf(chain);
    const head = chain.points[chain.points.length - 1];
    const center = toScreenXY(head.x, head.y);
    const v = DIRECTION_VECTORS[dir];
    const size = width * LINE.arrowScale;
    const tipX = center.x + shakeX + v.dx * size;
    const tipY = center.y + v.dy * size;
    // 진행 방향에 수직인 밑변
    const px = -v.dy;
    const py = v.dx;
    g.fillStyle(color, 1);
    g.fillTriangle(
      tipX,
      tipY,
      center.x + shakeX + px * size * 0.7,
      center.y + py * size * 0.7,
      center.x + shakeX - px * size * 0.7,
      center.y - py * size * 0.7
    );
  }

  /** §2.3 — 포커스 사슬의 진로 `R(S)`를 점선으로 흐리게. 막힘 여부는 담지 않는다 */
  private drawPathPreview(g: Phaser.GameObjects.Graphics, path: readonly GridPoint[]): void {
    if (path.length === 0) return;
    g.fillStyle(PALETTE.focus, 0.35);
    for (let i = 0; i < path.length; i += 1) {
      for (let d = 0; d < DASH_PER_CELL; d += 1) {
        const prev = i === 0 ? path[0] : path[i - 1];
        const t = d / DASH_PER_CELL;
        const x = prev.x + (path[i].x - prev.x) * t;
        const y = prev.y + (path[i].y - prev.y) * t;
        const s = toScreenXY(x, y);
        g.fillCircle(s.x, s.y, 3);
      }
    }
  }

  private strokePolyline(
    g: Phaser.GameObjects.Graphics,
    points: readonly { x: number; y: number }[],
    width: number,
    color: number,
    alpha: number,
    shakeX = 0
  ): void {
    if (points.length < 2) return;
    g.lineStyle(width, color, alpha);
    g.beginPath();
    const first = toScreenXY(points[0].x, points[0].y);
    g.moveTo(first.x + shakeX, first.y);
    for (let i = 1; i < points.length; i += 1) {
      const s = toScreenXY(points[i].x, points[i].y);
      g.lineTo(s.x + shakeX, s.y);
    }
    g.strokePath();
  }

  /** 격자 점선 — 보드 구조만 암시하고 사슬 판독을 방해하지 않는다 (§9.1) */
  private drawGrid(): void {
    const g = this.grid;
    g.fillStyle(PALETTE.grid, 1);
    for (let x = 0; x <= 12; x += 1) {
      for (let y = 0; y <= 18; y += 1) {
        const s = toScreenXY(x, y);
        g.fillCircle(s.x, s.y, 2);
      }
    }
    g.lineStyle(2, PALETTE.grid, 0.6);
    g.strokeRect(BOARD_ORIGIN.x, BOARD_ORIGIN.y, BOARD_WIDTH, BOARD_HEIGHT);
  }
}

/** `ChainView`는 코어 `Chain`의 부분집합이라 머리 방향 계산을 그대로 재사용한다 */
function headDirectionOf(chain: ChainView): Direction {
  return headDirection({
    id: chain.id,
    points: chain.points,
    length: chain.points.length,
    bends: 0,
    depth: chain.depth,
  } satisfies Chain);
}
