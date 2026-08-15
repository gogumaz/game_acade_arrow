// 로컬 랭킹 (§5.7) — SCR-310 정렬 · 등록 조건 · CSV 왕복 · 오늘의 1위
// 등급(§5.5 · 작업 계획 P-12)도 결과 화면이 함께 소비하므로 이 파일에서 판정한다.

import { describe, it, expect } from 'vitest';
import { FILES } from '../../src/persist/csv';
import {
  RANKING_HEADER,
  RANKING_SIZE,
  RankingStore,
  compareEntries,
  parseRankingCsv,
  parseRankingRow,
  rankingRow,
  rankingToCsv,
  type RankingEntry,
} from '../../src/game/rankingStore';
import {
  GRADE_THRESHOLDS,
  IMPROVEMENT_TIPS,
  PERFECT_STREAK_FOR_S_PLUS,
  gradeOf,
  tipFor,
} from '../../src/game/grade';
import { memoryStorage } from './harness';

interface Sub {
  initials?: string;
  score: number;
  board?: number;
  continues?: number;
  at?: string;
  combo?: number;
}

function submit(store: RankingStore, s: Sub): number | null {
  return store.submit({
    initials: s.initials ?? 'ABC',
    score: s.score,
    board: s.board ?? 1,
    maxComboCentis: s.combo ?? 100,
    continues: s.continues ?? 0,
    registeredAt: s.at ?? '2026-08-16T10:00:00.000Z',
  });
}

function filled(store: RankingStore, scores: readonly number[]): void {
  for (const score of scores) submit(store, { score });
}

describe('SCR-310 — 랭킹 정렬 (§5.7)', () => {
  it('점수 내림차순이 1순위다', () => {
    const store = new RankingStore();
    filled(store, [100, 900, 500]);
    expect(store.top().map((e) => e.score)).toEqual([900, 500, 100]);
  });

  it('동점이면 도달 보드 내림차순이다', () => {
    const store = new RankingStore();
    submit(store, { score: 500, board: 3 });
    submit(store, { score: 500, board: 9 });
    expect(store.top().map((e) => e.board)).toEqual([9, 3]);
  });

  it('동점·동보드면 컨티뉴 횟수 오름차순이다 (무컨티뉴가 위)', () => {
    const store = new RankingStore();
    submit(store, { score: 500, board: 3, continues: 4 });
    submit(store, { score: 500, board: 3, continues: 0 });
    expect(store.top().map((e) => e.continues)).toEqual([0, 4]);
  });

  it('그래도 동률이면 먼저 등록된 기록이 위다', () => {
    const store = new RankingStore();
    submit(store, { score: 500, initials: 'AAA' });
    submit(store, { score: 500, initials: 'BBB' });
    expect(store.top().map((e) => e.initials)).toEqual(['AAA', 'BBB']);
  });

  it('compareEntries는 4단 비교를 전부 수행한다', () => {
    const base: RankingEntry = {
      initials: 'AAA',
      score: 100,
      board: 1,
      maxComboCentis: 100,
      continues: 0,
      registeredAt: '2026-08-16',
      seq: 1,
    };
    expect(compareEntries(base, { ...base, score: 200 })).toBeGreaterThan(0);
    expect(compareEntries(base, { ...base, board: 2 })).toBeGreaterThan(0);
    expect(compareEntries(base, { ...base, continues: 1 })).toBeLessThan(0);
    expect(compareEntries(base, { ...base, seq: 2 })).toBeLessThan(0);
  });
});

describe('등록 조건 (§5.7 · 작업 계획 P-7)', () => {
  it('기록이 10개 미만이면 0점 초과로 등록된다', () => {
    const store = new RankingStore();
    expect(store.qualifies(1)).toBe(true);
    expect(submit(store, { score: 1 })).toBe(1);
  });

  it('0점은 등록되지 않는다', () => {
    const store = new RankingStore();
    expect(store.qualifies(0)).toBe(false);
    expect(submit(store, { score: 0 })).toBeNull();
    expect(store.size).toBe(0);
  });

  it('10개가 차면 10위 점수를 초과해야 등록된다', () => {
    const store = new RankingStore();
    filled(store, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(store.qualifies(100)).toBe(false); // 동점은 "초과"가 아니다
    expect(store.qualifies(101)).toBe(true);
  });

  it('TOP 10을 넘으면 마지막 기록이 밀려난다', () => {
    const store = new RankingStore();
    filled(store, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    // 1000 900 800 700 600 [550] 500 … 이므로 6위다
    expect(submit(store, { score: 550 })).toBe(6);
    expect(store.size).toBe(RANKING_SIZE);
    expect(store.top().map((e) => e.score)).not.toContain(100);
  });

  it('조건 미달이면 등록 순위가 null이다', () => {
    const store = new RankingStore();
    filled(store, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    expect(submit(store, { score: 50 })).toBeNull();
  });

  it('이니셜은 3자로 정규화된다', () => {
    const store = new RankingStore();
    submit(store, { score: 500, initials: 'ab' });
    expect(store.top()[0].initials).toBe('AB ');
  });

  it('clear는 기록과 순번을 함께 비운다', () => {
    const store = new RankingStore();
    filled(store, [100, 200]);
    store.clear();
    expect(store.top()).toEqual([]);
    submit(store, { score: 300 });
    expect(store.top()[0].seq).toBe(1);
  });
});

describe('오늘의 1위 (§4.6 · §8.1 BEST TODAY)', () => {
  it('등록 날짜가 오늘인 기록 중 최상위를 돌려준다', () => {
    const store = new RankingStore();
    submit(store, { score: 9000, at: '2026-08-15T20:00:00.000Z' });
    submit(store, { score: 500, at: '2026-08-16T09:00:00.000Z' });
    submit(store, { score: 800, at: '2026-08-16T11:00:00.000Z' });
    expect(store.bestOf('2026-08-16')?.score).toBe(800);
  });

  it('오늘 기록이 없으면 null이다', () => {
    const store = new RankingStore();
    submit(store, { score: 9000, at: '2026-08-15T20:00:00.000Z' });
    expect(store.bestOf('2026-08-16')).toBeNull();
  });
});

describe('CSV 왕복과 손상 처리 (§12.1 — 스키마 확정은 WU-06)', () => {
  it('헤더가 확정 컬럼 순서대로 나온다', () => {
    expect(rankingToCsv([])).toBe(RANKING_HEADER);
  });

  it('직렬화 → 파싱 → 재직렬화가 동일하다', () => {
    const store = new RankingStore();
    submit(store, { score: 900, initials: 'ZZZ', board: 7, continues: 2, combo: 250 });
    submit(store, { score: 400, initials: 'Q.-', board: 3 });
    const csv = store.serialize();
    const restored = new RankingStore();
    restored.apply(csv);
    expect(restored.serialize()).toBe(csv);
    expect(restored.top()).toEqual(store.top());
  });

  it('손상 행은 조용히 버린다', () => {
    const csv = [
      RANKING_HEADER,
      '1,AAA,500,3,150,0,2026-08-16T10:00:00.000Z,1',
      '깨진 줄',
      '1,BBB,없음,3,150,0,2026-08-16T10:00:00.000Z,2',
      '1,CCC,300,2,100,0,,3',
      '1,DDD,300,2,100,0,2026-08-16T10:00:00.000Z,4',
    ].join('\n');
    expect(parseRankingCsv(csv).map((e) => e.initials)).toEqual(['AAA', 'DDD']);
  });

  it('행 1건이 문자열로 왕복한다', () => {
    const entry: RankingEntry = {
      initials: 'XYZ',
      score: 1234,
      board: 6,
      maxComboCentis: 175,
      continues: 2,
      registeredAt: '2026-08-16T10:00:00.000Z',
      seq: 3,
    };
    expect(parseRankingRow(rankingRow(entry))).toEqual(entry);
  });

  it('컬럼이 모자란 행은 null이다', () => {
    expect(parseRankingRow('1,AAA,500')).toBeNull();
  });

  it('음수 점수 행도 버린다', () => {
    const csv = [RANKING_HEADER, '1,AAA,-5,3,150,0,2026-08-16T10:00:00.000Z,1'].join('\n');
    expect(parseRankingCsv(csv)).toEqual([]);
  });

  it('헤더가 없어도 본문을 읽는다', () => {
    const csv = '1,AAA,500,3,150,0,2026-08-16T10:00:00.000Z,1';
    expect(parseRankingCsv(csv).length).toBe(1);
  });

  it('10개를 넘는 파일은 상위 10개만 남긴다', () => {
    const rows = Array.from(
      { length: 15 },
      (_, i) => `1,A${i % 10}${i % 10},${100 + i},1,100,0,2026-08-16T10:00:00.000Z,${i + 1}`
    );
    expect(parseRankingCsv([RANKING_HEADER, ...rows].join('\n')).length).toBe(RANKING_SIZE);
  });

  it('불러온 뒤 등록해도 순번이 이어진다', () => {
    const store = new RankingStore();
    store.apply([RANKING_HEADER, '1,AAA,500,3,150,0,2026-08-16T10:00:00.000Z,7'].join('\n'));
    submit(store, { score: 400 });
    expect(store.top()[1].seq).toBe(8);
  });

  it('빈 CSV를 읽어도 빈 랭킹으로 시작한다', () => {
    const store = new RankingStore();
    store.apply('');
    expect(store.top()).toEqual([]);
  });

  it('WU-01 Storage에 문서로 등록되고 저장·복원된다', async () => {
    const write = memoryStorage();
    const store = new RankingStore();
    write.storage.register(store.asSaveDocument());
    submit(store, { score: 777, initials: 'WU3', board: 5 });
    write.storage.scheduleSave();
    write.flush();
    await Promise.resolve();
    const csv = await write.storage.read(FILES.ranking);
    expect(csv).toContain('WU3');

    const restored = new RankingStore();
    restored.apply(csv ?? '');
    expect(restored.top()[0].score).toBe(777);
  });

  it('저장 파일명은 ranking.csv다', () => {
    expect(new RankingStore().asSaveDocument().file).toBe(FILES.ranking);
  });
});

describe('§5.5 등급 고정 임계표 (SCR-308의 WU-03 분담분 · 작업 계획 P-12)', () => {
  it.each([
    [300000, 'S+'],
    [299999, 'S'],
    [200000, 'S'],
    [199999, 'A'],
    [125000, 'A'],
    [124999, 'B'],
    [65000, 'B'],
    [64999, 'C'],
    [0, 'C'],
  ])('%i점은 %s다', (score, grade) => {
    expect(gradeOf(score)).toBe(grade);
  });

  it('퍼펙트 3보드 연속이면 점수와 무관하게 S+다', () => {
    expect(PERFECT_STREAK_FOR_S_PLUS).toBe(3);
    expect(gradeOf(1000, PERFECT_STREAK_FOR_S_PLUS)).toBe('S+');
    expect(gradeOf(1000, PERFECT_STREAK_FOR_S_PLUS - 1)).toBe('C');
  });

  it('임계표가 §5.6 N7a~d 공장값과 같다', () => {
    expect(GRADE_THRESHOLDS).toEqual({ 'S+': 300000, S: 200000, A: 125000, B: 65000 });
  });

  it('개선 팁은 정확히 3종이다 (§8.4 "팁은 실패 원인에서 자동 선택")', () => {
    expect(Object.keys(IMPROVEMENT_TIPS)).toEqual(['mistakes', 'time', 'hearts']);
  });

  it('개선 팁 3종이 실패 원인별로 나온다 (§8.4)', () => {
    expect(tipFor('mistakes')).toContain('막힘');
    expect(tipFor('time')).toContain('안전수');
    expect(tipFor('hearts')).toContain('확실한');
  });
});
