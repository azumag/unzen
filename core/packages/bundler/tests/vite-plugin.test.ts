import { describe, expect, it } from 'vitest';
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
});
