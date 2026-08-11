/**
 * Tests for MoonBitSandboxExecutor
 *
 * Uses the real fibonacci.wasm fixture (compiled from moonbit-poc with
 * `moon build --target wasm-gc`) — Node 24 executes wasm-gc natively, so the
 * full fetch → compile → instantiate → call path is exercised in-process.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_FUNCTION_PAYLOAD_BYTES,
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { MoonBitSandboxExecutor } from '../src/moonbit-sandbox';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fibonacciBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));
const interopBytes = readFileSync(join(fixtureDir, 'interop.wasm'));
const customInteropBytes = readFileSync(join(fixtureDir, 'interop-custom-namespace.wasm'));

function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function mockFetchBytes(bytes: Uint8Array = fibonacciBytes) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('MoonBitSandboxExecutor', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])(
    'rejects an invalid module-cache limit (%s)',
    (maxCachedModules) => {
      expect(() => new MoonBitSandboxExecutor({ maxCachedModules })).toThrow(
        'maxCachedModules',
      );
    },
  );

  it('fetches, instantiates, and calls the configured export', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    // The fibonacci module exports `fibonacci(Int) -> Int`.
    const result = await executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      { exportName: 'fibonacci' },
    );

    expect(result).toBe(55);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/fibonacci.wasm',
      expect.objectContaining({ method: 'GET' }),
    );
    executor.dispose();
  });

  it('rejects an oversized module response before reading its body', async () => {
    const readBody = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({
        'Content-Length': String(MAX_FUNCTION_PAYLOAD_BYTES + 1),
      }),
      arrayBuffer: readBody,
    });
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.prepare('https://example.com/oversized.wasm'))
      .rejects.toThrow('exceeds');
    expect(readBody).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('snapshots execution options before asynchronous module preparation', async () => {
    let resolveFetch: ((response: {
      ok: boolean;
      status: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }) => void) | undefined;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    })) as unknown as typeof fetch;
    const reads = { signal: 0, exportName: 0, moonbitAbi: 0, expectedHash: 0 };
    let selectedExport = 'fibonacci';
    const options = {
      get signal() {
        reads.signal += 1;
        if (reads.signal > 1) throw new Error('signal read more than once');
        return undefined;
      },
      get exportName() {
        reads.exportName += 1;
        if (reads.exportName > 1) throw new Error('exportName read more than once');
        return selectedExport;
      },
      get moonbitAbi() {
        reads.moonbitAbi += 1;
        if (reads.moonbitAbi > 1) throw new Error('moonbitAbi read more than once');
        return undefined;
      },
      get expectedHash() {
        reads.expectedHash += 1;
        if (reads.expectedHash > 1) throw new Error('expectedHash read more than once');
        return undefined;
      },
    };
    const executor = new MoonBitSandboxExecutor();

    const execution = executor.execute(
      'https://example.com/fibonacci.wasm',
      [10],
      options,
    );
    selectedExport = 'missing';
    resolveFetch?.({
      ok: true,
      status: 200,
      arrayBuffer: async () => fibonacciBytes.buffer.slice(
        fibonacciBytes.byteOffset,
        fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
      ) as ArrayBuffer,
    });

    await expect(execution).resolves.toBe(55);
    expect(reads).toEqual({ signal: 1, exportName: 1, moonbitAbi: 1, expectedHash: 1 });
    executor.dispose();
  });

  it('rejects invalid execution inputs before fetching a module', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.execute('   ', [], {})).rejects.toThrow(
      'MoonBit module URL must be a non-empty string',
    );
    await expect(executor.execute(
      'https://example.com/fibonacci.wasm',
      [],
      { exportName: 42 } as never,
    )).rejects.toThrow('MoonBit exportName must be a string');
    await expect(executor.prepare(
      'https://example.com/fibonacci.wasm',
      { aborted: false } as never,
    )).rejects.toThrow(UnzenRuntimeError);
    await expect(executor.prepare('')).rejects.toThrow(UnzenRuntimeError);
    expect(fetchMock).not.toHaveBeenCalled();
    executor.dispose();
  });

  it('prepares a module once and reuses it across executions', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    const prepared = await executor.prepare('https://example.com/fibonacci.wasm');
    const again = await executor.prepare('https://example.com/fibonacci.wasm');

    expect(prepared).not.toBe(again);
    expect(prepared.module).toBe(again.module);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await executor.execute(prepared, [15], { exportName: 'fibonacci' })).toBe(610);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it('evicts settled compiled modules in least-recently-used order', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor({ maxCachedModules: 2 });
    const a = 'https://example.com/a.wasm';
    const b = 'https://example.com/b.wasm';
    const c = 'https://example.com/c.wasm';

    await executor.prepare(a);
    await executor.prepare(b);
    await executor.prepare(a); // Touch A, so B becomes least recently used.
    await executor.prepare(c); // Evicts B.
    await executor.prepare(a);
    await executor.prepare(b); // Fetches B again after eviction.

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([a, b, c, b]);
    executor.dispose();
  });

  it('disables settled compiled-module retention without disabling in-flight dedupe', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor({ maxCachedModules: 0 });
    const url = 'https://example.com/no-retention.wasm';

    const [first, shared] = await Promise.all([
      executor.prepare(url),
      executor.prepare(url),
    ]);
    const later = await executor.prepare(url);

    expect(first.module).toBe(shared.module);
    expect(later.module).not.toBe(first.module);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    executor.dispose();
  });

  it('does not expose the cache-owned prepared module wrapper', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();
    const url = 'https://example.com/fibonacci.wasm';

    const prepared = await executor.prepare(url);
    const verifiedModule = prepared.module;
    const callerOwned = prepared as {
      url: string;
      module: WebAssembly.Module;
    };
    callerOwned.url = 'https://attacker.example/replaced.wasm';
    callerOwned.module = {} as WebAssembly.Module;

    const cached = await executor.prepare(url);
    expect(cached).not.toBe(prepared);
    expect(cached).toEqual({ url, module: verifiedModule });
    await expect(executor.execute(url, [10], { exportName: 'fibonacci' })).resolves.toBe(55);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it('rejects a module hash mismatch without caching unverified bytes', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();
    const url = 'https://example.com/fibonacci.wasm';

    await expect(executor.prepare(url, undefined, hashBytes(new Uint8Array([1]))))
      .rejects.toThrow(UnzenNetworkError);
    await expect(executor.prepare(url, undefined, hashBytes(fibonacciBytes)))
      .resolves.toMatchObject({ url });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    executor.dispose();
  });

  it('throws UnzenFunctionError when the export is missing', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [1], { exportName: 'missing' }),
    ).rejects.toThrow(UnzenFunctionError);
    executor.dispose();
  });

  it('throws UnzenRuntimeError for invalid wasm bytes', async () => {
    mockFetchBytes(new Uint8Array([0, 1, 2, 3]));
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/bad.wasm', [], { exportName: 'run' }),
    ).rejects.toThrow(UnzenRuntimeError);
    executor.dispose();
  });

  it('wraps compile failures (js-string builtins validation) as UnzenRuntimeError', async () => {
    // A module that is valid without compile options but fails when the
    // js-string builtins are applied must surface as UnzenRuntimeError, the
    // same error contract as the worker path, not a raw CompileError.
    mockFetchBytes(fibonacciBytes);
    const originalCompile = WebAssembly.compile;
    (WebAssembly as unknown as { compile: unknown }).compile = async (
      _bytes: BufferSource,
      _options?: unknown,
    ) => {
      throw new TypeError('WebAssembly.Module(): invalid module with builtins');
    };
    const executor = new MoonBitSandboxExecutor();

    try {
      await expect(
        executor.execute('https://example.com/fibonacci.wasm', [10], { exportName: 'fibonacci' }),
      ).rejects.toThrow(UnzenRuntimeError);
      await expect(
        executor.execute('https://example.com/fibonacci.wasm', [10], { exportName: 'fibonacci' }),
      ).rejects.toThrow('Failed to compile MoonBit module');
    } finally {
      (WebAssembly as unknown as { compile: unknown }).compile = originalCompile;
    }
    executor.dispose();
  });

  it('reports a stable runtime error when compile options are silently ignored', async () => {
    mockFetchBytes(interopBytes);
    const originalCompile = WebAssembly.compile;
    (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = (
      bytes: BufferSource,
    ) => originalCompile(bytes);
    const executor = new MoonBitSandboxExecutor();

    try {
      const error = await executor.execute(
        'https://example.com/unsupported-string-builtins.wasm',
        ['hello'],
        { exportName: 'echo' },
      ).catch((reason) => reason);
      expect(error).toBeInstanceOf(UnzenRuntimeError);
      if (!(error instanceof Error)) throw new Error('Expected an Error');
      expect(error.message).toContain('MoonBit String interop is unsupported by this browser');
    } finally {
      (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = originalCompile;
      executor.dispose();
    }
  });

  it('executes a module built with a custom string-constant namespace', async () => {
    mockFetchBytes(customInteropBytes);
    const executor = new MoonBitSandboxExecutor({
      importedStringConstants: 'unzen:strings',
    });

    try {
      await expect(executor.execute(
        'https://example.com/interop-custom.wasm',
        [],
        { exportName: 'weird_string' },
      )).resolves.toBe('__proto__');
    } finally {
      executor.dispose();
    }
  });

  it('executes a module with imported string constants disabled', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor({ importedStringConstants: null });

    try {
      await expect(executor.execute(
        'https://example.com/fibonacci.wasm',
        [10],
        { exportName: 'fibonacci' },
      )).resolves.toBe(55);
    } finally {
      executor.dispose();
    }
  });

  it('throws UnzenNetworkError on a non-OK response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    }) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/missing.wasm', [], { exportName: 'run' }),
    ).rejects.toThrow(UnzenNetworkError);
    executor.dispose();
  });

  it('maps response body read failures to UnzenNetworkError', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new Error('body stream failed');
      },
    }) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.prepare('https://example.com/broken-body.wasm'))
      .rejects.toThrow(UnzenNetworkError);
    await expect(executor.prepare('https://example.com/broken-body.wasm'))
      .rejects.toThrow('Failed to read MoonBit module: body stream failed');
    executor.dispose();
  });

  it('rejects with UnzenCancelledError when aborted during fetch', async () => {
    // A slow fetch that never resolves: the caller's own signal races it.
    const signals: (AbortSignal | undefined)[] = [];
    globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return new Promise(() => {});
    }) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();
    const controller = new AbortController();

    const p = executor.prepare('https://example.com/fibonacci.wasm', controller.signal);
    controller.abort();

    await expect(p).rejects.toThrow(UnzenCancelledError);
    // The sole caller's cancel stops the underlying fetch.
    expect(signals[0]?.aborted).toBe(true);
    executor.dispose();
  });

  it('aborts the shared fetch when the last of two callers cancels', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return new Promise(() => {});
    }) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = executor.prepare('https://example.com/shared.wasm', c1.signal);
    const p2 = executor.prepare('https://example.com/shared.wasm', c2.signal);

    c1.abort();
    await expect(p1).rejects.toThrow(UnzenCancelledError);
    // One waiter remains: the shared fetch is still alive.
    expect(signals[0]?.aborted).toBe(false);

    c2.abort();
    await expect(p2).rejects.toThrow(UnzenCancelledError);
    // Last waiter left: the underlying fetch is aborted.
    expect(signals[0]?.aborted).toBe(true);
    executor.dispose();
  });

  it('aborts in-flight module fetches on dispose', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal);
      return new Promise((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        init?.signal?.addEventListener('abort', fail, { once: true });
      });
    }) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    const p = executor.prepare('https://example.com/slow.wasm');
    executor.dispose();

    await expect(p).rejects.toThrow(UnzenRuntimeError);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('does not let a stale in-flight request overwrite a newer retry cache slot', async () => {
    // First fetch is slow and ignores abort; the sole caller cancels, which
    // aborts the shared controller (the fetch mock ignores it) and drops the
    // in-flight entry. A retry must start a FRESH fetch rather than attaching
    // to the stale request, and the stale request's late success must not
    // overwrite the retry's cache slot.
    type FetchResult = { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> };
    let resolveFirst: (r: FetchResult) => void = () => {};
    const firstFetch = new Promise<FetchResult>((res) => {
      resolveFirst = res;
    });
    let fetchCalls = 0;
    const fetchMock = vi.fn((url: string, _init?: { signal?: AbortSignal }) => {
      if (url.includes('first')) {
        fetchCalls++;
        if (fetchCalls === 1) {
          // First fetch ignores abort and completes on our schedule.
          return firstFetch;
        }
        // Retry: a fresh, immediately-resolving fetch.
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            fibonacciBytes.buffer.slice(
              fibonacciBytes.byteOffset,
              fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
            ) as ArrayBuffer,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          fibonacciBytes.buffer.slice(
            fibonacciBytes.byteOffset,
            fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
          ) as ArrayBuffer,
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    const controller = new AbortController();
    const stale = executor.prepare('https://example.com/first.wasm', controller.signal);
    controller.abort();
    await expect(stale).rejects.toThrow(UnzenCancelledError);

    // A retry uses a fresh fetch (the stale in-flight entry was dropped).
    const retry = await executor.prepare('https://example.com/first.wasm');
    expect(retry.module).toBeDefined();
    expect(fetchCalls).toBe(2);

    // Resolve the stale fetch now: the stale request was aborted, so it must
    // not be promoted into the cache. The retry's module stays cached and is
    // returned for subsequent prepares without a new fetch.
    resolveFirst({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        fibonacciBytes.buffer.slice(
          fibonacciBytes.byteOffset,
          fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
        ) as ArrayBuffer,
    });
    await new Promise((r) => setTimeout(r, 20));

    const again = await executor.prepare('https://example.com/first.wasm');
    expect(again).not.toBe(retry);
    expect(again.module).toBe(retry.module);
    expect(again.url).toBe(retry.url);
    expect(fetchCalls).toBe(2);
    executor.dispose();
  });

  it('keeps a shared fetch alive for other callers when one caller cancels', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        fibonacciBytes.buffer.slice(
          fibonacciBytes.byteOffset,
          fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
        ) as ArrayBuffer,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    const canceller = new AbortController();
    const cancelled = executor.prepare('https://example.com/shared.wasm', canceller.signal);
    const survivor = executor.prepare('https://example.com/shared.wasm');

    canceller.abort();
    await expect(cancelled).rejects.toThrow(UnzenCancelledError);

    // The survivor still gets the shared module (one fetch total), and can
    // execute it.
    const prepared = await survivor;
    expect(await executor.execute(prepared, [10], { exportName: 'fibonacci' })).toBe(55);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    executor.dispose();
  });

  it('does not call the export when cancelled before execution begins', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();
    const prepared = await executor.prepare('https://example.com/fibonacci.wasm');
    const controller = new AbortController();
    controller.abort();

    await expect(
      executor.execute(prepared, [10], {
        exportName: 'fibonacci',
        signal: controller.signal,
      }),
    ).rejects.toThrow(UnzenCancelledError);
    executor.dispose();
  });

  it('settles with UnzenCancelledError immediately when cancelled during instantiate', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();
    const prepared = await executor.prepare('https://example.com/fibonacci.wasm');

    let resolveInstance!: (i: WebAssembly.Instance) => void;
    const deferred = new Promise<WebAssembly.Instance>((res) => {
      resolveInstance = res;
    });
    const originalInstantiate = WebAssembly.instantiate;
    const instantiateSpy = vi.fn(() => deferred);
    (WebAssembly as unknown as { instantiate: unknown }).instantiate = instantiateSpy;

    try {
      const exportSpy = vi.fn(() => 7);
      const controller = new AbortController();
      const p = executor.execute(prepared, [10], {
        exportName: 'fibonacci',
        signal: controller.signal,
      });

      // Abort while instantiate is still pending: the promise settles with
      // UnzenCancelledError immediately (not only after instantiate finishes).
      controller.abort();
      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(instantiateSpy).toHaveBeenCalledTimes(1);

      // A late instantiate completion must still never run the export.
      resolveInstance({ exports: { fibonacci: exportSpy } } as unknown as WebAssembly.Instance);
      await new Promise((r) => setTimeout(r, 20));
      expect(exportSpy).not.toHaveBeenCalled();
    } finally {
      (WebAssembly as unknown as { instantiate: unknown }).instantiate = originalInstantiate;
    }
    executor.dispose();
  });

  it('round-trips MoonBit String arguments/results via JS String Builtins', async () => {
    // The interop.wasm fixture is compiled with use-js-builtin-string and
    // imports `_` string-constant globals. The main-thread executor must
    // compile with builtins:['js-string'] and supply those constants for
    // String calls to work (same behavior as the worker path).
    mockFetchBytes(interopBytes);
    const executor = new MoonBitSandboxExecutor();

    expect(await executor.execute(
      'https://example.com/interop.wasm',
      ['hello'],
      { exportName: 'echo' },
    )).toBe('hello');

    expect(await executor.execute(
      'https://example.com/interop.wasm',
      ['foo', 'bar'],
      { exportName: 'join_words' },
    )).toBe('foobar');

    expect(await executor.execute(
      'https://example.com/interop.wasm',
      ['hello'],
      { exportName: 'string_len' },
    )).toBe(5);
    executor.dispose();
  });

  it('round-trips special String literals (__proto__, empty, Unicode)', async () => {
    // Compile-time importedStringConstants resolve `_` string-constant
    // imports without touching JS object prototypes, so even "__proto__"
    // round-trips losslessly (the manual import-map approach would have
    // triggered the Object.prototype setter).
    mockFetchBytes(interopBytes);
    const executor = new MoonBitSandboxExecutor();

    expect(await executor.execute(
      'https://example.com/interop.wasm',
      [],
      { exportName: 'weird_string' },
    )).toBe('__proto__');
    expect(await executor.execute(
      'https://example.com/interop.wasm',
      [],
      { exportName: 'empty_string' },
    )).toBe('');
    expect(await executor.execute(
      'https://example.com/interop.wasm',
      [],
      { exportName: 'unicode_string' },
    )).toBe('こんにちは');
    executor.dispose();
  });

  it('rejects non-scalar (opaque wasm-gc) return values', async () => {
    // make_array() returns an opaque wasm-gc array handle that cannot be
    // read as a plain JS array; the executor rejects it instead of leaking
    // the handle to the caller.
    mockFetchBytes(interopBytes);
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/interop.wasm', [], { exportName: 'make_array' }),
    ).rejects.toThrow('unsupported (non-scalar)');
    executor.dispose();
  });

  it('rejects plain JS array arguments when ABI metadata is omitted', async () => {
    mockFetchBytes(interopBytes);
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/interop.wasm', [[1, 2, 3]], { exportName: 'sum_array' }),
    ).rejects.toThrow('arrays and objects cannot cross');
    executor.dispose();
  });

  it('copies i32[] arguments/results through the standard bridge', async () => {
    mockFetchBytes(interopBytes);
    const executor = new MoonBitSandboxExecutor();
    const url = 'https://example.com/interop-array.wasm';

    expect(await executor.execute(url, [[7, -2, 5]], {
      exportName: 'sum_array',
      moonbitAbi: { params: ['i32[]'] },
    })).toBe(10);
    expect(await executor.execute(url, [[7, -2, 5]], {
      exportName: 'reverse_array',
      moonbitAbi: { params: ['i32[]'], result: 'i32[]' },
    })).toEqual([5, -2, 7]);
    expect(await executor.execute(url, [], {
      exportName: 'make_array',
      moonbitAbi: { params: [], result: 'i32[]' },
    })).toEqual([1, 2, 3]);
    executor.dispose();
  });

  it('copies f64[] with mixed scalar arguments/results', async () => {
    mockFetchBytes(interopBytes);
    const executor = new MoonBitSandboxExecutor();

    expect(await executor.execute(
      'https://example.com/interop-f64.wasm',
      [[1.5, -2.25, 4], 2],
      {
        exportName: 'scale_double_array',
        moonbitAbi: { params: ['f64[]', 'scalar'], result: 'f64[]' },
      },
    )).toEqual([3, -4.5, 8]);
    executor.dispose();
  });

  it('fails closed when ABI metadata requires bridge exports the module lacks', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    await expect(executor.execute(
      'https://example.com/fibonacci-no-bridge.wasm',
      [[10]],
      { exportName: 'fibonacci', moonbitAbi: { params: ['i32[]'] } },
    )).rejects.toThrow('unzen_array_i32_new');
    executor.dispose();
  });

  it('rejects non-scalar arguments (arrays, objects, null, undefined)', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [[1, 2]], { exportName: 'fibonacci' }),
    ).rejects.toThrow('arrays and objects cannot cross');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [{ n: 10 }], { exportName: 'fibonacci' }),
    ).rejects.toThrow('arrays and objects cannot cross');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [null], { exportName: 'fibonacci' }),
    ).rejects.toThrow('(got null)');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [undefined], { exportName: 'fibonacci' }),
    ).rejects.toThrow('(got undefined)');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [() => 1], { exportName: 'fibonacci' }),
    ).rejects.toThrow('(got function)');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [Symbol('x')], { exportName: 'fibonacci' }),
    ).rejects.toThrow('(got symbol)');
    executor.dispose();
  });

  it('accepts a numeric string for numeric exports via wasm ToNumber (documented)', async () => {
    // The executor validates scalars only; WebAssembly applies its own
    // implicit ToNumber conversion for numeric parameters. This is documented
    // behavior, not a bug: fibonacci("10") === 55.
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', ['10'], { exportName: 'fibonacci' }),
    ).resolves.toBe(55);
    executor.dispose();
  });

  it('does not publish a result or recreate the cache when disposed mid-compile', async () => {
    // fetch resolves immediately, but dispose lands BEFORE the body
    // (arrayBuffer) is consumed; the shared abort must stop publication and
    // the cache must stay empty.
    let resolveFetch: (r: { ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }) => void = () => {};
    const deferredFetch = new Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>((res) => {
      resolveFetch = res;
    });
    globalThis.fetch = vi.fn(() => deferredFetch) as unknown as typeof fetch;
    const executor = new MoonBitSandboxExecutor();

    const p = executor.prepare('https://example.com/slow-fetch.wasm');
    executor.dispose();
    // The fetch completes after dispose: fetchAndCompile re-checks the shared
    // signal after the body and rejects instead of publishing.
    resolveFetch({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        fibonacciBytes.buffer.slice(
          fibonacciBytes.byteOffset,
          fibonacciBytes.byteOffset + fibonacciBytes.byteLength,
        ) as ArrayBuffer,
    });

    await expect(p).rejects.toThrow();
    expect((executor as unknown as { moduleCache: Map<string, unknown> }).moduleCache.size)
      .toBe(0);
  });

  it('rejects execution after dispose', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();
    executor.dispose();

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [], { exportName: 'fibonacci' }),
    ).rejects.toThrow(UnzenRuntimeError);
  });
});
