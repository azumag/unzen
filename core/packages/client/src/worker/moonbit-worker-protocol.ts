/**
 * MoonBit Web Worker Message Protocol
 *
 * Type-safe message definitions for communication between the main thread
 * (MoonBitWorkerSandboxExecutor) and the Web Worker (moonbit-worker.ts).
 *
 * Unlike the QuickJS worker (which sends JS source), the MoonBit worker
 * receives the wasm-gc module BYTES (transferred as an ArrayBuffer) plus the
 * export name and scalar arguments, compiles/instantiates, and calls the
 * export synchronously. Execution inside the worker is uninterruptible, so
 * the main thread enforces timeouts by terminating the worker.
 *
 * Message flow:
 *   Main → Worker:  InitMessage | ExecuteMessage | CancelMessage
 *   Worker → Main:  InitResultMessage | ExecuteResultMessage | CancelResultMessage
 *
 * Design rationale (mirrors worker-protocol.ts for QuickJS):
 * - Discriminated union via `type` for safe routing
 * - requestId enables per-request tracking
 * - generationId ties every message to a Worker generation; the executor
 *   bumps it on every (re)creation so stale responses are rejected
 * - protocolVersion enables versioned schema validation
 * - errorType distinguishes function errors (no fallback) from runtime errors
 */

import {
  DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS,
  type MoonBitImportedStringConstants,
} from '../moonbit-compile-options';

// Version of the MoonBit worker wire protocol. Bump on incompatible changes.
export const MOONBIT_WORKER_PROTOCOL_VERSION = 2;

// ============================================================
// Main Thread → Worker Messages
// ============================================================

/** Initialize the MoonBit worker generation */
export interface MoonbitInitMessage {
  readonly type: 'init';
  readonly protocolVersion: number;
  readonly generationId: number;
  /** Namespace used by MoonBit's imported-string-constants compile option. */
  readonly importedStringConstants: MoonBitImportedStringConstants;
}

/** Execute an export of a wasm-gc module. */
export interface MoonbitExecuteMessage {
  readonly type: 'execute';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly generationId: number;
  /** Module URL (used as the worker-side compile cache key) */
  readonly url: string;
  /** wasm-gc module bytes; transferred to the worker (no copy) */
  readonly wasm: ArrayBuffer;
  /** Whether the compiled module may be cached in the worker keyed by `url`.
   * URL-based executions (true) reuse one compile per URL; inline ArrayBuffer
   * executions (false) compile per call and never accumulate in the cache. */
  readonly cacheable: boolean;
  /** Export to call (defaults to 'run') */
  readonly exportName: string;
  /** Scalar arguments for the export */
  readonly args: unknown[];
}

/** Cooperatively cancel a running execution (best-effort; see worker docs). */
export interface MoonbitCancelMessage {
  readonly type: 'cancel';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly generationId: number;
}

/** Union of all messages sent from main thread to the MoonBit worker */
export type MoonbitWorkerMessage =
  | MoonbitInitMessage
  | MoonbitExecuteMessage
  | MoonbitCancelMessage;

// ============================================================
// Worker → Main Thread Messages
// ============================================================

/** Result of initialization */
export interface MoonbitInitResultMessage {
  readonly type: 'init-result';
  readonly success: boolean;
  readonly error?: string;
  readonly protocolVersion: number;
  readonly generationId: number;
}

/** Result of export execution */
export interface MoonbitExecuteResultMessage {
  readonly type: 'execute-result';
  readonly requestId: string;
  readonly success: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly protocolVersion: number;
  readonly generationId: number;
  /** 'function_error' → no fallback; 'runtime_error' → fallback-eligible */
  readonly errorType?: 'function_error' | 'runtime_error';
}

/** Acknowledgement of a cancel request */
export interface MoonbitCancelResultMessage {
  readonly type: 'cancel-result';
  readonly requestId: string;
  readonly success: boolean;
  readonly error?: string;
  readonly protocolVersion: number;
  readonly generationId: number;
}

/** Union of all responses sent from the MoonBit worker */
export type MoonbitWorkerResponse =
  | MoonbitInitResultMessage
  | MoonbitExecuteResultMessage
  | MoonbitCancelResultMessage;

// ============================================================
// Factory Functions
// ============================================================

export function createMoonbitInitMessage(
  generationId: number,
  importedStringConstants: MoonBitImportedStringConstants = DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS,
): MoonbitInitMessage {
  return {
    type: 'init',
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
    importedStringConstants,
  };
}

export function createMoonbitExecuteMessage(
  requestId: string,
  url: string,
  wasm: ArrayBuffer,
  cacheable: boolean,
  exportName: string,
  args: unknown[],
  generationId: number,
): MoonbitExecuteMessage {
  return {
    type: 'execute',
    requestId,
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
    url,
    wasm,
    cacheable,
    exportName,
    args,
  };
}

export function createMoonbitCancelMessage(
  requestId: string,
  generationId: number,
): MoonbitCancelMessage {
  return {
    type: 'cancel',
    requestId,
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
  };
}

export function createMoonbitInitResultMessage(
  success: boolean,
  generationId: number,
  error?: string,
): MoonbitInitResultMessage {
  return {
    type: 'init-result',
    success,
    error,
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
  };
}

export function createMoonbitExecuteResultMessage(
  requestId: string,
  success: boolean,
  generationId: number,
  value?: unknown,
  error?: string,
  errorType?: 'function_error' | 'runtime_error',
): MoonbitExecuteResultMessage {
  return {
    type: 'execute-result',
    requestId,
    success,
    value,
    error,
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
    errorType,
  };
}

export function createMoonbitCancelResultMessage(
  requestId: string,
  success: boolean,
  generationId: number,
  error?: string,
): MoonbitCancelResultMessage {
  return {
    type: 'cancel-result',
    requestId,
    success,
    error,
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
  };
}

// ============================================================
// Runtime Validation
// ============================================================

/**
 * Validate an unknown value as a MoonbitWorkerResponse.
 *
 * Every response must carry the protocol version and a non-negative integer
 * generation id; a missing/malformed value is a protocol violation rather
 * than a trusted response (mirrors validateWorkerResponse).
 */
export function validateMoonbitWorkerResponse(
  data: unknown,
): { ok: true; msg: MoonbitWorkerResponse } | { ok: false; reason: string } {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, reason: 'response is not an object' };
  }
  const m = data as Record<string, unknown>;
  if (m.protocolVersion !== MOONBIT_WORKER_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocol version mismatch (got ${String(m.protocolVersion)}, expected ${MOONBIT_WORKER_PROTOCOL_VERSION})`,
    };
  }
  if (typeof m.generationId !== 'number' || !Number.isInteger(m.generationId)) {
    return { ok: false, reason: `malformed generationId: ${String(m.generationId)}` };
  }

  if (m.type === 'init-result') {
    if (typeof m.success !== 'boolean') {
      return { ok: false, reason: 'init-result missing boolean success' };
    }
    return { ok: true, msg: m as unknown as MoonbitInitResultMessage };
  }
  if (m.type === 'execute-result') {
    if (typeof m.requestId !== 'string' || typeof m.success !== 'boolean') {
      return { ok: false, reason: 'execute-result missing requestId/success' };
    }
    if (
      m.errorType !== undefined
      && m.errorType !== 'function_error'
      && m.errorType !== 'runtime_error'
    ) {
      return { ok: false, reason: `unknown errorType: ${String(m.errorType)}` };
    }
    return { ok: true, msg: m as unknown as MoonbitExecuteResultMessage };
  }
  if (m.type === 'cancel-result') {
    if (typeof m.requestId !== 'string' || typeof m.success !== 'boolean') {
      return { ok: false, reason: 'cancel-result missing requestId/success' };
    }
    return { ok: true, msg: m as unknown as MoonbitCancelResultMessage };
  }
  return { ok: false, reason: `unknown message type: ${String(m.type)}` };
}
