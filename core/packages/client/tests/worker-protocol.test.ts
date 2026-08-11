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
  validateWorkerRequest,
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

  describe('validateWorkerRequest', () => {
    it('accepts valid init, execute, and cancel requests', () => {
      expect(validateWorkerRequest(createInitMessage(1)).ok).toBe(true);
      expect(validateWorkerRequest(createExecuteMessage(
        'req-1',
        'function run() { return 1; }',
        [],
        1,
        50,
      )).ok).toBe(true);
      expect(validateWorkerRequest(createCancelMessage('req-1', 1)).ok).toBe(true);
    });

    it.each([null, [], 'init', 42])('rejects non-object request data (%p)', (data) => {
      expect(validateWorkerRequest(data).ok).toBe(false);
    });

    it('rejects unknown types and malformed execute fields', () => {
      expect(validateWorkerRequest({
        type: 'bogus',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      }).ok).toBe(false);
      expect(validateWorkerRequest({
        ...createExecuteMessage('req-1', 'code', [], 1),
        args: {},
      }).ok).toBe(false);
      expect(validateWorkerRequest({
        ...createExecuteMessage('req-1', 'code', [], 1),
        timeout: 0,
      }).ok).toBe(false);
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

    it('should reject response objects whose fields cannot be read', () => {
      const response = new Proxy({}, {
        get() {
          throw new Error('boom');
        },
      });
      const result = validateWorkerResponse(response);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('could not be read');
    });

    it('snapshots response fields instead of returning caller-owned accessors', () => {
      const reads = new Map<string, number>();
      const once = <T>(name: string, value: T): T => {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        if (count > 1) throw new Error(`${name} read more than once`);
        return value;
      };
      const response = {
        get type() { return once('type', 'execute-result' as const); },
        get requestId() { return once('requestId', 'req-1'); },
        get success() { return once('success', true); },
        get value() { return once('value', 42); },
        get error() { return once('error', undefined); },
        get errorType() { return once('errorType', undefined); },
        get protocolVersion() { return once('protocolVersion', WORKER_PROTOCOL_VERSION); },
        get generationId() { return once('generationId', 1); },
      };

      const result = validateWorkerResponse(response);

      expect(result).toEqual({
        ok: true,
        msg: createExecuteResultMessage('req-1', 42, 1),
      });
      expect(result.ok && Object.getOwnPropertyDescriptor(result.msg, 'type')?.get)
        .toBeUndefined();
      expect([...reads.values()]).toEqual(new Array(8).fill(1));
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

    it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
      'should reject an out-of-range generation id (%s)',
      (generationId) => {
        const result = validateWorkerResponse({
          type: 'init-result',
          success: true,
          protocolVersion: WORKER_PROTOCOL_VERSION,
          generationId,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toContain('generationId');
      },
    );

    it('should reject array responses and malformed error metadata', () => {
      const array = Object.assign([], {
        type: 'init-result',
        success: true,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(validateWorkerResponse(array).ok).toBe(false);
      expect(validateWorkerResponse({
        type: 'execute-result',
        requestId: 'req-1',
        success: false,
        error: 42,
        errorType: 'runtime_error',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      }).ok).toBe(false);
    });

    it('should reject a failed execute-result without an error classification', () => {
      const result = validateWorkerResponse({
        type: 'execute-result',
        requestId: 'req-1',
        success: false,
        error: 'failed',
        protocolVersion: WORKER_PROTOCOL_VERSION,
        generationId: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('errorType');
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
