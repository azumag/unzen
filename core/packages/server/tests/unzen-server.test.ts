/**
 * Tests for UnzenServer
 *
 * UnzenServer is the main server class that ties together all components:
 * - FunctionRegistry for storage
 * - ManifestBuilder for manifest generation
 * - QuickJSRuntime for fallback execution
 * - Hono middleware for HTTP endpoints
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { join, dirname } from 'node:path';
import {
  readFileSync,
  copyFileSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { UnzenServer } from '../src/unzen-server';
import {
  MAX_FUNCTION_PAYLOAD_BYTES,
  MAX_MANIFEST_RESPONSE_BYTES,
  type FunctionDefinition,
} from '@unzen/shared';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('UnzenServer', () => {
  let server: UnzenServer;

  beforeEach(async () => {
    server = new UnzenServer({ baseUrl: 'https://example.com/unzen' });
    await server.initialize();
  });

  describe('define', () => {
    it('should register a JavaScript function', () => {
      const testFunc = function (text: string) {
        return text.toUpperCase();
      };

      server.define('uppercase', testFunc);

      const fn = server.getFunction('uppercase');
      expect(fn).toBeDefined();
      expect(fn?.name).toBe('uppercase');
      expect(fn?.runtime).toBe('quickjs');
      expect(fn?.code).toContain('toUpperCase');
    });

    it.each([
      ['async', async () => 1],
      ['generator', function* () { yield 1; }],
      ['async generator', async function* () { yield 1; }],
    ])('should reject an %s function at registration', (_label, fn) => {
      expect(() => server.define('unsupported', fn)).toThrow('synchronous non-generator');
      expect(server.getFunction('unsupported')).toBeUndefined();
    });

    it('rejects async functions even when Symbol.toStringTag is spoofed', () => {
      const fn = async () => 1;
      Object.defineProperty(fn, Symbol.toStringTag, { value: 'Function' });

      expect(() => server.define('spoofedAsync', fn))
        .toThrow('synchronous non-generator');
      expect(server.getFunction('spoofedAsync')).toBeUndefined();
    });

    it('extracts source with the intrinsic instead of a custom toString', () => {
      const fn = () => 1;
      Object.defineProperty(fn, 'toString', { value: () => '() => 999' });

      server.define('intrinsicSource', fn);

      expect(server.getFunction('intrinsicSource')?.code).toContain('() => 1');
      expect(server.getFunction('intrinsicSource')?.code).not.toContain('999');
    });

    it('does not invoke a synchronous function Symbol.toStringTag getter', () => {
      const fn = () => 1;
      Object.defineProperty(fn, Symbol.toStringTag, {
        get() {
          throw new Error('tag getter must not run');
        },
      });

      expect(() => server.define('tagSafe', fn)).not.toThrow();
      expect(server.getFunction('tagSafe')).toBeDefined();
    });

    it('should wrap function code with run() function', () => {
      const testFunc = function (x: number) {
        return x * 2;
      };

      server.define('double', testFunc);

      const fn = server.getFunction('double');
      expect(fn?.code).toContain('function run');
      expect(fn?.code).toMatch(/function run\s*\(/);
    });

    it('should generate unique hash for function code', () => {
      const func1 = function () {
        return 1;
      };
      const func2 = function () {
        return 2;
      };

      server.define('func1', func1);
      server.define('func2', func2);

      const fn1 = server.getFunction('func1');
      const fn2 = server.getFunction('func2');

      expect(fn1?.hash).not.toBe(fn2?.hash);
    });

    it('should increment version for each registration', () => {
      const func1 = function () {
        return 1;
      };
      const func2 = function () {
        return 2;
      };

      server.define('func1', func1);
      server.define('func2', func2);

      const fn1 = server.getFunction('func1');
      const fn2 = server.getFunction('func2');

      expect(fn1?.version).toBe(1);
      expect(fn2?.version).toBe(2);
    });

    it('should update version when re-registering function', () => {
      const func1 = function () {
        return 1;
      };
      const func2 = function () {
        return 2;
      };

      server.define('testFunc', func1);
      const v1 = server.getFunction('testFunc')?.version;

      server.define('testFunc', func2);
      const v2 = server.getFunction('testFunc')?.version;

      expect(v2).toBeGreaterThan(v1!);
    });

    it('should preserve execution options for compile-time-compatible definitions', () => {
      server.define('privateDouble', (value: number) => value * 2, {
        timeout: 500,
        noFallback: true,
      });

      const fn = server.getFunction('privateDouble');
      expect(fn?.timeout).toBe(500);
      expect(fn?.noFallback).toBe(true);
    });
  });

  describe('defineRaw', () => {
    it('should register function from raw code string', () => {
      const code = '(x) => x * 2';

      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      expect(fn).toBeDefined();
      expect(fn?.code).toContain('function run');
      expect(fn?.runtime).toBe('quickjs');
    });

    it('should wrap raw code with run() function', () => {
      const code = '(x) => x * 2';

      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      expect(fn?.code).toContain('function run');
      expect(fn?.code).toContain(code);
    });

    it('should generate hash from code string', () => {
      const code1 = 'return args[0] + 1';
      const code2 = 'return args[0] + 2';

      server.defineRaw('func1', code1);
      server.defineRaw('func2', code2);

      const fn1 = server.getFunction('func1');
      const fn2 = server.getFunction('func2');

      expect(fn1?.hash).not.toBe(fn2?.hash);
    });

    it('should NOT double-wrap code that starts with function run', () => {
      // When code is already in `function run(...)` form, wrapping it again
      // would create nested functions that break execution
      const code = 'function run(x) { return x * 2; }';
      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      // Code should be used as-is, not wrapped in another function run()
      expect(fn?.code).toBe(code);
      // Should NOT contain double wrapping
      expect(fn?.code).not.toContain('return (function run');
    });

    it('should NOT double-wrap code with leading whitespace before function run', () => {
      const code = '  function run(x) { return x * 3; }';
      server.defineRaw('triple', code);

      const fn = server.getFunction('triple');
      // After trimming, this is the exact `function run(...)` declaration.
      expect(fn?.code).toBe(code);
    });

    it('should still wrap arrow functions', () => {
      const code = '(x) => x * 2';
      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      expect(fn?.code).toContain('function run');
      expect(fn?.code).toContain(code);
    });

    it('should still wrap regular function expressions', () => {
      const code = 'function(x) { return x * 2; }';
      server.defineRaw('double', code);

      const fn = server.getFunction('double');
      expect(fn?.code).toContain('function run(...args)');
    });

    it('wraps named functions whose names only begin with run', async () => {
      const code = 'function runner(value) { return value * 2; }';
      server.defineRaw('runner', code);

      expect(server.getFunction('runner')?.code).toContain('function run(...args)');
      const response = await server.middleware().request('/exec/runner', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [21] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: 42 });
    });

    it('rejects unsafe names and empty code before registration', () => {
      expect(() => server.defineRaw('../escape', '() => 1'))
        .toThrow('Invalid function name');
      expect(() => server.defineRaw('emptyCode', '   '))
        .toThrow('Function code must be a non-empty string');
      expect(server.getFunction('../escape')).toBeUndefined();
      expect(server.getFunction('emptyCode')).toBeUndefined();
    });

    it('validates and snapshots options before changing registry state', () => {
      let timeoutReads = 0;
      let fallbackReads = 0;
      const options = new Proxy({}, {
        get(_target, property) {
          if (property === 'timeout') return ++timeoutReads === 1 ? 500 : 0;
          if (property === 'noFallback') return ++fallbackReads === 1 ? true : 'invalid';
          return undefined;
        },
      });

      server.defineRaw('stableOptions', '() => 1', options);
      expect(server.getFunction('stableOptions')).toMatchObject({
        timeout: 500,
        noFallback: true,
      });
      expect(timeoutReads).toBe(1);
      expect(fallbackReads).toBe(1);

      expect(() => server.defineRaw(
        'badOptions',
        '() => 2',
        { noFallback: 'yes' } as never,
      )).toThrow('Invalid noFallback option');
      expect(server.getFunction('badOptions')).toBeUndefined();
    });

    it('rejects oversized source without consuming a version', () => {
      server.defineRaw('beforeLarge', '() => 1');
      expect(server.getFunction('beforeLarge')?.version).toBe(1);

      expect(() => server.defineRaw(
        'tooLarge',
        'x'.repeat(MAX_FUNCTION_PAYLOAD_BYTES),
      )).toThrow(`exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
      expect(server.getFunction('tooLarge')).toBeUndefined();

      server.defineRaw('afterLarge', '() => 2');
      expect(server.getFunction('afterLarge')?.version).toBe(2);
    });
  });

  describe('pure function warnings', () => {
    it('should warn when function code contains fetch(', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      server.defineRaw('fetchFunc', '() => fetch("https://example.com")');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('fetch')
      );
      warnSpy.mockRestore();
    });

    it('should warn when function code contains XMLHttpRequest', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      server.defineRaw('xhrFunc', '() => new XMLHttpRequest()');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('XMLHttpRequest')
      );
      warnSpy.mockRestore();
    });

    it('should warn when function code contains import(', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      server.defineRaw('importFunc', '() => import("module")');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('import(')
      );
      warnSpy.mockRestore();
    });

    it('should warn when function code contains WebSocket', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      server.defineRaw('wsFunc', '() => new WebSocket("ws://example.com")');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket')
      );
      warnSpy.mockRestore();
    });

    it('should NOT warn for pure computation code', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      server.defineRaw('pureFunc', '(x) => x * 2');

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('getFunction', () => {
    it('should return function definition by name', () => {
      const testFunc = function () {
        return 42;
      };

      server.define('testFunc', testFunc);
      const fn = server.getFunction('testFunc');

      expect(fn).toBeDefined();
      expect(fn?.name).toBe('testFunc');
    });

    it('should return undefined for non-existent function', () => {
      const fn = server.getFunction('nonExistent');
      expect(fn).toBeUndefined();
    });

    it('does not expose mutable registry state', async () => {
      server.defineRaw('stable', '() => 7');
      const exposed = server.getFunction('stable')!;
      exposed.code = 'function run() { return 999; }';
      exposed.hash = `sha256:${'f'.repeat(64)}`;
      exposed.noFallback = true;

      const fresh = server.getFunction('stable')!;
      expect(fresh.code).not.toContain('999');
      expect(fresh.hash).not.toBe(exposed.hash);
      expect(fresh.noFallback).toBeUndefined();

      const manifest = await (await server.middleware().request('/manifest')).json();
      expect(manifest.functions.stable.hash).toBe(fresh.hash);
    });
  });

  describe('configuration', () => {
    it('should accept baseUrl in constructor', async () => {
      const server1 = new UnzenServer({ baseUrl: 'https://example.com' });
      const server2 = new UnzenServer({ baseUrl: 'https://test.com' });

      await server1.initialize();
      await server2.initialize();

      server1.define('func', () => 1);
      server2.define('func', () => 1);

      // baseUrl will be tested via middleware in integration tests
      expect(server1.getFunction('func')).toBeDefined();
      expect(server2.getFunction('func')).toBeDefined();
    });

    it('should have default configuration', async () => {
      const defaultServer = new UnzenServer();
      await defaultServer.initialize();

      expect(defaultServer).toBeDefined();

      defaultServer.define('test', () => 1);
      expect(defaultServer.getFunction('test')).toBeDefined();
    });

    it('normalizes an absolute or origin-relative baseUrl from one config read', async () => {
      let reads = 0;
      const configured = new UnzenServer({
        get baseUrl() {
          reads += 1;
          return reads === 1 ? '  /unzen///  ' : 'javascript:alert(1)';
        },
      });
      configured.defineRaw('testBase', '() => 1');
      const manifest = await (await configured.middleware().request('/manifest')).json();

      expect(reads).toBe(1);
      expect(manifest.functions.testBase.codeUrl).toMatch(/^\/unzen\/code\/testBase\?/);
    });

    it.each([
      null,
      [],
      { baseUrl: '' },
      { baseUrl: 'javascript:alert(1)' },
      { baseUrl: 'relative/path' },
      { baseUrl: '//attacker.example/unzen' },
      { baseUrl: 'https://user:secret@example.com/unzen' },
      { baseUrl: 'https://example.com/unzen?tenant=1' },
      { baseUrl: 'https://example.com/unzen#fragment' },
    ])('rejects invalid server configuration %j', (config) => {
      expect(() => new UnzenServer(config as never)).toThrow('baseUrl');
    });
  });

  describe('defineRaw with timeout option', () => {
    it('should store timeout in function definition', () => {
      server.defineRaw('heavy', '(x) => x', { timeout: 500 });
      const fn = server.getFunction('heavy');
      expect(fn).toBeDefined();
      expect(fn?.timeout).toBe(500);
    });

    it('should keep default timeout behavior when no options given', () => {
      server.defineRaw('light', '(x) => x');
      const fn = server.getFunction('light');
      expect(fn).toBeDefined();
      // timeout should be undefined (runtime defaults to 50ms)
      expect(fn?.timeout).toBeUndefined();
    });

    it('should reject timeout > 2000', () => {
      expect(() => {
        server.defineRaw('bad', '(x) => x', { timeout: 3000 });
      }).toThrow();
    });

    it('should reject timeout <= 0', () => {
      expect(() => {
        server.defineRaw('bad', '(x) => x', { timeout: 0 });
      }).toThrow();
      expect(() => {
        server.defineRaw('bad', '(x) => x', { timeout: -1 });
      }).toThrow();
    });

    it('should reject non-integer timeout', () => {
      expect(() => {
        server.defineRaw('bad', '(x) => x', { timeout: 50.5 });
      }).toThrow();
    });

    it('should reject NaN timeout', () => {
      expect(() => {
        server.defineRaw('bad', '(x) => x', { timeout: NaN });
      }).toThrow();
    });

    it('should reject Infinity timeout', () => {
      expect(() => {
        server.defineRaw('bad', '(x) => x', { timeout: Infinity });
      }).toThrow();
    });

    it('should pass per-function timeout to runtime on exec', async () => {
      // Register a function with 500ms timeout (heavy computation)
      // A simple sleep-like busy loop that would fail at 50ms but succeed at 500ms
      server.defineRaw('slowFunc', `function run() {
        var start = Date.now();
        while (Date.now() - start < 100) {} // busy-wait 100ms
        return 'done';
      }`, { timeout: 500 });

      const app = server.middleware();
      const res = await app.request('/exec/slowFunc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBe('done');
    });

    it('should timeout at default 50ms for functions without timeout option', async () => {
      // A busy loop that takes > 50ms should timeout with default
      server.defineRaw('slowNoTimeout', `function run() {
        var start = Date.now();
        while (Date.now() - start < 200) {} // busy-wait 200ms
        return 'done';
      }`);

      const app = server.middleware();
      const res = await app.request('/exec/slowNoTimeout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      // Should fail due to 50ms default timeout
      expect(res.status).toBe(500);
    });
  });

  describe('initialize', () => {
    it('should initialize QuickJS runtime', async () => {
      const newServer = new UnzenServer();
      await expect(newServer.initialize()).resolves.toBeUndefined();
    });
  });

  describe('defineMoonbit', () => {
    it('rejects an oversized module before reading it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'unzen-large-mb-'));
      const wasmPath = join(dir, 'oversized.wasm');
      try {
        writeFileSync(wasmPath, '');
        truncateSync(wasmPath, MAX_FUNCTION_PAYLOAD_BYTES + 1);
        expect(() => server.defineMoonbit('tooLargeWasm', wasmPath))
          .toThrow(`exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
        expect(server.getFunction('tooLargeWasm')).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects non-regular module paths before attempting a body read', () => {
      const dir = mkdtempSync(join(tmpdir(), 'unzen-non-file-mb-'));
      try {
        const paths = [dir];
        if (existsSync('/dev/zero')) paths.push('/dev/zero');
        for (let index = 0; index < paths.length; index++) {
          const name = `nonFileWasm${index}`;
          expect(() => server.defineMoonbit(name, paths[index]))
            .toThrow('must be a regular file');
          expect(server.getFunction(name)).toBeUndefined();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects a registration that would make the manifest unreadable', () => {
      server.defineRaw('beforeManifestLimit', '() => 1');

      expect(() => server.defineMoonbit(
        'tooWideManifest',
        join(fixtureDir, 'fibonacci.wasm'),
        { exportName: 'x'.repeat(MAX_MANIFEST_RESPONSE_BYTES) },
      )).toThrow(`Manifest exceeds ${MAX_MANIFEST_RESPONSE_BYTES} bytes`);
      expect(server.getFunction('tooWideManifest')).toBeUndefined();

      server.defineRaw('afterManifestLimit', '() => 2');
      expect(server.getFunction('afterManifestLimit')?.version).toBe(2);
    });

    it('should register a MoonBit wasm module with export metadata', () => {
      server.defineMoonbit('fibonacci', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      });

      const fn = server.getFunction('fibonacci');
      expect(fn).toBeDefined();
      expect(fn?.runtime).toBe('moonbit');
      expect(fn?.exportName).toBe('fibonacci');
      expect(fn?.hash).toBeTruthy();
    });

    it('should default the export name to run', () => {
      server.defineMoonbit('defaultRun', join(fixtureDir, 'fibonacci.wasm'));
      expect(server.getFunction('defaultRun')?.exportName).toBe('run');
    });

    it('should register, copy, and advertise MoonBit ABI metadata', async () => {
      const abi = { params: ['f64[]', 'scalar'] as const, result: 'f64[]' as const };
      const supplied = { params: [...abi.params], result: abi.result };
      Object.defineProperty(supplied.params, Symbol.iterator, {
        value: () => { throw new Error('iterator must not run'); },
      });
      server.defineMoonbit('scaleArray', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'scale_double_array',
        abi: supplied,
      });

      const stored = server.getFunction('scaleArray')?.moonbitAbi;
      expect(stored).toEqual(abi);
      expect(stored?.params).not.toBe(supplied.params);

      const manifest = await (await server.middleware().request('/manifest')).json();
      expect(manifest.functions.scaleArray.moonbitAbi).toEqual(abi);
    });

    it('should reject invalid MoonBit ABI metadata from JavaScript callers', () => {
      expect(() => server.defineMoonbit(
        'badAbi',
        join(fixtureDir, 'fibonacci.wasm'),
        { abi: { params: ['u32[]'] } as never },
      )).toThrow('Invalid MoonBit ABI');
    });

    it('rejects an unsafe name before reading a MoonBit module', () => {
      expect(() => server.defineMoonbit('../escape', 'missing.wasm'))
        .toThrow('Invalid function name');
    });

    it('rejects invalid MoonBit metadata before reading the module', () => {
      expect(() => server.defineMoonbit(
        'badExport',
        'missing.wasm',
        { exportName: 42 } as never,
      )).toThrow('Invalid MoonBit exportName');
      expect(() => server.defineMoonbit('emptyPath', '   '))
        .toThrow('MoonBit module path must be a non-empty string');
      expect(server.getFunction('badExport')).toBeUndefined();
      expect(server.getFunction('emptyPath')).toBeUndefined();
    });

    it('should reject a missing module file', () => {
      expect(() =>
        server.defineMoonbit('missing', join(fixtureDir, 'does-not-exist.wasm')),
      ).toThrow('Cannot read MoonBit module');
    });

    it('should reject invalid wasm bytes', () => {
      // A valid path but not a wasm module (the repo root package.json).
      expect(() =>
        server.defineMoonbit('bad', join(fixtureDir, '..', '..', '..', '..', 'package.json')),
      ).toThrow('WebAssembly validation');
    });

    it('should serve the wasm bytes from the code endpoint', async () => {
      server.defineMoonbit('fibonacci', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      });
      const app = server.middleware();

      const res = await app.request('/code/fibonacci?v=1');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/wasm');
      const bytes = await res.arrayBuffer();
      expect(bytes.byteLength).toBeGreaterThan(1000);
      expect(WebAssembly.validate(bytes)).toBe(true);
    });

    it('should advertise exportName in the manifest', async () => {
      server.defineMoonbit('fibonacci', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      });
      const app = server.middleware();

      const res = await app.request('/manifest');
      const manifest = await res.json();
      expect(manifest.functions.fibonacci.runtime).toBe('moonbit');
      expect(manifest.functions.fibonacci.exportName).toBe('fibonacci');
      expect(manifest.functions.fibonacci.codeUrl).toContain('/code/fibonacci');
    });

    it('should reject server-side fallback execution with 501', async () => {
      server.defineMoonbit('fibonacci', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      });
      const app = server.middleware();

      const res = await app.request('/exec/fibonacci', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args: [10] }),
      });
      expect(res.status).toBe(501);
    });

    it('must deliver the exact registered bytes even if the file changes afterwards', async () => {
      // Register from a temp copy, then overwrite the file on disk: the
      // immutable version must still serve the originally validated bytes.
      const dir = mkdtempSync(join(tmpdir(), 'unzen-mb-'));
      const wasmPath = join(dir, 'fib.wasm');
      const original = readFileSync(join(fixtureDir, 'fibonacci.wasm'));
      writeFileSync(wasmPath, original);

      server.defineMoonbit('fibImmutable', wasmPath, { exportName: 'fibonacci' });
      const app = server.middleware();
      const manifest = await (await app.request('/manifest')).json();
      const immutableSearch = new URL(manifest.functions.fibImmutable.codeUrl).search;
      const before = await (
        await app.request(`/code/fibImmutable${immutableSearch}`)
      ).arrayBuffer();

      // Overwrite with different bytes (a trivial different module header).
      writeFileSync(wasmPath, original.subarray(0, 100));
      const after = await (
        await app.request(`/code/fibImmutable${immutableSearch}`)
      ).arrayBuffer();

      expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
      expect(Buffer.from(before).equals(original)).toBe(true);
    });

    it('should hash the raw module bytes in the manifest', async () => {
      server.defineMoonbit('fibHash', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      });
      const app = server.middleware();

      const res = await app.request('/manifest');
      const manifest = await res.json();
      const rawBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));
      const expected = `sha256:${createHash('sha256').update(rawBytes).digest('hex')}`;
      expect(manifest.functions.fibHash.hash).toBe(expected);
    });

    it('serves per-version immutable bytes after a same-name re-registration', async () => {
      const fibBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));
      const sortBytes = readFileSync(join(fixtureDir, 'sort.wasm'));

      server.defineMoonbit('rebound', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      }); // version 1
      const app = server.middleware();
      const manifestV1 = await (await app.request('/manifest')).json();
      const v1Search = new URL(manifestV1.functions.rebound.codeUrl).search;
      const v1Response = await app.request(`/code/rebound${v1Search}`);
      const v1 = await v1Response.arrayBuffer();
      expect(v1Response.headers.get('Cache-Control')).toContain('immutable');

      server.defineMoonbit('rebound', join(fixtureDir, 'sort.wasm'), {
        exportName: 'sort_benchmark',
      }); // version 2
      const manifestV2 = await (await app.request('/manifest')).json();
      const v2Search = new URL(manifestV2.functions.rebound.codeUrl).search;
      const v2 = await (await app.request(`/code/rebound${v2Search}`)).arrayBuffer();
      // The already-published v1 URL must keep serving the original bytes.
      const v1After = await (await app.request(`/code/rebound${v1Search}`)).arrayBuffer();

      expect(Buffer.from(v1).equals(fibBytes)).toBe(true);
      expect(Buffer.from(v2).equals(sortBytes)).toBe(true);
      expect(Buffer.from(v1After).equals(fibBytes)).toBe(true);
      expect(Buffer.from(v1After).equals(sortBytes)).toBe(false);
    });

    it('keeps an old moonbit version immutable when the name is re-registered as quickjs', async () => {
      const fibBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));

      server.defineMoonbit('crossRuntime', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      }); // version 1 (moonbit)
      const app = server.middleware();
      const manifestV1 = await (await app.request('/manifest')).json();
      const v1Search = new URL(manifestV1.functions.crossRuntime.codeUrl).search;
      const v1Before = await (
        await app.request(`/code/crossRuntime${v1Search}`)
      ).arrayBuffer();
      expect((await app.request(`/code/crossRuntime${v1Search}`)).headers.get('Content-Type'))
        .toContain('application/wasm');

      server.defineRaw('crossRuntime', 'function run() { return "js"; }'); // version 2 (quickjs)
      const manifestV2 = await (await app.request('/manifest')).json();
      const v2Search = new URL(manifestV2.functions.crossRuntime.codeUrl).search;
      const v1After = await (
        await app.request(`/code/crossRuntime${v1Search}`)
      ).arrayBuffer();
      const v1AfterHeaders = (await app.request(`/code/crossRuntime${v1Search}`)).headers;
      const v2 = await (await app.request(`/code/crossRuntime${v2Search}`)).text();

      // v1 stays the original wasm bytes + content type; v2 is the JS source.
      expect(Buffer.from(v1After).equals(fibBytes)).toBe(true);
      expect(Buffer.from(v1Before).equals(fibBytes)).toBe(true);
      expect(v1AfterHeaders.get('Content-Type')).toContain('application/wasm');
      expect(v2).toContain('function run');
    });

    it('rejects unknown or malformed explicit versions without serving current code', async () => {
      server.defineRaw('verCheck', 'function run() { return 1; }'); // version 1
      server.defineMoonbit('mbVerCheck', join(fixtureDir, 'fibonacci.wasm'), {
        exportName: 'fibonacci',
      }); // version 1 (moonbit)
      const app = server.middleware();

      // Unknown version for a quickjs function: 404, not current code.
      const quickjsUnknown = await app.request('/code/verCheck?v=999');
      expect(quickjsUnknown.status).toBe(404);
      expect(quickjsUnknown.headers.get('Cache-Control')).toContain('no-store');

      // Unknown version for a moonbit function: 404, not the wasm path text.
      const moonbitUnknown = await app.request('/code/mbVerCheck?v=999');
      expect(moonbitUnknown.status).toBe(404);

      // Malformed versions: 400.
      expect((await app.request('/code/verCheck?v=abc')).status).toBe(400);
      expect((await app.request('/code/verCheck?v=1.5')).status).toBe(400);
      expect((await app.request('/code/verCheck?v=-1')).status).toBe(400);
      expect((await app.request('/code/verCheck?v=0')).status).toBe(400);
      expect((await app.request('/code/verCheck?v=9007199254740992')).status).toBe(400);
      expect((await app.request('/code/verCheck?v=999999999999999999999999')).status).toBe(400);

      // The largest safe integer is valid syntax, but remains an unknown version.
      expect((await app.request('/code/verCheck?v=9007199254740991')).status).toBe(404);

      // Missing ?v resolves to the current version with the right content type.
      const quickjsCurrent = await app.request('/code/verCheck');
      expect(quickjsCurrent.status).toBe(200);
      expect(quickjsCurrent.headers.get('Content-Type')).toContain('text/javascript');
      // Without ?v= the URL may move to a newer version later, so it must NOT
      // be cached as immutable.
      expect(quickjsCurrent.headers.get('Cache-Control')).not.toContain('immutable');
      const moonbitCurrent = await app.request('/code/mbVerCheck');
      expect(moonbitCurrent.status).toBe(200);
      expect(moonbitCurrent.headers.get('Content-Type')).toContain('application/wasm');
      expect(moonbitCurrent.headers.get('Cache-Control')).not.toContain('immutable');

      // The manifest's version + hash identity is immutable. A legacy
      // version-only URL remains readable but must revalidate across restarts.
      const manifest = await (await app.request('/manifest')).json();
      const immutableUrl = new URL(manifest.functions.verCheck.codeUrl);
      const quickjsV1 = await app.request(`/code/verCheck${immutableUrl.search}`);
      expect(quickjsV1.status).toBe(200);
      expect(quickjsV1.headers.get('Cache-Control')).toContain('immutable');
      const legacyV1 = await app.request('/code/verCheck?v=1');
      expect(legacyV1.headers.get('Cache-Control')).toBe('no-cache');
    });
  });
});
