import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/shared
 *
 * Design choices:
 * - Single entry point (index.ts)
 * - ESM-only output (no CJS needed for browser target)
 * - External: no dependencies to bundle
 * - dts: TypeScript declaration generation enabled
 * - clean: Clean dist folder before build
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // No splitting for a small library
  splitting: false,
  // Skip Node.js polyfills (browser-targeted)
  shims: false,
});
