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
import {
  UnzenNetworkError,
  type FunctionManifestEntry,
} from '@unzen/shared';
import { CodeFetcher } from '../src/code-fetcher';

describe('CodeFetcher', () => {
  let originalFetch: typeof globalThis.fetch;

  const mockEntry: FunctionManifestEntry = {
    name: 'add',
    runtime: 'quickjs',
    codeUrl: 'https://example.com/code/add.js',
    hash: 'abc123',
  };

  const mockCode = 'function add(a, b) { return a + b; }';

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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockCode,
    });

    const fetcher = new CodeFetcher('https://example.com');
    const code = await fetcher.fetch(mockEntry);

    expect(code).toBe(mockCode);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/code/add.js',
      expect.any(Object)
    );
  });

  it('should cache code by hash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockCode,
    });
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    // First fetch - should call server
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second fetch with same hash - should use cache
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1); // Still 1, not 2
  });

  it('should fetch again if hash changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockCode,
    });
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    // First fetch
    await fetcher.fetch(mockEntry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second fetch with different hash - should fetch again
    const updatedEntry: FunctionManifestEntry = {
      ...mockEntry,
      hash: 'def456', // Different hash
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
      return Promise.resolve({
        ok: true,
        text: async () => code,
      });
    });
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    const addEntry: FunctionManifestEntry = {
      name: 'add',
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/add.js',
      hash: 'hash1',
    };

    const multiplyEntry: FunctionManifestEntry = {
      name: 'multiply',
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/multiply.js',
      hash: 'hash2',
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => mockCode,
    });
    globalThis.fetch = fetchMock;

    const fetcher = new CodeFetcher('https://example.com');

    const entry1: FunctionManifestEntry = {
      name: 'func1',
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/func1.js',
      hash: 'same-hash',
    };

    const entry2: FunctionManifestEntry = {
      name: 'func2',
      runtime: 'quickjs',
      codeUrl: 'https://example.com/code/func2.js',
      hash: 'same-hash', // Same hash as func1
    };

    await fetcher.fetch(entry1);
    await fetcher.fetch(entry2);

    // Should only fetch once since hash is the same
    // This is correct behavior: hash represents content, not identity
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
