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
import {
  MAX_EXECUTION_ARGUMENTS,
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
} from '@unzen/shared';
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

  it('should reject invalid endpoints during construction', () => {
    expect(() => new FallbackHandler('   ')).toThrow('endpoint must be a non-empty string');
    expect(() => new FallbackHandler(null as unknown as string)).toThrow(
      'endpoint must be a non-empty string',
    );
  });

  it('should execute function successfully', async () => {
    // Mock successful response
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: 42 }),
    });

    const handler = new FallbackHandler('  https://example.com///  ');
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

  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 'success'],
    ['empty error', { result: null, error: '' }],
    ['blank error', { result: null, error: '   ' }],
    ['non-string error', { result: null, error: 42 }],
    ['error without null result', { error: 'failed' }],
    ['conflicting result and error', { result: 42, error: 'failed' }],
    ['unknown-only success', { status: 'ok' }],
  ])('rejects an invalid %s response envelope', async (_label, payload) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
    });

    const handler = new FallbackHandler('https://example.com');
    await expect(handler.execute('test', [])).rejects.toThrow(UnzenNetworkError);
  });

  it('preserves falsy and legacy undefined success values', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: 0 }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: false }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: '' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: null }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).resolves.toBe(0);
    await expect(handler.execute('test', [])).resolves.toBe(false);
    await expect(handler.execute('test', [])).resolves.toBe('');
    await expect(handler.execute('test', [])).resolves.toBeNull();
    await expect(handler.execute('test', [])).resolves.toBeUndefined();
  });

  it('classifies a non-OK redirect envelope as a network error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      statusText: 'Found',
      json: async () => ({ result: null, error: 'Redirected' }),
    });
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(UnzenNetworkError);
  });

  it('classifies a rate-limit response as a network error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({ result: null, error: 'Rate limited' }),
    });
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [])).rejects.toThrow(UnzenNetworkError);
  });

  it('does not accept a JSON body that resolves after cancellation', async () => {
    let resolveBody!: (value: unknown) => void;
    let bodyStartedResolve!: () => void;
    const bodyStarted = new Promise<void>((resolve) => {
      bodyStartedResolve = resolve;
    });
    const body = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => {
        bodyStartedResolve();
        return body;
      },
    });
    const handler = new FallbackHandler('https://example.com');
    const controller = new AbortController();
    const request = handler.execute('test', [], controller.signal);
    await bodyStarted;
    controller.abort();
    resolveBody({ result: 42 });

    await expect(request).rejects.toThrow(UnzenCancelledError);
  });

  it('rejects unsafe function names and excessive argument counts before fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('../manifest', [])).rejects.toThrow(UnzenFunctionError);
    await expect(handler.execute(
      'test',
      new Array(MAX_EXECUTION_ARGUMENTS + 1).fill(null),
    )).rejects.toThrow(UnzenFunctionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies non-serializable arguments as a function error before fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', [1n])).rejects.toThrow(UnzenFunctionError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('snapshots arguments by index without invoking a custom iterator', async () => {
    const args = [1, 2];
    Object.defineProperty(args, Symbol.iterator, {
      value: () => { throw new Error('iterator must not run'); },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: 3 }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', args)).resolves.toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/exec/test',
      expect.objectContaining({ body: JSON.stringify({ args: [1, 2] }) }),
    );
  });

  it('rechecks cancellation after argument serialization and before fetch', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const controller = new AbortController();
    const args = [{
      toJSON: () => {
        controller.abort();
        return 'cancelled';
      },
    }];
    const handler = new FallbackHandler('https://example.com');

    await expect(handler.execute('test', args, controller.signal))
      .rejects.toThrow(UnzenCancelledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
