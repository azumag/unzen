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

  it('should throw UnzenNetworkError on HTTP error with unparseable body', async () => {
    // Mock HTTP error response with no JSON body
    // When body can't be parsed, it's a network/infrastructure error
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => { throw new SyntaxError('Unexpected token'); },
    });

    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      UnzenNetworkError
    );
  });

  it('should throw UnzenFunctionError on HTTP 400 with error body', async () => {
    // Server returns 400 for UnzenFunctionError (user code bug)
    // Client must preserve this classification, not wrap as NetworkError
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({
        result: null,
        error: 'Function execution failed: TypeError',
      }),
    });

    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      UnzenFunctionError
    );
    await expect(handler.execute('test', [])).rejects.toThrow(
      'Function execution failed: TypeError'
    );
  });

  it('should throw UnzenNetworkError on HTTP 500 with error body', async () => {
    // Server returns 500 for UnzenRuntimeError (timeout, OOM) → retryable
    // 5xx errors are infrastructure/runtime issues, not user code bugs
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({
        result: null,
        error: 'Execution timeout exceeded (50ms)',
      }),
    });

    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(
      UnzenNetworkError
    );
    await expect(handler.execute('test', [])).rejects.toThrow(
      'Execution timeout exceeded (50ms)'
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
