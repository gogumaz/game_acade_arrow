// WU-06 T10 — SAV-701 폴트 인젝션 500회 · ADM-301 잔존 `.tmp` 복구 (계획 P-2 · P-4)
//
// 인수 SAV-701은 "전원 차단 500회에서 데이터 손실 0"이다. 실기 전원 차단은 WU-09/운영으로
// 이월했고(착수 Q1), 여기서는 **결정적 시뮬레이션**으로 같은 명제를 판정한다.
//
// 매 회차 절차
//   ① 값 A를 안전 쓰기로 커밋한다 (성공)
//   ② 값 B를 쓰는 도중 N번째 fs 호출에서 전원이 끊긴다 (예외 · 찢어진 기록 · rename 유실)
//   ③ 재부팅 = `recoverStrays()` → 읽기 → `validate()` (본 파일 무효면 `.bak`)
//   ④ 판정: 읽힌 값이 A 또는 B이고 **null도 손상도 아니다**
//
// 시드가 고정이라 실패하면 같은 회차가 그대로 재현된다.

import { describe, expect, it } from 'vitest';
import { BAK_SUFFIX, TMP_SUFFIX } from '../../electron/safe-write.cjs';
import { FAULT_SEED, InjectableFs, makeWriter, mulberry32, FAKE_DIR } from './harness';
import path from 'node:path';

const NAME = 'settings.csv';

/** 회차마다 쓰는 내용 — 길이를 다르게 해서 찢어진 기록이 확실히 다른 값이 되게 한다 */
function payload(tag: string, n: number): string {
  return `schema,value\n1,${tag}-${String(n)}-${'x'.repeat(n % 17)}`;
}

function isValid(csv: string | null, accepted: readonly string[]): boolean {
  return csv !== null && accepted.includes(csv);
}

/** 재부팅 직후 판정 — 잔존 `.tmp` 정리 후 본 파일을, 무효면 `.bak`을 읽는다 */
async function readAfterReboot(
  fs: InjectableFs,
  accepted: readonly string[]
): Promise<string | null> {
  fs.reboot();
  const { writer } = makeWriter(fs);
  await writer.recoverStraysDirect();
  const main = fs.files.get(path.join(FAKE_DIR, NAME)) ?? null;
  if (isValid(main, accepted)) return main;
  const bak = fs.files.get(path.join(FAKE_DIR, `${NAME}${BAK_SUFFIX}`)) ?? null;
  return isValid(bak, accepted) ? bak : null;
}

describe('SAV-701 — 폴트 인젝션 500회 (고정 시드 · 손실 0)', () => {
  it('어느 지점에서 끊겨도 마지막 정상값 A 또는 새 값 B가 남는다', async () => {
    const rand = mulberry32(FAULT_SEED);
    const kinds = ['throw', 'torn', 'silent'] as const;
    const results = { A: 0, B: 0 };
    const failures: string[] = [];

    for (let round = 0; round < 500; round += 1) {
      const fs = new InjectableFs();
      const { writer } = makeWriter(fs);
      const a = payload('A', round);
      const b = payload('B', round);

      // ① A 커밋 (차단 없음)
      fs.inject(null);
      await writer.safeWriteDirect(NAME, a);
      expect(fs.files.get(path.join(FAKE_DIR, NAME))).toBe(a);

      // ② B 저장 중 차단 — A가 이미 있으므로 5단계가 fs 호출 정확히 5번이다.
      // 1~5를 고르면 **모든 단계**가 최소 한 번씩 끊긴다
      const atCall = 1 + Math.floor(rand() * 5);
      const kind = kinds[Math.floor(rand() * kinds.length)];
      fs.inject({ atCall, kind });
      await expect(writer.safeWriteDirect(NAME, b)).rejects.toThrow();

      // ③④ 재부팅 후 판정
      const recovered = await readAfterReboot(fs, [a, b]);
      if (recovered === null) {
        failures.push(`round ${String(round)} call ${String(atCall)} ${kind}: 손실`);
      } else if (recovered === a) results.A += 1;
      else results.B += 1;
    }

    expect(failures).toEqual([]);
    expect(results.A + results.B).toBe(500);
    // 양쪽 결과가 모두 나와야 시나리오가 5단계 전 구간을 실제로 훑었다는 뜻이다
    expect(results.A).toBeGreaterThan(0);
    expect(results.B).toBeGreaterThan(0);
  });

  it('같은 시드는 같은 결과를 낸다 (결정적)', () => {
    const a = Array.from({ length: 20 }, mulberry32(FAULT_SEED));
    const b = Array.from({ length: 20 }, mulberry32(FAULT_SEED));
    expect(a).toEqual(b);
    expect(a).not.toEqual(Array.from({ length: 20 }, mulberry32(FAULT_SEED + 1)));
  });
});

describe('SAV-701 — 5단계 지점별 결정 케이스 5건', () => {
  async function commitThenBreak(atCall: number, kind: 'throw' | 'torn' | 'silent') {
    const fs = new InjectableFs();
    const { writer } = makeWriter(fs);
    fs.inject(null);
    await writer.safeWriteDirect(NAME, 'schema,value\n1,A');
    fs.inject({ atCall, kind });
    await expect(writer.safeWriteDirect(NAME, 'schema,value\n1,B')).rejects.toThrow();
    return fs;
  }

  it('① `.tmp` 기록 중 차단 — 본 파일 A가 그대로다', async () => {
    const fs = await commitThenBreak(1, 'torn');
    expect(await readAfterReboot(fs, ['schema,value\n1,A'])).toBe('schema,value\n1,A');
  });

  it('② `.tmp` 재읽기 검증 중 차단 — 본 파일 A가 그대로다', async () => {
    const fs = await commitThenBreak(2, 'throw');
    expect(await readAfterReboot(fs, ['schema,value\n1,A'])).toBe('schema,value\n1,A');
  });

  it('③ 본 파일 → `.bak` rename 중 차단 — A는 본 파일 또는 `.bak`에 있다', async () => {
    const fs = await commitThenBreak(3, 'silent');
    expect(await readAfterReboot(fs, ['schema,value\n1,A'])).toBe('schema,value\n1,A');
  });

  it('④ `.tmp` → 본 파일 rename 중 차단 — `.bak`의 A로 복구된다', async () => {
    const fs = await commitThenBreak(4, 'silent');
    // 이 시점 디스크: 본 파일 없음 · `.bak`=A · `.tmp`=B → `.tmp` 승격으로 B가 산다
    const recovered = await readAfterReboot(fs, ['schema,value\n1,A', 'schema,value\n1,B']);
    expect(recovered).toBe('schema,value\n1,B');
  });

  it('⑤ 접근 재확인 중 차단 — B가 이미 본 파일이다', async () => {
    const fs = await commitThenBreak(5, 'throw');
    expect(await readAfterReboot(fs, ['schema,value\n1,B'])).toBe('schema,value\n1,B');
  });

  it('찢어진 `.tmp`는 2단계 검증이 잡아 본 파일에 닿지 않는다', async () => {
    const fs = new InjectableFs();
    const { writer } = makeWriter(fs);
    fs.inject(null);
    await writer.safeWriteDirect(NAME, 'schema,value\n1,A');
    fs.inject({ atCall: 1, kind: 'torn' });
    await expect(writer.safeWriteDirect(NAME, 'schema,value\n1,BBBBBBBB')).rejects.toThrow();
    expect(fs.files.get(path.join(FAKE_DIR, NAME))).toBe('schema,value\n1,A');
  });
});

describe('ADM-301 — 잔존 `.tmp` 복구 3케이스 (P-2)', () => {
  it('본 파일이 있으면 `.tmp`를 지운다', async () => {
    const fs = new InjectableFs();
    fs.files.set(path.join(FAKE_DIR, NAME), 'main');
    fs.files.set(path.join(FAKE_DIR, `${NAME}${TMP_SUFFIX}`), 'stale');
    const { writer } = makeWriter(fs);
    const report = await writer.recoverStraysDirect();
    expect(report.removed).toEqual([`${NAME}${TMP_SUFFIX}`]);
    expect(report.promoted).toEqual([]);
    expect(fs.names()).toEqual([NAME]);
    expect(fs.files.get(path.join(FAKE_DIR, NAME))).toBe('main');
  });

  it('본 파일이 없으면 `.tmp`를 본 파일로 승격한다', async () => {
    const fs = new InjectableFs();
    fs.files.set(path.join(FAKE_DIR, `${NAME}${TMP_SUFFIX}`), 'promoted');
    const { writer } = makeWriter(fs);
    const report = await writer.recoverStraysDirect();
    expect(report.promoted).toEqual([NAME]);
    expect(report.removed).toEqual([]);
    expect(fs.files.get(path.join(FAKE_DIR, NAME))).toBe('promoted');
  });

  it('`.tmp`가 없으면 아무것도 하지 않는다', async () => {
    const fs = new InjectableFs();
    fs.files.set(path.join(FAKE_DIR, NAME), 'main');
    fs.files.set(path.join(FAKE_DIR, `${NAME}${BAK_SUFFIX}`), 'bak');
    const { writer } = makeWriter(fs);
    const report = await writer.recoverStraysDirect();
    expect(report).toEqual({ promoted: [], removed: [] });
    expect(fs.names()).toEqual([`${NAME}${BAK_SUFFIX}`, NAME].sort());
  });

  it('여러 파일의 `.tmp`를 한 번에 처리한다', async () => {
    const fs = new InjectableFs();
    fs.files.set(path.join(FAKE_DIR, 'stats.csv'), 'main');
    fs.files.set(path.join(FAKE_DIR, `stats.csv${TMP_SUFFIX}`), 'stale');
    fs.files.set(path.join(FAKE_DIR, `ranking.csv${TMP_SUFFIX}`), 'promote-me');
    const { writer } = makeWriter(fs);
    const report = await writer.recoverStraysDirect();
    expect(report.removed).toEqual([`stats.csv${TMP_SUFFIX}`]);
    expect(report.promoted).toEqual(['ranking.csv']);
    expect(fs.files.get(path.join(FAKE_DIR, 'ranking.csv'))).toBe('promote-me');
  });

  it('디렉터리를 못 읽어도 부팅을 막지 않는다', async () => {
    const fs = new InjectableFs();
    fs.files.set(path.join(FAKE_DIR, NAME), 'x');
    // 첫 fs 호출(readdir 뒤의 access)에서 끊어도 정리는 예외를 던지지 않는다
    fs.inject({ atCall: 1, kind: 'throw' });
    const { writer } = makeWriter(fs);
    await expect(writer.recoverStraysDirect()).resolves.toEqual({ promoted: [], removed: [] });
  });
});
