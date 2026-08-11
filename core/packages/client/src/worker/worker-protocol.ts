/**
 * Worker Message Protocol
 *
 * Type-safe message definitions for communication between the main thread
 * (WebWorkerSandboxExecutor) and the Web Worker (quickjs-worker.ts).
 *
 * Message flow:
 *   Main Thread → Worker:  InitMessage | ExecuteMessage | CancelMessage
 *   Worker → Main Thread:  InitResultMessage | ExecuteResultMessage | CancelResultMessage
 *
 * Design rationale:
 * - Discriminated union via `type` field for safe message routing
 * - requestId on execute/cancel messages enables per-request tracking
 * - generationId ties every message to a specific Worker generation. The
 *   executor increments it each time it (re)creates a Worker, so stale
 *   responses from an old generation are rejected instead of being applied
 *   to a fresh Worker's requests.
 * - protocolVersion (WORKER_PROTOCOL_VERSION) enables versioned schema
 *   validation: a response from an incompatible worker is treated as
 *   malformed rather than trusted.
 * - errorType distinguishes function errors (no fallback) from runtime errors (fallback)
 * - Factory functions ensure consistent message creation
 * - Type guards enable safe narrowing in message handlers
 */

// Version of the worker wire protocol. Bump on incompatible shape changes.
// The executor validates every response against this; mismatches are
// classified as malformed/protocol-violation instead of being trusted.
export const WORKER_PROTOCOL_VERSION = 1;

// ============================================================
// Main Thread → Worker Messages
// ============================================================

/** Initialize QuickJS Wasm module in the worker */
export interface InitMessage {
  readonly type: 'init';
  readonly protocolVersion: number;
  /** Worker generation this init belongs to (echoed in init-result) */
  readonly generationId: number;
}

/** Execute code in the QuickJS sandbox */
export interface ExecuteMessage {
  readonly type: 'execute';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly generationId: number;
  readonly code: string;
  readonly args: unknown[];
  readonly timeout?: number;
}

/** Cooperatively cancel a running execution */
export interface CancelMessage {
  readonly type: 'cancel';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly generationId: number;
}

/** Union of all messages sent from main thread to worker */
export type WorkerMessage = InitMessage | ExecuteMessage | CancelMessage;

// ============================================================
// Worker → Main Thread Messages
// ============================================================

/** Result of QuickJS Wasm initialization */
export interface InitResultMessage {
  readonly type: 'init-result';
  readonly success: boolean;
  readonly error?: string;
  readonly protocolVersion: number;
  readonly generationId: number;
}

/** Result of code execution (success or error) */
export interface ExecuteResultMessage {
  readonly type: 'execute-result';
  readonly requestId: string;
  readonly success: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly protocolVersion: number;
  readonly generationId: number;
  /** Required when success is false; omitted from successful responses.
   * Distinguishes user code errors from runtime/environment errors.
   * 'function_error' → UnzenFunctionError (no server fallback)
   * 'runtime_error' → UnzenRuntimeError (triggers server fallback)
   * 'deadline_exceeded' → UnzenDeadlineExceededError (triggers server fallback,
   *   reported as `deadline_exceeded` instead of a generic runtime failure) */
  readonly errorType?: 'function_error' | 'runtime_error' | 'deadline_exceeded';
}

/** Acknowledgement of a cooperative cancel request */
export interface CancelResultMessage {
  readonly type: 'cancel-result';
  readonly requestId: string;
  readonly success: boolean;
  readonly error?: string;
  readonly protocolVersion: number;
  readonly generationId: number;
}

/** Union of all messages sent from worker to main thread */
export type WorkerResponse = InitResultMessage | ExecuteResultMessage | CancelResultMessage;

// ============================================================
// Factory Functions
// ============================================================

export function createInitMessage(generationId: number): InitMessage {
  return { type: 'init', protocolVersion: WORKER_PROTOCOL_VERSION, generationId };
}

export function createExecuteMessage(
  requestId: string,
  code: string,
  args: unknown[],
  generationId: number,
  timeout?: number,
): ExecuteMessage {
  return {
    type: 'execute',
    requestId,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    generationId,
    code,
    args,
    timeout,
  };
}

export function createCancelMessage(
  requestId: string,
  generationId: number,
): CancelMessage {
  return {
    type: 'cancel',
    requestId,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    generationId,
  };
}

export function createInitResultMessage(
  success: boolean,
  generationId: number,
  error?: string,
): InitResultMessage {
  return {
    type: 'init-result',
    protocolVersion: WORKER_PROTOCOL_VERSION,
    generationId,
    success,
    error,
  };
}

export function createExecuteResultMessage(
  requestId: string,
  value: unknown,
  generationId: number,
): ExecuteResultMessage {
  return {
    type: 'execute-result',
    requestId,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    generationId,
    success: true,
    value,
  };
}

export function createExecuteErrorMessage(
  requestId: string,
  errorType: 'function_error' | 'runtime_error' | 'deadline_exceeded',
  error: string,
  generationId: number,
): ExecuteResultMessage {
  return {
    type: 'execute-result',
    requestId,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    generationId,
    success: false,
    error,
    errorType,
  };
}

export function createCancelResultMessage(
  requestId: string,
  success: boolean,
  generationId: number,
  error?: string,
): CancelResultMessage {
  return {
    type: 'cancel-result',
    requestId,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    generationId,
    success,
    error,
  };
}

// ============================================================
// Runtime Validation
// ============================================================

/**
 * Validate an unknown value as a WorkerResponse.
 *
 * Returns `{ ok: true, msg }` on success or `{ ok: false, reason }` on
 * failure. The executor uses this instead of trusting `event.data` blindly:
 * a response that is not an object, declares a mismatched protocolVersion,
 * or is missing required fields is classified as malformed rather than
 * applied to request bookkeeping.
 */
export function validateWorkerResponse(
  data: unknown,
): { ok: true; msg: WorkerResponse } | { ok: false; reason: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'response is not an object' };
  }
  const m = data as Record<string, unknown>;
  if (m.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocol version mismatch (got ${String(m.protocolVersion)}, expected ${WORKER_PROTOCOL_VERSION})`,
    };
  }
  // generationId is REQUIRED: every response must echo its generation so the
  // executor can reject stale-worker responses (a missing or non-number value
  // is a protocol violation, not a trusted response).
  if (
    typeof m.generationId !== 'number'
    || !Number.isSafeInteger(m.generationId)
    || m.generationId < 1
  ) {
    return { ok: false, reason: `malformed generationId: ${String(m.generationId)}` };
  }
  if (m.type === 'init-result') {
    if (typeof m.success !== 'boolean') {
      return { ok: false, reason: 'init-result missing boolean success' };
    }
    if (m.error !== undefined && typeof m.error !== 'string') {
      return { ok: false, reason: 'init-result error must be a string' };
    }
    if (m.success && m.error !== undefined) {
      return { ok: false, reason: 'successful init-result must not include an error' };
    }
    return { ok: true, msg: m as unknown as InitResultMessage };
  }
  if (m.type === 'execute-result') {
    if (
      typeof m.requestId !== 'string'
      || m.requestId.length === 0
      || typeof m.success !== 'boolean'
    ) {
      return { ok: false, reason: 'execute-result missing requestId/success' };
    }
    if (m.error !== undefined && typeof m.error !== 'string') {
      return { ok: false, reason: 'execute-result error must be a string' };
    }
    if (m.success) {
      if (m.error !== undefined || m.errorType !== undefined) {
        return { ok: false, reason: 'successful execute-result has error metadata' };
      }
      return { ok: true, msg: m as unknown as ExecuteResultMessage };
    }
    if (
      m.errorType !== 'function_error'
      && m.errorType !== 'runtime_error'
      && m.errorType !== 'deadline_exceeded'
    ) {
      return { ok: false, reason: `missing or unknown errorType: ${String(m.errorType)}` };
    }
    if (m.value !== undefined) {
      return { ok: false, reason: 'failed execute-result must not include a value' };
    }
    return { ok: true, msg: m as unknown as ExecuteResultMessage };
  }
  if (m.type === 'cancel-result') {
    if (
      typeof m.requestId !== 'string'
      || m.requestId.length === 0
      || typeof m.success !== 'boolean'
    ) {
      return { ok: false, reason: 'cancel-result missing requestId/success' };
    }
    if (m.error !== undefined && typeof m.error !== 'string') {
      return { ok: false, reason: 'cancel-result error must be a string' };
    }
    if (m.success && m.error !== undefined) {
      return { ok: false, reason: 'successful cancel-result must not include an error' };
    }
    return { ok: true, msg: m as unknown as CancelResultMessage };
  }
  return { ok: false, reason: `unknown message type: ${String(m.type)}` };
}

// ============================================================
// Type Guards
// ============================================================

export function isInitResultMessage(msg: WorkerResponse): msg is InitResultMessage {
  return msg.type === 'init-result';
}

export function isExecuteResultMessage(msg: WorkerResponse): msg is ExecuteResultMessage {
  return msg.type === 'execute-result';
}

export function isCancelResultMessage(msg: WorkerResponse): msg is CancelResultMessage {
  return msg.type === 'cancel-result';
}
