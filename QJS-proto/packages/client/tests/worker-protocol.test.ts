/**
 * Tests for Worker Message Protocol
 *
 * The worker protocol defines type-safe message passing between the main thread
 * (WebWorkerSandboxExecutor) and the Web Worker (quickjs-worker.ts).
 *
 * TDD approach: Tests first, then implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  type WorkerMessage,
  type WorkerResponse,
  createInitMessage,
  createExecuteMessage,
  createInitResultMessage,
  createExecuteResultMessage,
  createExecuteErrorMessage,
  isInitResultMessage,
  isExecuteResultMessage,
} from '../src/worker/worker-protocol';

describe('WorkerProtocol', () => {
  describe('createInitMessage', () => {
    it('should create init message with type "init"', () => {
      const msg = createInitMessage();
      expect(msg.type).toBe('init');
    });
  });

  describe('createExecuteMessage', () => {
    it('should create execute message with code and args', () => {
      const msg = createExecuteMessage('req-1', 'function run(a,b){return a+b;}', [1, 2]);
      expect(msg.type).toBe('execute');
      expect(msg.requestId).toBe('req-1');
      expect(msg.code).toBe('function run(a,b){return a+b;}');
      expect(msg.args).toEqual([1, 2]);
    });

    it('should create execute message with empty args', () => {
      const msg = createExecuteMessage('req-2', 'function run(){return 42;}', []);
      expect(msg.args).toEqual([]);
    });

    it('should create execute message with optional timeout', () => {
      const msg = createExecuteMessage('req-3', 'code', [1], 500);
      expect(msg.timeout).toBe(500);
    });
  });

  describe('createInitResultMessage', () => {
    it('should create success init result', () => {
      const msg = createInitResultMessage(true);
      expect(msg.type).toBe('init-result');
      expect(msg.success).toBe(true);
      expect(msg.error).toBeUndefined();
    });

    it('should create error init result', () => {
      const msg = createInitResultMessage(false, 'Wasm load failed');
      expect(msg.type).toBe('init-result');
      expect(msg.success).toBe(false);
      expect(msg.error).toBe('Wasm load failed');
    });
  });

  describe('createExecuteResultMessage', () => {
    it('should create success result with value', () => {
      const msg = createExecuteResultMessage('req-1', 42);
      expect(msg.type).toBe('execute-result');
      expect(msg.requestId).toBe('req-1');
      expect(msg.success).toBe(true);
      expect(msg.value).toBe(42);
      expect(msg.error).toBeUndefined();
    });

    it('should create success result with object value', () => {
      const msg = createExecuteResultMessage('req-2', { greeting: 'hello' });
      expect(msg.value).toEqual({ greeting: 'hello' });
    });

    it('should create success result with null value', () => {
      const msg = createExecuteResultMessage('req-3', null);
      expect(msg.value).toBeNull();
      expect(msg.success).toBe(true);
    });
  });

  describe('createExecuteErrorMessage', () => {
    it('should create error result with error type', () => {
      const msg = createExecuteErrorMessage('req-1', 'function_error', 'run is not defined');
      expect(msg.type).toBe('execute-result');
      expect(msg.requestId).toBe('req-1');
      expect(msg.success).toBe(false);
      expect(msg.error).toBe('run is not defined');
      expect(msg.errorType).toBe('function_error');
    });

    it('should create runtime error result', () => {
      const msg = createExecuteErrorMessage('req-2', 'runtime_error', 'Execution timeout');
      expect(msg.errorType).toBe('runtime_error');
    });
  });

  describe('type guards', () => {
    it('isInitResultMessage should return true for init-result', () => {
      const msg = createInitResultMessage(true);
      expect(isInitResultMessage(msg)).toBe(true);
    });

    it('isInitResultMessage should return false for execute-result', () => {
      const msg = createExecuteResultMessage('req-1', 42);
      expect(isInitResultMessage(msg)).toBe(false);
    });

    it('isExecuteResultMessage should return true for execute-result', () => {
      const msg = createExecuteResultMessage('req-1', 42);
      expect(isExecuteResultMessage(msg)).toBe(true);
    });

    it('isExecuteResultMessage should return false for init-result', () => {
      const msg = createInitResultMessage(true);
      expect(isExecuteResultMessage(msg)).toBe(false);
    });
  });
});
