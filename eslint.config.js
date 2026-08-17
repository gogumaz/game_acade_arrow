// ESLint flat config (기획서 부록 E.6)
// @typescript-eslint 권장 세트 + 프로젝트 규칙 3개
//   ① src/core/에서 Phaser·DOM 전역 사용 금지 — 규칙 계층 순수성 (§1.4)
//   ② 미사용 export 경고
//   ③ 항상 참인 사용 가능 플래그·도달 불가 분기 금지 (§13 G7 재발 방지)

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'release/',
      'log/',
      'node_modules/',
      '_workspace/',
      'docs/',
      'distribution/',
    ],
  },

  // ── 공통 ──
  js.configs.recommended,

  // ── 렌더러·테스트 TypeScript (타입 인식 린트) ──
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { 'import-x': importX },
    settings: {
      // no-unused-modules가 .ts 파일을 "import 하는 쪽"으로도 훑게 한다
      'import-x/extensions': ['.ts', '.tsx', '.js', '.cjs', '.mjs'],
      'import-x/resolver': {
        node: { extensions: ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.cts'] },
      },
    },
    rules: {
      // 규칙 ③ — 항상 참/거짓인 조건과 도달 불가 분기 금지 (타입 인식)
      '@typescript-eslint/no-unnecessary-condition': 'error',
      // 규칙 ② — 미사용 export 경고
      'import-x/no-unused-modules': ['warn', { unusedExports: true }],
    },
  },

  // ── 규칙 ① — src/core/는 Phaser·DOM을 모른다 ──
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message: 'src/core/는 Phaser를 모르는 순수 규칙 계층이다 (§1.4 · 부록 E.3).',
            },
          ],
          patterns: [
            {
              group: ['phaser/*', '../game/*', '../scenes/*'],
              message: 'src/core/는 Phaser 의존 계층을 import 하지 않는다 (§1.4 · 부록 E.3).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/core/는 DOM 전역을 쓰지 않는다 (§1.4 · 부록 E.3).' },
        { name: 'document', message: 'src/core/는 DOM 전역을 쓰지 않는다 (§1.4 · 부록 E.3).' },
        { name: 'localStorage', message: 'src/core/는 DOM 전역을 쓰지 않는다 (§1.4 · 부록 E.3).' },
      ],
    },
  },

  // ── Electron 메인·preload (CommonJS) ──
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },

  // ── 운영 보조 명령 (Node ESM) ──
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },

  // ── Electron CJS 타입 선언 (tsconfig 프로젝트 밖이라 타입 인식 린트 제외) ──
  {
    files: ['electron/**/*.d.cts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },

  // ── 저장소 루트 설정 파일 ──
  {
    files: ['*.js', '*.ts'],
    ignores: ['src/**', 'tests/**'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  }
);
