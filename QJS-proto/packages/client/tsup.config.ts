import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/client
 *
 * Design choices:
 * - ESM-only for modern browsers (ES2022+)
 * - Minimal bundle size (no dependencies except @unzen/shared)
 * - sourcemap: Enabled for debugging
 * - splitting: False (single entry point)
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  clean: true,
  sourcemap: true,
  splitting: false,
  // @unzen/shared should be resolved at runtime (workspace dependency)
  external: ['@unzen/shared'],
});
