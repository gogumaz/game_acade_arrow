// 로컬 랭킹 TOP 10 (§5.7 · §12.1 — 착수 리포트 §3. **스키마 확정은 WU-06이 승계**)
//
// 개인정보는 **이니셜 외에 아무것도** 담지 않는다 (§5.7). 저장은 WU-01 `Storage`의
// `SaveDocument`로 붙이고, 손상 행은 조용히 버린다(완전한 `.bak` 복구 판정 SAV-707은 WU-06).

import { FILES, SCHEMA_VERSION, sanitizeField } from '../persist/csv';
import type { SaveDocument } from '../persist/storage';
import { NAME_LENGTH } from './nameEntry';

/** §5.7 N13a */
export const RANKING_SIZE = 10;

export const RANKING_HEADER = 'schema,initials,score,board,maxCombo,continues,registeredAt,seq';

export interface RankingEntry {
  /** 이니셜 3자 */
  readonly initials: string;
  readonly score: number;
  /** 도달 보드 */
  readonly board: number;
  readonly maxComboCentis: number;
  readonly continues: number;
  /** 등록 날짜 ISO 8601 */
  readonly registeredAt: string;
  /** 등록 순번 — 동점·동보드·동컨티뉴에서 "먼저 등록된 기록이 상위" 판정 */
  readonly seq: number;
}

/**
 * §5.7 정렬 — 점수 ↓ → 도달 보드 ↓ → **컨티뉴 횟수 ↑** → 먼저 등록(`seq` ↑).
 * 컨티뉴가 적은 기록이 위로 가야 무컨티뉴 기록이 돈으로 밀리지 않는다 (SCR-310).
 */
export function compareEntries(a: RankingEntry, b: RankingEntry): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.board !== b.board) return b.board - a.board;
  if (a.continues !== b.continues) return a.continues - b.continues;
  return a.seq - b.seq;
}

function normalizeInitials(raw: string): string {
  const clean = sanitizeField(raw).slice(0, NAME_LENGTH).toUpperCase();
  return clean.padEnd(NAME_LENGTH, ' ');
}

function toInt(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** 손상 행이면 `null` — 조용히 버린다 */
export function parseRankingRow(line: string): RankingEntry | null {
  const c = line.split(',');
  if (c.length < 8) return null;
  const nums = [c[2], c[3], c[4], c[5], c[7]].map(toInt);
  if (nums.some((n) => n === null)) return null;
  const [score, board, maxComboCentis, continues, seq] = nums as number[];
  if (score < 0 || board < 0 || continues < 0 || seq < 0) return null;
  if (c[6].trim() === '') return null;
  return {
    initials: normalizeInitials(c[1]),
    score,
    board,
    maxComboCentis,
    continues,
    registeredAt: c[6],
    seq,
  };
}

export function rankingRow(e: RankingEntry): string {
  return [
    SCHEMA_VERSION,
    sanitizeField(e.initials),
    e.score,
    e.board,
    e.maxComboCentis,
    e.continues,
    sanitizeField(e.registeredAt),
    e.seq,
  ].join(',');
}

export function rankingToCsv(entries: readonly RankingEntry[]): string {
  return [RANKING_HEADER, ...entries.map(rankingRow)].join('\n');
}

export function parseRankingCsv(csv: string): RankingEntry[] {
  const lines = csv.trim().split(/\r?\n/);
  const body = lines[0] === RANKING_HEADER ? lines.slice(1) : lines;
  const out: RankingEntry[] = [];
  for (const line of body) {
    if (line.trim() === '') continue;
    const entry = parseRankingRow(line);
    if (entry !== null) out.push(entry);
  }
  return out.sort(compareEntries).slice(0, RANKING_SIZE);
}

export class RankingStore {
  private entries: RankingEntry[] = [];
  private nextSeq = 1;

  top(): readonly RankingEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * §5.7 등록 조건 — 10위 점수를 **초과**할 때만. 기록이 10개 미만이면 0점 초과면 등록 후보다
   * (작업 계획 P-7: 0점 등록은 TOP 10을 무의미하게 만든다).
   */
  qualifies(score: number): boolean {
    if (score <= 0) return false;
    if (this.entries.length < RANKING_SIZE) return true;
    return score > this.entries[RANKING_SIZE - 1].score;
  }

  /** 등록 순위(1..10)를 돌려준다. 조건 미달이면 `null` */
  submit(entry: Omit<RankingEntry, 'seq'>): number | null {
    if (!this.qualifies(entry.score)) return null;
    const full: RankingEntry = {
      ...entry,
      initials: normalizeInitials(entry.initials),
      seq: this.nextSeq,
    };
    this.nextSeq += 1;
    this.entries = [...this.entries, full].sort(compareEntries).slice(0, RANKING_SIZE);
    const index = this.entries.findIndex((e) => e.seq === full.seq);
    return index < 0 ? null : index + 1;
  }

  /** 어트랙트의 "오늘의 1위" · HUD `BEST TODAY` (§4.6 · §8.1) */
  bestOf(dateISO: string): RankingEntry | null {
    const sameDay = this.entries.filter((e) => e.registeredAt.startsWith(dateISO));
    return sameDay.length === 0 ? null : sameDay[0];
  }

  /** 관리자 `RESET` 그룹의 랭킹 단독 초기화 (§11.7 — 화면은 WU-05) */
  clear(): void {
    this.entries = [];
    this.nextSeq = 1;
  }

  serialize(): string {
    return rankingToCsv(this.entries);
  }

  apply(csv: string): void {
    this.entries = parseRankingCsv(csv);
    this.nextSeq = this.entries.reduce((max, e) => Math.max(max, e.seq), 0) + 1;
  }

  /** WU-01 `Storage.register()`에 그대로 등록한다 */
  asSaveDocument(): SaveDocument {
    return {
      file: FILES.ranking,
      serialize: () => this.serialize(),
      apply: (csv) => {
        this.apply(csv);
      },
    };
  }
}
