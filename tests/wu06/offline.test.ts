// WU-06 T10 — SAV-705 오프라인 동작 (§12.5)
//
// 기획서 §12.5는 "네트워크를 전제로 한 기능이 없다"이다. 판정 방법은 **정적 검색**이다 —
// 실행 시점 판정(네트워크를 끊고 돌려 보기)은 "쓰지 않는 코드가 없다"를 증명하지 못한다.
//
// 검색 대상: `src/`(렌더러 전량) · `electron/`(메인·preload). 주석과 문자열 안의 URL은
// 실행되지 않으므로 **주석 줄을 제거한 뒤** 본다.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 네트워크 접근을 만드는 식별자 (§12.5) */
const NETWORK_TOKENS = [
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator.sendBeacon',
  'http://',
  'https://',
  "require('http')",
  "require('https')",
  "require('net')",
  "require('dgram')",
  'net.connect',
];

function collectFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full, exts));
      continue;
    }
    if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/** 줄 주석·블록 주석을 지운다 — 주석 안의 URL은 실행되지 않는다 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SOURCES = [
  ...collectFiles(path.join(ROOT, 'src'), ['.ts']),
  ...collectFiles(path.join(ROOT, 'electron'), ['.cjs', '.cts', '.html']),
];

describe('SAV-705 — 네트워크 의존 0건 (§12.5)', () => {
  it('검색 대상 파일이 실제로 모였다 (검색이 헛돌지 않았다)', () => {
    expect(SOURCES.length).toBeGreaterThan(30);
    expect(SOURCES.some((f) => f.endsWith(path.join('src', 'game', 'app.ts')))).toBe(true);
    expect(SOURCES.some((f) => f.endsWith(path.join('electron', 'main.cjs')))).toBe(true);
  });

  it.each(NETWORK_TOKENS)('`%s`가 코드에 없다', (token) => {
    const hits: string[] = [];
    for (const file of SOURCES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      if (code.includes(token)) hits.push(path.relative(ROOT, file));
    }
    expect(hits).toEqual([]);
  });

  it('원격 스크립트·스타일 태그가 없다 (오류 화면 2종 포함)', () => {
    for (const file of SOURCES.filter((f) => f.endsWith('.html'))) {
      const html = readFileSync(file, 'utf8');
      expect(html).not.toMatch(/<script[^>]+src=/i);
      expect(html).not.toMatch(/<link[^>]+href=["']http/i);
    }
  });

  it('의존성이 phaser 하나뿐이다 (런타임 네트워크 라이브러리 없음)', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies)).toEqual(['phaser']);
  });

  it('저장 백엔드는 파일 IPC · localStorage · 메모리 3종뿐이다 (§12.2)', () => {
    const storage = readFileSync(path.join(ROOT, 'src', 'persist', 'storage.ts'), 'utf8');
    expect(storage).toContain("kind: 'electron'");
    expect(storage).toContain("kind: 'localStorage'");
    expect(storage).toContain("kind: 'memory'");
    expect(stripComments(storage)).not.toContain('fetch');
  });
});
