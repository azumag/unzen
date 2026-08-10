import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for unzen core monorepo
 *
 * Design choices:
 * - ESNext modules: Native ESM for modern browser compatibility
 * - no-coverage: False by default, can be enabled via --coverage flag
 * - include: Uses Vitest's default pattern (test and .test.ts files)
 * - workspace: Configured via package.json workspaces
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/test/**/*.ts', '**/*.test.ts'],
    // Exclude macOS AppleDouble resource fork files (._*) that vitest would
    // erroneously pick up as test files on external/network volumes.
    exclude: ['**/node_modules', 'dist', '**/._*'],
    // Enable watch mode during development
    watch: false,
    // Coverage configuration (optional, requires @vitest/coverage-v8)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.test.ts',
        '**/test/**',
      ],
    },
  },
});
