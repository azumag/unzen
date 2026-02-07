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
import { UnzenNetworkError, type ManifestResponse } from '@unzen/shared';
import { ManifestFetcher } from '../src/manifest-fetcher';

describe('ManifestFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  const mockManifest: ManifestResponse = {
    functions: {
      add: {
        name: 'add',
        runtime: 'quickjs',
        codeUrl: 'https://example.com/code/add.js',
        hash: 'abc123',
      },
      multiply: {
        name: 'multiply',
        runtime: 'quickjs',
        codeUrl: 'https://example.com/code/multiply.js',
        hash: 'def456',
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
    globalThis.fetch = fetchMock;

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
      name: 'add',
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/add.js',
      hash: 'abc123',
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
    globalThis.fetch = fetchMock;

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

  it('should deduplicate concurrent fetch calls', async () => {
    // When multiple callers invoke fetch() concurrently before the first
    // resolves, only one HTTP request should be made (race condition fix)
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockManifest,
    });
    globalThis.fetch = fetchMock;

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
  });
});
