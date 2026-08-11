import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import unzenWebpackLoader, { type UnzenWebpackLoaderContext } from '../src/webpack-loader';

const SOURCE = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('double', (value: number) => value * 2);`;

describe('unzenWebpackLoader', () => {
  it('returns transformed code and a source map through the loader callback', () => {
    const callback = vi.fn();
    const cacheable = vi.fn();
    const context: UnzenWebpackLoaderContext = {
      resourcePath: '/src/functions.ts',
      sourceMap: true,
      callback,
      cacheable,
    };

    const returned = unzenWebpackLoader.call(context, SOURCE, undefined, { marker: true });

    expect(returned).toBeUndefined();
    expect(cacheable).toHaveBeenCalledWith(true);
    expect(callback).toHaveBeenCalledOnce();
    const [error, code, map, meta] = callback.mock.calls[0]!;
    expect(error).toBeNull();
    expect(code).toContain('server.defineRaw');
    expect(map).toBeDefined();
    expect(meta).toEqual({ marker: true });
  });

  it('passes an unchanged module and incoming map through when there is no definition', () => {
    const callback = vi.fn();
    const inputMap = { version: 3, sources: ['value.ts'], names: [], mappings: '' };
    const context: UnzenWebpackLoaderContext = {
      resourcePath: '/src/value.ts',
      sourceMap: true,
      callback,
      cacheable: vi.fn(),
    };

    unzenWebpackLoader.call(context, 'export const value = 1;', inputMap);

    expect(callback).toHaveBeenCalledWith(
      null,
      'export const value = 1;',
      inputMap,
      undefined,
    );
  });

  it('runs asynchronously and disables loader caching for dependency bundling', async () => {
    const root = mkdtempSync(join(tmpdir(), 'unzen-webpack-loader-'));
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
    const callback = vi.fn();
    const cacheable = vi.fn();
    const addDependency = vi.fn();
    const asyncLoader = vi.fn(() => callback);
    const context: UnzenWebpackLoaderContext = {
      resourcePath: join(root, 'functions.ts'),
      sourceMap: true,
      callback: vi.fn(),
      cacheable,
      addDependency,
      async: asyncLoader,
      getOptions: () => ({
        dependencyBundling: { allowedModules: ['unzen-safe-math'] },
      }),
    };

    try {
      unzenWebpackLoader.call(context, source, undefined, { marker: true });
      await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce());

      expect(asyncLoader).toHaveBeenCalledOnce();
      expect(cacheable).toHaveBeenCalledWith(false);
      expect(addDependency).toHaveBeenCalledWith(join(packageDirectory, 'index.js'));
      expect(context.callback).not.toHaveBeenCalled();
      const [error, code, map, meta] = callback.mock.calls[0]!;
      expect(error).toBeNull();
      expect(code).toContain('server.defineRaw');
      expect(code).toContain('function run(...args)');
      expect(map).toBeDefined();
      expect(meta).toEqual({ marker: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
