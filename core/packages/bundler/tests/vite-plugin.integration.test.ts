import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { unzenVitePlugin } from '../src/vite-plugin';

describe('unzenVitePlugin with Vite', () => {
  it('extracts a typed definition during a real library build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-vite-'));
    const entry = join(root, 'functions.ts');
    writeFileSync(entry, `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('double', (value: number): number => value * 2);
export { server };`);

    try {
      const buildResult = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [unzenVitePlugin({ declarationFile: 'unzen-functions.d.ts' })],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ['es'] },
          rollupOptions: { external: ['@unzen/server'] },
        },
      });
      const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
      const generated = outputs.flatMap((output) => (
        'output' in output ? output.output : []
      ));
      const chunk = generated.find((item) => item.type === 'chunk');
      const declaration = generated.find((item) => (
        item.type === 'asset' && item.fileName === 'unzen-functions.d.ts'
      ));

      expect(chunk?.type).toBe('chunk');
      expect(chunk && chunk.type === 'chunk' ? chunk.code : '').toContain('server.defineRaw');
      expect(chunk && chunk.type === 'chunk' ? chunk.code : '').not.toContain('value: number');
      expect(chunk && chunk.type === 'chunk' ? chunk.code : '').toContain('(value) => value * 2');
      expect(declaration?.type).toBe('asset');
      expect(declaration && declaration.type === 'asset' ? declaration.source : '')
        .toContain('readonly "double": (value: number) => number;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bundles an imported dependency into the extracted registration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-vite-dependency-'));
    const packageDirectory = join(root, 'node_modules', 'unzen-safe-math');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
      name: 'unzen-safe-math',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }));
    writeFileSync(
      join(packageDirectory, 'index.js'),
      `throw new Error('UNZEN_HOST_IMPORT_EXECUTED');
export const triple = (value) => value * 3;`,
    );
    const entry = join(root, 'functions.ts');
    writeFileSync(entry, `import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number): number => triple(value));
export { server };`);

    try {
      const buildResult = await build({
        configFile: false,
        logLevel: 'silent',
        plugins: [unzenVitePlugin({
          dependencyBundling: { allowedModules: ['unzen-safe-math'] },
          declarationFile: 'unzen-functions.d.ts',
        })],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ['es'] },
          rollupOptions: { external: ['@unzen/server'] },
        },
      });
      const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
      const generated = outputs.flatMap((output) => (
        'output' in output ? output.output : []
      ));
      const chunk = generated.find((item) => item.type === 'chunk');
      const declaration = generated.find((item) => (
        item.type === 'asset' && item.fileName === 'unzen-functions.d.ts'
      ));
      const code = chunk?.type === 'chunk' ? chunk.code : '';

      expect(code).toContain('server.defineRaw');
      expect(code).toContain('function run(...args)');
      expect(code).toContain('value * 3');
      expect(code).not.toContain("from 'unzen-safe-math'");
      expect(declaration?.type).toBe('asset');
      expect(declaration && declaration.type === 'asset' ? declaration.source : '')
        .toContain('readonly "triple": (value: number) => number;');

      const defineRaw = vi.fn();
      const executable = code
        .replace(/^import[^\n]+;\n?/gm, '')
        .replace(/^export\s*\{[^}]*\};?\n?/gm, '');
      expect(() => new Function('UnzenServer', executable)(
        class TestUnzenServer { defineRaw = defineRaw; },
      )).not.toThrow();
      expect(defineRaw).toHaveBeenCalledOnce();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
