import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/client
 *
 * Design choices:
 * - ESM-only for modern browsers (ES2022+)
 * - Two entry points: main client SDK + Web Worker script
 * - Worker script bundles all dependencies (self-contained for browser)
 * - Main entry externalizes @unzen/shared (resolved at runtime)
 * - sourcemap: Enabled for debugging
 */
export default defineConfig([
  // Main client SDK entry
  {
    entry: { index: 'src/index.ts' },
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
  },
  // Worker script entry — self-contained bundle for browser
  // All dependencies (quickjs-emscripten-core, @jitl variant, @unzen/shared)
  // are bundled into this single file since it runs in a Web Worker
  // without access to the host page's module resolution.
  {
    entry: { 'quickjs-worker': 'src/worker/quickjs-worker.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    // Bundle everything — worker script must be self-contained
    noExternal: [/.*/],
  },
]);
