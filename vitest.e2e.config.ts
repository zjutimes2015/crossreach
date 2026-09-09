// E2E (contract-level) Vitest configuration.
// Runs the real Fastify server + real Postgres against local fake upstreams
// (WhatsApp Graph, etc.). Requires a reachable Postgres — see README.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    // Real HTTP + DB polling; allow generous timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Files share one database — never truncate each other concurrently.
    fileParallelism: false,
  },
});
