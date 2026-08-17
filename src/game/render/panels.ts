// 화면별 문구와 패널 레이아웃 (§8.4 문구 원칙 · 작업 계획 §10.2)
//
// **게임 문자열은 이 파일 1곳에만 있다.** 씬은 문구를 만들지 않고 여기서 받은 줄 배열만 그린다.
// 1차 언어는 한국어이며 `SCORE`·`CREDIT`처럼 아케이드 관용 영문만 예외다 (§8.3 혼합 언어).

import Phaser from 'phaser';
import type { FlowSnapshot } from '../flow';
import { tipFor } from '../grade';
import type { RankingEntry } from '../rankingStore';
import { paidBlockedMessage } from '../safety';
import {
  CSS,
  FONT_FAMILY,
  FONT_SIZE,
  LAYOUT,
  formatCombo,
  formatCountdown,
  formatScore,
} from './boardView';

interface PanelText {
  readonly title: string;
  readonly lines: readonly string[];
}

const EMPTY_RANK = '— — —';

function rankLine(index: number, e: RankingEntry): string {
  const cont = e.continues > 0 ? ` C${e.continues}` : '';
  return `${(index + 1).toString().padStart(2, ' ')}  ${e.initials}  ${formatScore(e.score)}  B${e.board}${cont}`;
}

function topTenLines(ranking: readonly RankingEntry[]): string[] {
  if (ranking.length === 0) return [EMPTY_RANK];
  return ranking.map((e, i) => rankLine(i, e));
}

/** §4.6 · P-9 — 어트랙트 3패널: ① 조작·가격 ② 오늘의 1위 ③ TOP 10 */
export function attractPanel(snap: FlowSnapshot, coinsPerPlay: number): PanelText {
  const best = snap.bestToday;
  switch (snap.attractPanel) {
    case 1:
      return {
        title: '오늘의 1위',
        lines: [
          best === null ? '아직 기록이 없습니다' : `${best.initials}   ${formatScore(best.score)}`,
          best === null ? '' : `도달 보드 ${best.board}`,
        ],
      };
    case 2:
      return { title: 'TOP 10', lines: topTenLines(snap.ranking) };
    default:
      return {
        title: 'ARROW OUT',
        lines: ['레버로 고르고, 우측 버튼으로 당긴다', '', `${coinsPerPlay} CREDIT`],
      };
  }
}

/**
 * §12.4 — 유료 플레이가 막혀 있으면 어트랙트·READY가 사유를 표시한다 (WU-06 P-5).
 * 문제·영향·다음 행동 3요소는 `paidBlockedMessage()`가 만든다.
 */
export function paidBlockedLine(snap: FlowSnapshot): string | null {
  return snap.paidBlockReason === null ? null : paidBlockedMessage(snap.paidBlockReason);
}

/** §8.4 — 가격과 다음 행동을 함께, 지시는 1개만 */
export function readyPanel(coinsPerPlay: number, blocked: string | null = null): PanelText {
  if (blocked !== null) return { title: 'READY', lines: [blocked, '크레딧은 그대로 유지됩니다'] };
  return { title: 'READY', lines: [`${coinsPerPlay} CREDIT — START를 누르세요`] };
}

export function tutorialPanel(): PanelText {
  return { title: '', lines: ['빛나는 사슬을 당겨 보세요'] };
}

/** §8.4 — 종료 사유를 구분하고 남은 초를 항상 표시 (작업 계획 Q-6) */
export function continuePanel(snap: FlowSnapshot): PanelText {
  const reason = snap.endReason;
  const title = reason === 'hearts' ? 'HEART OUT' : reason === 'time' ? 'TIME UP' : 'GAME OVER';
  const seconds = formatCountdown(snap.countdownMs);
  return {
    title,
    lines: [
      snap.canContinue
        ? `우측 버튼으로 이어하기 · ${seconds}`
        : `코인을 넣으면 이어서 합니다 · ${seconds}`,
      '좌측 버튼 — 종료',
    ],
  };
}

/** §8.4 — 등급 + 점수 + 도달 보드 + 개선 팁 1개 */
export function resultPanel(snap: FlowSnapshot): PanelText {
  const r = snap.result;
  if (r === null) return { title: 'RESULT', lines: [] };
  return {
    title: r.grade,
    lines: [
      `SCORE  ${formatScore(r.score)}`,
      `도달 보드 ${r.boardReached}`,
      `최고 콤보 ${formatCombo(r.maxComboCentis)}`,
      r.continues > 0 ? `컨티뉴 ${r.continues}회` : '',
      '',
      tipFor(r.tip),
    ],
  };
}

export function nameEntryPanel(snap: FlowSnapshot): PanelText {
  const entry = snap.nameEntry;
  const seconds = formatCountdown(snap.countdownMs);
  const value = entry === null ? '   ' : entry.value;
  const cursor = entry === null ? 0 : entry.cursor;
  // 글자와 커서를 같은 4칸 간격으로 짜야 caret이 정확히 아래에 선다 (§8.3 잘림·정렬)
  const gap = '    ';
  return {
    title: `TOP 10 진입! 이름을 입력하세요 · ${seconds}`,
    lines: [
      value.split('').join(gap),
      [0, 1, 2].map((i) => (i === cursor ? '^' : ' ')).join(gap),
      '',
      '레버 상하 = 문자 · 좌우 = 자리 · 우측 = 확정',
    ],
  };
}

/** WU-05가 실체를 채운다 (착수 리포트 §3) */
export function adminPanel(): PanelText {
  return { title: 'ADMIN — 준비 중 (WU-05)', lines: ['좌측 버튼으로 돌아가기'] };
}

/** 인게임 중앙 문구 — 보드 영역의 유일한 오버레이 예외다 (§8.1) */
export function blockedMessage(): string {
  return '막혔습니다 — 앞을 가로막은 사슬을 먼저';
}

export function clearMessage(perfect: boolean, bonus: number): string {
  return perfect ? `PERFECT · +${bonus.toLocaleString('en-US')}` : 'CLEAR';
}

/**
 * §12.3 SAFE PAUSE — 보드 위 중앙 문구 (WU-06 P-7).
 * 정지 중에는 사유를, 해제 후에는 남은 초를 보여 준다. 연출은 WU-07이다.
 */
export function safePauseMessage(snap: FlowSnapshot): string {
  return snap.safePause.text;
}

const MAX_LINES = 12;

/** 제목 1줄 + 본문 N줄을 화면 중앙에 쌓는다 */
export class TextPanel {
  private readonly title: Phaser.GameObjects.Text;
  private readonly lines: Phaser.GameObjects.Text[] = [];

  constructor(
    scene: Phaser.Scene,
    private readonly centerY = LAYOUT.centerY - 160,
    private readonly titleSize: number = FONT_SIZE.headline
  ) {
    this.title = scene.add
      .text(LAYOUT.centerX, this.centerY, '', {
        fontFamily: FONT_FAMILY,
        fontSize: `${titleSize}px`,
        color: CSS.focus,
      })
      .setOrigin(0.5);
    for (let i = 0; i < MAX_LINES; i += 1) {
      this.lines.push(
        scene.add
          .text(LAYOUT.centerX, this.centerY + 110 + i * 44, '', {
            fontFamily: FONT_FAMILY,
            fontSize: `${FONT_SIZE.label}px`,
            color: CSS.text,
          })
          .setOrigin(0.5)
      );
    }
  }

  set(text: PanelText): void {
    this.fit(this.title, text.title, this.titleSize, FONT_SIZE.label, 1760);
    for (let i = 0; i < MAX_LINES; i += 1) {
      this.fit(
        this.lines[i],
        i < text.lines.length ? text.lines[i] : '',
        FONT_SIZE.label,
        FONT_SIZE.body,
        1760
      );
    }
  }

  destroy(): void {
    this.title.destroy();
    for (const line of this.lines) line.destroy();
  }

  /** EFX-811 — 고정 폭을 넘으면 최소 22px까지 단계적으로 줄여 잘림을 막는다. */
  private fit(
    target: Phaser.GameObjects.Text,
    value: string,
    baseSize: number,
    minSize: number,
    maxWidth: number
  ): void {
    target.setText(value).setFontSize(baseSize);
    let size = baseSize;
    while (target.width > maxWidth && size > minSize) {
      size = Math.max(minSize, size - 4);
      target.setFontSize(size);
    }
  }
}
