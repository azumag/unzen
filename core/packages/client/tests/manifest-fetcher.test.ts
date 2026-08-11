/**
 * Tests for ManifestFetcher
 *
 * ManifestFetcher retrieves the function manifest from the server
 * and provides in-memory caching.
 *
 * Test strategy:
 * - Mock global fetch
 * - Test initial fetch from server
 * - Test cache behavior (second fetch should not call server)
 * - Test getEntry lookup
 * - Test cache invalidation
 * - Test network error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnzenCancelledError, UnzenNetworkError, type ManifestResponse } from '@unzen/shared';
import { ManifestFetcher } from '../src/manifest-fetcher';

const ADD_HASH = `sha256:${'a'.repeat(64)}`;
const MULTIPLY_HASH = `sha256:${'b'.repeat(64)}`;
const UPDATED_HASH = `sha256:${'c'.repeat(64)}`;

describe('ManifestFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  const mockManifest: ManifestResponse = {
    functions: {
      add: {
        version: 1,
        runtime: 'quickjs',
        codeUrl: 'https://example.com/code/add.js',
        hash: ADD_HASH,
      },
      multiply: {
        version: 1,
        runtime: 'quickjs',
        codeUrl: 'https://example.com/code/multiply.js',
        hash: MULTIPLY_HASH,
      },
    },
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('should construct with endpoint', () => {
    const fetcher = new ManifestFetcher('https://example.com');
    expect(fetcher).toBeInstanceOf(ManifestFetcher);
  });

  it('should fetch manifest from server', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });

    const fetcher = new ManifestFetcher('https://example.com');
    const manifest = await fetcher.fetch();

    expect(manifest).toEqual(mockManifest);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/manifest',
      expect.any(Object)
    );
  });

  it('should cache manifest after first fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetcher = new ManifestFetcher('https://example.com');

    // First fetch - should call server
    await fetcher.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second fetch - should use cache
    await fetcher.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('should get entry by function name', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });

    const fetcher = new ManifestFetcher('https://example.com');
    await fetcher.fetch();

    const entry = fetcher.getEntry('add');
    expect(entry).toEqual({
      version: 1,
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/add.js',
      hash: ADD_HASH,
    });
  });

  it('should return undefined for non-existent function', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });

    const fetcher = new ManifestFetcher('https://example.com');
    await fetcher.fetch();

    const entry = fetcher.getEntry('nonexistent');
    expect(entry).toBeUndefined();
  });

  it('should return undefined before fetch', () => {
    const fetcher = new ManifestFetcher('https://example.com');
    const entry = fetcher.getEntry('add');
    expect(entry).toBeUndefined();
  });

  it('should invalidate cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetcher = new ManifestFetcher('https://example.com');

    // First fetch
    await fetcher.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Invalidate cache
    fetcher.invalidate();

    // Next fetch should call server again
    await fetcher.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should throw UnzenNetworkError on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(UnzenNetworkError);
  });

  it('should throw UnzenNetworkError on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(UnzenNetworkError);
  });

  it('rejects an invalid manifest without caching its body or ETag', async () => {
    const invalidManifest = {
      functions: {
        add: { ...mockManifest.functions.add, runtime: 'v8' },
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ ETag: 'W/"invalid"' }),
        json: async () => invalidManifest,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => mockManifest,
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const fetcher = new ManifestFetcher('https://example.com');

    await expect(fetcher.fetch()).rejects.toThrow(UnzenNetworkError);
    expect(fetcher.isCached()).toBe(false);
    expect(fetcher.getEntry('add')).toBeUndefined();

    await expect(fetcher.fetch()).resolves.toEqual(mockManifest);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      headers: expect.not.objectContaining({ 'If-None-Match': expect.anything() }),
    }));
  });

  it('should deduplicate concurrent fetch calls', async () => {
    // When multiple callers invoke fetch() concurrently before the first
    // resolves, only one HTTP request should be made (race condition fix)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetcher = new ManifestFetcher('https://example.com');

    // Fire 3 concurrent fetches
    const [result1, result2, result3] = await Promise.all([
      fetcher.fetch(),
      fetcher.fetch(),
      fetcher.fetch(),
    ]);

    // Only 1 HTTP request should have been made
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // All callers should get the same result
    expect(result1).toEqual(mockManifest);
    expect(result2).toEqual(mockManifest);
    expect(result3).toEqual(mockManifest);
  });

  describe('cancellation (issue #105 signal propagation)', () => {
    /**
     * Mock fetch that honors the AbortSignal in RequestInit: rejects with an
     * AbortError-style rejection when aborted, resolves with the manifest
     * otherwise. Returns the signal so tests can assert propagation.
     */
    function createAbortableFetchMock() {
      const signals: (AbortSignal | undefined)[] = [];
      const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        signals.push(init?.signal);
        const signal = init?.signal;
        return new Promise((resolve, reject) => {
          const fail = () => {
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener('abort', fail, { once: true });
          setTimeout(() => {
            if (!signal?.aborted) {
              resolve({ ok: true, json: async () => mockManifest });
            }
          }, 50);
        });
      });
      return { fetchMock, signals };
    }

    it('should pass an AbortSignal to the underlying fetch request', async () => {
      const { fetchMock, signals } = createAbortableFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();

      expect(signals).toHaveLength(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
    });

    it('should reject a single cancelled caller with UnzenCancelledError and abort the request', async () => {
      const { fetchMock, signals } = createAbortableFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const fetcher = new ManifestFetcher('https://example.com');
      const controller = new AbortController();
      const p = fetcher.fetch(controller.signal);

      // Give the request a chance to start, then cancel it.
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();

      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(signals[0]?.aborted).toBe(true);

      // A later caller must start a fresh request (new signal, not pre-aborted).
      const freshP = fetcher.fetch();
      expect(signals[1]).not.toBe(signals[0]);
      expect(signals[1]?.aborted).toBe(false);
      const fresh = await freshP;
      expect(fresh).toEqual(mockManifest);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should keep the shared request alive when one of two callers cancels', async () => {
      const { fetchMock } = createAbortableFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const fetcher = new ManifestFetcher('https://example.com');
      const cancelledController = new AbortController();
      const cancelled = fetcher.fetch(cancelledController.signal);
      const survivor = fetcher.fetch();

      await new Promise((r) => setTimeout(r, 5));
      cancelledController.abort();

      await expect(cancelled).rejects.toThrow(UnzenCancelledError);
      // The other waiter must still receive the shared result — no second
      // HTTP request was started for it.
      await expect(survivor).resolves.toEqual(mockManifest);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should abort the shared request when all callers cancel, then allow a fresh start', async () => {
      const { fetchMock, signals } = createAbortableFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const fetcher = new ManifestFetcher('https://example.com');
      const c1 = new AbortController();
      const c2 = new AbortController();
      const p1 = fetcher.fetch(c1.signal);
      const p2 = fetcher.fetch(c2.signal);

      await new Promise((r) => setTimeout(r, 5));
      c1.abort();
      c2.abort();

      await expect(p1).rejects.toThrow(UnzenCancelledError);
      await expect(p2).rejects.toThrow(UnzenCancelledError);
      expect(signals[0]?.aborted).toBe(true);

      const freshP = fetcher.fetch();
      expect(signals[1]).not.toBe(signals[0]);
      expect(signals[1]?.aborted).toBe(false);
      const fresh = await freshP;
      expect(fresh).toEqual(mockManifest);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('must not commit a JSON body that resolves after the last waiter aborts', async () => {
      let resolveBody!: (manifest: ManifestResponse) => void;
      let bodyStartedResolve!: () => void;
      const bodyStarted = new Promise<void>((resolve) => {
        bodyStartedResolve = resolve;
      });
      const body = new Promise<ManifestResponse>((resolve) => {
        resolveBody = resolve;
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ ETag: 'W/"late"' }),
        json: () => {
          bodyStartedResolve();
          return body;
        },
      });

      const fetcher = new ManifestFetcher('https://example.com');
      const controller = new AbortController();
      const request = fetcher.fetch(controller.signal);
      await bodyStarted;
      controller.abort();
      await expect(request).rejects.toThrow(UnzenCancelledError);

      resolveBody(mockManifest);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetcher.isCached()).toBe(false);
      expect((fetcher as unknown as { etag: string | null }).etag).toBeNull();
    });
  });

  it('should handle empty manifest', async () => {
    const emptyManifest: ManifestResponse = {
      functions: {},
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => emptyManifest,
    });

    const fetcher = new ManifestFetcher('https://example.com');
    const manifest = await fetcher.fetch();

    expect(manifest).toEqual(emptyManifest);
    expect(fetcher.getEntry('anything')).toBeUndefined();
    expect(fetcher.getEntry('toString')).toBeUndefined();
  });

  it('aborts an in-flight request when invalidated', async () => {
    let requestSignal: AbortSignal | undefined;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      startedResolve();
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const fetcher = new ManifestFetcher('https://example.com');
    const request = fetcher.fetch();
    await started;
    fetcher.invalidate();

    expect(requestSignal?.aborted).toBe(true);
    await expect(request).rejects.toThrow(UnzenCancelledError);
    expect(fetcher.isCached()).toBe(false);
  });

  // === ETag caching tests (Phase 3) ===
  // ETag caching allows the client to send conditional requests
  // (If-None-Match) and receive 304 Not Modified when the manifest
  // hasn't changed, saving bandwidth and parse time.

  describe('ETag caching', () => {
    it('should store ETag from server response and send If-None-Match on next fetch', async () => {
      // First fetch: server returns manifest with ETag header
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"abc123"' }),
        json: async () => mockManifest,
      });

      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();

      // Invalidate in-memory cache to force a new server request
      // (ETag and lastManifest should be preserved across invalidation)
      fetcher.invalidate();

      // Second fetch: verify If-None-Match is sent with stored ETag
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"abc123"' }),
        json: async () => mockManifest,
      });

      await fetcher.fetch();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://example.com/manifest',
        expect.objectContaining({
          headers: expect.objectContaining({
            'If-None-Match': 'W/"abc123"',
          }),
        })
      );
    });

    it('should return cached manifest on 304 response', async () => {
      // First fetch: get manifest and ETag from server
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"abc123"' }),
        json: async () => mockManifest,
      });

      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();

      // Invalidate in-memory cache (simulates stale cache scenario)
      fetcher.invalidate();

      // Second fetch: server responds 304 Not Modified
      // Client should reuse the last known manifest from lastManifest
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 304,
        statusText: 'Not Modified',
        headers: new Headers({ 'ETag': 'W/"abc123"' }),
      });

      const manifest = await fetcher.fetch();
      expect(manifest).toEqual(mockManifest);
    });

    it('should update cached manifest and ETag on 200 after invalidation', async () => {
      // First fetch: initial manifest
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"etag1"' }),
        json: async () => mockManifest,
      });

      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();
      fetcher.invalidate();

      // Second fetch: server returns updated manifest with new ETag
      const updatedManifest: ManifestResponse = {
        functions: {
          ...mockManifest.functions,
          newFunc: {
            runtime: 'quickjs',
            hash: UPDATED_HASH,
            version: 3,
            codeUrl: 'https://example.com/code/newFunc',
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"etag2"' }),
        json: async () => updatedManifest,
      });

      const manifest = await fetcher.fetch();
      expect(manifest).toEqual(updatedManifest);
    });

    it('must not pair a new ETag with a stale manifest when the body parse is aborted', async () => {
      // First response establishes E1 + M1 (old version).
      const oldManifest: ManifestResponse = {
        functions: {
          add: {
            version: 1,
            runtime: 'quickjs',
            codeUrl: 'u1',
            hash: ADD_HASH,
          },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"e1"' }),
        json: async () => oldManifest,
      });
      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();
      fetcher.invalidate();

      // Second response returns E2 but its body parse is aborted by the caller.
      const newManifest: ManifestResponse = {
        functions: {
          add: {
            version: 1,
            runtime: 'quickjs',
            codeUrl: 'u2',
            hash: UPDATED_HASH,
          },
        },
      };
      globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        const signal = init?.signal;
        return new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          signal?.addEventListener('abort', fail, { once: true });
          setTimeout(() => {
            if (!signal?.aborted) {
              resolve({
                ok: true,
                status: 200,
                headers: new Headers({ 'ETag': 'W/"e2"' }),
                json: async () => newManifest,
              });
            }
          }, 60);
        });
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      const p = fetcher.fetch(controller.signal);
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      await expect(p).rejects.toThrow(UnzenCancelledError);

      // The ETag must still be E1 (the last successfully committed body), so a
      // later 304 never serves the old M1 manifest against E2.
      expect((fetcher as unknown as { etag: string | null }).etag).toBe('W/"e1"');

      // Third request sends If-None-Match: W/"e1" and a 304 must reuse M1.
      let ifNoneMatch: string | null = null;
      globalThis.fetch = vi.fn((_url: string, init?: { headers?: Record<string, string> }) => {
        ifNoneMatch = init?.headers?.['If-None-Match'] ?? null;
        return Promise.resolve({ ok: true, status: 304 });
      }) as unknown as typeof fetch;
      const result = await fetcher.fetch();
      expect(ifNoneMatch).toBe('W/"e1"');
      expect(result.functions.add.hash).toBe(ADD_HASH);
    });

    it('must discard the old ETag when a 200 arrives without an ETag header', async () => {
      const oldManifest: ManifestResponse = {
        functions: {
          add: { version: 1, runtime: 'quickjs', codeUrl: 'u1', hash: ADD_HASH },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"e1"' }),
        json: async () => oldManifest,
      });
      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();
      fetcher.invalidate();

      // Second 200 has a new body but NO ETag header.
      const newManifest: ManifestResponse = {
        functions: {
          add: { version: 1, runtime: 'quickjs', codeUrl: 'u2', hash: UPDATED_HASH },
        },
      };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({}),
        json: async () => newManifest,
      });
      const manifest = await fetcher.fetch();
      expect(manifest.functions.add.hash).toBe(UPDATED_HASH);
      expect((fetcher as unknown as { etag: string | null }).etag).toBeNull();

      // After invalidation, the next request must NOT send the stale E1.
      fetcher.invalidate();
      let ifNoneMatch: string | null = 'unset';
      globalThis.fetch = vi.fn((_url: string, init?: { headers?: Record<string, string> }) => {
        ifNoneMatch = init?.headers?.['If-None-Match'] ?? null;
        return Promise.resolve({ ok: true, status: 200, headers: new Headers({}), json: async () => newManifest });
      }) as unknown as typeof fetch;
      await fetcher.fetch();
      expect(ifNoneMatch).toBeNull();
    });

    it('must not commit an ETag when the json() parse is interrupted by abort', async () => {
      // First response establishes E1 + M1.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'ETag': 'W/"e1"' }),
        json: async () => mockManifest,
      });
      const fetcher = new ManifestFetcher('https://example.com');
      await fetcher.fetch();
      fetcher.invalidate();

      // Second response: headers arrive (200 + E2) but json() hangs and is
      // interrupted by the caller's abort.
      globalThis.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        const signal = init?.signal;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ 'ETag': 'W/"e2"' }),
          json: () => new Promise((_resolve, reject) => {
            const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            signal?.addEventListener('abort', fail, { once: true });
          }),
        });
      }) as unknown as typeof fetch;

      const controller = new AbortController();
      const p = fetcher.fetch(controller.signal);
      controller.abort();
      await expect(p).rejects.toThrow(UnzenCancelledError);

      // E1 stays committed; E2 must not have been stored.
      expect((fetcher as unknown as { etag: string | null }).etag).toBe('W/"e1"');
    });
  });
});
