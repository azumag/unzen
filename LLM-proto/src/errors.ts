/**
 * Structured error taxonomy for the Coordinator (issue #103).
 *
 * The issue requires separating worker health from task failure:
 *   - A task-specific failure (invalid input, unsupported language) must NOT
 *     disconnect a healthy worker.
 *   - Worker-health, transport, protocol, identity, and integrity failures ARE
 *     isolatable (the worker or its generation is quarantined).
 *
 * Every surfaced error carries a machine-readable code so the retry policy,
 * the worker-health bookkeeping, and the cancellation handling can switch on
 * the code instead of `instanceof` or message text.
 */

// --- Error codes (discriminated, exhaustive taxonomy) ---

export const ErrorCode = {
  /** The worker disconnected mid-execution. */
  WorkerDisconnected: 'worker-disconnected',
  /** Heartbeats stopped arriving; the worker is presumed gone. */
  HeartbeatTimeout: 'heartbeat-timeout',
  /** Transient transport failure (reconnect may help). */
  TransportTransient: 'transport-transient',
  /** Transient runtime failure (e.g. WebGPU context lost). */
  RuntimeTransient: 'runtime-transient',
  /** The request is not supported by the assigned worker. */
  UnsupportedRequest: 'unsupported-request',
  /** The input payload is invalid. */
  InvalidInput: 'invalid-input',
  /** The context window was exceeded. */
  ContextOverflow: 'context-overflow',
  /** Model weights / runtime preparation failed on the worker. */
  ModelPreparationFailure: 'model-preparation-failure',
  /** The user cancelled the request. Never retried, never triggers fallback. */
  UserCancellation: 'user-cancelled',
  /** The request deadline (or lease) expired. */
  DeadlineExceeded: 'deadline-exceeded',
  /** A single segment/span execution exceeded its per-segment timeout. */
  SegmentTimeout: 'segment-timeout',
  /** The worker violated the wire protocol. */
  ProtocolViolation: 'protocol-violation',
  /** A result/failure did not match the active lease identity. */
  ResultIdentityMismatch: 'result-identity-mismatch',
  /** A checkpoint envelope failed integrity / ownership validation. */
  CheckpointIntegrityMismatch: 'checkpoint-integrity-mismatch',
  /** Tampering or signature/integrity-security failure. */
  IntegritySecurityFailure: 'integrity-security-failure',
  /** A heartbeat/state mutation from an unknown worker. */
  UnknownWorker: 'unknown-worker',
  /** A heartbeat/state mutation from an unknown or revoked generation. */
  StaleGeneration: 'stale-generation',
  /** A lease expired or was reclaimed before the result arrived. */
  LeaseExpired: 'lease-expired',
  /** The request does not exist in the repository. */
  RequestNotFound: 'request-not-found',
  /** A completion was already committed for the request (late duplicate). */
  DuplicateCompletion: 'duplicate-completion',
  /** An illegal state transition was attempted. */
  StateTransitionViolation: 'state-transition-violation',
  /** The browser/API surface is not supported by this environment (issue #95). */
  UnsupportedApi: 'unsupported-api',
  /** The model is unavailable or the hardware requirements are not met (issue #95). */
  ModelUnavailable: 'model-unavailable',
  /** The operation was rejected because a user activation is required (issue #95). */
  UserActivationRequired: 'user-activation-required',
  /** The request uses a language/modality the backend does not support (issue #95). */
  UnsupportedModality: 'unsupported-modality',
  /** The session was destroyed and cannot be reused (issue #95). */
  SessionDestroyed: 'session-destroyed',
  /** A browser policy / permission denied the operation (issue #95). */
  PermissionDenied: 'permission-denied',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// --- Base error classes ---

/**
 * Base class for all Coordinator-domain errors.
 * Mirrors `core/packages/shared` UnzenError semantics but keeps LLM-proto
 * free of a dependency on the core package.
 */
export class UnzenError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = 'UnzenError';
    this.code = code;
  }
}

/**
 * User cancellation. Mirrors `core` UnzenCancelledError (issue #106 contract):
 * a cancel must settle the execution with this error and MUST never trigger
 * retry or fallback — the user who pressed "cancel" does not want the work
 * silently continued elsewhere.
 */
export class UnzenCancelledError extends UnzenError {
  constructor(message: string) {
    super(message, ErrorCode.UserCancellation);
    this.name = 'UnzenCancelledError';
  }
}

/** State-transition violation (late update from a terminal state, etc.). */
export class StateTransitionError extends UnzenError {
  constructor(message: string) {
    super(message, ErrorCode.StateTransitionViolation);
    this.name = 'StateTransitionError';
  }
}

/** A single segment/span exceeded its timeout; the work was aborted. */
export class SegmentTimeoutError extends UnzenError {
  constructor(message: string) {
    super(message, ErrorCode.SegmentTimeout);
    this.name = 'SegmentTimeoutError';
  }
}

/** The overall request deadline was exceeded. */
export class DeadlineError extends UnzenError {
  constructor(message: string) {
    super(message, ErrorCode.DeadlineExceeded);
    this.name = 'DeadlineError';
  }
}

// --- Classification helpers ---

/** The taxonomy code is a closed set; this narrows arbitrary strings. */
export function classifyErrorCode(code: string): ErrorCode | undefined {
  for (const candidate of Object.values(ErrorCode)) {
    if (candidate === code) return candidate as ErrorCode;
  }
  return undefined;
}

/** Best-effort extraction of a taxonomy code from any thrown value. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (error instanceof UnzenError) return error.code;
  return undefined;
}

/**
 * Classify an arbitrary thrown value (or an already-aborted signal) into an
 * ErrorCode. AbortError / aborted signals map to UserCancellation so the
 * timeout-vs-cancel distinction is preserved at the Coordinator boundary.
 */
export function classifyError(error: unknown): ErrorCode {
  if (error instanceof UnzenError) return error.code;
  if (isAbortLike(error)) return ErrorCode.UserCancellation;
  return ErrorCode.RuntimeTransient;
}

/** True when the thrown value is an AbortError / aborted signal. */
function isAbortLike(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { name?: unknown; aborted?: unknown };
    if (candidate.name === 'AbortError') return true;
  }
  // An AbortSignal itself can be thrown / passed.
  if (error instanceof AbortSignal) return error.aborted;
  return false;
}

// --- Policy helpers ---

/** True when the failure is a deliberate user cancellation. */
export function isCancellation(code: ErrorCode): boolean {
  return code === ErrorCode.UserCancellation;
}

/**
 * True when the failure is attributed to the worker and the worker (or its
 * generation) should be isolated from future assignments. Task-level failures
 * (invalid input, unsupported language, context overflow) never harm a healthy
 * worker. Issue #95 additions (Chrome Prompt API backend) are also task- or
 * capability-level: they describe the environment/request, not a fault of a
 * healthy segmented worker.
 */
export function isIsolatable(code: ErrorCode): boolean {
  switch (code) {
    case ErrorCode.InvalidInput:
    case ErrorCode.UnsupportedRequest:
    case ErrorCode.ContextOverflow:
    case ErrorCode.UserCancellation:
    case ErrorCode.DeadlineExceeded:
    case ErrorCode.RequestNotFound:
    case ErrorCode.DuplicateCompletion:
    case ErrorCode.StateTransitionViolation:
    case ErrorCode.UnknownWorker:
    case ErrorCode.UnsupportedApi:
    case ErrorCode.ModelUnavailable:
    case ErrorCode.UserActivationRequired:
    case ErrorCode.UnsupportedModality:
    case ErrorCode.SessionDestroyed:
    case ErrorCode.PermissionDenied:
      return false;
    default:
      return true;
  }
}

export enum RetryPolicy {
  /** Retry the segment, possibly on a different worker. */
  Retryable = 'retryable',
  /** Fail the request; retrying cannot help. */
  NotRetryable = 'not-retryable',
}

/** Retry policy keyed by error code (issue #103 deliverable 8). */
export function retryPolicyFor(code: ErrorCode): RetryPolicy {
  switch (code) {
    case ErrorCode.WorkerDisconnected:
    case ErrorCode.HeartbeatTimeout:
    case ErrorCode.TransportTransient:
    case ErrorCode.RuntimeTransient:
    case ErrorCode.ModelPreparationFailure:
    case ErrorCode.SegmentTimeout:
      return RetryPolicy.Retryable;
    default:
      return RetryPolicy.NotRetryable;
  }
}