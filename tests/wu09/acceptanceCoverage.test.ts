// §13 추적성 게이트 — ID를 목록에 적는 것만으로 통과하지 않도록 이 파일 자체는 증거 검색에서 뺀다.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const ID = /\b(?:CTL|PZL|SES|SCR|GEN|HNT|CRD|SAV|EFX)-\d{3}\b/g;
const REQUIRED_ADMIN = [
  'ADM-001',
  'ADM-002',
  'ADM-003',
  'ADM-004',
  'ADM-005',
  'ADM-006',
  'ADM-101',
  'ADM-102',
  'ADM-103',
  'ADM-104',
  'ADM-105',
  'ADM-106',
  'ADM-107',
  'ADM-201',
  'ADM-204',
  'ADM-205',
  'ADM-206',
  'ADM-207',
  'ADM-301',
  'ADM-302',
  'ADM-303',
  'ADM-304',
  'ADM-305',
  'ADM-306',
  'ADM-307',
  'ADM-401',
  'ADM-402',
  'ADM-403',
  'ADM-404',
] as const;

function ids(text: string, pattern: RegExp): Set<string> {
  return new Set(text.match(pattern) ?? []);
}

function acceptanceEvidence(): string {
  const files = readdirSync(path.join(ROOT, 'tests'), { recursive: true, encoding: 'utf8' });
  return files
    .filter(
      (file) =>
        typeof file === 'string' &&
        file.endsWith('.test.ts') &&
        !file.endsWith('acceptanceCoverage.test.ts')
    )
    .map((file) => readFileSync(path.join(ROOT, 'tests', file), 'utf8'))
    .join('\n');
}

describe('WU-09 §13 acceptance traceability', () => {
  it('88개 CTL/PZL/SES/SCR/GEN/HNT/CRD/SAV/EFX 항목에 자동 증거가 있다', () => {
    const gdd = readFileSync(path.join(ROOT, 'docs', 'arrow_out_arcade_gdd_v1_0.md'), 'utf8');
    const required = ids(gdd.slice(gdd.indexOf('## §13.'), gdd.indexOf('## §14.')), ID);
    const covered = ids(acceptanceEvidence(), ID);
    expect(required.size).toBe(88);
    expect([...required].filter((id) => !covered.has(id))).toEqual([]);
  });

  it('ADM 승계 25개와 신설 4개에 자동 증거가 있다', () => {
    const covered = ids(acceptanceEvidence(), /\bADM-\d{3}\b/g);
    expect(REQUIRED_ADMIN).toHaveLength(29);
    expect(REQUIRED_ADMIN.filter((id) => !covered.has(id))).toEqual([]);
  });
});
