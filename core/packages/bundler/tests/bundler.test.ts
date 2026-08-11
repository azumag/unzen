/**
 * Tests for the main bundler module
 *
 * The bundler takes function code with npm imports and produces
 * self-contained code that can run in the QuickJS sandbox.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { bundle, DEFAULT_MAX_BUNDLE_SIZE_BYTES } from '../src/bundler';

const fixtureDirectories: string[] = [];

function createPackageProject(packages: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'unzen-bundler-project-'));
  fixtureDirectories.push(root);
  for (const [name, source] of Object.entries(packages)) {
    const packageDirectory = join(root, 'node_modules', name);
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.js' }),
    );
    writeFileSync(join(packageDirectory, 'index.js'), source);
  }
  return root;
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('bundler', () => {
  it('should bundle simple code without imports', async () => {
    const result = await bundle({
      code: `export function run(a, b) { return a + b; }`,
      allowedModules: [],
    });

    expect(result.code).toBeDefined();
    expect(result.code.length).toBeGreaterThan(0);
    expect(result.size).toBeGreaterThan(0);
    expect(result.modules).toEqual([]);
    expect(result.watchFiles).toEqual([]);
  });

  it('should produce code containing function run', async () => {
    const result = await bundle({
      code: `export function run(x) { return x * 2; }`,
      allowedModules: [],
    });

    expect(result.code).toContain('run');
  });

  it('should emit code that defineRaw can register without wrapping', async () => {
    const result = await bundle({
      code: `export function run(value) { return value * 2; }`,
      allowedModules: [],
    });

    expect(result.code.trimStart()).toMatch(/^function run\(\.\.\.args\)/);
    expect(new Function(`${result.code}\nreturn run(6);`)()).toBe(12);
  });

  it('should report bundle size in bytes', async () => {
    const result = await bundle({
      code: `export function run() { return 42; }`,
      allowedModules: [],
    });

    expect(typeof result.size).toBe('number');
    expect(result.size).toBeGreaterThan(0);
    expect(result.size).toBe(Buffer.byteLength(result.code, 'utf8'));
  });

  it('should enforce a 100 KiB default bundle size limit', async () => {
    const payload = 'x'.repeat(DEFAULT_MAX_BUNDLE_SIZE_BYTES);

    await expect(bundle({
      code: `export function run() { return ${JSON.stringify(payload)}; }`,
      allowedModules: [],
    })).rejects.toThrow(/exceeds maxBundleSize of 102400 bytes/);
  });

  it('should allow an explicit larger bundle size limit', async () => {
    const payload = 'x'.repeat(DEFAULT_MAX_BUNDLE_SIZE_BYTES);
    const result = await bundle({
      code: `export function run() { return ${JSON.stringify(payload)}; }`,
      allowedModules: [],
      maxBundleSize: DEFAULT_MAX_BUNDLE_SIZE_BYTES * 2,
    });

    expect(result.size).toBeGreaterThan(DEFAULT_MAX_BUNDLE_SIZE_BYTES);
    expect(new Function(`${result.code}\nreturn run();`)()).toBe(payload);
  });

  it('should accept an exact final-payload boundary and reject one byte less', async () => {
    const options = {
      code: `export function run() { return 'boundary'; }`,
      allowedModules: [],
    };
    const baseline = await bundle({ ...options, maxBundleSize: 10 * 1024 });
    const atBoundary = await bundle({ ...options, maxBundleSize: baseline.size });

    expect(atBoundary.size).toBe(baseline.size);
    await expect(bundle({
      ...options,
      maxBundleSize: baseline.size - 1,
    })).rejects.toThrow(`exceeds maxBundleSize of ${baseline.size - 1} bytes`);
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'should reject invalid maxBundleSize %s',
    async (maxBundleSize) => {
      await expect(bundle({
        code: 'export function run() { return 1; }',
        allowedModules: [],
        maxBundleSize,
      })).rejects.toThrow(/maxBundleSize must be a positive integer/);
    },
  );

  it('should reject code with forbidden Node.js built-in imports', async () => {
    await expect(bundle({
      code: `import { readFileSync } from 'fs'; export function run() { return readFileSync('/etc/passwd'); }`,
      allowedModules: ['fs'],  // Even if "allowed", fs is a Node built-in
    })).rejects.toThrow(/fs/);
  });

  it.each([
    'fs/promises',
    'node:fs/promises',
    'assert/strict',
    'node:test',
  ])('should reject built-in subpath %s before module resolution', async (moduleName) => {
    await expect(bundle({
      code: `import * as builtin from ${JSON.stringify(moduleName)}; export function run() { return builtin; }`,
      allowedModules: [moduleName],
    })).rejects.toThrow(/Node\.js built-in/);
  });

  it('should reject code with non-whitelisted module imports', async () => {
    await expect(bundle({
      code: `import axios from 'axios'; export function run() { return axios.get('https://example.com'); }`,
      allowedModules: ['lodash'],  // axios not in the list
    })).rejects.toThrow(/axios/);
  });

  it.each([
    ['fetch', `fetch("https://evil.com")`],
    ['Proxy', 'new Proxy({}, {})'],
    ['Reflect', 'Reflect.get({}, "value")'],
    ['WeakRef', 'new WeakRef({})'],
    ['FinalizationRegistry', 'new FinalizationRegistry(() => undefined)'],
    ['WebAssembly', 'WebAssembly.compile(new Uint8Array())'],
  ])('should reject sandbox-disabled global %s after bundling', async (name, expression) => {
    await expect(bundle({
      code: `export function run() { return ${expression}; }`,
      allowedModules: [],
    })).rejects.toThrow(name);
  });

  it('should use ES2018 target for QuickJS compatibility', async () => {
    // ES2018 should work; optional chaining (ES2020) should be transpiled
    const result = await bundle({
      code: `export function run(obj) { return obj?.value ?? 'default'; }`,
      allowedModules: [],
    });

    // The bundled output should NOT contain ?. (optional chaining)
    // because ES2018 doesn't support it - esbuild should transpile
    expect(result.code).not.toContain('?.');
    expect(result.code).not.toContain('??');
  });

  it.each([
    ['async function', 'export async function run() { return 1; }', 'async function'],
    ['Promise', 'export function run() { return Promise.resolve(1); }', 'Promise'],
    ['generator', 'export function* run() { yield 1; }', 'generator function'],
  ])('should reject unsupported %s execution after bundling', async (_label, code, message) => {
    await expect(bundle({ code, allowedModules: [] })).rejects.toThrow(message);
  });

  it('should return empty modules array for code without imports', async () => {
    const result = await bundle({
      code: `export function run() { return 'hello'; }`,
      allowedModules: [],
    });

    expect(result.modules).toEqual([]);
  });

  // Review fix: esbuild plugin validates modules at resolve time
  it('should reject dynamic require() of forbidden modules', async () => {
    await expect(bundle({
      code: `export function run() { const m = require('child_process'); return m; }`,
      allowedModules: [],
    })).rejects.toThrow(/require|child_process/);
  });

  it('should reject path traversal in imports', async () => {
    await expect(bundle({
      code: `import evil from 'lodash/../../fs-extra'; export function run() { return evil; }`,
      allowedModules: ['lodash/*'],
    })).rejects.toThrow(/traversal|lodash/);
  });

  // Review fix: esbuild plugin validates ALL module resolution, not just source imports
  it('should use esbuild plugin to validate modules at resolution time', async () => {
    // This test verifies the esbuild onResolve plugin is active.
    // Even modules that aren't visible in source code import statements
    // should be caught at resolution time.
    await expect(bundle({
      code: `import net from 'net'; export function run() { return net; }`,
      allowedModules: [],
    })).rejects.toThrow(/net/);
  });

  it('should resolve allowed packages from the configured project directory', async () => {
    const resolveDir = createPackageProject({
      'unzen-safe-math': 'export function triple(value) { return value * 3; }',
    });

    const result = await bundle({
      code: `
        import {
          triple
        } from 'unzen-safe-math';
        export function run(value) { return triple(value); }
      `,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    });

    expect(result.modules).toEqual(['unzen-safe-math']);
    expect(result.watchFiles).toEqual([
      join(resolveDir, 'node_modules', 'unzen-safe-math', 'index.js'),
    ]);
    expect(result.code).not.toContain(basename(resolveDir));
    expect(new Function(`${result.code}\nreturn run(7);`)()).toBe(21);
  });

  it('should allow static relative imports from the application', async () => {
    const resolveDir = createPackageProject({});
    writeFileSync(join(resolveDir, 'helper.js'), 'export const value = 42;');

    const result = await bundle({
      code: `import { value } from './helper.js'; export function run() { return value; }`,
      allowedModules: [],
      resolveDir,
    });

    expect(new Function(`${result.code}\nreturn run();`)()).toBe(42);
  });

  it('should allow relative modules contained by an allowed package', async () => {
    const resolveDir = createPackageProject({
      'unzen-safe-math': `
        import { triple } from './internal.js';
        export { triple };
      `,
    });
    writeFileSync(
      join(resolveDir, 'node_modules', 'unzen-safe-math', 'internal.js'),
      'export function triple(value) { return value * 3; }',
    );

    const result = await bundle({
      code: `
        import { triple } from 'unzen-safe-math';
        export function run(value) { return triple(value); }
      `,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    });

    expect(new Function(`${result.code}\nreturn run(7);`)()).toBe(21);
  });

  it('should reject a relative escape from an allowed package', async () => {
    const resolveDir = createPackageProject({
      'unzen-safe-math': `
        import { secret } from '../unzen-hidden-helper/index.js';
        export { secret };
      `,
      'unzen-hidden-helper': `export const secret = 'not allowed';`,
    });

    await expect(bundle({
      code: `
        import { secret } from 'unzen-safe-math';
        export function run() { return secret; }
      `,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    })).rejects.toThrow(/escapes dependency package "unzen-safe-math"/);
  });

  it('should reject a package-internal symlink that resolves outside its root', async () => {
    const resolveDir = createPackageProject({
      'unzen-safe-math': `
        import { secret } from './linked-secret';
        export { secret };
      `,
    });
    const secretFile = join(resolveDir, 'secret.js');
    writeFileSync(secretFile, `export const secret = 'not allowed';`);
    symlinkSync(
      secretFile,
      join(resolveDir, 'node_modules', 'unzen-safe-math', 'linked-secret.js'),
    );

    await expect(bundle({
      code: `
        import { secret } from 'unzen-safe-math';
        export function run() { return secret; }
      `,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    })).rejects.toThrow(/escapes dependency package "unzen-safe-math"/);
  });

  it('should retain the package boundary when the package root is a symlink', async () => {
    const resolveDir = createPackageProject({});
    const packageDirectory = join(resolveDir, 'packages', 'unzen-safe-math');
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
      `import { secret } from '../secret.js'; export { secret };`,
    );
    writeFileSync(join(resolveDir, 'packages', 'secret.js'), `export const secret = 'not allowed';`);
    mkdirSync(join(resolveDir, 'node_modules'), { recursive: true });
    symlinkSync(
      packageDirectory,
      join(resolveDir, 'node_modules', 'unzen-safe-math'),
      'dir',
    );

    await expect(bundle({
      code: `
        import { secret } from 'unzen-safe-math';
        export function run() { return secret; }
      `,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    })).rejects.toThrow(/escapes dependency package "unzen-safe-math"/);
  });

  it('should reject application-relative access to node_modules', async () => {
    const resolveDir = createPackageProject({
      'unzen-hidden-helper': `export const secret = 'not allowed';`,
    });

    await expect(bundle({
      code: `
        import { secret } from './node_modules/unzen-hidden-helper/index.js';
        export function run() { return secret; }
      `,
      allowedModules: [],
      resolveDir,
    })).rejects.toThrow(/must be imported by name.*allowedModules/);
  });

  it('should reject asynchronous execution inside an allowed dependency', async () => {
    const resolveDir = createPackageProject({
      'unzen-async-helper': `
        export function calculate(value) {
          return Promise.resolve(value * 2);
        }
      `,
    });

    await expect(bundle({
      code: `
        import { calculate } from 'unzen-async-helper';
        export function run(value) { return calculate(value); }
      `,
      allowedModules: ['unzen-async-helper'],
      resolveDir,
    })).rejects.toThrow(/Promise.*asynchronous execution/);
  });

  it('should collect modules from re-export declarations', async () => {
    const resolveDir = createPackageProject({
      'unzen-safe-math': 'export function triple(value) { return value * 3; }',
    });

    const result = await bundle({
      code: `export { triple as run } from 'unzen-safe-math';`,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    });

    expect(result.modules).toEqual(['unzen-safe-math']);
    expect(new Function(`${result.code}\nreturn run(5);`)()).toBe(15);
  });

  it('should ignore import-like text in comments and string literals', async () => {
    const result = await bundle({
      code: `
        // import blocked from 'not-allowed';
        const documentation = "import other from 'also-not-allowed'";
        export function run() { return documentation.length; }
      `,
      allowedModules: [],
    });

    expect(result.modules).toEqual([]);
  });

  it('should reject non-whitelisted transitive package dependencies', async () => {
    const resolveDir = createPackageProject({
      'unzen-safe-math': `
        import { triple } from 'unzen-hidden-helper';
        export { triple };
      `,
      'unzen-hidden-helper': 'export function triple(value) { return value * 3; }',
    });

    await expect(bundle({
      code: `
        import { triple } from 'unzen-safe-math';
        export function run(value) { return triple(value); }
      `,
      allowedModules: ['unzen-safe-math'],
      resolveDir,
    })).rejects.toThrow(/unzen-hidden-helper.*not in the allowed modules list/);
  });

  it('should reject dynamic imports before esbuild can lower them', async () => {
    const resolveDir = createPackageProject({});
    writeFileSync(join(resolveDir, 'helper.js'), 'export const value = 42;');

    await expect(bundle({
      code: `
        export async function run() {
          return (await import('./helper.js')).value;
        }
      `,
      allowedModules: [],
      resolveDir,
    })).rejects.toThrow(/dynamic import.*blocked/);
  });

  it('should reject dynamic imports inside allowed dependencies', async () => {
    const resolveDir = createPackageProject({
      'unzen-dynamic-loader': `
        export async function load() {
          return (await import('./helper.js')).value;
        }
      `,
    });
    writeFileSync(
      join(resolveDir, 'node_modules', 'unzen-dynamic-loader', 'helper.js'),
      'export const value = 42;',
    );

    await expect(bundle({
      code: `
        import { load } from 'unzen-dynamic-loader';
        export function run() { return load(); }
      `,
      allowedModules: ['unzen-dynamic-loader'],
      resolveDir,
    })).rejects.toThrow(/dynamic import.*blocked/);
  });
});
