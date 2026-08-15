// Vite + Vitest 설정 (기획서 부록 E.2 · E.5)
// defineConfig를 vitest/config에서 가져와 설정 파일을 하나로 유지한다.
// base·server.port·server.strictPort는 부록 E.2 확정값이므로 바꾸지 않는다.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Electron file:// 로딩을 위한 상대 경로 (부록 E.2)
  base: './',
  server: {
    port: 5199,
    // 포트가 밀리면 Electron 개발 로딩이 깨진다 (부록 E.2)
    strictPort: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
