/**
 * Tests for FallbackHandler
 *
 * FallbackHandler is responsible for making HTTP requests to the server
 * for fallback execution when browser execution fails.
 *
 * Test strategy:
 * - Mock global fetch to avoid real HTTP calls
 * - Test successful execution
 * - Test function errors (should throw UnzenFunctionError)
 * - Test network errors (should throw UnzenNetworkError)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnzenFunctionError, UnzenNetworkError } from '@unzen/shared';
import { FallbackHandler } from '../src/fallback-handler';

describe('FallbackHandler', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // Save original fetch
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    // Restore original fetch
    globalThis.fetch = originalFetch;
  });

  it('should construct with endpoint', () => {
    const handler = new FallbackHandler('https://example.com');
    expect(handler).toBeInstanceOf(FallbackHandler);
  });

  it('should execute function successfully', async () => {
    // Mock successful response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 42 }),
    });

    const handler = new FallbackHandler('https://example.com');
    const result = await handler.execute('add', [1, 2]);

    expect(result).toBe(42);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/exec/add',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [1, 2] }),
      }
    );
  });

  it('should throw UnzenFunctionError when server returns error', async () => {
    // Mock error response
    // ExecutionResponse: { result: unknown, error?: string }
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        result: null,
        error: 'Division by zero',
      }),
    });

    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('divide', [1, 0])).rejects.toThrow(
      UnzenFunctionError
    );
    await expect(handler.execute('divide', [1, 0])).rejects.toThrow(
      'Division by zero'
    );
  });

  it('should throw UnzenNetworkError on network failure', async () => {
    // Mock network failure
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      UnzenNetworkError
    );
  });

  it('should throw UnzenNetworkError on HTTP error status', async () => {
    // Mock HTTP error response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      UnzenNetworkError
    );
  });

  it('should handle complex return values', async () => {
    const complexResult = {
      data: [1, 2, 3],
      meta: { count: 3 },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: complexResult }),
    });

    const handler = new FallbackHandler('https://example.com');
    const result = await handler.execute('getData', []);

    expect(result).toEqual(complexResult);
  });
});
