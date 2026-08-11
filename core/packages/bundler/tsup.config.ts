import { defineConfig } from 'tsup';

/**
 * tsup configuration for @unzen/bundler
 *
 * Builds the ESM bundler/plugin API plus an additional CommonJS webpack
 * loader entry for require.resolve()-based configurations.
 */
export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'webpack-loader': 'src/webpack-loader.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    external: ['esbuild', 'magic-string', 'typescript'],
    noExternal: ['@unzen/shared'],
  },
  // CommonJS loader output keeps require.resolve() usable from the webpack
  // configuration format most projects still use.
  {
    entry: { 'webpack-loader': 'src/webpack-loader.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    external: ['esbuild', 'magic-string', 'typescript'],
    noExternal: ['@unzen/shared'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
