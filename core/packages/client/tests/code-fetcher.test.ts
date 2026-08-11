/**
 * Tests for CodeFetcher
 *
 * CodeFetcher retrieves function source code from URLs and implements
 * hash-based caching to avoid redundant downloads.
 *
 * Test strategy:
 * - Mock global fetch
 * - Test initial code fetch
 * - Test cache behavior (same hash should not refetch)
 * - Test different hash triggers new fetch
 * - Test network error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  UnzenCancelledError,
  UnzenNetworkError,
  type FunctionManifestEntry,
} from '@unzen/shared';
import { CodeFetcher } from '../src/code-fetcher';

describe('CodeFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  const mockCode = 'function add(a, b) { return a + b; }';
  const hashText = (value: string): string =>
    `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
  const codeResponse = (value: string): Response => new Response(value, {
    status: 200,
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  });

  const mockEntry: FunctionManifestEntry = {
    version: 1,
    runtime: 'quickjs',
    codeUrl: 'https://example.com/code/add.js',
    hash: hashText(mockCode),
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should construct with endpoint', () => {
    const fetcher = new CodeFetcher('https://example.com');
    expect(fetcher).toBeInstanceOf(CodeFetcher);
  });

  it('should fetch code from URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(codeResponse(mockCode));

    const fetcher = new CodeFetcher('https://example.com');
    const code = await fetcher.fetch(mockEntry);

    expect(code).toBe(mockCode);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/code/add.js',
      expect.any(Object)
    );
  });

  it('rejects an oversized code response before reading its body', async () => {
    const readBody = vi.fn().mockResolvedValue(new TextEncoder().encode(mockCode).buffer);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Length': String(16 * 1024 * 1024 + 1) }),
      arrayBuffer: readBody,
    });
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(mockEntry)).rejects.toThrow('exceeds');
    expect(readBody).not.toHaveBeenCalled();
  });

  it('snapshots a manifest entry before asynchronous response handling', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const reads = { hash: 0, codeUrl: 0 };
    let selectedHash = hashText(mockCode);
    let selectedUrl = 'https://example.com/code/add.js';
    const entry = {
      runtime: 'quickjs' as const,
      version: 1,
      get hash() {
        reads.hash += 1;
        return selectedHash;
      },
      get codeUrl() {
        reads.codeUrl += 1;
        return selectedUrl;
      },
    };
    const fetcher = new CodeFetcher('https://example.com');

    const request = fetcher.fetch(entry);
    selectedHash = hashText('replaced code');
    selectedUrl = 'https://attacker.example/replaced.js';
    resolveFetch?.(codeResponse(mockCode));

    await expect(request).resolves.toBe(mockCode);
    expect(reads).toEqual({ hash: 1, codeUrl: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/code/add.js',
      expect.any(Object),
    );
  });

  it('rejects invalid entries and signals before fetching code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(codeResponse(mockCode));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(null as never)).rejects.toThrow(UnzenNetworkError);
    await expect(fetcher.fetch({
      ...mockEntry,
      codeUrl: 'javascript:alert(1)',
    })).rejects.toThrow(UnzenNetworkError);
    await expect(fetcher.fetch({
      ...mockEntry,
      runtime: 'moonbit',
    })).rejects.toThrow(UnzenNetworkError);
    await expect(fetcher.fetch(
      mockEntry,
      { aborted: false } as never,
    )).rejects.toThrow(UnzenNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a pre-aborted signal before fetching code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(codeResponse(mockCode));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new CodeFetcher('https://example.com');
    const controller = new AbortController();
    controller.abort();

    await expect(fetcher.fetch(mockEntry, controller.signal))
      .rejects.toThrow(UnzenCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should cache code by hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue(codeResponse(mockCode));
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    // First fetch - should call server
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second fetch with same hash - should use cache
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('honors cancellation triggered while snapshotting a cached entry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(codeResponse(mockCode));
    globalThis.fetch = fetchMock;
    const fetcher = new CodeFetcher('https://example.com');
    await fetcher.fetch(mockEntry);

    const controller = new AbortController();
    const abortingEntry: FunctionManifestEntry = {
      runtime: 'quickjs',
      version: mockEntry.version,
      codeUrl: mockEntry.codeUrl,
      get hash() {
        controller.abort();
        return mockEntry.hash;
      },
    };

    await expect(fetcher.fetch(abortingEntry, controller.signal))
      .rejects.toThrow(UnzenCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('evicts least-recent code by aggregate UTF-8 weight', async () => {
    const bodies = new Map([
      ['https://example.com/a.js', 'a'],
      ['https://example.com/b.js', 'b'],
      ['https://example.com/c.js', 'c'],
    ]);
    const fetchMock = vi.fn((url: string) => Promise.resolve(codeResponse(bodies.get(url)!)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const entry = (name: string): FunctionManifestEntry => {
      const code = bodies.get(`https://example.com/${name}.js`)!;
      return {
        runtime: 'quickjs',
        version: 1,
        codeUrl: `https://example.com/${name}.js`,
        hash: hashText(code),
      };
    };
    const fetcher = new CodeFetcher('https://example.com', { maxCacheBytes: 2 });

    await fetcher.fetch(entry('a'));
    await fetcher.fetch(entry('b'));
    await fetcher.fetch(entry('a')); // touch a; b is now least-recent
    await fetcher.fetch(entry('c')); // evicts b
    await fetcher.fetch(entry('a')); // still cached
    await fetcher.fetch(entry('b')); // evicted, so fetch again

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://example.com/a.js',
      'https://example.com/b.js',
      'https://example.com/c.js',
      'https://example.com/b.js',
    ]);
  });

  it('supports disabling the settled cache and validates its byte limit', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(codeResponse(mockCode)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new CodeFetcher('https://example.com', { maxCacheBytes: 0 });

    await fetcher.fetch(mockEntry);
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(() => new CodeFetcher('https://example.com', null as never)).toThrow(TypeError);
    expect(() => new CodeFetcher('https://example.com', { maxCacheBytes: -1 })).toThrow(
      'non-negative safe integer',
    );
  });

  it('deduplicates concurrent downloads with the same hash', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new CodeFetcher('https://example.com');

    const first = fetcher.fetch(mockEntry);
    const second = fetcher.fetch({
      ...mockEntry,
      codeUrl: 'https://cdn.example.com/same-code.js',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(codeResponse(mockCode));
    await expect(Promise.all([first, second])).resolves.toEqual([mockCode, mockCode]);
  });

  it('keeps a shared download alive when one waiter cancels', async () => {
    let resolveFetch!: (response: Response) => void;
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      sharedSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new CodeFetcher('https://example.com');
    const controller = new AbortController();

    const cancelled = fetcher.fetch(mockEntry, controller.signal);
    const retained = fetcher.fetch(mockEntry);
    controller.abort();

    await expect(cancelled).rejects.toThrow(UnzenCancelledError);
    expect(sharedSignal?.aborted).toBe(false);
    resolveFetch(codeResponse(mockCode));
    await expect(retained).resolves.toBe(mockCode);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts an unneeded download and does not cache its late body', async () => {
    let resolveFirst!: (response: Response) => void;
    let sharedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        sharedSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockResolvedValueOnce(codeResponse(mockCode));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new CodeFetcher('https://example.com');
    const controller = new AbortController();

    const cancelled = fetcher.fetch(mockEntry, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(UnzenCancelledError);
    expect(sharedSignal?.aborted).toBe(true);

    resolveFirst(codeResponse(mockCode));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(fetcher.fetch(mockEntry)).resolves.toBe(mockCode);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should fetch again if hash changes', async () => {
    const updatedCode = `${mockCode}\n`;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(codeResponse(mockCode))
      .mockResolvedValueOnce(codeResponse(updatedCode));
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    // First fetch
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second fetch with different hash - should fetch again
    const updatedEntry: FunctionManifestEntry = {
      ...mockEntry,
      hash: hashText(updatedCode),
    };
    await fetcher.fetch(updatedEntry);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should handle different functions with different hashes', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      const code =
        url.includes('add.js')
          ? 'function add(a, b) { return a + b; }'
          : 'function multiply(a, b) { return a * b; }';
      return Promise.resolve(codeResponse(code));
    });
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    const addEntry: FunctionManifestEntry = {
      version: 1,
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/add.js',
      hash: hashText('function add(a, b) { return a + b; }'),
    };

    const multiplyEntry: FunctionManifestEntry = {
      version: 1,
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/multiply.js',
      hash: hashText('function multiply(a, b) { return a * b; }'),
    };

    const addCode = await fetcher.fetch(addEntry);
    const multiplyCode = await fetcher.fetch(multiplyEntry);

    expect(addCode).toContain('add');
    expect(multiplyCode).toContain('multiply');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should throw UnzenNetworkError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(mockEntry)).rejects.toThrow(UnzenNetworkError);
  });

  it('should throw UnzenNetworkError on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(mockEntry)).rejects.toThrow(UnzenNetworkError);
  });

  it('should cache even if same hash is used for different function names', async () => {
    // Edge case: Two different functions with same code (same hash)
    const fetchMock = vi.fn().mockResolvedValue(codeResponse(mockCode));
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    const entry1: FunctionManifestEntry = {
      version: 1,
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/func1.js',
      hash: hashText(mockCode),
    };

    const entry2: FunctionManifestEntry = {
      version: 1,
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/func2.js',
      hash: hashText(mockCode),
    };

    await fetcher.fetch(entry1);
    await fetcher.fetch(entry2);

    // Should only fetch once since hash is the same
    // This is correct behavior: hash represents content, not identity
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should reject a hash mismatch without caching the response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(codeResponse('function run() { return "tampered"; }'))
      .mockResolvedValueOnce(codeResponse(mockCode));
    globalThis.fetch = fetchMock;
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch(mockEntry)).rejects.toThrow(UnzenNetworkError);
    await expect(fetcher.fetch(mockEntry)).resolves.toBe(mockCode);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should reject a malformed manifest hash before fetching code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(codeResponse(mockCode));
    globalThis.fetch = fetchMock;
    const fetcher = new CodeFetcher('https://example.com');

    await expect(fetcher.fetch({ ...mockEntry, hash: 'sha256:not-a-digest' }))
      .rejects.toThrow(UnzenNetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
