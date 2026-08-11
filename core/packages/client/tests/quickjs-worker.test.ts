/**
 * Tests for QuickJS Worker Handler Logic
 *
 * Tests the worker's message handling logic directly, without creating
 * an actual Worker or loading Wasm. This validates the control flow:
 * - Init message → loads QuickJS Wasm, responds with init-result
 * - Execute message → creates context, runs code, responds with result
 * - Error handling → function errors vs runtime errors
 *
 * The actual QuickJS Wasm execution is tested indirectly via the server's
 * quickjs-runtime.test.ts (same QuickJS engine, same security code).
 * Here we focus on the worker message routing and error classification.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createInitMessage,
  createExecuteMessage,
  createCancelMessage,
  type WorkerResponse,
} from '../src/worker/worker-protocol';
import { handleWorkerMessage, type WorkerState } from '../src/worker/quickjs-worker';

/**
 * Create a mock QuickJS context that simulates evalCode behavior.
 * This allows testing worker logic without loading the actual Wasm module.
 */
function createMockContext(evalResults: Array<{ error?: unknown; value?: unknown }>) {
  let callIndex = 0;
  return {
    evalCode: vi.fn((_code: string) => {
      const result = evalResults[callIndex++];
      if (result?.error !== undefined) {
        return {
          error: {
            consume: vi.fn((fn: (h: unknown) => unknown) => fn(result.error)),
          },
        };
      }
      return {
        value: {
          consume: vi.fn((fn: (h: unknown) => unknown) => fn(result.value)),
        },
      };
    }),
    runtime: {
      setMemoryLimit: vi.fn(),
      setInterruptHandler: vi.fn(),
    },
    dump: vi.fn((handle: unknown) => handle),
    dispose: vi.fn(),
  };
}

/**
 * Create a mock QuickJS Wasm module (simulates newQuickJSWASMModuleFromVariant result)
 */
function createMockQuickJS(context?: ReturnType<typeof createMockContext>) {
  return {
    newContext: vi.fn(() => context ?? createMockContext([])),
  };
}

describe('quickjs-worker handleWorkerMessage', () => {
  let responses: WorkerResponse[];
  let postMessage: (msg: WorkerResponse) => void;

  beforeEach(() => {
    responses = [];
    postMessage = (msg: WorkerResponse) => responses.push(msg);
  });

  describe('init message', () => {
    it('should respond with success when QuickJS loads', async () => {
      const state: WorkerState = { quickJS: null };
      const mockLoader = vi.fn().mockResolvedValue(createMockQuickJS());

      await handleWorkerMessage(
        { data: createInitMessage(1) },
        state,
        postMessage,
        mockLoader,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]).toEqual({
        type: 'init-result',
        protocolVersion: 1,
        generationId: 1,
        success: true,
        error: undefined,
      });
      expect(state.quickJS).not.toBeNull();
    });

    it('should respond with error when QuickJS fails to load', async () => {
      const state: WorkerState = { quickJS: null };
      const mockLoader = vi.fn().mockRejectedValue(new Error('Wasm init failed'));

      await handleWorkerMessage(
        { data: createInitMessage(1) },
        state,
        postMessage,
        mockLoader,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].type).toBe('init-result');
      expect((responses[0] as { success: boolean }).success).toBe(false);
      expect((responses[0] as { error: string }).error).toBe('Wasm init failed');
    });
  });

  describe('execute message', () => {
    it('should execute code successfully and return result', async () => {
      // Mock context: security init succeeds, user code succeeds, run() returns 42
      const context = createMockContext([
        { value: undefined }, // security init
        { value: undefined }, // user code load
        { value: undefined }, // args injection
        { value: 42 },       // run() execution
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-1', 'function run(){return 42;}', [], 1) },
        state,
        postMessage,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'execute-result',
        requestId: 'req-1',
        success: true,
        value: 42,
      });
      expect(context.evalCode.mock.calls[3][0]).toContain('return synchronously');
      expect(context.evalCode.mock.calls[3][0]).toContain('materialized value');
      // Context should be disposed after execution
      expect(context.dispose).toHaveBeenCalled();
    });

    it('should return function_error when user code fails', async () => {
      // Mock context: security init + user code load succeed, run() throws
      const context = createMockContext([
        { value: undefined }, // security init
        { value: undefined }, // user code load
        { value: undefined }, // args injection
        { error: 'ReferenceError: x is not defined' }, // run() fails
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-2', 'function run(){return x;}', [], 1) },
        state,
        postMessage,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'execute-result',
        requestId: 'req-2',
        success: false,
        errorType: 'function_error',
      });
    });

    it('should return function_error when code syntax is invalid', async () => {
      // Mock: security init succeeds, user code load fails (syntax error)
      const context = createMockContext([
        { value: undefined }, // security init
        { error: 'SyntaxError: unexpected token' }, // code load fails
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-3', 'function run({{', [], 1) },
        state,
        postMessage,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'execute-result',
        requestId: 'req-3',
        success: false,
        errorType: 'function_error',
      });
    });

    it('should return runtime_error when QuickJS not initialized', async () => {
      const state: WorkerState = { quickJS: null };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-4', 'function run(){return 1;}', [], 1) },
        state,
        postMessage,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'execute-result',
        requestId: 'req-4',
        success: false,
        errorType: 'runtime_error',
      });
    });

    it('should return runtime_error when security init fails', async () => {
      const context = createMockContext([
        { error: 'Failed to apply security' }, // security init fails
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-5', 'function run(){return 1;}', [], 1) },
        state,
        postMessage,
      );

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'execute-result',
        requestId: 'req-5',
        success: false,
        errorType: 'runtime_error',
      });
    });

    it('should apply SANDBOX_SECURITY_INIT as first evalCode call', async () => {
      // Verify that the security hardening code is the FIRST thing executed
      // in each context. This prevents regressions where security init is
      // accidentally removed or reordered (gemini review finding).
      const context = createMockContext([
        { value: undefined }, // security init
        { value: undefined }, // user code
        { value: undefined }, // args injection
        { value: 'ok' },     // run()
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-sec', 'function run(){return "ok";}', [], 1) },
        state,
        postMessage,
      );

      // First evalCode call should be the security init (contains constructor chain cutting)
      const firstCall = context.evalCode.mock.calls[0][0];
      expect(firstCall).toContain('Function.prototype');
      expect(firstCall).toContain('Object.freeze');
      expect(firstCall).toContain('constructor');
    });

    it('should pass args as JSON to the context', async () => {
      const context = createMockContext([
        { value: undefined }, // security init
        { value: undefined }, // user code load
        { value: undefined }, // args injection
        { value: 3 },        // run(1,2) = 3
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-6', 'function run(a,b){return a+b;}', [1, 2], 1) },
        state,
        postMessage,
      );

      // Verify args were injected via evalCode
      const argsCall = context.evalCode.mock.calls[2];
      expect(argsCall[0]).toBe('globalThis.__args__ = [1,2]');
    });

    it('should set memory limit on context runtime', async () => {
      const context = createMockContext([
        { value: undefined },
        { value: undefined },
        { value: undefined },
        { value: 'ok' },
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-7', 'function run(){return "ok";}', [], 1) },
        state,
        postMessage,
      );

      // Memory limit should be 16MB
      expect(context.runtime.setMemoryLimit).toHaveBeenCalledWith(16 * 1024 * 1024);
    });

    it('should set interrupt handler for timeout', async () => {
      const context = createMockContext([
        { value: undefined },
        { value: undefined },
        { value: undefined },
        { value: 'ok' },
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-8', 'function run(){return "ok";}', [], 1, 100) },
        state,
        postMessage,
      );

      expect(context.runtime.setInterruptHandler).toHaveBeenCalled();
    });

    it('should dispose context even when execution fails', async () => {
      const context = createMockContext([
        { value: undefined },
        { error: 'parse error' },
      ]);
      const mockQJS = createMockQuickJS(context);
      const state: WorkerState = { quickJS: mockQJS as any };

      await handleWorkerMessage(
        { data: createExecuteMessage('req-9', 'bad code', [], 1) },
        state,
        postMessage,
      );

      // Context must always be disposed (QuickJS manual memory management)
      expect(context.dispose).toHaveBeenCalled();
    });
  });

  describe('cancel message', () => {
    it('should record and ack a cancel only for the actively running request', async () => {
      const state: WorkerState = { quickJS: null, activeRequestId: 'req-live' };

      await handleWorkerMessage(
        { data: createCancelMessage('req-live', 1) },
        state,
        postMessage,
      );

      expect(state.cancelled?.has('req-live')).toBe(true);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'cancel-result',
        requestId: 'req-live',
        success: true,
        generationId: 1,
      });
    });

    it('should ignore a cancel for a request that already finished (no stale set entry)', async () => {
      // The event loop was blocked during the synchronous run; the execute
      // result was posted and the execution's finally cleared activeRequestId
      // BEFORE the cancel message was processed.
      const state: WorkerState = { quickJS: null, activeRequestId: null, cancelled: new Set() };

      await handleWorkerMessage(
        { data: createCancelMessage('req-done', 1) },
        state,
        postMessage,
      );

      expect(state.cancelled?.has('req-done')).toBe(false);
      expect(responses).toHaveLength(0);
    });
  });
});
