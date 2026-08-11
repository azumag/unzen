import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnzenSourceTransformResult } from '../src/source-transform';

const transformWithDependencies = vi.hoisted(() => vi.fn());

vi.mock('../src/source-transform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source-transform')>();
  return {
    ...actual,
    transformUnzenDefinitionsWithDependencies: transformWithDependencies,
  };
});

import { transformUnzenDefinitions } from '../src/source-transform';
import { unzenVitePlugin, type UnzenVitePlugin } from '../src/vite-plugin';

const DOUBLE_SOURCE = `import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('double', (value: number) => value * 2);`;
const TRIPLE_SOURCE = DOUBLE_SOURCE.replaceAll('double', 'triple');

interface DeferredTransform {
  promise: Promise<UnzenSourceTransformResult | null>;
  resolve(result: UnzenSourceTransformResult | null): void;
}

function deferredTransform(): DeferredTransform {
  let resolve!: DeferredTransform['resolve'];
  const promise = new Promise<UnzenSourceTransformResult | null>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function transformed(source: string): UnzenSourceTransformResult {
  return transformUnzenDefinitions(source, '/src/functions.ts')!;
}

function emittedDeclaration(plugin: UnzenVitePlugin): string {
  let declaration = '';
  plugin.generateBundle.call({
    emitFile(asset) {
      declaration = asset.source;
      return 'declaration-asset';
    },
  });
  return declaration;
}

afterEach(() => {
  transformWithDependencies.mockReset();
});

describe('unzenVitePlugin async declaration snapshots', () => {
  it('ignores an older transform that resolves after a newer invocation', async () => {
    const first = deferredTransform();
    const second = deferredTransform();
    transformWithDependencies
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const plugin = unzenVitePlugin({
      declarationFile: 'unzen-functions.d.ts',
      dependencyBundling: { allowedModules: [] },
    });
    plugin.buildStart();

    const olderResult = plugin.transform(DOUBLE_SOURCE, '/src/functions.ts');
    const newerResult = plugin.transform(TRIPLE_SOURCE, '/src/functions.ts');
    second.resolve(transformed(TRIPLE_SOURCE));
    await newerResult;
    first.resolve(transformed(DOUBLE_SOURCE));
    await olderResult;

    const declaration = emittedDeclaration(plugin);
    expect(declaration).toContain('readonly "triple"');
    expect(declaration).not.toContain('readonly "double"');
  });

  it('ignores a transform from a previous build that resolves late', async () => {
    const previousBuild = deferredTransform();
    const currentBuild = deferredTransform();
    transformWithDependencies
      .mockImplementationOnce(() => previousBuild.promise)
      .mockImplementationOnce(() => currentBuild.promise);
    const plugin = unzenVitePlugin({
      declarationFile: 'unzen-functions.d.ts',
      dependencyBundling: { allowedModules: [] },
    });
    plugin.buildStart();
    const staleResult = plugin.transform(DOUBLE_SOURCE, '/src/functions.ts');

    plugin.buildStart();
    const freshResult = plugin.transform(TRIPLE_SOURCE, '/src/functions.ts');
    currentBuild.resolve(transformed(TRIPLE_SOURCE));
    await freshResult;
    previousBuild.resolve(transformed(DOUBLE_SOURCE));
    await staleResult;

    const declaration = emittedDeclaration(plugin);
    expect(declaration).toContain('readonly "triple"');
    expect(declaration).not.toContain('readonly "double"');
  });
});
