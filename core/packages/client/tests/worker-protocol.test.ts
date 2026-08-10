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
  createInitMessage,
  createExecuteMessage,
  createInitResultMessage,
  createExecuteResultMessage,
  createExecuteErrorMessage,
  createCancelMessage,
  createCancelResultMessage,
  validateWorkerResponse,
  WORKER_PROTOCOL_VERSION,
  isInitResultMessage,
  isExecuteResultMessage,
  isCancelResultMessage,
} from '../src/worker/worker-protocol';

describe('WorkerProtocol', () => {
  describe('createInitMessage', () => {
    it('should create init message with type "init"', () => {
      const msg = createInitMessage(1);
      expect(msg.type).toBe('init');
    });
  });

  describe('createExecuteMessage', () => {
    it('should create execute message with code and args', () => {
      const msg = createExecuteMessage('req-1', 'function run(a,b){return a+b;}', [1, 2], 1);
      expect(msg.type).toBe('execute');
      expect(msg.requestId).toBe('req-1');
      expect(msg.code).toBe('function run(a,b){return a+b;}');
      expect(msg.args).toEqual([1, 2]);
    });

    it('should create execute message with empty args', () => {
      const msg = createExecuteMessage('req-2', 'function run(){return 42;}', [], 1);
      expect(msg.args).toEqual([]);
    });

    it('should create execute message with optional timeout', () => {
      const msg = createExecuteMessage('req-3', 'code', [1], 1, 500);
      expect(msg.timeout).toBe(500);
    });
  });

  describe('createInitResultMessage', () => {
    it('should create success init result', () => {
      const msg = createInitResultMessage(true, 1);
      expect(msg.type).toBe('init-result');
      expect(msg.success).toBe(true);
      expect(msg.error).toBeUndefined();
    });

    it('should create error init result', () => {
      const msg = createInitResultMessage(false, 1, 'Wasm load failed');
      expect(msg.type).toBe('init-result');
      expect(msg.success).toBe(false);
      expect(msg.error).toBe('Wasm load failed');
    });
  });

  describe('createExecuteResultMessage', () => {
    it('should create success result with value', () => {
      const msg = createExecuteResultMessage('req-1', 42, 1);
      expect(msg.type).toBe('execute-result');
      expect(msg.requestId).toBe('req-1');
      expect(msg.success).toBe(true);
      expect(msg.value).toBe(42);
      expect(msg.error).toBeUndefined();
    });

    it('should create success result with object value', () => {
      const msg = createExecuteResultMessage('req-2', { greeting: 'hello' }, 1);
      expect(msg.value).toEqual({ greeting: 'hello' });
    });

    it('should create success result with null value', () => {
      const msg = createExecuteResultMessage('req-3', null, 1);
      expect(msg.value).toBeNull();
      expect(msg.success).toBe(true);
    });
  });

  describe('createExecuteErrorMessage', () => {
    it('should create error result with error type', () => {
      const msg = createExecuteErrorMessage('req-1', 'function_error', 'run is not defined', 1);
      expect(msg.type).toBe('execute-result');
      expect(msg.requestId).toBe('req-1');
      expect(msg.success).toBe(false);
      expect(msg.error).toBe('run is not defined');
      expect(msg.errorType).toBe('function_error');
    });

    it('should create runtime error result', () => {
      const msg = createExecuteErrorMessage('req-2', 'runtime_error', 'Execution timeout', 1);
      expect(msg.errorType).toBe('runtime_error');
    });
  });

  describe('type guards', () => {
    it('isInitResultMessage should return true for init-result', () => {
      const msg = createInitResultMessage(true, 1);
      expect(isInitResultMessage(msg)).toBe(true);
    });

    it('isInitResultMessage should return false for execute-result', () => {
      const msg = createExecuteResultMessage('req-1', 42, 1);
      expect(isInitResultMessage(msg)).toBe(false);
    });

    it('isExecuteResultMessage should return true for execute-result', () => {
      const msg = createExecuteResultMessage('req-1', 42, 1);
      expect(isExecuteResultMessage(msg)).toBe(true);
    });

    it('isExecuteResultMessage should return false for init-result', () => {
      const msg = createInitResultMessage(true, 1);
      expect(isExecuteResultMessage(msg)).toBe(false);
    });

    it('isCancelResultMessage should return true for cancel-result', () => {
      const msg = createCancelResultMessage('req-1', true, 1);
      expect(isCancelResultMessage(msg)).toBe(true);
    });
  });

  describe('generation id and protocol version', () => {
    it('createInitMessage should carry the protocol version and generation id', () => {
      const msg = createInitMessage(7);
      expect(msg.protocolVersion).toBe(WORKER_PROTOCOL_VERSION);
      expect(msg.generationId).toBe(7);
    });

    it('createExecuteMessage should carry generation id', () => {
      const msg = createExecuteMessage('req-1', 'code', [], 3, 100);
      expect(msg.generationId).toBe(3);
      expect(msg.protocolVersion).toBe(WORKER_PROTOCOL_VERSION);
    });

    it('createExecuteErrorMessage should echo generation id', () => {
      const msg = createExecuteErrorMessage('req-1', 'runtime_error', 'boom', 2);
      expect(msg.generationId).toBe(2);
    });
  });

  describe('cancel messages', () => {
    it('createCancelMessage should create a cancel message', () => {
      const msg = createCancelMessage('req-1', 5);
      expect(msg.type).toBe('cancel');
      expect(msg.requestId).toBe('req-1');
      expect(msg.generationId).toBe(5);
    });

    it('createCancelResultMessage should create an ack', () => {
      const msg = createCancelResultMessage('req-1', true, 5);
      expect(msg.type).toBe('cancel-result');
      expect(msg.requestId).toBe('req-1');
      expect(msg.success).toBe(true);
      expect(msg.generationId).toBe(5);
    });
  });

  describe('validateWorkerResponse', () => {
    it('should accept a valid init-result', () => {
      const result = validateWorkerResponse({
        type: 'init-result',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(result.ok).toBe(true);
    });

    it('should accept a valid execute-result', () => {
      const result = validateWorkerResponse({
        type: 'execute-result',
        requestId: 'req-1',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(result.ok).toBe(true);
    });

    it('should accept a valid cancel-result', () => {
      const result = validateWorkerResponse({
        type: 'cancel-result',
        requestId: 'req-1',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(result.ok).toBe(true);
    });

    it('should reject non-object responses', () => {
      const result = validateWorkerResponse(null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('not an object');
    });

    it('should reject a protocol version mismatch', () => {
      const result = validateWorkerResponse({
        type: 'init-result',
        success: true,
        protocolVersion: 999,
        generationId: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('protocol version mismatch');
    });

    it('should reject a response missing the protocol version', () => {
      const result = validateWorkerResponse({
        type: 'init-result',
        success: true,
        generationId: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('protocol version mismatch');
    });

    it('should reject a response missing the generation id', () => {
      const result = validateWorkerResponse({
        type: 'init-result',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('generationId');
    });

    it('should reject a non-integer generation id', () => {
      const result = validateWorkerResponse({
        type: 'init-result',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1.5,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('generationId');
    });

    it('should reject unknown message types', () => {
      const result = validateWorkerResponse({
        type: 'bogus',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('unknown message type');
    });

    it('should reject execute-result missing required fields', () => {
      const result = validateWorkerResponse({
        type: 'execute-result',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('requestId');
    });
  });
});
