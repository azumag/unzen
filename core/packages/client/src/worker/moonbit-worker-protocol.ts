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

/**
 * Validate an unknown main-thread request before worker state is touched.
 *
 * Successful validation returns a plain request snapshot. Each declared
 * request field is captured once so getter/Proxy-backed input cannot pass
 * validation with one value and drift before worker dispatch. The captured
 * ArrayBuffer, args array, and ABI object keep their references here; their
 * downstream ownership/transfer semantics remain unchanged.
 */
export function validateMoonbitWorkerRequest(
  data: unknown,
): { ok: true; msg: MoonbitWorkerMessage } | { ok: false; reason: string } {
  try {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { ok: false, reason: 'request is not an object' };
    }
    const m = data as Record<string, unknown>;
    const protocolVersion = m.protocolVersion;
    const generationId = m.generationId;
    const type = m.type;
    if (protocolVersion !== MOONBIT_WORKER_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: `protocol version mismatch (got ${String(protocolVersion)}, expected ${MOONBIT_WORKER_PROTOCOL_VERSION})`,
      };
    }
    if (
      typeof generationId !== 'number'
      || !Number.isSafeInteger(generationId)
      || generationId < 1
    ) {
      return { ok: false, reason: `malformed generationId: ${String(generationId)}` };
    }

    if (type === 'init') {
      const importedStringConstants = m.importedStringConstants;
      const maxCachedModules = m.maxCachedModules;
      if (importedStringConstants !== null && typeof importedStringConstants !== 'string') {
        return { ok: false, reason: 'Invalid importedStringConstants setting' };
      }
      if (typeof maxCachedModules !== 'number') {
        return { ok: false, reason: 'Invalid maxCachedModules setting' };
      }
      try {
        normalizeMoonBitCacheLimit(maxCachedModules);
      } catch {
        return { ok: false, reason: 'Invalid maxCachedModules setting' };
      }
      return {
        ok: true,
        msg: {
          type,
          protocolVersion,
          generationId,
          importedStringConstants,
          maxCachedModules,
        },
      };
    }
    if (type === 'execute') {
      const requestId = m.requestId;
      const wasm = m.wasm;
      const cacheKey = m.cacheKey;
      const cacheable = m.cacheable;
      const exportName = m.exportName;
      const args = m.args;
      const moonbitAbi = m.moonbitAbi;
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return { ok: false, reason: 'execute request missing requestId' };
      }
      const wasmByteLength = getArrayBufferByteLength(wasm);
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
        typeof cacheKey !== 'string'
        || cacheKey.length === 0
        || typeof cacheable !== 'boolean'
        || typeof exportName !== 'string'
        || !Array.isArray(args)
      ) {
        return { ok: false, reason: 'execute request has invalid cache/export/args metadata' };
      }
      if (moonbitAbi !== undefined && normalizeMoonBitAbi(moonbitAbi) === undefined) {
        return { ok: false, reason: 'Invalid MoonBit ABI metadata' };
      }
      return {
        ok: true,
        msg: {
          type,
          requestId,
          protocolVersion,
          generationId,
          cacheKey,
          wasm: wasm as ArrayBuffer,
          cacheable,
          exportName,
          args,
          ...(moonbitAbi !== undefined && { moonbitAbi: moonbitAbi as MoonBitAbi }),
        },
      };
    }
    if (type === 'cancel') {
      const requestId = m.requestId;
      if (typeof requestId !== 'string' || requestId.length === 0) {
        return { ok: false, reason: 'cancel request missing requestId' };
      }
      return {
        ok: true,
        msg: { type, requestId, protocolVersion, generationId },
      };
    }
    return { ok: false, reason: `unknown message type: ${String(type)}` };
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
  const protocolVersion = m.protocolVersion;
  const generationId = m.generationId;
  const type = m.type;
  if (protocolVersion !== MOONBIT_WORKER_PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `protocol version mismatch (got ${String(protocolVersion)}, expected ${MOONBIT_WORKER_PROTOCOL_VERSION})`,
    };
  }
  if (
    typeof generationId !== 'number'
    || !Number.isSafeInteger(generationId)
    || generationId < 1
  ) {
    return { ok: false, reason: `malformed generationId: ${String(generationId)}` };
  }

  if (type === 'init-result') {
    const success = m.success;
    const error = m.error;
    if (typeof success !== 'boolean') {
      return { ok: false, reason: 'init-result missing boolean success' };
    }
    if (error !== undefined && typeof error !== 'string') {
      return { ok: false, reason: 'init-result error must be a string' };
    }
    if (success && error !== undefined) {
      return { ok: false, reason: 'successful init-result must not include an error' };
    }
    return {
      ok: true,
      msg: {
        type,
        success,
        ...(error !== undefined && { error }),
        protocolVersion,
        generationId,
      },
    };
  }
  if (type === 'execute-result') {
    const requestId = m.requestId;
    const success = m.success;
    const value = m.value;
    const error = m.error;
    const errorType = m.errorType;
    if (
      typeof requestId !== 'string'
      || requestId.length === 0
      || typeof success !== 'boolean'
    ) {
      return { ok: false, reason: 'execute-result missing requestId/success' };
    }
    if (error !== undefined && typeof error !== 'string') {
      return { ok: false, reason: 'execute-result error must be a string' };
    }
    if (success) {
      if (error !== undefined || errorType !== undefined) {
        return { ok: false, reason: 'successful execute-result has error metadata' };
      }
      return {
        ok: true,
        msg: {
          type,
          requestId,
          success,
          value,
          protocolVersion,
          generationId,
        },
      };
    }
    if (
      errorType !== 'function_error'
      && errorType !== 'runtime_error'
    ) {
      return { ok: false, reason: `missing or unknown errorType: ${String(errorType)}` };
    }
    if (value !== undefined) {
      return { ok: false, reason: 'failed execute-result must not include a value' };
    }
    return {
      ok: true,
      msg: {
        type,
        requestId,
        success,
        ...(error !== undefined && { error }),
        errorType,
        protocolVersion,
        generationId,
      },
    };
  }
  if (type === 'cancel-result') {
    const requestId = m.requestId;
    const success = m.success;
    const error = m.error;
    if (
      typeof requestId !== 'string'
      || requestId.length === 0
      || typeof success !== 'boolean'
    ) {
      return { ok: false, reason: 'cancel-result missing requestId/success' };
    }
    if (error !== undefined && typeof error !== 'string') {
      return { ok: false, reason: 'cancel-result error must be a string' };
    }
    if (success && error !== undefined) {
      return { ok: false, reason: 'successful cancel-result must not include an error' };
    }
    return {
      ok: true,
      msg: {
        type,
        requestId,
        success,
        ...(error !== undefined && { error }),
        protocolVersion,
        generationId,
      },
    };
  }
  return { ok: false, reason: `unknown message type: ${String(type)}` };
}
