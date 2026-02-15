import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/bundler
 *
 * Builds module bundler that wraps esbuild for sandbox-safe function bundling.
 * ESM-only for consistency with other @unzen packages.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  external: ['esbuild'],
});
