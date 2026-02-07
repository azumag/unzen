import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/server
 *
 * Design choices:
 * - ESM-only for edge runtime compatibility (Cloudflare Workers, Deno)
 * - Treeshaking: esbuild handles this automatically
 * - External: mark dependencies for runtime resolution
 * - onWarn: Filter out Hono's "Use eval()" warnings (intentional)
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: {
    compilerOptions: {
      skipLibCheck: true,
      rootDir: undefined,
    },
  },
  clean: true,
  sourcemap: true,
  splitting: false,
  // Dependencies should be resolved at runtime (not bundled)
  external: ['hono', 'quickjs-emscripten', '@unzen/shared'],
});
