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
});
