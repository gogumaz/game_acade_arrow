// WU-01 T6 — 테스트 도구 동작 확인 + 부록 E 확정 스캐폴드 값 회귀 검사.
// 부록 E.1·E.2·E.4가 확정한 값이 나중 유닛에서 조용히 바뀌는 것을 막는다.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
    expect(build.appId).toBe('com.neongrid.arcade');
    expect(build.productName).toBe('NeonGridArcade');
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
