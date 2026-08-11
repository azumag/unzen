import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function readPackage(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(coreRoot, 'packages', name, 'package.json'), 'utf8'));
}

describe('published package metadata', () => {
  it('uses a publishable exact version for internal runtime dependencies', async () => {
    const shared = await readPackage('shared');
    const sharedVersion = shared.version;
    expect(typeof sharedVersion).toBe('string');

    for (const name of ['client', 'server', 'bundler']) {
      const packageJson = await readPackage(name);
      const dependencies = packageJson.dependencies as Record<string, unknown>;
      expect(dependencies['@unzen/shared'], `${name} @unzen/shared dependency`)
        .toBe(sharedVersion);
    }
  });
});
