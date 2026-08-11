import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { unzenVitePlugin } from '../src/vite-plugin';

const SOURCE = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('double', (value: number) => value * 2);`;

describe('unzenVitePlugin', () => {
  it('uses a pre-transform hook for TypeScript and JavaScript modules', () => {
    const plugin = unzenVitePlugin();

    expect(plugin.name).toBe('unzen-function-extraction');
    expect(plugin.enforce).toBe('pre');
    const result = plugin.transform(SOURCE, '/src/functions.ts');
    expect(result).not.toBeNull();
    expect(result && result.code).toContain('server.defineRaw');
    expect(result && result.map).toBeDefined();
  });

  it('ignores dependencies, unsupported extensions, and Vite raw requests', () => {
    const plugin = unzenVitePlugin();

    expect(plugin.transform(SOURCE, '/project/node_modules/pkg/index.ts')).toBeNull();
    expect(plugin.transform(SOURCE, '/src/functions.css')).toBeNull();
    expect(plugin.transform(SOURCE, '/src/functions.ts?raw')).toBeNull();
  });

  it('supports include and exclude filters without a Vite runtime dependency', () => {
    const plugin = unzenVitePlugin({
      include: /\/server\//,
      exclude: /\.generated\.ts$/,
    });

    expect(plugin.transform(SOURCE, '/src/client/functions.ts')).toBeNull();
    expect(plugin.transform(SOURCE, '/src/server/functions.generated.ts')).toBeNull();
    expect(plugin.transform(SOURCE, '/src/server/functions.ts')).not.toBeNull();
  });

  it('returns null when an eligible module has no matching definition', () => {
    const plugin = unzenVitePlugin();
    expect(plugin.transform('export const value = 1;', '/src/value.ts')).toBeNull();
  });

  it('uses the asynchronous dependency transform only when explicitly configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-vite-plugin-'));
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
      'export const triple = (value) => value * 3;',
    );
    const source = `import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number) => triple(value));`;

    try {
      const plugin = unzenVitePlugin({
        dependencyBundling: { allowedModules: ['unzen-safe-math'] },
      });
      const pending = plugin.transform(source, join(root, 'functions.ts'));
      expect(pending).toBeInstanceOf(Promise);

      const result = await pending;
      expect(result?.code).toContain('server.defineRaw');
      expect(result?.code).toContain('function run(...args)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits one generated declaration asset when configured', () => {
    const plugin = unzenVitePlugin({ declarationFile: 'types/unzen-functions.d.ts' });
    const emitted: Array<{ type: 'asset'; fileName: string; source: string }> = [];
    plugin.buildStart();
    plugin.transform(SOURCE, '/src/functions.ts');

    plugin.generateBundle.call({
      emitFile(asset) {
        emitted.push(asset);
        return 'declaration-asset';
      },
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.fileName).toBe('types/unzen-functions.d.ts');
    expect(emitted[0]?.source).toContain('readonly "double": (value: number) => unknown;');
  });

  it('does not emit declarations unless a declaration file is configured', () => {
    const plugin = unzenVitePlugin();
    const emitFile = vi.fn(() => 'unused');
    plugin.buildStart();
    plugin.transform(SOURCE, '/src/functions.ts');

    plugin.generateBundle.call({ emitFile });

    expect(emitFile).not.toHaveBeenCalled();
  });

  it('replaces a module declaration snapshot when Vite transforms it again', () => {
    const plugin = unzenVitePlugin({ declarationFile: 'unzen-functions.d.ts' });
    let declaration = '';
    plugin.buildStart();
    plugin.transform(SOURCE, '/src/functions.ts');
    plugin.transform(SOURCE.replaceAll('double', 'triple'), '/src/functions.ts');

    plugin.generateBundle.call({
      emitFile(asset) {
        declaration = asset.source;
        return 'declaration-asset';
      },
    });

    expect(declaration).toContain('readonly "triple"');
    expect(declaration).not.toContain('readonly "double"');
  });

  it.each([
    '/absolute/unzen.d.ts',
    '../unzen.d.ts',
    'types/unzen.ts',
    '',
  ])('rejects unsafe or non-declaration asset path %j', (declarationFile) => {
    expect(() => unzenVitePlugin({ declarationFile })).toThrow(
      'declarationFile must be a relative .d.ts asset path',
    );
  });
});
