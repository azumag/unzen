/**
 * Unit tests for the structured error taxonomy and retry policy (issue #103).
 *
 * Verifies typed error codes, the worker-health / retry classification, and
 * that the taxonomy separates "task failed" (does NOT harm the worker) from
 * "worker/transport/protocol failed" (ISOLATABLE).
 */
import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  UnzenError,
  UnzenCancelledError,
  classifyError,
  classifyErrorCode,
  errorCodeOf,
  isCancellation,
  isIsolatable,
  retryPolicyFor,
  RetryPolicy,
} from '../src/errors.js';

describe('errors', () => {
  describe('UnzenError', () => {
    it('carries a typed code', () => {
      const error = new UnzenError('boom', ErrorCode.InvalidInput);
      expect(error.code).toBe(ErrorCode.InvalidInput);
      expect(error.name).toBe('UnzenError');
      expect(error instanceof Error).toBe(true);
    });

    it('UnzenCancelledError maps to the user-cancellation code', () => {
      const error = new UnzenCancelledError('user pressed stop');
      expect(error.code).toBe(ErrorCode.UserCancellation);
      expect(error.name).toBe('UnzenCancelledError');
    });
  });

  describe('classifyError', () => {
    it('maps a DOMException-style AbortError to user cancellation', () => {
      const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      expect(classifyError(abort)).toBe(ErrorCode.UserCancellation);
    });

    it('maps a raw AbortSignal abort to user cancellation', () => {
      const controller = new AbortController();
      controller.abort();
      expect(classifyError(controller.signal)).toBe(ErrorCode.UserCancellation);
    });

    it('maps UnzenError to its own code', () => {
      expect(classifyError(new UnzenError('x', ErrorCode.TransportTransient)))
        .toBe(ErrorCode.TransportTransient);
    });

    it('maps an arbitrary error to runtime-transient', () => {
      expect(classifyError(new Error('WebGPU context lost'))).toBe(ErrorCode.RuntimeTransient);
    });

    it('classifyErrorCode returns unknown for a bogus code', () => {
      expect(classifyErrorCode('nope')).toBeUndefined();
    });

    it('errorCodeOf returns the code for known errors', () => {
      expect(errorCodeOf(new UnzenError('m', ErrorCode.DeadlineExceeded)))
        .toBe(ErrorCode.DeadlineExceeded);
    });
  });

  describe('isCancellation', () => {
    it('true only for user-cancelled', () => {
      expect(isCancellation(ErrorCode.UserCancellation)).toBe(true);
      expect(isCancellation(ErrorCode.DeadlineExceeded)).toBe(false);
      expect(isCancellation(ErrorCode.RuntimeTransient)).toBe(false);
    });
  });

  describe('worker health isolation', () => {
    it('task-specific failures do NOT harm a healthy worker', () => {
      expect(isIsolatable(ErrorCode.InvalidInput)).toBe(false);
      expect(isIsolatable(ErrorCode.UnsupportedRequest)).toBe(false);
      expect(isIsolatable(ErrorCode.ContextOverflow)).toBe(false);
    });

    it('issue #95 backend errors describe the environment/request, not a worker fault', () => {
      expect(isIsolatable(ErrorCode.UnsupportedApi)).toBe(false);
      expect(isIsolatable(ErrorCode.ModelUnavailable)).toBe(false);
      expect(isIsolatable(ErrorCode.UserActivationRequired)).toBe(false);
      expect(isIsolatable(ErrorCode.UnsupportedModality)).toBe(false);
      expect(isIsolatable(ErrorCode.SessionDestroyed)).toBe(false);
      expect(isIsolatable(ErrorCode.PermissionDenied)).toBe(false);
    });

    it('worker/transport/protocol failures ARE isolatable', () => {
      expect(isIsolatable(ErrorCode.WorkerDisconnected)).toBe(true);
      expect(isIsolatable(ErrorCode.HeartbeatTimeout)).toBe(true);
      expect(isIsolatable(ErrorCode.TransportTransient)).toBe(true);
      expect(isIsolatable(ErrorCode.ProtocolViolation)).toBe(true);
      expect(isIsolatable(ErrorCode.ResultIdentityMismatch)).toBe(true);
      expect(isIsolatable(ErrorCode.CheckpointIntegrityMismatch)).toBe(true);
      expect(isIsolatable(ErrorCode.IntegritySecurityFailure)).toBe(true);
      expect(isIsolatable(ErrorCode.StaleGeneration)).toBe(true);
    });

    it('runtime-transient is isolatable (the runtime itself failed)', () => {
      expect(isIsolatable(ErrorCode.RuntimeTransient)).toBe(true);
    });
  });

  describe('retry policy', () => {
    it('worker-health and transient transport failures are retryable', () => {
      expect(retryPolicyFor(ErrorCode.WorkerDisconnected)).toBe(RetryPolicy.Retryable);
      expect(retryPolicyFor(ErrorCode.HeartbeatTimeout)).toBe(RetryPolicy.Retryable);
      expect(retryPolicyFor(ErrorCode.TransportTransient)).toBe(RetryPolicy.Retryable);
      expect(retryPolicyFor(ErrorCode.RuntimeTransient)).toBe(RetryPolicy.Retryable);
      expect(retryPolicyFor(ErrorCode.ModelPreparationFailure)).toBe(RetryPolicy.Retryable);
    });

    it('task-level and terminal failures are NOT retryable', () => {
      expect(retryPolicyFor(ErrorCode.InvalidInput)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.UnsupportedRequest)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.ContextOverflow)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.UserCancellation)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.DeadlineExceeded)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.ProtocolViolation)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.ResultIdentityMismatch)).toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.CheckpointIntegrityMismatch))
        .toBe(RetryPolicy.NotRetryable);
      expect(retryPolicyFor(ErrorCode.IntegritySecurityFailure)).toBe(RetryPolicy.NotRetryable);
    });

    it('every defined code resolves to a policy (exhaustive)', () => {
      for (const code of Object.values(ErrorCode)) {
        expect([RetryPolicy.Retryable, RetryPolicy.NotRetryable])
          .toContain(retryPolicyFor(code as ErrorCode));
      }
    });
  });
});
