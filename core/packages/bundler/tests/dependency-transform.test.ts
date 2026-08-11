import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  transformUnzenDefinitionsWithDependencies,
  UnzenTransformError,
} from '../src/source-transform';

const fixtureDirectories: string[] = [];

function createPackageProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'unzen-transform-project-'));
  fixtureDirectories.push(root);
  const packageDirectory = join(root, 'node_modules', 'unzen-safe-math');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'unzen-safe-math',
      version: '1.0.0',
      type: 'module',
      exports: './index.js',
    }),
  );
  writeFileSync(
    join(packageDirectory, 'index.js'),
    `export default function double(value) { return value * 2; }
export function triple(value) { return value * 3; }
export const settings = { factor: 3 };
export function requestPrivateData() { return fetch('/private'); }`,
  );
  return root;
}

function executeRegistration(source: string): unknown[] {
  const registrations: unknown[][] = [];
  class TestUnzenServer {
    defineRaw(...args: unknown[]): void {
      registrations.push(args);
    }
  }
  const executable = source.replace(/^import[^\n]+;\n?/gm, '');
  new Function('UnzenServer', executable)(TestUnzenServer);
  return registrations[0] ?? [];
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('transformUnzenDefinitionsWithDependencies', () => {
  it('bundles referenced runtime imports into registerable run code', async () => {
    const resolveDir = createPackageProject();
    const source = `import { triple, type TripleOptions } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number): number => triple(value), { timeout: 500 });`;

    const result = await transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    );

    expect(result?.definitions[0]?.returnType).toBe('number');
    const registration = executeRegistration(result!.code);
    expect(registration[0]).toBe('triple');
    expect(registration[2]).toEqual({ timeout: 500 });
    const bundledCode = registration[1] as string;
    expect(bundledCode.trimStart()).toMatch(/^function run\(\.\.\.args\)/);
    expect(new Function(`${bundledCode}\nreturn run(4);`)()).toBe(12);
  });

  it('does not bundle unrelated runtime imports from the containing module', async () => {
    const resolveDir = createPackageProject();
    const source = `import { unused } from 'not-allowed';
import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number) => triple(value));`;

    const result = await transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    );

    expect(result?.code).toContain('server.defineRaw');
  });

  it.each([
    {
      label: 'default import',
      importCode: `import double from 'unzen-safe-math';`,
      expression: 'double(value)',
      expected: 8,
    },
    {
      label: 'aliased named import',
      importCode: `import { triple as thrice } from 'unzen-safe-math';`,
      expression: 'thrice(value)',
      expected: 12,
    },
    {
      label: 'namespace import',
      importCode: `import * as math from 'unzen-safe-math';`,
      expression: 'math.triple(value)',
      expected: 12,
    },
  ])('bundles a referenced $label', async ({ importCode, expression, expected }) => {
    const resolveDir = createPackageProject();
    const source = `${importCode}
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('calculate', (value: number) => ${expression});`;

    const result = await transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    );
    const bundledCode = executeRegistration(result!.code)[1] as string;

    expect(new Function(`${bundledCode}\nreturn run(4);`)()).toBe(expected);
  });

  it('keeps closure references forbidden when dependency bundling is enabled', async () => {
    const resolveDir = createPackageProject();
    const source = `import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const offset = 1;
const server = new UnzenServer();
server.define('shifted', (value: number) => triple(value) + offset);`;

    await expect(transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    )).rejects.toThrow(/closure reference "offset"/);
  });

  it('keeps writes to imported bindings forbidden', async () => {
    const resolveDir = createPackageProject();
    const source = `import { settings } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('mutate', () => ++settings.factor);`;

    await expect(transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    )).rejects.toThrow(/assignment to closure reference "settings"/);
  });

  it('reports the definition location when a referenced package is not allowed', async () => {
    const resolveDir = createPackageProject();
    const fileName = join(resolveDir, 'functions.ts');
    const source = `import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number) => triple(value));`;

    try {
      await transformUnzenDefinitionsWithDependencies(
        source,
        fileName,
        { allowedModules: [] },
      );
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenTransformError);
      expect((error as Error).message).toContain(`${fileName}:4:1`);
      expect((error as Error).message).toContain('unzen-safe-math');
    }
  });

  it('reports the definition location when an allowed package uses a forbidden API', async () => {
    const resolveDir = createPackageProject();
    const fileName = join(resolveDir, 'functions.ts');
    const source = `import { requestPrivateData } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('unsafe', () => requestPrivateData());`;

    try {
      await transformUnzenDefinitionsWithDependencies(
        source,
        fileName,
        { allowedModules: ['unzen-safe-math'] },
      );
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenTransformError);
      expect(error).toMatchObject({ fileName, line: 4, column: 1 });
      expect((error as Error).message).toMatch(/forbidden APIs[\s\S]*fetch/);
    }
  });
});
