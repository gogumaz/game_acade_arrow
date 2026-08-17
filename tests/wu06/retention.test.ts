// WU-06 T10 — SAV-706 로그 보존 (§12.1 · 착수 Q2(a) · 계획 P-6)
//
// `credit_log.csv`·`audit_log.csv`는 12개월 보존이다. 판정의 핵심은 **다른 행 손실 0**이다 —
// 보존 정리가 헤더나 손상 행을 함께 삼키면 잔액 복원(WU-04)과 감사 조회(WU-05)가 깨진다.

import { describe, expect, it } from 'vitest';
import { cutoffIso, pruneByAge, pruneLog, RETENTION_MONTHS } from '../../src/persist/retention';
import { CREDIT_LOG_HEADER, FILES } from '../../src/persist/csv';
import { electronBackend, LOG_KEEP_LINES } from '../../src/persist/storage';

const NOW = '2026-08-17T09:00:00.000Z';

function row(iso: string, tag: string): string {
  return `${iso},coin_insert,coin,1,0,${tag}`;
}

describe('SAV-706 — 12개월 cutoff', () => {
  it('보존 기간은 12개월이다', () => {
    expect(RETENTION_MONTHS).toBe(12);
  });

  it('`cutoffIso`가 정확히 12개월 전을 만든다', () => {
    expect(cutoffIso(NOW)).toBe('2025-08-17T09:00:00.000Z');
    expect(cutoffIso(NOW, 1)).toBe('2026-07-17T09:00:00.000Z');
  });

  it('해석할 수 없는 시각이면 빈 문자열 — 아무것도 지우지 않는다', () => {
    expect(cutoffIso('언제인가')).toBe('');
    const csv = `${CREDIT_LOG_HEADER}\n${row('2000-01-01T00:00:00.000Z', 'old')}`;
    expect(pruneByAge(csv, '')).toBe(csv);
    expect(pruneByAge(csv, '역시 알 수 없음')).toBe(csv);
  });
});

describe('SAV-706 — 경계·보존 규칙', () => {
  const cutoff = cutoffIso(NOW);

  it('cutoff 이상은 남고 미만은 지운다 (경계 포함)', () => {
    const csv = [
      CREDIT_LOG_HEADER,
      row('2025-08-17T08:59:59.999Z', 'just-old'),
      row(cutoff, 'exact'),
      row('2025-08-17T09:00:00.001Z', 'just-new'),
    ].join('\n');
    const result = pruneLog(csv, cutoff);
    expect(result.removed).toBe(1);
    expect(result.next).not.toContain('just-old');
    expect(result.next).toContain('exact');
    expect(result.next).toContain('just-new');
  });

  it('헤더는 항상 보존된다', () => {
    const csv = [CREDIT_LOG_HEADER, row('2020-01-01T00:00:00.000Z', 'ancient')].join('\n');
    const next = pruneByAge(csv, cutoff);
    expect(next.split('\n')[0]).toBe(CREDIT_LOG_HEADER);
    expect(next.split('\n')).toHaveLength(1);
  });

  it('타임스탬프를 해석할 수 없는 손상 행은 **보존**한다', () => {
    const csv = [
      CREDIT_LOG_HEADER,
      '망가진행,,,,,',
      row('2020-01-01T00:00:00.000Z', 'ancient'),
      row(NOW, 'fresh'),
    ].join('\n');
    const next = pruneByAge(csv, cutoff);
    expect(next).toContain('망가진행');
    expect(next).toContain('fresh');
    expect(next).not.toContain('ancient');
  });

  it('전부 최신이면 내용이 한 글자도 바뀌지 않는다 (`changed: false`)', () => {
    const csv = [CREDIT_LOG_HEADER, row(NOW, 'a'), row(NOW, 'b')].join('\n');
    const result = pruneLog(csv, cutoff);
    expect(result.changed).toBe(false);
    expect(result.next).toBe(csv);
    expect(result.removed).toBe(0);
  });

  it('행 순서를 유지한다 (추가 전용 로그의 마지막 행 = 최신 잔액)', () => {
    const csv = [
      CREDIT_LOG_HEADER,
      row('2020-01-01T00:00:00.000Z', 'drop'),
      row('2026-01-01T00:00:00.000Z', 'keep-1'),
      row('2026-06-01T00:00:00.000Z', 'keep-2'),
      row(NOW, 'keep-3'),
    ].join('\n');
    const lines = pruneByAge(csv, cutoff).split('\n');
    expect(lines[0]).toBe(CREDIT_LOG_HEADER);
    expect(lines.map((l) => l.split(',')[5])).toEqual([
      'timestamp,action,source,paidBalance,eventBalance,reason'.split(',')[5],
      'keep-1',
      'keep-2',
      'keep-3',
    ]);
  });

  it('빈 파일·헤더만 있는 파일도 안전하다', () => {
    expect(pruneByAge('', cutoff)).toBe('');
    expect(pruneByAge(CREDIT_LOG_HEADER, cutoff)).toBe(CREDIT_LOG_HEADER);
  });

  it('12개월 치 대용량에서도 다른 행 손실 0이다', () => {
    const rows: string[] = [CREDIT_LOG_HEADER];
    const keep: string[] = [];
    for (let i = 0; i < 5000; i += 1) {
      // 절반은 2년 전, 절반은 최근
      const old = i % 2 === 0;
      const iso = old ? '2024-01-01T00:00:00.000Z' : '2026-08-01T00:00:00.000Z';
      const line = row(iso, `r${String(i)}`);
      rows.push(line);
      if (!old) keep.push(line);
    }
    const result = pruneLog(rows.join('\n'), cutoff);
    expect(result.removed).toBe(2500);
    expect(result.next.split('\n').slice(1)).toEqual(keep);
  });
});

describe('SAV-706 — 실기 append 경로에는 줄 수 상한이 없다 (착수 Q2(a))', () => {
  it('Electron 백엔드는 `append`를 그대로 넘긴다 (트림 없음)', async () => {
    const appended: string[] = [];
    const backend = electronBackend({
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      append: (_n, l) => {
        appended.push(l);
        return Promise.resolve();
      },
    });
    for (let i = 0; i < LOG_KEEP_LINES + 100; i += 1) {
      await backend.append(FILES.creditLog, `row-${String(i)}`);
    }
    // 실기에서는 저장 계층이 한 줄도 버리지 않는다 — 보존 규칙은 12개월 정리가 담당한다
    expect(appended).toHaveLength(LOG_KEEP_LINES + 100);
    expect(appended[0]).toBe('row-0');
    expect(appended[appended.length - 1]).toBe(`row-${String(LOG_KEEP_LINES + 99)}`);
  });

  it('`LOG_KEEP_LINES`는 개발 백엔드(localStorage·메모리) 전용으로만 남아 있다', () => {
    // WU-01 판정(`tests/wu01/storage.test.ts` 5-10)이 이 상수와 트림 동작을 고정했다.
    // WU-06은 그것을 **실기 경로에서 제외**하는 것으로 착수 Q2(a)의 충돌을 해소한다
    expect(LOG_KEEP_LINES).toBe(2000);
  });
});
