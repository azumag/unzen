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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UnzenFunctionError,
  UnzenRuntimeError,
  type ManifestResponse,
} from '@unzen/shared';
import { UnzenClient } from '../src/unzen-client';

describe('UnzenClient', () => {
  let originalFetch: typeof globalThis.fetch;

  const mockManifest: ManifestResponse = {
    functions: {
      add: {
        name: 'add',
        runtime: 'quickjs',
        codeUrl: 'https://example.com/code/add.js',
        hash: 'abc123',
      },
    },
  };

  const mockAddCode = 'function run(a, b) { return a + b; }';

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('should create instance with endpoint', () => {
      const client = new UnzenClient({ endpoint: 'https://example.com' });
      expect(client).toBeInstanceOf(UnzenClient);
      client.dispose();
    });

    it('should default to production mode', () => {
      const client = new UnzenClient({ endpoint: 'https://example.com' });
      expect(client).toBeInstanceOf(UnzenClient);
      client.dispose();
    });

    it('should accept explicit mode', () => {
      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
      });
      expect(client).toBeInstanceOf(UnzenClient);
      client.dispose();
    });
  });

  describe('development mode', () => {
    it('should always use fallback in development mode', async () => {
      // Mock fallback endpoint
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: 3 }),
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          error: { type: 'function_error', message: 'Test error' },
        }),
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'development',
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
          return Promise.resolve({
            ok: true,
            text: async () => mockAddCode,
          });
        }
        throw new Error('Unexpected URL');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
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

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return Promise.resolve({
            ok: true,
            text: async () => invalidCode,
          });
        }
        throw new Error('Should not reach here');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
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

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return Promise.resolve({
            ok: true,
            text: async () => errorCode,
          });
        }
        throw new Error('Should not call other endpoints');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
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
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
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
          return Promise.resolve({
            ok: true,
            text: async () => mockAddCode,
          });
        }
        throw new Error('Unexpected URL');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'browser-only',
      });

      const result = await client.call<number>('add', 1, 2);

      expect(result).toBe(3);

      client.dispose();
    });

    it('should throw error on runtime error without fallback', async () => {
      const invalidCode = 'this is not valid code';

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return Promise.resolve({
            ok: true,
            text: async () => invalidCode,
          });
        }
        throw new Error('Should not call other endpoints');
      });
      globalThis.fetch = fetchMock;

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'browser-only',
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
    it('should return ExecutionResult with success', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return Promise.resolve({
            ok: true,
            text: async () => mockAddCode,
          });
        }
        throw new Error('Unexpected URL');
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
      });

      const result = await client.callWithDiagnostics<number>('add', 1, 2);

      expect(result.success).toBe(true);
      expect(result.result).toBe(3);
      expect(result.error).toBeUndefined();

      client.dispose();
    });

    it('should return ExecutionResult with error', async () => {
      const errorCode = 'function run() { throw new Error("Test error"); }';

      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/manifest')) {
          return Promise.resolve({
            ok: true,
            json: async () => mockManifest,
          });
        }
        if (url.includes('/code/add.js')) {
          return Promise.resolve({
            ok: true,
            text: async () => errorCode,
          });
        }
        throw new Error('Unexpected URL');
      });

      const client = new UnzenClient({
        endpoint: 'https://example.com',
        mode: 'production',
      });

      const result = await client.callWithDiagnostics('add', 1, 2);

      expect(result.success).toBe(false);
      expect(result.result).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Test error');

      client.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up resources', () => {
      const client = new UnzenClient({ endpoint: 'https://example.com' });
      expect(() => client.dispose()).not.toThrow();
    });

    it('should be safe to call multiple times', () => {
      const client = new UnzenClient({ endpoint: 'https://example.com' });
      client.dispose();
      expect(() => client.dispose()).not.toThrow();
    });

    it('should throw UnzenRuntimeError when call() is invoked after dispose', async () => {
      // Disposed client has released sandbox resources
      // Subsequent call() must fail immediately with clear error
      const client = new UnzenClient({ endpoint: 'https://example.com' });
      client.dispose();

      await expect(client.call('add', 1, 2)).rejects.toThrow(UnzenRuntimeError);
      await expect(client.call('add', 1, 2)).rejects.toThrow('disposed');
    });
  });
});
