import { defineConfig } from 'vitest/config';

const MINIFLARE_MULTI_SERVICE_TESTS = [
  'tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapter-workers.test.ts',
  'tests/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-worker.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'standard',
          globals: false,
          environment: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['node_modules', 'dist', ...MINIFLARE_MULTI_SERVICE_TESTS],
          watch: false,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'miniflare-multi-service',
          globals: false,
          environment: 'node',
          include: MINIFLARE_MULTI_SERVICE_TESTS,
          exclude: ['node_modules', 'dist'],
          watch: false,
          // These tests repeatedly transpile the full Worker graph and start
          // Miniflare multi-service runtimes. Running them after the standard
          // suite prevents unrelated file workers from consuming the same CPU
          // and I/O budget while preserving the existing 5s assertion timeout.
          sequence: { groupOrder: 1 },
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
