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

import { describe, it, expect, vi } from 'vitest';
import {
  MAX_EXECUTION_ARGUMENTS,
  MAX_EXECUTION_REQUEST_BYTES,
  MAX_FUNCTION_PAYLOAD_BYTES,
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenRuntimeError,
} from '@unzen/shared';
import { WebWorkerSandboxExecutor } from '../src/web-worker-sandbox';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerMessage,
  type WorkerResponse,
} from '../src/worker/worker-protocol';

/**
 * Mock Worker class that simulates the Web Worker postMessage API.
 * Allows tests to control worker responses without real Wasm.
 */

/** A response fixture without the envelope — the mock adds version/generation. */
type RespondFixture =
  | { type: 'init-result'; success: boolean; error?: string }
  | {
      type: 'execute-result';
      requestId: string;
      success: boolean;
      value?: unknown;
      error?: string;
      errorType?: 'function_error' | 'runtime_error' | 'deadline_exceeded';
    }
  | { type: 'cancel-result'; requestId: string; success: boolean; error?: string };

class MockWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private messageHandler: ((msg: WorkerMessage) => void) | null = null;
  /** When set, postMessage throws synchronously for matching messages. */
  throwOnPostMessage: ((msg: WorkerMessage) => boolean) | null = null;
  /** Generation echoed in responses — recorded from the last incoming message */
  lastGenerationId = 1;

  /** Register a handler that will respond to postMessage calls */
  onPostMessage(handler: (msg: WorkerMessage) => void) {
    this.messageHandler = handler;
  }

  postMessage(msg: WorkerMessage) {
    if (this.throwOnPostMessage?.(msg)) {
      throw new Error('DataCloneError: value could not be cloned');
    }
    if (typeof msg.generationId === 'number') {
      this.lastGenerationId = msg.generationId;
    }
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
  respond(data: RespondFixture) {
    if (this.onmessage) {
      // Echo the protocol version/generation so responses are valid per the
      // wire contract. A stale-generation test overrides it after the fact.
      const full: WorkerResponse = {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: this.lastGenerationId,
        ...data,
      } as WorkerResponse;
      this.onmessage(new MessageEvent('message', { data: full }));
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
  return (_url: string | URL) => {
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

    it.each([
      ['empty workerUrl', { workerUrl: '   ' }, 'workerUrl'],
      ['zero timeout', { workerUrl: '/worker.js', timeout: 0 }, 'timeout'],
      ['non-finite timeout', { workerUrl: '/worker.js', timeout: Infinity }, 'timeout'],
      ['fractional init timeout', { workerUrl: '/worker.js', initTimeoutMs: 1.5 }, 'initTimeoutMs'],
      ['negative queue size', { workerUrl: '/worker.js', maxQueueSize: -1 }, 'maxQueueSize'],
      ['fractional queue size', { workerUrl: '/worker.js', maxQueueSize: 1.5 }, 'maxQueueSize'],
      ['zero cancel timeout', { workerUrl: '/worker.js', cancelAckTimeoutMs: 0 }, 'cancelAckTimeoutMs'],
      ['non-positive hard-kill multiplier', { workerUrl: '/worker.js', hardKillMultiplier: 0 }, 'hardKillMultiplier'],
      [
        'overflowing hard-kill delay',
        { workerUrl: '/worker.js', timeout: 2_147_483_647, hardKillMultiplier: 2 },
        'hard-kill delay',
      ],
      ['non-function worker factory', { workerUrl: '/worker.js', createWorker: 42 }, 'createWorker'],
    ])('rejects %s during construction', (_label, options, expected) => {
      expect(() => new WebWorkerSandboxExecutor(options as never)).toThrow(expected);
    });

    it('accepts a zero-length queue and a fractional hard-kill multiplier', () => {
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 10,
        maxQueueSize: 0,
        hardKillMultiplier: 0.5,
      });
      expect(executor).toBeDefined();
      executor.dispose();
    });
  });

  describe('execute', () => {
    it('should reject invalid calls before creating a worker', async () => {
      const factory = vi.fn();
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);
      const validCode = 'function run() { return 1; }';
      const invalidCalls: Array<{ code: unknown; args: unknown }> = [
        { code: '   ', args: [] },
        { code: validCode, args: {} },
        { code: validCode, args: new Array(MAX_EXECUTION_ARGUMENTS + 1) },
        { code: validCode, args: cyclic },
        { code: validCode, args: [1n] },
      ];

      for (const { code, args } of invalidCalls) {
        await expect(executor.execute(code as string, args as unknown[]))
          .rejects.toThrow(UnzenFunctionError);
      }

      expect(factory).not.toHaveBeenCalled();
      executor.dispose();
    });

    it('rejects oversized code and arguments before creating a worker', async () => {
      const factory = vi.fn();
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });

      await expect(executor.execute(
        'x'.repeat(MAX_FUNCTION_PAYLOAD_BYTES + 1),
        [],
      )).rejects.toThrow(`code exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
      await expect(executor.execute(
        'function run() { return 1; }',
        ['x'.repeat(MAX_EXECUTION_REQUEST_BYTES)],
      )).rejects.toThrow(`arguments exceed ${MAX_EXECUTION_REQUEST_BYTES} bytes`);

      expect(factory).not.toHaveBeenCalled();
      executor.dispose();
    });

    it('rejects invalid execution options before reading args or reserving the worker', async () => {
      const factory = vi.fn();
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });
      let lengthReads = 0;
      const args = new Proxy([], {
        get(target, property, receiver) {
          if (property === 'length') lengthReads += 1;
          return Reflect.get(target, property, receiver);
        },
      });

      await expect(executor.execute(
        'function run() { return 1; }',
        args,
        { signal: { aborted: false } } as never,
      )).rejects.toThrow(UnzenFunctionError);
      expect(lengthReads).toBe(0);
      expect(factory).not.toHaveBeenCalled();

      // Invalid input must not leave a phantom running request behind.
      expect((executor as unknown as { runningRequest: unknown }).runningRequest).toBeNull();
      executor.dispose();
    });

    it('should snapshot JSON arguments before asynchronous worker initialization', async () => {
      const worker = new MockWorker();
      let postedArgs: unknown[] | undefined;
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          postedArgs = msg.args;
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: 'ok',
          });
        }
      });
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });
      const args = [{ value: 1 }];
      Object.defineProperty(args, Symbol.iterator, {
        value: () => {
          throw new Error('argument iterator must not run at the executor boundary');
        },
      });

      const execution = executor.execute('function run(value) { return value; }', args);
      args[0].value = 999;
      args.push({ value: 2 });

      await expect(execution).resolves.toBe('ok');
      expect(postedArgs).toEqual([{ value: 1 }]);
      expect(postedArgs).not.toBe(args);
      executor.dispose();
    });

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

    it('preserves a successful null result from the worker', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: null,
          });
        }
      });
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { return null; }', []))
        .resolves.toBeNull();
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

    it('should throw UnzenDeadlineExceededError for a worker-reported deadline_exceeded', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: false,
            errorType: 'deadline_exceeded',
            error: 'Execution timeout exceeded (50ms)',
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { while(true){} }', []))
        .rejects.toThrow(UnzenDeadlineExceededError);
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

  // === issue #106 lifecycle (init / queue / timeout / cancel / generation) ===
  describe('init timeout', () => {
    it('should settle init waiters when init-result never arrives', async () => {
      const worker = new MockWorker();
      // Never respond to init — simulates a hung Wasm load
      worker.onPostMessage(() => {
        // Intentionally drop all messages
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        initTimeoutMs: 30,
        createWorker: createMockWorkerFactory(worker),
      });

      const p = executor.execute('function run() { return 1; }', []);
      await expect(p).rejects.toThrow(UnzenRuntimeError);
      await expect(p).rejects.toThrow('initialization timed out');
      expect(executor.diagnostics.initTimeoutCount).toBe(1);

      // Executor must be able to start a fresh generation afterwards.
      executor.dispose();
    });
  });

  describe('single-flight concurrency and queueing', () => {
    it('should run at most one request per generation (single-flight)', async () => {
      const worker = new MockWorker();
      let inFlight = 0;
      let maxInFlight = 0;
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          // Simulate async execution, then respond
          queueMicrotask(() => {
            inFlight--;
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: true,
              value: msg.requestId,
            });
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      const results = await Promise.all([
        executor.execute('a', []),
        executor.execute('b', []),
        executor.execute('c', []),
      ]);

      expect(new Set(results).size).toBe(3);
      expect(maxInFlight).toBe(1); // never more than one running at a time
      executor.dispose();
    });

    it('should reject when the bounded queue overflows', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        }
        // execute messages intentionally dropped → first request keeps running
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        maxQueueSize: 2,
        createWorker: createMockWorkerFactory(worker),
      });

      const running = executor.execute('hang', []);
      await new Promise((r) => setTimeout(r, 10));
      const queued1 = executor.execute('q1', []);
      const queued2 = executor.execute('q2', []);
      const overflow = executor.execute('q3', []);

      await expect(overflow).rejects.toThrow('queue is full');
      expect(executor.diagnostics.queueOverflowCount).toBe(1);

      executor.dispose();
      await expect(running).rejects.toThrow(UnzenRuntimeError);
      await expect(queued1).rejects.toThrow(UnzenRuntimeError);
      await expect(queued2).rejects.toThrow(UnzenRuntimeError);
    });

    it('should not count queue wait time against the execution timeout', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          if (msg.code === 'hang') {
            // First request hangs → hard timeout after 1.5 * timeout
          } else {
            // Second request completes immediately once it starts
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: true,
              value: 'ok',
            });
          }
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 40,
        createWorker: createMockWorkerFactory(worker),
      });

      const hanging = executor.execute('hang', []);
      // Queued while the first request runs (and hard-times-out)
      const queued = executor.execute('quick', []);

      await expect(hanging).rejects.toThrow(UnzenRuntimeError);

      // The queued request waited longer than `timeout` before starting, but
      // its own execution timer begins at execution start, so it must succeed.
      const result = await queued;
      expect(result).toBe('ok');
      executor.dispose();
    });
  });

  describe('cancellation via AbortSignal', () => {
    it('rejects an unsolicited cancel acknowledgement as a protocol violation', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'cancel-result',
            requestId: msg.requestId,
            success: true,
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow('Unexpected cancel acknowledgement');
      expect(executor.diagnostics.cancelCount).toBe(0);
      expect(executor.diagnostics.forcedTerminationCount).toBe(1);
      expect(executor.diagnostics.cancelLatencyMs).toBeNull();
      executor.dispose();
    });

    it('should cancel a queued request without touching the running request', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        }
        // execute messages dropped → first keeps running
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      const running = executor.execute('hang', []);
      await new Promise((r) => setTimeout(r, 10));

      const controller = new AbortController();
      const queued = executor.execute('queued', [], { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));

      controller.abort();

      // Cancellation must surface as UnzenCancelledError (NOT a runtime error,
      // so it never triggers server fallback).
      await expect(queued).rejects.toThrow(UnzenCancelledError);
      expect(executor.diagnostics.cancelCount).toBe(1);

      executor.dispose();
      await expect(running).rejects.toThrow(UnzenRuntimeError);
    });

    it('should cancel a running request via cooperative worker cancel', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'cancel') {
          worker.respond({ type: 'cancel-result', requestId: msg.requestId, success: true });
        }
        // execute messages dropped → request stays running until cancelled
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        cancelAckTimeoutMs: 1000,
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const p = executor.execute('hang', [], { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));

      controller.abort();

      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(executor.diagnostics.cancelCount).toBe(1);
      expect(executor.diagnostics.cancelLatencyMs).not.toBeNull();
      executor.dispose();
    });

    it('should force-terminate the generation when the worker never acks cancel', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        }
        // execute AND cancel messages both dropped → unresponsive worker
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        cancelAckTimeoutMs: 30,
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const p = executor.execute('hang', [], { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));

      controller.abort();

      // Cancellation intent must surface as UnzenCancelledError even when the
      // worker never acknowledges — it must NOT become a server-fallback runtime error.
      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(executor.diagnostics.cancelAckTimeoutCount).toBe(1);
      executor.dispose();
    });

    it('should settle once and count once when the worker returns a negative cancel ack', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'cancel') {
          // The worker cannot cancel (e.g. unknown request) — negative ack.
          worker.respond({
            type: 'cancel-result',
            requestId: msg.requestId,
            success: false,
            error: 'unknown request',
          });
        }
        // execute messages dropped → request stays running until the cancel
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        cancelAckTimeoutMs: 30,
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const p = executor.execute('hang', [], { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      await expect(p).rejects.toThrow(UnzenCancelledError);
      // The negative ack settles the request immediately; the ack timer must
      // not fire later and count the same cancel a second time.
      expect(executor.diagnostics.cancelAckTimeoutCount).toBe(1);
      expect(executor.diagnostics.cancelCount).toBe(1);
      executor.dispose();
    });

    it('should reject immediately when signal is already aborted', async () => {
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(createAutoRespondingMockWorker()),
      });

      const controller = new AbortController();
      controller.abort();
      const factory = vi.fn();
      const countingExecutor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });

      await expect(
        executor.execute('function run() { return 1; }', [], { signal: controller.signal }),
      ).rejects.toThrow(UnzenCancelledError);
      // A pre-aborted request counts as one cancellation and never touches the
      // worker factory.
      await expect(
        countingExecutor.execute('function run() { return 1; }', [], { signal: controller.signal }),
      ).rejects.toThrow(UnzenCancelledError);
      expect(countingExecutor.diagnostics.cancelCount).toBe(1);
      expect(factory).not.toHaveBeenCalled();
      executor.dispose();
      countingExecutor.dispose();
    });

    it('recovers when abort listener registration throws', async () => {
      const worker = createAutoRespondingMockWorker();
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });
      const signal = {
        aborted: false,
        addEventListener() {
          throw new Error('registration failed');
        },
        removeEventListener() {},
      } as unknown as AbortSignal;

      await expect(
        executor.execute('function run() { return 1; }', [], { signal }),
      ).rejects.toThrow(UnzenFunctionError);
      await expect(
        executor.execute('function run() { return 2; }', []),
      ).resolves.toBe('__mock_result__');
      executor.dispose();
    });

    it('cancels before worker creation when abort races listener registration', async () => {
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener() {
          aborted = true;
        },
        removeEventListener() {},
      } as unknown as AbortSignal;
      const factory = vi.fn();
      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: factory,
      });

      await expect(
        executor.execute('function run() { return 1; }', [], { signal }),
      ).rejects.toThrow(UnzenCancelledError);
      expect(executor.diagnostics.cancelCount).toBe(1);
      expect(factory).not.toHaveBeenCalled();
      executor.dispose();
    });

    it('must not commit a successful execute-result that races an abort (cancel wins)', async () => {
      // A real worker runs QuickJS synchronously, so a CancelMessage cannot be
      // processed mid-loop: an execute-result (success) can arrive AFTER the
      // caller aborted but BEFORE the cancel-result. The success must NOT be
      // committed — the request settles as cancelled (never server fallback).
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          // The worker finishes the run AFTER the caller aborts and reports
          // success without having processed the cancel message yet.
          setTimeout(() => {
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: true,
              value: 42,
            });
          }, 30);
        } else if (msg.type === 'cancel') {
          // The cancel ack arrives AFTER the finished execute-result, exactly
          // like a real worker whose event loop was blocked during the run.
          setTimeout(() => {
            worker.respond({ type: 'cancel-result', requestId: msg.requestId, success: true });
          }, 60);
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        cancelAckTimeoutMs: 1000,
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const p = executor.execute('function run() { return 42; }', [], { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));

      controller.abort();

      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(executor.diagnostics.cancelCount).toBe(1);
      executor.dispose();
    });

    it('must not surface a racing execute-result error as a runtime failure after abort', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          setTimeout(() => {
            worker.respond({
              type: 'execute-result',
              requestId: msg.requestId,
              success: false,
              errorType: 'runtime_error',
              error: 'Execution timeout exceeded',
            });
          }, 30);
        } else if (msg.type === 'cancel') {
          setTimeout(() => {
            worker.respond({ type: 'cancel-result', requestId: msg.requestId, success: true });
          }, 60);
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        cancelAckTimeoutMs: 1000,
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const p = executor.execute('hang', [], { signal: controller.signal });
      await new Promise((r) => setTimeout(r, 10));

      controller.abort();

      await expect(p).rejects.toThrow(UnzenCancelledError);
      executor.dispose();
    });
  });

  describe('init-waiting requests (bounded backpressure + prompt cancel)', () => {
    it('should apply the queue bound to requests that arrive while init is in progress', async () => {
      const worker = new MockWorker();
      // Init never resolves — simulates a hung Wasm load. All requests wait.
      worker.onPostMessage(() => {
        // Intentionally drop everything.
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        initTimeoutMs: 5000,
        maxQueueSize: 2,
        createWorker: createMockWorkerFactory(worker),
      });

      const owner = executor.execute('owner', []);
      // The owner occupies the single-flight slot; two more fit in the queue.
      const q1 = executor.execute('q1', []);
      const q2 = executor.execute('q2', []);
      const overflow = executor.execute('q3', []);

      await expect(overflow).rejects.toThrow('queue is full');
      expect(executor.diagnostics.queueOverflowCount).toBe(1);

      executor.dispose();
      await expect(owner).rejects.toThrow(UnzenRuntimeError);
      await expect(q1).rejects.toThrow(UnzenRuntimeError);
      await expect(q2).rejects.toThrow(UnzenRuntimeError);
    });

    it('should settle promptly when a request is aborted during init (no init-timeout wait)', async () => {
      const worker = new MockWorker();
      worker.onPostMessage(() => {
        // Intentionally drop everything — init hangs.
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        initTimeoutMs: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const p = executor.execute('function run() { return 1; }', [], { signal: controller.signal });

      controller.abort();

      // Must reject immediately — NOT after initTimeoutMs (5000ms).
      const started = Date.now();
      await expect(p).rejects.toThrow(UnzenCancelledError);
      expect(Date.now() - started).toBeLessThan(500);
      expect(executor.diagnostics.cancelCount).toBe(1);

      executor.dispose();
    });

    it('should start queued requests on the same init once the init-owner aborts during init', async () => {
      let initResponded = false;
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init' && !initResponded) {
          initResponded = true;
          // Delay init so the owner can abort before it completes.
          setTimeout(() => worker.respond({ type: 'init-result', success: true }), 20);
        } else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: 'ran-' + msg.requestId,
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      const controller = new AbortController();
      const owner = executor.execute('owner', [], { signal: controller.signal });
      const queued = executor.execute('queued', []);

      controller.abort();
      await expect(owner).rejects.toThrow(UnzenCancelledError);

      // The queued request must still run on the completed init.
      await expect(queued).resolves.toMatch(/^ran-req-\d+$/);
      executor.dispose();
    });
  });

  describe('synchronous postMessage failures (DataCloneError etc.)', () => {
    it('should settle an execute immediately when postMessage throws, then continue the queue', async () => {
      const worker = new MockWorker();
      worker.throwOnPostMessage = (msg) => msg.type === 'execute';
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') worker.respond({ type: 'init-result', success: true });
        else if (msg.type === 'execute') {
          worker.respond({
            type: 'execute-result',
            requestId: msg.requestId,
            success: true,
            value: 7,
          });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      // The clone failure must not leave the request waiting on its hard-kill
      // timer; it settles as a runtime error (fallback-eligible).
      await expect(
        executor.execute('function run() {}', [() => 1]),
      ).rejects.toThrow('Failed to send execute message');

      // The executor is still usable (the failure was not generation-fatal).
      worker.throwOnPostMessage = null;
      const result = await executor.execute('function run() { return 7; }', []);
      expect(result).toBe(7);
      executor.dispose();
    });

    it('should fail init immediately when the init postMessage throws', async () => {
      const worker = new MockWorker();
      worker.throwOnPostMessage = (msg) => msg.type === 'init';

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        initTimeoutMs: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      const started = Date.now();
      await expect(executor.execute('function run() { return 1; }', []))
        .rejects.toThrow('Failed to send init message');
      // Settled immediately — not after the 5s init timeout.
      expect(Date.now() - started).toBeLessThan(500);
      executor.dispose();
    });
  });

  describe('synchronous Worker creation failures', () => {
    it('should settle the init owner and queued requests, then recover on a later attempt', async () => {
      let factoryCalls = 0;
      let healthyWorker: MockWorker | null = null;
      const createWorker = () => {
        factoryCalls++;
        if (factoryCalls === 1) {
          // First attempt: the Worker constructor itself throws (SecurityError
          // / invalid URL / injected test factory).
          throw new Error('SecurityError: Failed to construct Worker');
        }
        healthyWorker = createAutoRespondingMockWorker();
        return healthyWorker as unknown as Worker;
      };

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        initTimeoutMs: 5000,
        createWorker,
      });

      const started = Date.now();
      const owner = executor.execute('function run() { return 1; }', []);
      const queued = executor.execute('function run() { return 2; }', []);

      // Both settle immediately (NOT after the 5s init timeout) with a runtime
      // error that is fallback-eligible.
      await expect(owner).rejects.toThrow('Failed to create Worker');
      await expect(queued).rejects.toThrow('Failed to create Worker');
      expect(Date.now() - started).toBeLessThan(500);

      // The factory recovers: a fresh execution re-initializes and succeeds.
      const result = await executor.execute('function run() { return 3; }', []);
      expect(result).toBe('__mock_result__');
      expect(factoryCalls).toBe(2);
      executor.dispose();
    });
  });

  describe('generation lifecycle', () => {
    it('should ignore stale responses from an old generation after recreate', async () => {
      let workerCount = 0;
      const workers: MockWorker[] = [];
      const createWorker = () => {
        workerCount++;
        const w = new MockWorker();
        workers.push(w);
        if (workerCount === 1) {
          // First worker: init OK, execute hangs → hard timeout kills generation
          w.onPostMessage((msg) => {
            if (msg.type === 'init') w.respond({ type: 'init-result', success: true });
          });
        } else {
          // Second worker: fully functional
          w.onPostMessage((msg) => {
            if (msg.type === 'init') w.respond({ type: 'init-result', success: true });
            else if (msg.type === 'execute') {
              w.respond({
                type: 'execute-result',
                requestId: msg.requestId,
                success: true,
                value: 'new-gen',
              });
            }
          });
        }
        return w as unknown as Worker;
      };

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 40,
        createWorker,
      });

      // First request hard-times-out → generation 1 is torn down
      await expect(executor.execute('hang', [])).rejects.toThrow(UnzenRuntimeError);
      expect(workerCount).toBe(1);

      // Second request recreates the worker on generation 2
      const result = await executor.execute('ok', []);
      expect(result).toBe('new-gen');
      expect(workerCount).toBe(2);
      // The generation restart is counted even though nothing was queued when
      // generation 1 failed (issue #106 regression: restart counter).
      expect(executor.diagnostics.generationRestartCount).toBe(1);

      // Feed a stale response tagged with the OLD generation through the live
      // worker's handler — it must be rejected and counted, not acted upon.
      const before = executor.diagnostics.lateResponseCount;
      const stale = {
        type: 'execute-result',
        requestId: 'stale-req',
        success: true,
        value: 'stale',
      } as const;
      workers[1].lastGenerationId = 1;
      workers[1].respond(stale);
      expect(executor.diagnostics.lateResponseCount).toBe(before + 1);

      // Executor must remain functional.
      const r2 = await executor.execute('ok2', []);
      expect(r2).toBe('new-gen');
      executor.dispose();
    });

    it('should ignore duplicate completions for an already-settled request', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          const rid = msg.requestId;
          worker.respond({ type: 'execute-result', requestId: rid, success: true, value: 'first' });
          // Duplicate completion for the same requestId
          worker.respond({ type: 'execute-result', requestId: rid, success: true, value: 'dup' });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        createWorker: createMockWorkerFactory(worker),
      });

      const result = await executor.execute('code', []);
      expect(result).toBe('first');
      expect(executor.diagnostics.duplicateCompletionCount).toBe(1);
      executor.dispose();
    });

    it('should treat a malformed worker response as generation-fatal', async () => {
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          worker.respond({ type: 'unknown-type' } as unknown as WorkerResponse);
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      await expect(executor.execute('code', [])).rejects.toThrow('Malformed worker response');
      expect(executor.diagnostics.malformedResponseCount).toBe(1);
      executor.dispose();
    });

    it('should settle all affected requests on dispose (running + queued + init)', async () => {
      const workers: MockWorker[] = [];
      const createWorker = () => {
        const w = new MockWorker();
        workers.push(w);
        // First generation: init OK, execute hangs
        w.onPostMessage((msg) => {
          if (msg.type === 'init') w.respond({ type: 'init-result', success: true });
        });
        return w as unknown as Worker;
      };

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker,
      });

      const running = executor.execute('hang', []);
      await new Promise((r) => setTimeout(r, 10));
      const queued = executor.execute('q', []);
      const queued2 = executor.execute('q2', []);

      executor.dispose();

      await expect(running).rejects.toThrow(UnzenRuntimeError);
      await expect(queued).rejects.toThrow(UnzenRuntimeError);
      await expect(queued2).rejects.toThrow(UnzenRuntimeError);
      expect(executor.diagnostics.forcedTerminationCount).toBe(0);
    });
  });

  // === issue #106 regression fixes (found by strict review) ===
  describe('regression fixes', () => {
    it('should not leak a queued request when re-init fails after a generation failure', async () => {
      let workerCount = 0;
      const createWorker = () => {
        workerCount++;
        const w = new MockWorker();
        if (workerCount === 1) {
          // Generation 1: init OK, execute hangs → hard timeout kills it
          w.onPostMessage((msg) => {
            if (msg.type === 'init') w.respond({ type: 'init-result', success: true });
          });
        } else {
          // Generation 2: init FAILS → drainQueue must reject the shifted `next`
          w.onPostMessage((msg) => {
            if (msg.type === 'init') {
              w.respond({ type: 'init-result', success: false, error: 're-init failed' });
            }
          });
        }
        return w as unknown as Worker;
      };

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 30,
        createWorker,
      });

      const first = executor.execute('hang', []);
      const queued = executor.execute('queued', []);

      await expect(first).rejects.toThrow(UnzenRuntimeError);

      // The queued request was shifted out of the queue before re-init failed;
      // it must be rejected too, never left pending.
      await expect(queued).rejects.toThrow(UnzenRuntimeError);
      expect(workerCount).toBe(2);
      executor.dispose();
    });

    it('should not resurrect a disposed executor after dispose during init', async () => {
      const worker = new MockWorker();
      // Init never responds
      worker.onPostMessage(() => {
        // Intentionally drop all messages
      });
      const createWorker = vi.fn(() => worker as unknown as Worker);

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        initTimeoutMs: 1000,
        createWorker,
      });

      const p = executor.execute('code', []);
      await new Promise((r) => setTimeout(r, 10));
      executor.dispose();
      await expect(p).rejects.toThrow(UnzenRuntimeError);

      // Executing after dispose must throw, NOT spawn a brand-new worker.
      await expect(executor.execute('code2', [])).rejects.toThrow('disposed');
      expect(createWorker).toHaveBeenCalledTimes(1);
    });

    it('should post exactly one cancel message when aborting a queued->running request', async () => {
      let cancelCount = 0;
      const worker = new MockWorker();
      worker.onPostMessage((msg) => {
        if (msg.type === 'init') {
          worker.respond({ type: 'init-result', success: true });
        } else if (msg.type === 'execute') {
          if (msg.code === 'first') {
            // First request completes quickly so the second can start
            queueMicrotask(() => {
              worker.respond({
                type: 'execute-result',
                requestId: msg.requestId,
                success: true,
                value: 'first',
              });
            });
          }
          // second request stays running until cancelled
        } else if (msg.type === 'cancel') {
          cancelCount++;
          worker.respond({ type: 'cancel-result', requestId: msg.requestId, success: true });
        }
      });

      const executor = new WebWorkerSandboxExecutor({
        workerUrl: '/worker.js',
        timeout: 5000,
        createWorker: createMockWorkerFactory(worker),
      });

      const first = executor.execute('first', []);
      const controller = new AbortController();
      const second = executor.execute('second', [], { signal: controller.signal });

      // Wait until the second request is running (queued->running transition).
      await new Promise((r) => setTimeout(r, 20));
      controller.abort();

      await expect(second).rejects.toThrow(UnzenCancelledError);
      expect(cancelCount).toBe(1); // double abort listener would post 2
      await expect(first).resolves.toBe('first');
      executor.dispose();
    });
  });
});
