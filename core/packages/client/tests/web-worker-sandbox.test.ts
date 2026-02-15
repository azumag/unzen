/**
 * Tests for WebWorkerSandboxExecutor
 *
 * Tests the executor that communicates with a Web Worker running QuickJS Wasm.
 * Uses a mock Worker to test in Node.js environment (no real Web Worker available).
 *
 * Test strategy:
 * - Mock Worker simulates postMessage/onmessage protocol
 * - Contract tests (same as MockSandboxExecutor) ensure interface compliance
 * - Timeout behavior (cooperative + hard kill)
 * - Dispose and re-init behavior
 * - Error classification (function_error vs runtime_error)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UnzenFunctionError, UnzenRuntimeError } from '@unzen/shared';
import { WebWorkerSandboxExecutor } from '../src/web-worker-sandbox';
import type { WorkerMessage, WorkerResponse } from '../src/worker/worker-protocol';

/**
 * Mock Worker class that simulates the Web Worker postMessage API.
 * Allows tests to control worker responses without real Wasm.
 */
class MockWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private messageHandler: ((msg: WorkerMessage) => void) | null = null;

  /** Register a handler that will respond to postMessage calls */
  onPostMessage(handler: (msg: WorkerMessage) => void) {
    this.messageHandler = handler;
  }

  postMessage(msg: WorkerMessage) {
    // Simulate async message passing (like real Worker)
    if (this.messageHandler) {
      // Use queueMicrotask for async simulation
      queueMicrotask(() => this.messageHandler!(msg));
    }
  }

  terminate() {
    // No-op in mock
  }

  /** Simulate a response from the worker */
  respond(data: WorkerResponse) {
    if (this.onmessage) {
      this.onmessage(new MessageEvent('message', { data }));
    }
  }

  /** Simulate a fatal worker error (e.g., script load failure, OOM crash).
   * Uses a plain object because ErrorEvent is not available in Node.js. */
  simulateError(message = 'Worker crashed') {
    if (this.onerror) {
      this.onerror({ message, type: 'error' } as unknown as ErrorEvent);
    }
  }
}

/**
 * Create a MockWorker that auto-responds to init and execute messages.
 * Simulates a healthy QuickJS worker.
 */
function createAutoRespondingMockWorker() {
  const worker = new MockWorker();

  worker.onPostMessage((msg) => {
    if (msg.type === 'init') {
      worker.respond({ type: 'init-result', success: true });
    } else if (msg.type === 'execute') {
      // Default: evaluate code by executing a simple lookup
      // In tests, we override this via specific test setups
      worker.respond({
        type: 'execute-result',
        requestId: msg.requestId,
        success: true,
        value: '__mock_result__',
      });
    }
  });

  return worker;
}

/** Factory that returns a mock worker and tracks calls */
function createMockWorkerFactory(worker: MockWorker) {
  return (url: string | URL) => {
    return worker as unknown as Worker;
  };
}

describe('WebWorkerSandboxExecutor', () => {
  describe('construction', () => {
    it('should create instance with workerUrl', () => {
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(createAutoRespondingMockWorker()),
      });
      expect(executor).toBeDefined();
      executor.dispose();
    });

    it('should accept optional timeout', () => {
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 1000,
        createWorker: createMockWorkerFactory(createAutoRespondingMockWorker()),
      });
      expect(executor).toBeDefined();
      executor.dispose();
    });
  });

  describe('execute', () => {
    it('should initialize worker on first execute (lazy init)', async () => {
      const worker = createAutoRespondingMockWorker();
      const factory = vi.fn(createMockWorkerFactory(worker));

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });

      // Worker not created until first execute
      expect(factory).not.toHaveBeenCalled();

      await executor.execute('function run() { return 42; }', []);

      // Worker created on first execute
      expect(factory).toHaveBeenCalledTimes(1);
      executor.dispose();
    });

    it('should reuse worker across executions (not create new worker each time)', async () => {
      const worker = createAutoRespondingMockWorker();
      const factory = vi.fn(createMockWorkerFactory(worker));

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });

      await executor.execute('function run() { return 1; }', []);
      await executor.execute('function run() { return 2; }', []);

      // Same worker reused (Wasm init is expensive ~100ms)
      expect(factory).toHaveBeenCalledTimes(1);
      executor.dispose();
    });

    it('should return result from worker', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: 42,
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      const result = await executor.execute('function run() { return 42; }', []);
      expect(result).toBe(42);
      executor.dispose();
    });

    it('should return object results', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: { greeting: 'hello' },
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      const result = await executor.execute('function run() {}', []);
      expect(result).toEqual({ greeting: 'hello' });
      executor.dispose();
    });

    it('should throw UnzenFunctionError for function_error', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: false,
            errorType: 'function_error',
            error: 'run is not defined',
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('var x = 1;', []))
        .rejects.toThrow(UnzenFunctionError);
      await expect(executor.execute('var x = 1;', []))
        .rejects.toThrow('run is not defined');
      executor.dispose();
    });

    it('should throw UnzenRuntimeError for runtime_error', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: false,
            errorType: 'runtime_error',
            error: 'Execution timeout exceeded (50ms)',
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { while(true){} }', []))
        .rejects.toThrow(UnzenRuntimeError);
      executor.dispose();
    });

    it('should throw UnzenRuntimeError when worker init fails', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: false, error: 'Wasm load failed' });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow(UnzenRuntimeError);
      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow('Wasm load failed');
      executor.dispose();
    });
  });

  describe('concurrent execution', () => {
    it('should handle multiple concurrent execute calls correctly', async () => {
      let requestCounter = 0;
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          requestCounter++;
          // Each request returns its own requestCounter value
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: requestCounter,
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      // Fire 3 concurrent execute calls
      const [r1, r2, r3] = await Promise.all([
        executor.execute('function run() { return 1; }', []),
        executor.execute('function run() { return 2; }', []),
        executor.execute('function run() { return 3; }', []),
      ]);

      // All 3 should resolve with unique values (no lost requests)
      expect(new Set([r1, r2, r3]).size).toBe(3);
      executor.dispose();
    });
  });

  describe('dispose', () => {
    it('should be idempotent (safe to call multiple times)', () => {
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(createAutoRespondingMockWorker()),
      });

      expect(() => {
        executor.dispose();
        executor.dispose();
        executor.dispose();
      }).not.toThrow();
    });

    it('should reject when disposed during initialization', async () => {
      const worker = new MockWorker();
      // Init NEVER responds — simulates slow Wasm load
      worker.onPostMessage(() => {
        // Intentionally do nothing — init hangs
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      // Start execute (triggers init) but don't await
      const promise = executor.execute('function run() { return 1; }', []);

      // Dispose while init is in progress
      await new Promise(resolve => setTimeout(resolve, 10));
      executor.dispose();

      // Execute should reject with RuntimeError
      await expect(promise).rejects.toThrow(UnzenRuntimeError);
    });

    it('should reject pending executions on dispose', async () => {
      const worker = new MockWorker();
      // Init responds, but execute never responds (simulating hang)
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        }
        // execute messages are silently dropped — simulates worker hang
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000, // Long timeout so test doesn't timeout first
        createWorker: createMockWorkerFactory(worker),
      });

      // Start execution but don't await yet
      const promise = executor.execute('function run() { return 1; }', []);

      // Dispose while execution is pending
      // Use setTimeout to let the execute start first
      await new Promise(resolve => setTimeout(resolve, 10));
      executor.dispose();

      await expect(promise).rejects.toThrow(UnzenRuntimeError);
    });
  });

  describe('hard-kill timeout', () => {
    it('should reject with UnzenRuntimeError when worker never responds (H6)', async () => {
      const worker = new MockWorker();
      // Init responds normally, but execute messages are silently dropped
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        }
        // execute messages intentionally dropped — simulates stuck Wasm
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 50, // Short timeout so test runs quickly
        createWorker: createMockWorkerFactory(worker),
      });

      // Hard kill fires at 1.5x timeout = 75ms
      await expect(executor.execute('function run() { while(true){} }', []))
        .rejects.toThrow(UnzenRuntimeError);
      await expect(executor.execute('function run() { while(true){} }', []))
        .rejects.toThrow('hard timeout');
      executor.dispose();
    });

    it('should recover and create new worker after hard-kill (M15)', async () => {
      let workerCount = 0;

      // First worker: init responds, execute hangs (triggers hard kill)
      // Second worker: both init and execute respond normally
      const createWorker = () => {
        workerCount++;
        const w = new MockWorker();
        if (workerCount === 1) {
          // First worker: init OK, execute drops
          w.onPostMessage((msg) => {
            if (msg.type === 'init') {
              w.respond({ type: 'init-result', success: true });
            }
            // execute silently dropped
          });
        } else {
          // Second worker: fully functional
          w.onPostMessage((msg) => {
            if (msg.type === 'init') {
              w.respond({ type: 'init-result', success: true });
            } else if (msg.type === 'execute') {
              w.respond({
                type: 'execute-result',
                requestId: msg.requestId,
                success: true,
                value: 'recovered',
              });
            }
          });
        }
        return w as unknown as Worker;
      };

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 50,
        createWorker,
      });

      // First call: times out (hard kill)
      await expect(executor.execute('function run() {}', []))
        .rejects.toThrow(UnzenRuntimeError);
      expect(workerCount).toBe(1);

      // Second call: should create new worker and succeed
      const result = await executor.execute('function run() {}', []);
      expect(result).toBe('recovered');
      expect(workerCount).toBe(2);
      executor.dispose();
    });
  });

  describe('worker.onerror handling', () => {
    it('should reject init when worker fires onerror during initialization (H2)', async () => {
      const worker = new MockWorker();
      // Worker fires onerror instead of responding to init (e.g., script load failure)
      worker.onPostMessage(() => {
        // Simulate async error (like script parse failure)
        queueMicrotask(() => worker.simulateError('Script parse error'));
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow(UnzenRuntimeError);
      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow('Worker error during initialization');
      executor.dispose();
    });

    it('should reject pending executions when worker crashes during execution (H2)', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          // Worker crashes instead of responding
          queueMicrotask(() => worker.simulateError('Out of memory'));
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow(UnzenRuntimeError);
      executor.dispose();
    });
  });

  // === SandboxExecutor Contract Tests ===
  // These must match the contract in quickjs-sandbox.test.ts
  describe('SandboxExecutor contract', () => {
    function createContractExecutor(responses: Map<string, { success: boolean; value?: unknown; error?: string; errorType?: string }>) {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          const resp = responses.get(msg.code) ?? {
            success: true,
            value: undefined,
          };
          if (resp.success) {
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: true,
              value: resp.value,
            });
          } else {
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: false,
              errorType: (resp.errorType ?? 'function_error') as 'function_error' | 'runtime_error',
              error: resp.error,
            });
          }
        }
      });

      return new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });
    }

    it('contract: must throw UnzenFunctionError for missing run function', async () => {
      const responses = new Map([
        ['var x = 1;', { success: false, error: 'Code must define a function named "run"', errorType: 'function_error' }],
      ]);
      const executor = createContractExecutor(responses);
      await expect(executor.execute('var x = 1;', [])).rejects.toThrow(UnzenFunctionError);
      executor.dispose();
    });

    it('contract: must throw UnzenFunctionError for code throwing errors', async () => {
      const code = 'function run() { throw new Error("user error"); }';
      const responses = new Map([
        [code, { success: false, error: 'user error', errorType: 'function_error' }],
      ]);
      const executor = createContractExecutor(responses);
      await expect(executor.execute(code, [])).rejects.toThrow(UnzenFunctionError);
      executor.dispose();
    });

    it('contract: must pass arguments correctly to run function', async () => {
      const code = 'function run(a, b, c) { return [a, b, c]; }';
      const responses = new Map([
        [code, { success: true, value: [1, 'two', true] }],
      ]);
      const executor = createContractExecutor(responses);
      const result = await executor.execute(code, [1, 'two', true]);
      expect(result).toEqual([1, 'two', true]);
      executor.dispose();
    });

    it('contract: must support object arguments and return values', async () => {
      const code = 'function run(obj) { return { doubled: obj.value * 2 }; }';
      const responses = new Map([
        [code, { success: true, value: { doubled: 42 } }],
      ]);
      const executor = createContractExecutor(responses);
      const result = await executor.execute(code, [{ value: 21 }]);
      expect(result).toEqual({ doubled: 42 });
      executor.dispose();
    });

    it('contract: dispose must be idempotent (safe to call multiple times)', () => {
      const executor = createContractExecutor(new Map());
      expect(() => {
        executor.dispose();
        executor.dispose();
        executor.dispose();
      }).not.toThrow();
    });
  });
});
