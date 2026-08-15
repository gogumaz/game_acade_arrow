// WU-01 T6 — 테스트 도구 동작 확인 + 부록 E 확정 스캐폴드 값 회귀 검사.
// 부록 E.1·E.2·E.4가 확정한 값이 나중 유닛에서 조용히 바뀌는 것을 막는다.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_TITLE } from '../../src/core/types';
import { STORAGE_PREFIX } from '../../src/persist/storage';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')) as Record<string, unknown>;
}

describe('WU-01 스캐폴드 (부록 E)', () => {
  it('Vitest 러너가 동작한다', () => {
    expect(1 + 1).toBe(2);
  });

  it('E.4 스크립트 9종이 확정 내용대로 있다', () => {
    const pkg = readJson('package.json');
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts).toEqual({
      dev: 'vite',
      build: 'tsc --noEmit && vite build',
      typecheck: 'tsc --noEmit',
      test: 'vitest run',
      lint: 'eslint . && prettier --check .',
      preview: 'vite preview',
      desktop: 'npm run build && electron .',
      package: 'npm run build && electron-builder --win portable',
      'package:linux': 'npm run build && electron-builder --linux tar.gz',
    });
  });

  it('E.1 의존성 하한이 확정값을 만족한다', () => {
    const pkg = readJson('package.json');
    const deps = pkg.dependencies as Record<string, string>;
    const dev = pkg.devDependencies as Record<string, string>;
    const major = (range: string): number => Number(range.replace(/^\D*/, '').split('.')[0]);

    expect(major(deps.phaser)).toBeGreaterThanOrEqual(4);
    expect(major(dev.electron)).toBeGreaterThanOrEqual(43);
    expect(major(dev.typescript)).toBeGreaterThanOrEqual(5);
    expect(major(dev.vite)).toBeGreaterThanOrEqual(5);
    expect(major(dev['electron-builder'])).toBeGreaterThanOrEqual(26);
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('electron/main.cjs');
  });

  it('E.2 tsconfig 확정값을 지킨다', () => {
    const ts = readJson('tsconfig.json');
    const opts = ts.compilerOptions as Record<string, unknown>;
    expect(ts.include).toEqual(['src', 'tests']);
    expect(opts.strict).toBe(true);
    expect(opts.noEmit).toBe(true);
    expect(opts.target).toBe('ES2020');
    expect(opts.moduleResolution).toBe('bundler');
    // 경로 별칭은 두지 않는다 (§12 연결표의 상대 경로 표기 유지)
    expect(opts.paths).toBeUndefined();
  });

  it('E.2 electron-builder 확정값을 지킨다', () => {
    const pkg = readJson('package.json');
    const build = pkg.build as Record<string, unknown>;
    expect(build.appId).toBe('com.arrowout.arcade');
    expect(build.productName).toBe('ArrowOutArcade');
    expect(build.files).toEqual(['dist/**', 'electron/**']);
    expect(build.directories).toEqual({ output: 'release' });
  });

  it('E.2 vite 확정값(base·포트)을 지킨다', () => {
    const cfg = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    expect(cfg).toContain("base: './'");
    expect(cfg).toContain('port: 5199');
    expect(cfg).toContain('strictPort: true');
  });

  it('E.6 Prettier 확정값을 지킨다', () => {
    const rc = readJson('.prettierrc.json');
    expect(rc.printWidth).toBe(100);
    expect(rc.singleQuote).toBe(true);
    expect(rc.semi).toBe(true);
    expect(rc.trailingComma).toBe('es5');
  });
});

// ── 명칭 회귀 장치 (§16.4) ────────────────────────────────────────────────

/**
 * 스캔 대상. 이 파일 자신은 제외한다 — 아래 금지 패턴 문자열을 정의상 포함하기 때문이다.
 * `docs/`는 보관·기획 문서라 대상이 아니다.
 */
const SCAN_DIRS = ['src', path.join('tests', 'wu01'), 'electron'];
const SCAN_FILES = ['index.html', 'package.json', 'eslint.config.js', 'vite.config.ts'];
const SCAN_EXT = /\.(ts|cts|cjs)$/;
const SELF = path.basename(fileURLToPath(import.meta.url));

/**
 * 이전 게임(8×20 테트로미노) 고유 식별자.
 *
 * 액션명(`ROTATE`·`PLACE`·`ADMIN`·`DAILY`)은 **일부러 넣지 않는다.** `InputAction`이
 * 유니온 타입이라 잔존 리터럴은 `npm run typecheck`가 컴파일 에러로 잡고, 텍스트로 금지하면
 * 나중 유닛의 관리자 화면 문구(`ADMIN` 메뉴 라벨 등)와 충돌해 잘못된 실패를 만든다.
 * 소문자 `admin`도 같은 이유로 금지하지 않는다 — `audit_log.csv`의 정당한 값이다 (§12.1).
 */
const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['이전 게임 브랜드', /neon.?grid/i],
  ['이전 게임 장르', /tetromino/i],
  ['이전 게임 보드 규격', /8\s*[x×]\s*20/],
  ['stages 레코드 타입', /\bStageRecord\b/],
  ['stages 인코더', /\bstagesToCsv\b/],
  ['stages 디코더', /\bparseStagesCsv\b/],
  ['stages 헤더 상수', /\bSTAGES_HEADER\b/],
  ['stages 저장 파일', /stages\.csv/],
];

function collectScanTargets(): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      const child = path.join(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (SCAN_EXT.test(entry) && entry !== SELF) {
        out.push(child);
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir));
  for (const file of SCAN_FILES) out.push(path.join(ROOT, file));
  return out;
}

describe('명칭 회귀 장치 (§16.4)', () => {
  it('이전 게임 식별자가 코드·설정에 남지 않는다', () => {
    const targets = collectScanTargets();
    // 스캔이 실제로 파일을 읽고 있는지부터 확인한다 — 0건 스캔은 항상 통과하므로 무의미하다
    expect(targets.length).toBeGreaterThan(10);

    const hits: string[] = [];
    for (const file of targets) {
      const text = readFileSync(file, 'utf8');
      for (const [label, pattern] of FORBIDDEN) {
        if (pattern.test(text)) {
          hits.push(`${path.relative(ROOT, file)} — ${label} (${String(pattern)})`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('package.json·index.html 명칭이 GAME_TITLE에서 파생된다', () => {
    // 이름이 확정(가칭 해제)되면 GAME_TITLE만 바꾸고 이 테스트가 지목하는 지점만 맞추면 된다.
    const compact = GAME_TITLE.replace(/\s+/g, '').toUpperCase();
    expect(compact).toBe('ARROWOUT');

    const pkg = readJson('package.json');
    const build = pkg.build as Record<string, unknown>;
    const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';

    expect(String(pkg.name).replace(/-/g, '').toUpperCase()).toBe(`${compact}ARCADE`);
    expect(String(build.productName).toUpperCase()).toBe(`${compact}ARCADE`);
    expect(build.appId).toBe(`com.${compact.toLowerCase()}.arcade`);
    expect(title.replace(/\s+/g, '').toUpperCase()).toBe(`${compact}ARCADE`);
    expect(STORAGE_PREFIX).toBe(`${compact.toLowerCase()}:`);
  });
});
