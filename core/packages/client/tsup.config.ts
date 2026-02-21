import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/client
 *
 * Design choices:
 * - ESM-only for modern browsers (ES2022+)
 * - Three entry points: main SDK + browser bundle + Web Worker script
 * - Main entry externalizes @unzen/shared (for npm consumers)
 * - Browser bundle inlines all deps (for direct <script> usage)
 * - Worker script bundles all dependencies (self-contained for browser)
 * - sourcemap: Enabled for debugging
 */
export default defineConfig([
  // Main client SDK entry (for npm package consumers)
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
    // @unzen/shared resolved via node_modules for npm consumers
    external: ['@unzen/shared'],
  },
  // Browser-ready bundle — self-contained for direct <script type="module"> usage.
  // Uses a separate entry point that excludes MockSandboxExecutor (Node.js vm dep).
  // Inlines @unzen/shared since browsers cannot resolve bare specifiers.
  {
    entry: { 'index.browser': 'src/index.browser.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    // Inline @unzen/shared for browser compatibility (bare specifier resolution)
    noExternal: ['@unzen/shared'],
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
