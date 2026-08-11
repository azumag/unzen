/**
 * Tests for UnzenClient
 *
 * UnzenClient is the main entry point for the framework.
 * It orchestrates manifest fetching, code loading, sandbox execution,
 * and fallback to server.
 *
 * Test strategy:
 * - Mock all dependencies (fetch, sandbox)
 * - Test different execution modes (development, production, browser-only)
 * - Test fallback behavior
 * - Test error handling
 */

import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
  type ManifestResponse,
} from '@unzen/shared';
import { UnzenClient, type UnzenExecutionEvent } from '../src/unzen-client';
import { MockSandboxExecutor } from '../src/quickjs-sandbox';

const fibonacciWasmBytes = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fibonacci.wasm'),
);
const MOCK_CONTENT_HASH = `sha256:${'a'.repeat(64)}`;

function hashText(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function hashBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/** Create an AbortError-compatible rejection for mocked fetch/sandbox */
function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/** Helper: fetch mock that resolves a JSON body for a URL */
function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, json: async () => data });
}

/** Helper: fetch mock that resolves a text body for a URL */
function textResponse(data: string) {
  return Promise.resolve(new Response(data, {
    status: 200,
    headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
  }));
}

describe('UnzenClient', () => {
  let originalFetch: typeof globalThis.fetch;

  const mockAddCode = 'function run(a, b) { return a + b; }';

  const mockManifest: ManifestResponse = {
    functions: {
      add: {
        version: 1,
        runtime: 'quickjs',
        codeUrl: 'https://example.com/code/add.js',
        hash: hashText(mockAddCode),
      },
    },
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('infers names, arguments, and results from a generated function schema', () => {
    type Functions = {
      add: (a: number, b: number) => number;
      greet: (name: string) => string;
    };

    function assertGeneratedTypes(client: UnzenClient<Functions>): void {
      expectTypeOf(client.call('add', 1, 2)).toEqualTypeOf<Promise<number>>();
      expectTypeOf(client.call('greet', 'Ada')).toEqualTypeOf<Promise<string>>();
      // @ts-expect-error generated schemas reject incorrect argument types
      void client.call('add', '1', 2);
      // @ts-expect-error generated schemas reject unknown function names
      void client.call('missing');
    }

    expectTypeOf(assertGeneratedTypes).toBeFunction();
  });

  describe('constructor', () => {
    it('should create instance with endpoint and sandbox', () => {
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        sandbox: new MockSandboxExecutor(),
      });
      expect(client).toBeInstanceOf(UnzenClient);
      client.dispose();
    });

    it('should default to production mode', () => {
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        sandbox: new MockSandboxExecutor(),
      });
      expect(client).toBeInstanceOf(UnzenClient);
      client.dispose();
    });

    it('should accept explicit mode', () => {
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });
      expect(client).toBeInstanceOf(UnzenClient);
      client.dispose();
    });

    it('should throw error when neither sandbox nor workerUrl is provided', () => {
      // Constructor requires either workerUrl (for production browser execution)
      // or sandbox (for testing / custom implementations).
      // Omitting both is a configuration error that should fail fast.
      expect(() => new UnzenClient({ endpoint: 'https://example.com' })).toThrow(
        'UnzenClient requires either workerUrl or sandbox option'
      );
    });
  });

  describe('development mode', () => {
    it('should always use fallback in development mode', async () => {
      // Mock manifest (proves `add` is an ordinary server-executable
      // function) and fallback endpoint.
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        return Promise.resolve({
          ok: true,
          json: async () => ({ result: 3 }),
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });

      const result = await client.call('add', 1, 2);

      expect(result).toBe(3);
      // Should call fallback endpoint directly
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/exec/add',
        expect.any(Object)
      );

      client.dispose();
    });

    it('should propagate function errors in development mode', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        return Promise.resolve({
          ok: true,
          json: async () => ({
            error: { type: 'function_error', message: 'Test error' },
          }),
        });
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });

      await expect(client.call('add', 1, 2)).rejects.toThrow(
        UnzenFunctionError
      );

      client.dispose();
    });
  });

  describe('production mode', () => {
    it('should execute in browser successfully', async () => {
      // Mock manifest and code fetch
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(mockAddCode);
        }
        throw new Error('Unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      const result = await client.call<number>('add', 1, 2);

      expect(result).toBe(3);
      // Should fetch manifest and code, but NOT call /exec endpoint
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/manifest',
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/code/add.js',
        expect.any(Object)
      );

      client.dispose();
    });

    it('should NOT fallback on code syntax error (UnzenFunctionError)', async () => {
      // Syntax error in code should throw UnzenFunctionError
      // This is a function/code error, not a runtime environment error
      const invalidCode = 'this is not valid code';
      const invalidCodeManifest: ManifestResponse = {
        functions: {
          add: { ...mockManifest.functions.add, hash: hashText(invalidCode) },
        },
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => invalidCodeManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(invalidCode);
        }
        throw new Error('Should not reach here');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      // Should throw UnzenFunctionError without fallback
      await expect(client.call<number>('add', 1, 2)).rejects.toThrow(
        UnzenFunctionError
      );

      // Should NOT call /exec endpoint (no fallback for code errors)
      const execCalls = fetchMock.mock.calls.filter((call) =>
        call[0].includes('/exec/')
      );
      expect(execCalls).toHaveLength(0);

      client.dispose();
    });

    it('should NOT fallback on UnzenFunctionError', async () => {
      // Code that throws function error
      const errorCode = 'function run() { throw new Error("User error"); }';
      const errorManifest: ManifestResponse = {
        functions: {
          add: { ...mockManifest.functions.add, hash: hashText(errorCode) },
        },
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => errorManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(errorCode);
        }
        throw new Error('Should not call other endpoints');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      // Should throw UnzenFunctionError without fallback
      await expect(client.call('add', 1, 2)).rejects.toThrow(
        UnzenFunctionError
      );

      // Should NOT call /exec endpoint (no fallback for function errors)
      const execCalls = fetchMock.mock.calls.filter((call) =>
        call[0].includes('/exec/')
      );
      expect(execCalls).toHaveLength(0);

      client.dispose();
    });

    it('should throw UnzenFunctionError if function not in manifest (no fallback)', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        throw new Error('Unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      // Should throw UnzenFunctionError (user error, not runtime error)
      await expect(client.call('nonexistent')).rejects.toThrow(
        UnzenFunctionError
      );
      await expect(client.call('nonexistent')).rejects.toThrow(
        'Function "nonexistent" not found in manifest'
      );

      // Should NOT call /exec endpoint (no fallback for function errors)
      const execCalls = fetchMock.mock.calls.filter((call) =>
        call[0].includes('/exec/')
      );
      expect(execCalls).toHaveLength(0);

      client.dispose();
    });
  });

  describe('browser-only mode', () => {
    it('should execute in browser without fallback', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(mockAddCode);
        }
        throw new Error('Unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'browser-only',
        sandbox: new MockSandboxExecutor(),
      });

      const result = await client.call<number>('add', 1, 2);

      expect(result).toBe(3);

      client.dispose();
    });

    it('should throw error on runtime error without fallback', async () => {
      const invalidCode = 'this is not valid code';
      const invalidCodeManifest: ManifestResponse = {
        functions: {
          add: { ...mockManifest.functions.add, hash: hashText(invalidCode) },
        },
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => invalidCodeManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(invalidCode);
        }
        throw new Error('Should not call other endpoints');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'browser-only',
        sandbox: new MockSandboxExecutor(),
      });

      // Should throw error without fallback
      await expect(client.call('add', 1, 2)).rejects.toThrow();

      // Should NOT call /exec endpoint
      const execCalls = fetchMock.mock.calls.filter((call) =>
        call[0].includes('/exec/')
      );
      expect(execCalls).toHaveLength(0);

      client.dispose();
    });
  });

  describe('callWithDiagnostics', () => {
    it('should return success result with diagnostics for browser execution', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(mockAddCode);
        }
        throw new Error('Unexpected URL');
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      const result = await client.callWithDiagnostics<number>('add', 1, 2);

      // Success shape with diagnostics
      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
      expect(result.error).toBeUndefined();

      // Diagnostics must include execution location, timing, and cache status
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics!.executedOn).toBe('browser');
      expect(typeof result.diagnostics!.durationMs).toBe('number');
      expect(result.diagnostics!.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.diagnostics!.cached).toBe('boolean');

      client.dispose();
    });

    it('should report executedOn as server when fallback is used', async () => {
      // Development mode always uses server fallback
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        return Promise.resolve({
          ok: true,
          json: async () => ({ result: 3 }),
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });

      const result = await client.callWithDiagnostics<number>('add', 1, 2);

      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics!.executedOn).toBe('server');
      expect(typeof result.diagnostics!.durationMs).toBe('number');

      client.dispose();
    });

    it('should report cached=true when manifest was already in cache', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(mockAddCode);
        }
        throw new Error('Unexpected URL');
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      // First call populates cache
      await client.call('add', 1, 2);

      // Second call with diagnostics — manifest should be cached
      const result = await client.callWithDiagnostics<number>('add', 1, 2);

      expect(result.success).toBe(true);
      expect(result.diagnostics!.cached).toBe(true);

      client.dispose();
    });

    it('should return error result with partial diagnostics on failure', async () => {
      // Function error: user code throws. Error result should include
      // partial diagnostics (durationMs, cached, executedOn) for debugging.
      const errorCode = 'function run() { throw new Error("Test error"); }';
      const errorManifest: ManifestResponse = {
        functions: {
          add: { ...mockManifest.functions.add, hash: hashText(errorCode) },
        },
      };

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => errorManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(errorCode);
        }
        throw new Error('Unexpected URL');
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });

      const result = await client.callWithDiagnostics('add', 1, 2);

      expect(result.success).toBe(false);
      expect(result.result).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.type).toBe('function_error');
      expect(result.error?.message).toContain('Test error');

      // Partial diagnostics should be present even on failure
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.diagnostics.cached).toBe('boolean');
      expect(result.diagnostics.executedOn).toBe('browser');

      client.dispose();
    });

    it('should return client_disposed error with diagnostics for disposed client', async () => {
      // Disposed client should return a clear error with diagnostics
      // (durationMs measured, but no executedOn since no execution occurred)
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: new MockSandboxExecutor(),
      });
      client.dispose();

      const result = await client.callWithDiagnostics('add', 1, 2);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('client_disposed');
      expect(result.error?.message).toContain('disposed');

      // Diagnostics present but no executedOn (no execution was attempted)
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.diagnostics.cached).toBe('boolean');
      expect(result.diagnostics.executedOn).toBeUndefined();
    });

    it('should return browser_runtime_error for runtime errors in browser-only mode', async () => {
      // In browser-only mode, runtime errors should NOT fallback to server
      // and should be reported as browser_runtime_error with location info
      const { MockSandboxExecutor } = await import('../src/quickjs-sandbox');
      const failingSandbox = new MockSandboxExecutor();
      failingSandbox.execute = async () => {
        throw new UnzenRuntimeError('Wasm init failed');
      };

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(mockAddCode);
        }
        throw new Error('Should not call other endpoints');
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'browser-only',
        sandbox: failingSandbox,
      });

      const result = await client.callWithDiagnostics('add', 1, 2);

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('browser_runtime_error');
      expect(result.error?.message).toContain('Wasm init failed');

      // Should report where the error occurred
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics.executedOn).toBe('browser');
      expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);

      client.dispose();
    });

    it('should include durationMs even for server fallback in production mode', async () => {
      // Simulate a scenario where browser execution fails with RuntimeError
      // and falls back to server
      const { MockSandboxExecutor } = await import('../src/quickjs-sandbox');
      const failingSandbox = new MockSandboxExecutor();
      failingSandbox.execute = async () => {
        throw new UnzenRuntimeError('Wasm unavailable');
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return textResponse(mockAddCode);
        }
        if (url.includes('/exec/add')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ result: 3 }),
          });
        }
        throw new Error('Unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
        sandbox: failingSandbox,
      });

      const result = await client.callWithDiagnostics<number>('add', 1, 2);

      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
      expect(result.diagnostics).toBeDefined();
      expect(result.diagnostics!.executedOn).toBe('server');
      expect(result.diagnostics!.durationMs).toBeGreaterThanOrEqual(0);

      client.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        sandbox: new MockSandboxExecutor(),
      });
      expect(() => client.dispose()).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        sandbox: new MockSandboxExecutor(),
      });
      client.dispose();
      expect(() => client.dispose()).not.toThrow();
    });

    it('should throw UnzenRuntimeError when call() is invoked after dispose', async () => {
      // Disposed client has released sandbox resources
      // Subsequent call() must fail immediately with clear error
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        sandbox: new MockSandboxExecutor(),
      });
      client.dispose();

      await expect(client.call('add', 1, 2)).rejects.toThrow(UnzenRuntimeError);
      await expect(client.call('add', 1, 2)).rejects.toThrow('disposed');
    });
  });

  // === issue #105 execution lifecycle (signal / events / diagnostics) ===
  describe('issue #105 execution lifecycle', () => {
    const endpoint = 'https://example.com';

    it('should reject immediately when signal is already aborted (no fetch, no fallback)', async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const controller = new AbortController();
      controller.abort();

      await expect(
        client.execute({ name: 'add', args: [1, 2], signal: controller.signal }),
      ).rejects.toThrow(UnzenCancelledError);
      expect(fetchMock).not.toHaveBeenCalled();
      client.dispose();
    });

    it('should cancel during manifest fetch and never fall back', async () => {
      // Manifest fetch hangs until the signal aborts (then rejects as AbortError)
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(abortError());
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
      }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const controller = new AbortController();
      const p = client.execute({ name: 'add', args: [1, 2], signal: controller.signal });
      setTimeout(() => controller.abort(), 10);

      await expect(p).rejects.toThrow(UnzenCancelledError);
      const execCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/exec/'));
      expect(execCalls).toHaveLength(0);
      client.dispose();
    });

    it('should cancel during browser execution without fallback', async () => {
      // Sandbox that only settles when its signal aborts → cancelled
      const hangingSandbox = new MockSandboxExecutor();
      hangingSandbox.execute = (_code, _args, options) => new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new UnzenCancelledError('cancelled'));
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(new UnzenCancelledError('cancelled')), { once: true });
      });

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: hangingSandbox });
      const controller = new AbortController();
      const p = client.execute({ name: 'add', args: [1, 2], signal: controller.signal });
      setTimeout(() => controller.abort(), 10);

      await expect(p).rejects.toThrow(UnzenCancelledError);
      const execCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/exec/'));
      expect(execCalls).toHaveLength(0);
      client.dispose();
    });

    it('should not start server fallback when cancelled after a browser failure', async () => {
      // Browser fails with a runtime error and cancels the signal in the same
      // breath — the fallback must be skipped entirely.
      const failingSandbox = new MockSandboxExecutor();
      const controller = new AbortController();
      failingSandbox.execute = async (_code, _args, options) => {
        if (options?.signal?.aborted) throw new UnzenCancelledError('cancelled');
        controller.abort();
        throw new UnzenRuntimeError('browser down');
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        if (url.includes('/exec/add')) return jsonResponse({ result: 3 });
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: failingSandbox });
      const p = client.execute({ name: 'add', args: [1, 2], signal: controller.signal });

      await expect(p).rejects.toThrow(UnzenCancelledError);
      const execCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/exec/'));
      expect(execCalls).toHaveLength(0);
      client.dispose();
    });

    it('should cancel in-flight executions on dispose (no unsettled promises)', async () => {
      const hangingSandbox = new MockSandboxExecutor();
      hangingSandbox.execute = (_code, _args, options) => new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) {
          reject(new UnzenCancelledError('cancelled'));
          return;
        }
        options?.signal?.addEventListener('abort', () => reject(new UnzenCancelledError('cancelled')), { once: true });
      });

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: hangingSandbox });
      const p = client.execute({ name: 'add', args: [1, 2] });
      await new Promise((r) => setTimeout(r, 10));

      client.dispose();

      await expect(p).rejects.toThrow(); // settles (cancelled), never hangs
      client.dispose();
    });

    it('should record the full attempt chain when a server fallback is used', async () => {
      const failingSandbox = new MockSandboxExecutor();
      failingSandbox.execute = async () => {
        throw new UnzenRuntimeError('browser down');
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        if (url.includes('/exec/add')) return jsonResponse({ result: 3 });
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: failingSandbox });
      const result = await client.executeWithDiagnostics<number>({ name: 'add', args: [1, 2] });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe(3);
        expect(result.diagnostics.finalRoute).toBe('server');
        expect(result.diagnostics.fallbackUsed).toBe(true);
        expect(result.diagnostics.attempts).toHaveLength(2);
        expect(result.diagnostics.attempts[0]).toMatchObject({
          kind: 'browser',
          outcome: 'failed',
          errorCode: 'browser_runtime_failed',
        });
        expect(result.diagnostics.attempts[1]).toMatchObject({ kind: 'server', outcome: 'succeeded' });
      }
      client.dispose();
    });

    it('should emit lifecycle events with monotonic sequence and one terminal event', async () => {
      const events: Array<{ type: UnzenExecutionEvent['type']; sequence: number; executionId: string }> = [];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const result = await client.executeWithDiagnostics<number>({
        name: 'add',
        args: [1, 2],
        onEvent: (e) => events.push({ type: e.type, sequence: e.sequence, executionId: e.executionId }),
      });

      expect(result.success).toBe(true);
      const terminals = events.filter((e) =>
        ['completed', 'cancelled', 'failed'].includes(e.type),
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0].type).toBe('completed');

      // Sequence must be monotonic 1..N and executionId stable.
      const sequences = events.map((e) => e.sequence);
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
      expect(new Set(events.map((e) => e.executionId)).size).toBe(1);
      client.dispose();
    });

    it('should emit sandbox-initializing before browser-execution-started on a cold sandbox', async () => {
      const events: string[] = [];
      let sandboxReady = false;
      const coldSandbox = new MockSandboxExecutor();
      coldSandbox.isReady = () => sandboxReady;
      coldSandbox.execute = async (_code, args) => {
        sandboxReady = true;
        return (args as number[]).reduce((a, b) => a + b, 0);
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: coldSandbox });
      const result = await client.executeWithDiagnostics<number>({
        name: 'add',
        args: [1, 2],
        onEvent: (e) => events.push(e.type),
      });

      expect(result.success).toBe(true);
      expect(events).toEqual([
        'accepted',
        'manifest-fetch-started',
        'manifest-fetch-completed',
        'code-fetch-started',
        'code-fetch-completed',
        'sandbox-initializing',
        'browser-execution-started',
        'completed',
      ]);
      client.dispose();
    });

    it('should not emit sandbox-initializing for a warm sandbox', async () => {
      const events: string[] = [];
      const warmSandbox = new MockSandboxExecutor();
      warmSandbox.isReady = () => true;

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: warmSandbox });
      await client.executeWithDiagnostics<number>({
        name: 'add',
        args: [1, 2],
        onEvent: (e) => events.push(e.type),
      });

      expect(events).not.toContain('sandbox-initializing');
      expect(events).toContain('browser-execution-started');
      client.dispose();
    });

    it('should return stable error codes from executeWithDiagnostics', async () => {
      // function error → 'function_failed'
      const errorCode = 'function run() { throw new Error("User error"); }';
      const errorManifest: ManifestResponse = {
        functions: {
          add: { ...mockManifest.functions.add, hash: hashText(errorCode) },
        },
      };
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(errorManifest);
        if (url.includes('/code/add.js')) return textResponse(errorCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const result = await client.executeWithDiagnostics({ name: 'add', args: [1, 2] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('function_failed');
      }

      // manifest failure → 'manifest_fetch_failed'
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
      const client2 = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const result2 = await client2.executeWithDiagnostics({ name: 'add', args: [1, 2] });
      expect(result2.success).toBe(false);
      if (!result2.success) {
        expect(result2.error.code).toBe('manifest_fetch_failed');
      }

      // cancelled → 'cancelled'
      const controller = new AbortController();
      controller.abort();
      const result3 = await client2.executeWithDiagnostics({ name: 'add', args: [], signal: controller.signal });
      expect(result3.success).toBe(false);
      if (!result3.success) {
        expect(result3.error.code).toBe('cancelled');
      }

      client.dispose();
      client2.dispose();
    });

    it('should NOT commit a late sandbox result after cancellation (AC #5)', async () => {
      // Sandbox resolves ONLY when the signal aborts — simulating a result
      // arriving after the caller cancelled. It must not be committed.
      const lateSandbox = new MockSandboxExecutor();
      lateSandbox.execute = (_code, _args, options) => new Promise((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(999), { once: true });
      });

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: lateSandbox });
      const controller = new AbortController();
      const p = client.execute<number>({ name: 'add', args: [1, 2], signal: controller.signal });
      setTimeout(() => controller.abort(), 10);

      await expect(p).rejects.toThrow(UnzenCancelledError);
      client.dispose();
    });

    it('should cancel during code fetch without fallback', async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) {
          return new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(abortError());
              return;
            }
            init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const controller = new AbortController();
      const p = client.execute({ name: 'add', args: [1, 2], signal: controller.signal });
      setTimeout(() => controller.abort(), 10);

      await expect(p).rejects.toThrow(UnzenCancelledError);
      const execCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/exec/'));
      expect(execCalls).toHaveLength(0);
      client.dispose();
    });

    it('should cancel during server fallback execution', async () => {
      const failingSandbox = new MockSandboxExecutor();
      failingSandbox.execute = async () => {
        throw new UnzenRuntimeError('browser down');
      };

      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        if (url.includes('/exec/add')) {
          return new Promise((_resolve, reject) => {
            if (init?.signal?.aborted) {
              reject(abortError());
              return;
            }
            init?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: failingSandbox });
      const controller = new AbortController();
      const p = client.execute({ name: 'add', args: [1, 2], signal: controller.signal });
      setTimeout(() => controller.abort(), 20);

      await expect(p).rejects.toThrow(UnzenCancelledError);
      client.dispose();
    });

    it('should emit only the cancelled terminal on pre-abort', async () => {
      const events: string[] = [];
      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      const controller = new AbortController();
      controller.abort();

      const result = await client.executeWithDiagnostics({
        name: 'add',
        args: [],
        signal: controller.signal,
        onEvent: (e) => events.push(e.type),
      });

      expect(result.success).toBe(false);
      expect(events).toEqual(['cancelled']);
      client.dispose();
    });

    it('should report a sandbox deadline as deadline_exceeded (browser-only mode)', async () => {
      const timeoutSandbox = new MockSandboxExecutor();
      timeoutSandbox.execute = async () => {
        throw new UnzenDeadlineExceededError('Execution timeout exceeded');
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint,
        mode: 'browser-only',
        sandbox: timeoutSandbox,
      });
      const result = await client.executeWithDiagnostics({ name: 'add', args: [1, 2] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('deadline_exceeded');
      }
      client.dispose();
    });

    it('should classify a fallback network failure as server_network_failed', async () => {
      const failingSandbox = new MockSandboxExecutor();
      failingSandbox.execute = async () => {
        throw new UnzenRuntimeError('browser down');
      };

      // Manifest/code succeed; the fallback /exec call fails with a network error.
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        if (url.includes('/exec/add')) {
          return Promise.reject(new UnzenNetworkError('connect ECONNREFUSED'));
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: failingSandbox });
      const result = await client.executeWithDiagnostics({ name: 'add', args: [1, 2] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('server_network_failed');
        expect(result.diagnostics.fallbackUsed).toBe(true);
        expect(result.diagnostics.attempts[1]).toMatchObject({
          kind: 'server',
          outcome: 'failed',
        });
      }
      client.dispose();
    });

    it('should route moonbit manifest entries to the moonbit sandbox', async () => {
      const events: string[] = [];
      const contentHash = `sha256:${'a'.repeat(64)}`;
      const moonbitManifest: ManifestResponse = {
        functions: {
          fibonacci: {
            runtime: 'moonbit',
            hash: contentHash,
            version: 1,
            codeUrl: 'https://example.com/code/fibonacci.wasm',
            exportName: 'fibonacci',
          },
        },
      };
      const prepared: Array<{ url: string; expectedHash?: string }> = [];
      const executed: Array<{ url: string; args: unknown[]; expectedHash?: string }> = [];
      const fakeMoonbit = {
        prepare: async (url: string, _signal?: AbortSignal, expectedHash?: string) => {
          prepared.push({ url, expectedHash });
        },
        execute: async (url: string, args: unknown[], options?: { expectedHash?: string }) => {
          executed.push({ url, args, expectedHash: options?.expectedHash });
          return 55;
        },
        dispose: () => {},
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        throw new Error('unexpected URL: ' + url);
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint,
        sandbox: new MockSandboxExecutor(),
        moonbitSandbox: fakeMoonbit,
      });
      const result = await client.executeWithDiagnostics<number>({
        name: 'fibonacci',
        args: [10],
        onEvent: (e) => events.push(e.type),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe(55);
        expect(result.diagnostics.finalRoute).toBe('browser');
        expect(result.diagnostics.attempts[0]).toMatchObject({
          kind: 'browser',
          outcome: 'succeeded',
        });
      }
      // The wasm module was prepared and executed via the moonbit executor,
      // not the QuickJS code fetcher (which would corrupt wasm bytes as text).
      expect(prepared).toEqual([{
        url: 'https://example.com/code/fibonacci.wasm',
        expectedHash: contentHash,
      }]);
      expect(executed).toEqual([
        {
          url: 'https://example.com/code/fibonacci.wasm',
          args: [10],
          expectedHash: contentHash,
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1); // manifest only
      client.dispose();
    });

    it('should NOT fall back to the server when a moonbit runtime error occurs', async () => {
      const moonbitManifest: ManifestResponse = {
        functions: {
          boom: {
            runtime: 'moonbit',
            hash: MOCK_CONTENT_HASH,
            version: 1,
            codeUrl: 'https://example.com/code/boom.wasm',
            noFallback: true,
          },
        },
      };
      const failingMoonbit = {
        prepare: async () => {},
        execute: async () => {
          throw new UnzenRuntimeError('wasm crashed');
        },
        dispose: () => {},
      };

      const execRequests: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        if (url.includes('/exec/')) execRequests.push(url);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint,
        sandbox: new MockSandboxExecutor(),
        moonbitSandbox: failingMoonbit,
      });
      const result = await client.executeWithDiagnostics({ name: 'boom', args: [] });

      expect(result.success).toBe(false);
      if (!result.success) {
        // The original browser error is the final result — not a replaced
        // server_fallback_failed.
        expect(result.error.code).toBe('browser_runtime_failed');
        expect(result.diagnostics.fallbackUsed).toBe(false);
        expect(result.diagnostics.finalRoute).toBeUndefined();
        expect(result.diagnostics.attempts[0]).toMatchObject({
          kind: 'browser',
          outcome: 'failed',
        });
      }
      // No server /exec request may have been made for a noFallback function.
      expect(execRequests).toHaveLength(0);
      client.dispose();
    });

    it('should suppress fallback for moonbit even when noFallback is omitted from the manifest', async () => {
      // A hand-written manifest may omit the optional noFallback flag; the
      // runtime alone must still prevent server fallback.
      const moonbitManifest: ManifestResponse = {
        functions: {
          fib: {
            runtime: 'moonbit',
            hash: MOCK_CONTENT_HASH,
            version: 1,
            codeUrl: 'https://example.com/code/fib.wasm',
            // noFallback intentionally omitted
          },
        },
      };
      const failingMoonbit = {
        prepare: async () => {},
        execute: async () => {
          throw new UnzenRuntimeError('wasm crashed');
        },
        dispose: () => {},
      };
      const execCalls: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        if (url.includes('/exec/')) execCalls.push(url);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint,
        sandbox: new MockSandboxExecutor(),
        moonbitSandbox: failingMoonbit,
      });
      const result = await client.executeWithDiagnostics({ name: 'fib', args: [10] });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('browser_runtime_failed');
        expect(result.diagnostics.fallbackUsed).toBe(false);
      }
      expect(execCalls).toHaveLength(0);
      client.dispose();
    });

    it('routes moonbit entries to the worker executor when moonbitWorkerUrl is set', async () => {
      const events: string[] = [];
      const moonbitManifest: ManifestResponse = {
        functions: {
          fibonacci: {
            runtime: 'moonbit',
            hash: MOCK_CONTENT_HASH,
            version: 1,
            codeUrl: 'https://example.com/code/fibonacci.wasm',
            exportName: 'fibonacci',
          },
        },
      };
      let executed = false;
      const fakeWorkerExecutor = {
        prepare: async () => new ArrayBuffer(8),
        execute: async (_url: string, _args: unknown[], opts?: { exportName?: string }) => {
          executed = true;
          expect(opts?.exportName).toBe('fibonacci');
          return 55;
        },
        dispose: () => {},
        isReady: () => true,
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        throw new Error('unexpected URL: ' + url);
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint,
        sandbox: new MockSandboxExecutor(),
        // moonbitWorkerUrl is set, but an explicit moonbitSandbox override
        // wins — this test verifies the option surface accepts either and the
        // moonbit path routes to the moonbit executor.
        moonbitSandbox: fakeWorkerExecutor,
        moonbitWorkerUrl: '/moonbit-worker.js',
      });
      const result = await client.executeWithDiagnostics<number>({
        name: 'fibonacci',
        args: [10],
        onEvent: (e) => events.push(e.type),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe(55);
        expect(result.diagnostics.finalRoute).toBe('browser');
      }
      expect(executed).toBe(true);
      client.dispose();
    });

    it('passes manifest MoonBit ABI metadata to the selected executor', async () => {
      const moonbitManifest: ManifestResponse = {
        functions: {
          sumArray: {
            runtime: 'moonbit',
            hash: MOCK_CONTENT_HASH,
            version: 1,
            codeUrl: 'https://example.com/code/arrays.wasm',
            exportName: 'sum_array',
            moonbitAbi: { params: ['i32[]'] },
          },
        },
      };
      const moonbitSandbox = {
        prepare: async () => new ArrayBuffer(8),
        execute: async (_url: string, args: unknown[], opts?: {
          exportName?: string;
          moonbitAbi?: { params: string[]; result?: string };
        }) => {
          expect(args).toEqual([[1, 2, 3]]);
          expect(opts?.exportName).toBe('sum_array');
          expect(opts?.moonbitAbi).toEqual({ params: ['i32[]'] });
          return 6;
        },
        dispose: () => {},
        isReady: () => true,
      };
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        throw new Error('unexpected URL: ' + url);
      });
      const client = new UnzenClient({
        endpoint,
        sandbox: new MockSandboxExecutor(),
        moonbitSandbox,
      });

      await expect(client.call<number>('sumArray', [1, 2, 3])).resolves.toBe(6);
      client.dispose();
    });

    it('routes moonbit entries through the real worker executor when moonbitWorkerUrl is set', async () => {
      // Global Worker is replaced with a mock that runs the REAL MoonBit
      // worker message handler against the fibonacci fixture, so this proves
      // UnzenClient → MoonBitWorkerSandboxExecutor → worker script path end
      // to end (including the wasm fetch on the main thread).
      const { handleMoonbitWorkerMessage } = await import('../src/worker/moonbit-worker');
      const workerState: {
        compiledModules: Map<string, WebAssembly.Module>;
        importedStringConstants?: string | null;
      } = { compiledModules: new Map() };

      class FakeWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        terminate() {}
        postMessage(msg: unknown) {
          queueMicrotask(() => {
            void handleMoonbitWorkerMessage(
              { data: msg as never },
              workerState,
              (resp) => {
                this.onmessage?.(new MessageEvent('message', { data: resp }));
              },
            );
          });
        }
      }
      const originalWorker = globalThis.Worker;
      (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;

      const moonbitManifest: ManifestResponse = {
        functions: {
          fibonacci: {
            runtime: 'moonbit',
            hash: hashBytes(fibonacciWasmBytes),
            version: 1,
            codeUrl: 'https://example.com/code/fibonacci.wasm',
            exportName: 'fibonacci',
          },
        },
      };
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        if (url.includes('/code/fibonacci.wasm')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            arrayBuffer: async () =>
              fibonacciWasmBytes.buffer.slice(
                fibonacciWasmBytes.byteOffset,
                fibonacciWasmBytes.byteOffset + fibonacciWasmBytes.byteLength,
              ) as ArrayBuffer,
          });
        }
        throw new Error('unexpected URL: ' + url);
      });
      globalThis.fetch = fetchMock;

      try {
        const client = new UnzenClient({
          endpoint,
          sandbox: new MockSandboxExecutor(),
          moonbitWorkerUrl: '/moonbit-worker.js',
          moonbitImportedStringConstants: 'unzen:strings',
        });
        const result = await client.executeWithDiagnostics<number>({
          name: 'fibonacci',
          args: [10],
        });

        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.result).toBe(55);
          expect(result.diagnostics.finalRoute).toBe('browser');
        }
        expect(workerState.importedStringConstants).toBe('unzen:strings');
        client.dispose();
      } finally {
        (globalThis as unknown as { Worker: unknown }).Worker = originalWorker;
      }
    });

    it('should not send noFallback inputs in development mode', async () => {
      const noFallbackManifest: ManifestResponse = {
        functions: {
          hashPassword: {
            runtime: 'quickjs',
            hash: hashText('function run() {}'),
            version: 1,
            codeUrl: 'https://example.com/code/hashPassword.js',
            noFallback: true,
          },
        },
      };
      const execBodies: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse(noFallbackManifest);
        if (url.includes('/exec/')) {
          execBodies.push(String(init?.body ?? ''));
          return jsonResponse({ result: 'server-hash' });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint,
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });
      const result = await client.executeWithDiagnostics({
        name: 'hashPassword',
        args: ['supersecret', 'salt', 100, 32],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('browser_runtime_failed');
      }
      // The password must never be POSTed, even in development mode.
      expect(execBodies).toHaveLength(0);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/exec/'))).toBe(false);
      client.dispose();
    });

    it('should not send moonbit inputs in development mode (noFallback omitted)', async () => {
      const moonbitManifest: ManifestResponse = {
        functions: {
          fib: {
            runtime: 'moonbit',
            hash: MOCK_CONTENT_HASH,
            version: 1,
            codeUrl: 'https://example.com/code/fib.wasm',
          },
        },
      };
      const execBodies: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse(moonbitManifest);
        if (url.includes('/exec/')) {
          execBodies.push(String(init?.body ?? ''));
          return jsonResponse({ result: 55 });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint,
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });
      const result = await client.executeWithDiagnostics({ name: 'fib', args: [10] });

      expect(result.success).toBe(false);
      expect(execBodies).toHaveLength(0);
      client.dispose();
    });

    it('still runs ordinary functions on the server in development mode', async () => {
      const fetchMock = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/exec/add')) {
          return jsonResponse({ result: 3 });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint,
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });
      const result = await client.executeWithDiagnostics<number>({ name: 'add', args: [1, 2] });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toBe(3);
        expect(result.diagnostics.finalRoute).toBe('server');
      }
      client.dispose();
    });

    it('does not send inputs to /exec when the development manifest fetch fails', async () => {
      const execBodies: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return Promise.reject(new Error('network down'));
        if (url.includes('/exec/')) {
          execBodies.push(String(init?.body ?? ''));
          return jsonResponse({ result: 'server-hash' });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint,
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });
      const result = await client.executeWithDiagnostics({
        name: 'hashPassword',
        args: ['secret-marker', 'salt', 100, 32],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('manifest_fetch_failed');
      }
      expect(execBodies).toHaveLength(0);
      client.dispose();
    });

    it('does not send inputs to /exec when the manifest lacks the entry in development mode', async () => {
      const execBodies: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse({ functions: {} });
        if (url.includes('/exec/')) {
          execBodies.push(String(init?.body ?? ''));
          return jsonResponse({ result: 'server-hash' });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({
        endpoint,
        mode: 'development',
        sandbox: new MockSandboxExecutor(),
      });
      const result = await client.executeWithDiagnostics({
        name: 'hashPassword',
        args: ['secret-marker', 'salt', 100, 32],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('function_failed');
      }
      expect(execBodies).toHaveLength(0);
      client.dispose();
    });

    it('should not send noFallback inputs (password) to the server on browser failure', async () => {
      const noFallbackManifest: ManifestResponse = {
        functions: {
          hashPassword: {
            runtime: 'quickjs',
            hash: hashText('function run() {}'),
            version: 1,
            codeUrl: 'https://example.com/code/hashPassword.js',
            noFallback: true,
          },
        },
      };
      const failingSandbox = new MockSandboxExecutor();
      failingSandbox.execute = async () => {
        throw new UnzenRuntimeError('browser sandbox crashed');
      };

      const bodyStrings: string[] = [];
      const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url.includes('/manifest')) return jsonResponse(noFallbackManifest);
        if (url.includes('/code/hashPassword')) return textResponse('function run() {}');
        if (url.includes('/exec/')) {
          bodyStrings.push(String(init?.body ?? ''));
          return jsonResponse({ result: 'server-hash' });
        }
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: failingSandbox });
      const result = await client.executeWithDiagnostics({
        name: 'hashPassword',
        args: ['supersecret', 'salt', 100, 32],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('browser_runtime_failed');
        expect(result.diagnostics.fallbackUsed).toBe(false);
      }
      // The password must never reach the server via a fallback POST.
      expect(bodyStrings).toHaveLength(0);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/exec/'))).toBe(false);
      client.dispose();
    });

    it('must not start fallback events when the caller cancels inside browser-execution-failed', async () => {
      // The onEvent listener aborts the run while the browser failure is being
      // reported. After cancel-requested, no new phase (fallback / server)
      // event may be emitted and no server fallback may start.
      const events: string[] = [];
      const failingSandbox = new MockSandboxExecutor();
      const controller = new AbortController();
      failingSandbox.execute = async (_code, _args, _options) => {
        throw new UnzenRuntimeError('browser down');
      };

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) return jsonResponse(mockManifest);
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        if (url.includes('/exec/add')) return jsonResponse({ result: 3 });
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: failingSandbox });
      const result = await client.executeWithDiagnostics({
        name: 'add',
        args: [1, 2],
        signal: controller.signal,
        onEvent: (e) => {
          events.push(e.type);
          if (e.type === 'browser-execution-failed') {
            controller.abort();
          }
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('cancelled');
        expect(result.diagnostics.fallbackUsed).toBe(false);
        expect(result.diagnostics.finalRoute).toBeUndefined();
        expect(result.diagnostics.attempts.some((a) => a.kind === 'server')).toBe(false);
      }

      // No phase event may follow cancel-requested; the terminal cancelled is last.
      const cancelIdx = events.indexOf('cancel-requested');
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      const afterCancel = events.slice(cancelIdx);
      expect(afterCancel).toEqual(['cancel-requested', 'cancelled']);
      expect(events[events.length - 1]).toBe('cancelled');

      // No server /exec request may have been made.
      const execCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/exec/'));
      expect(execCalls).toHaveLength(0);
      client.dispose();
    });

    it('should emit a terminal event when the client is disposed', async () => {
      const events: string[] = [];
      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });
      client.dispose();

      await client.executeWithDiagnostics({
        name: 'add',
        args: [],
        onEvent: (e) => events.push(e.type),
      });

      const terminals = events.filter((t) => ['completed', 'cancelled', 'failed'].includes(t));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toBe('failed');
    });

    it('should report executedOn=browser for legacy diagnostics on manifest failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });

      const result = await client.callWithDiagnostics('add', 1, 2);

      expect(result.success).toBe(false);
      expect(result.diagnostics.executedOn).toBe('browser');
      client.dispose();
    });

    it('should settle a cancelled caller that shares a deduplicated manifest fetch', async () => {
      // The shared manifest fetch is not bound to any single caller's signal:
      // cancelling one caller must settle only that caller, not the others.
      const fetchMock = vi.fn((url: string) => {
        if (url.includes('/manifest')) {
          return new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true, json: async () => mockManifest }), 40);
          });
        }
        if (url.includes('/code/add.js')) return textResponse(mockAddCode);
        throw new Error('unexpected URL');
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const client = new UnzenClient({ endpoint, sandbox: new MockSandboxExecutor() });

      const controllerA = new AbortController();
      const pA = client.execute<number>({ name: 'add', args: [1, 2], signal: controllerA.signal });
      await new Promise((r) => setTimeout(r, 5)); // A now owns the shared manifest fetch

      const controllerB = new AbortController();
      const pB = client.execute<number>({ name: 'add', args: [1, 2], signal: controllerB.signal });
      controllerB.abort();

      // B settles as cancelled immediately even though the shared fetch is in flight
      await expect(pB).rejects.toThrow(UnzenCancelledError);

      // A is unaffected by B's cancel and completes normally once the manifest arrives
      const resultA = await pA;
      expect(resultA).toBe(3);
      client.dispose();
    });
  });
});
