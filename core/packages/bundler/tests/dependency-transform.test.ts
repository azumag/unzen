import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import {
  transformUnzenDefinitionsWithDependencies,
  UnzenTransformError,
} from '../src/source-transform';
import { MAX_ALLOWED_MODULE_PATTERNS } from '../src/bundler';

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

function importedNames(source: string, moduleName: string): string[] {
  const sourceFile = ts.createSourceFile(
    'transformed.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (!clause) return [];
    const names = clause.name ? [clause.name.text] : [];
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      names.push(clause.namedBindings.name.text);
    } else if (clause.namedBindings) {
      names.push(...clause.namedBindings.elements.map((element) => element.name.text));
    }
    return names;
  }
  return [];
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('transformUnzenDefinitionsWithDependencies', () => {
  it('rejects an oversized sparse whitelist before source analysis', async () => {
    await expect(transformUnzenDefinitionsWithDependencies(
      'export const untouched = true;',
      '/src/functions.ts',
      { allowedModules: new Array(MAX_ALLOWED_MODULE_PATTERNS + 1) },
    )).rejects.toThrow(`at most ${MAX_ALLOWED_MODULE_PATTERNS} patterns`);
  });

  it('snapshots a whitelist without invoking its iterator', async () => {
    const allowedModules = ['unzen-safe-math'];
    Object.defineProperty(allowedModules, Symbol.iterator, {
      value() {
        throw new Error('whitelist iterator must not run');
      },
    });
    const result = await transformUnzenDefinitionsWithDependencies(
      'export const untouched = true;',
      '/src/functions.ts',
      { allowedModules },
    );

    expect(result).toBeNull();
  });

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
    expect(result?.watchFiles).toEqual([
      join(resolveDir, 'node_modules', 'unzen-safe-math', 'index.js'),
    ]);
    expect(importedNames(result!.code, 'unzen-safe-math')).toEqual(['TripleOptions']);
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
    expect(importedNames(result!.code, 'unzen-safe-math')).toEqual([]);
    expect(importedNames(result!.code, 'not-allowed')).toEqual(['unused']);
  });

  it('keeps a bundled binding when host code also references it', async () => {
    const resolveDir = createPackageProject();
    const source = `import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number) => triple(value));
export const hostValue = triple(2);`;

    const result = await transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    );

    expect(importedNames(result!.code, 'unzen-safe-math')).toEqual(['triple']);
    expect(result?.code).toContain('export const hostValue = triple(2)');
  });

  it('keeps a bundled binding referenced by a host type query', async () => {
    const resolveDir = createPackageProject();
    const source = `import { triple } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
type TripleFunction = typeof triple;
const server = new UnzenServer();
server.define('triple', (value: number) => triple(value));
export type { TripleFunction };`;

    const result = await transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    );

    expect(importedNames(result!.code, 'unzen-safe-math')).toEqual(['triple']);
  });

  it('removes only extracted bindings from a mixed host import', async () => {
    const resolveDir = createPackageProject();
    const source = `import { triple, settings } from 'unzen-safe-math';
import { UnzenServer } from '@unzen/server';
const server = new UnzenServer();
server.define('triple', (value: number) => triple(value));
export const hostFactor = settings.factor;`;

    const result = await transformUnzenDefinitionsWithDependencies(
      source,
      join(resolveDir, 'functions.ts'),
      { allowedModules: ['unzen-safe-math'] },
    );

    expect(importedNames(result!.code, 'unzen-safe-math')).toEqual(['settings']);
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

    expect(importedNames(result!.code, 'unzen-safe-math')).toEqual([]);
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

  it('reports the definition location when the dependency bundle exceeds its limit', async () => {
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
        { allowedModules: ['unzen-safe-math'], maxBundleSize: 1 },
      );
      throw new Error('expected transform to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenTransformError);
      expect(error).toMatchObject({ fileName, line: 4, column: 1 });
      expect((error as Error).message).toContain('exceeds maxBundleSize of 1 byte');
    }
  });
});
