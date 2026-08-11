/**
 * MoonBit Web Worker Message Protocol
 *
 * Type-safe message definitions for communication between the main thread
 * (MoonBitWorkerSandboxExecutor) and the Web Worker (moonbit-worker.ts).
 *
 * Unlike the QuickJS worker (which sends JS source), the MoonBit worker
 * receives the wasm-gc module BYTES (transferred as an ArrayBuffer) plus the
 * export name, arguments, and optional numeric-array ABI, then
 * compiles/instantiates and calls the export synchronously. Execution inside
 * the worker is uninterruptible, so the main thread enforces timeouts by
 * terminating the worker.
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
import {
  DEFAULT_MAX_MOONBIT_CACHED_MODULES,
  normalizeMoonBitCacheLimit,
} from '../moonbit-cache';
import {
  MAX_FUNCTION_PAYLOAD_BYTES,
  normalizeMoonBitAbi,
  type MoonBitAbi,
} from '@unzen/shared';

// Version of the MoonBit worker wire protocol. Bump on incompatible changes.
export const MOONBIT_WORKER_PROTOCOL_VERSION = 5;

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
  /** Maximum settled compiled modules retained by this worker generation. */
  readonly maxCachedModules: number;
}

/** Execute an export of a wasm-gc module. */
export interface MoonbitExecuteMessage {
  readonly type: 'execute';
  readonly requestId: string;
  readonly protocolVersion: number;
  readonly generationId: number;
  /** Content identity used as the worker-side compile cache key. */
  readonly cacheKey: string;
  /** wasm-gc module bytes; transferred to the worker (no copy) */
  readonly wasm: ArrayBuffer;
  /** Whether the compiled module may be cached in the worker by `cacheKey`.
   * URL-based executions (true) reuse one compile per URL + expected hash;
   * inline executions (false) never accumulate in the cache. */
  readonly cacheable: boolean;
  /** Export to call (defaults to 'run') */
  readonly exportName: string;
  /** Scalar/array arguments for the export */
  readonly args: unknown[];
  /** Optional standard array-copy ABI. */
  readonly moonbitAbi?: MoonBitAbi;
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
  /** Required when success is false; omitted from successful responses.
   * 'function_error' → no fallback; 'runtime_error' → fallback-eligible */
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
  maxCachedModules: number = DEFAULT_MAX_MOONBIT_CACHED_MODULES,
): MoonbitInitMessage {
  return {
    type: 'init',
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
    importedStringConstants,
    maxCachedModules,
  };
}

export function createMoonbitExecuteMessage(
  requestId: string,
  cacheKey: string,
  wasm: ArrayBuffer,
  cacheable: boolean,
  exportName: string,
  args: unknown[],
  generationId: number,
  moonbitAbi?: MoonBitAbi,
): MoonbitExecuteMessage {
  return {
    type: 'execute',
    requestId,
    protocolVersion: MOONBIT_WORKER_PROTOCOL_VERSION,
    generationId,
    cacheKey,
    wasm,
    cacheable,
    exportName,
    args,
    moonbitAbi,
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

const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;

function getArrayBufferByteLength(value: unknown): number | undefined {
  if (ARRAY_BUFFER_BYTE_LENGTH === undefined) return undefined;
  try {
    return Reflect.apply(ARRAY_BUFFER_BYTE_LENGTH, value, []) as number;
  } catch {
    return undefined;
  }
}

/** Validate an unknown main-thread request before worker state is touched. */
export function validateMoonbitWorkerRequest(
  data: unknown,
): { ok: true; msg: MoonbitWorkerMessage } | { ok: false; reason: string } {
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { ok: false, reason: 'request is not an object' };
    }
    const m = data as Record<string, unknown>;
    if (m.protocolVersion !== MOONBIT_WORKER_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `protocol version mismatch (got ${String(m.protocolVersion)}, expected ${MOONBIT_WORKER_PROTOCOL_VERSION})`,
      };
    }
    if (
      typeof m.generationId !== 'number'
      || !Number.isSafeInteger(m.generationId)
      || m.generationId < 1
    ) {
      return { ok: false, reason: `malformed generationId: ${String(m.generationId)}` };
    }

    if (m.type === 'init') {
      if (m.importedStringConstants !== null && typeof m.importedStringConstants !== 'string') {
        return { ok: false, reason: 'Invalid importedStringConstants setting' };
      }
      if (typeof m.maxCachedModules !== 'number') {
        return { ok: false, reason: 'Invalid maxCachedModules setting' };
      }
      try {
        normalizeMoonBitCacheLimit(m.maxCachedModules);
      } catch {
        return { ok: false, reason: 'Invalid maxCachedModules setting' };
      }
      return { ok: true, msg: m as unknown as MoonbitInitMessage };
    }
    if (m.type === 'execute') {
      if (typeof m.requestId !== 'string' || m.requestId.length === 0) {
        return { ok: false, reason: 'execute request missing requestId' };
      }
      const wasmByteLength = getArrayBufferByteLength(m.wasm);
      if (wasmByteLength === undefined) {
        return { ok: false, reason: 'execute request wasm must be an ArrayBuffer' };
      }
      if (wasmByteLength > MAX_FUNCTION_PAYLOAD_BYTES) {
        return {
          ok: false,
          reason: `execute request wasm exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`,
        };
      }
      if (
        typeof m.cacheKey !== 'string'
        || m.cacheKey.length === 0
        || typeof m.cacheable !== 'boolean'
        || typeof m.exportName !== 'string'
        || !Array.isArray(m.args)
      ) {
        return { ok: false, reason: 'execute request has invalid cache/export/args metadata' };
      }
      if (m.moonbitAbi !== undefined && normalizeMoonBitAbi(m.moonbitAbi) === undefined) {
        return { ok: false, reason: 'Invalid MoonBit ABI metadata' };
      }
      return { ok: true, msg: m as unknown as MoonbitExecuteMessage };
    }
    if (m.type === 'cancel') {
      if (typeof m.requestId !== 'string' || m.requestId.length === 0) {
        return { ok: false, reason: 'cancel request missing requestId' };
      }
      return { ok: true, msg: m as unknown as MoonbitCancelMessage };
    }
    return { ok: false, reason: `unknown message type: ${String(m.type)}` };
  } catch {
    return { ok: false, reason: 'request could not be read' };
  }
}

/**
 * Validate an unknown value as a MoonbitWorkerResponse.
 *
 * Every response must carry the protocol version and a positive safe integer
 * generation id; a missing/malformed value is a protocol violation rather
 * than a trusted response (mirrors validateWorkerResponse).
 */
export function validateMoonbitWorkerResponse(
  data: unknown,
): { ok: true; msg: MoonbitWorkerResponse } | { ok: false; reason: string } {
  try {
    return validateMoonbitWorkerResponseFields(data);
  } catch {
    return { ok: false, reason: 'response could not be read' };
  }
}

function validateMoonbitWorkerResponseFields(
  data: unknown,
): { ok: true; msg: MoonbitWorkerResponse } | { ok: false; reason: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'response is not an object' };
  }
  const m = data as Record<string, unknown>;
  if (m.protocolVersion !== MOONBIT_WORKER_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocol version mismatch (got ${String(m.protocolVersion)}, expected ${MOONBIT_WORKER_PROTOCOL_VERSION})`,
    };
  }
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
    return { ok: true, msg: m as unknown as MoonbitInitResultMessage };
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
      return { ok: true, msg: m as unknown as MoonbitExecuteResultMessage };
    }
    if (
      m.errorType !== 'function_error'
      && m.errorType !== 'runtime_error'
    ) {
      return { ok: false, reason: `missing or unknown errorType: ${String(m.errorType)}` };
    }
    if (m.value !== undefined) {
      return { ok: false, reason: 'failed execute-result must not include a value' };
    }
    return { ok: true, msg: m as unknown as MoonbitExecuteResultMessage };
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
    return { ok: true, msg: m as unknown as MoonbitCancelResultMessage };
  }
  return { ok: false, reason: `unknown message type: ${String(m.type)}` };
}
