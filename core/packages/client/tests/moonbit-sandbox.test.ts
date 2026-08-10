/**
 * Tests for MoonBitSandboxExecutor
 *
 * Uses the real fibonacci.wasm fixture (compiled from moonbit-poc with
 * `moon build --target wasm-gc`) — Node 24 executes wasm-gc natively, so the
 * full fetch → compile → instantiate → call path is exercised in-process.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { MoonBitSandboxExecutor } from '../src/moonbit-sandbox';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fibonacciBytes = readFileSync(join(fixtureDir, 'fibonacci.wasm'));

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

  it('prepares a module once and reuses it across executions', async () => {
    const fetchMock = mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    const prepared = await executor.prepare('https://example.com/fibonacci.wasm');
    const again = await executor.prepare('https://example.com/fibonacci.wasm');

    expect(prepared).toBe(again);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await executor.execute(prepared, [15], { exportName: 'fibonacci' })).toBe(610);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    expect(again).toBe(retry);
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

  it('does not call the export when cancelled during instantiate', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();
    const prepared = await executor.prepare('https://example.com/fibonacci.wasm');

    let resolveInstance: (i: WebAssembly.Instance) => void = () => {};
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

      // Abort while instantiate is still pending, then resolve it: the export
      // must never run.
      controller.abort();
      resolveInstance({ exports: { fibonacci: exportSpy } } as unknown as WebAssembly.Instance);

      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(instantiateSpy).toHaveBeenCalledTimes(1);
      expect(exportSpy).not.toHaveBeenCalled();
    } finally {
      (WebAssembly as unknown as { instantiate: unknown }).instantiate = originalInstantiate;
    }
    executor.dispose();
  });

  it('rejects non-scalar arguments', async () => {
    mockFetchBytes();
    const executor = new MoonBitSandboxExecutor();

    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [[1, 2]], { exportName: 'fibonacci' }),
    ).rejects.toThrow('number/boolean/bigint');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', ['10'], { exportName: 'fibonacci' }),
    ).rejects.toThrow('number/boolean/bigint');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [null], { exportName: 'fibonacci' }),
    ).rejects.toThrow('number/boolean/bigint');
    await expect(
      executor.execute('https://example.com/fibonacci.wasm', [undefined], { exportName: 'fibonacci' }),
    ).rejects.toThrow('number/boolean/bigint');
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
