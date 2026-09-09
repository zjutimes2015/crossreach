import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // E2E requires a live Postgres + boots the real server; run separately
    // via `npm run test:e2e` (see vitest.e2e.config.ts).
    exclude: ['test/e2e/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
