/**
 * Core type definitions for unzen core framework
 *
 * This module defines all shared types used across client and server packages.
 * Types are designed to be serializable and compatible with both browser and Node.js environments.
 */

/**
 * Supported runtime types for function execution
 * - quickjs: JavaScript functions executed in QuickJS Wasm sandbox
 * - moonbit: Functions compiled to Wasm via MoonBit wasm-gc backend
 */
export type RuntimeType = 'quickjs' | 'moonbit';

/**
 * Type guard for RuntimeType
 *
 * @param value - Value to check
 * @returns true if value is a valid RuntimeType
 */
export function isRuntimeType(value: unknown): value is RuntimeType {
  return typeof value === 'string' && (value === 'quickjs' || value === 'moonbit');
}

/** Value categories supported by the MoonBit wasm-gc boundary. */
export type MoonBitAbiType = 'scalar' | 'i32[]' | 'f64[]';

/**
 * Per-export MoonBit ABI metadata.
 *
 * Array entries opt into the standard unzen copy bridge. `scalar` keeps the
 * existing loose scalar contract (number / boolean / bigint / string).
 * When `result` is omitted it defaults to `scalar`.
 */
export interface MoonBitAbi {
  params: MoonBitAbiType[];
  result?: MoonBitAbiType;
}

/** Bound manifest metadata and the number of arguments copied per call. */
export const MAX_MOONBIT_ABI_PARAMS = 128;

export function isMoonBitAbiType(value: unknown): value is MoonBitAbiType {
  return value === 'scalar' || value === 'i32[]' || value === 'f64[]';
}

/** Validate and copy ABI metadata without invoking a source array iterator. */
export function normalizeMoonBitAbi(value: unknown): MoonBitAbi | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const abi = value as Record<string, unknown>;
    const sourceParams = abi.params;
    const result = abi.result;
    if (!Array.isArray(sourceParams)) return undefined;
    const paramCount = sourceParams.length;
    if (
      typeof paramCount !== 'number'
      || !Number.isInteger(paramCount)
      || paramCount < 0
      || paramCount > MAX_MOONBIT_ABI_PARAMS
    ) {
      return undefined;
    }

    const params = new Array<MoonBitAbiType>(paramCount);
    for (let index = 0; index < paramCount; index++) {
      const type = sourceParams[index];
      if (!isMoonBitAbiType(type)) return undefined;
      params[index] = type;
    }
    if (result !== undefined && !isMoonBitAbiType(result)) return undefined;
    return {
      params,
      ...(result !== undefined && { result }),
    };
  } catch {
    return undefined;
  }
}

/** Runtime validation for manifest and JavaScript callers. */
export function isValidMoonBitAbi(value: unknown): value is MoonBitAbi {
  return normalizeMoonBitAbi(value) !== undefined;
}

/**
 * Function definition metadata
 *
 * Contains all information needed to execute a function in either browser or server environment.
 * Function code is stored as string for transmission over HTTP.
 */
export interface FunctionDefinition {
  /** Unique function identifier (used as key in manifest) */
  name: string;
  /** Runtime type that can execute this function */
  runtime: RuntimeType;
  /** Function code as string (JavaScript for quickjs, Wasm URL for moonbit) */
  code: string;
  /** Version number for cache invalidation */
  version: number;
  /** SHA-256 hash of function code for integrity verification */
  hash: string;
  /** Name of the export to call on a MoonBit wasm-gc module (defaults to 'run') */
  exportName?: string;
  /** Optional MoonBit array-copy ABI for this export. */
  moonbitAbi?: MoonBitAbi;
  /**
   * Per-function execution timeout in milliseconds (1-2000).
   * Controls server-side fallback execution timeout only.
   * Browser-side execution uses the WebWorkerSandboxExecutor's own timeout.
   * Timeout tiers: 50ms (default), 500ms (medium), 2000ms (heavy).
   */
  timeout?: number;
  /** When true, a browser failure never falls back to the server.
   * Used for functions whose inputs must not leave the client (e.g. password
   * hashing) and for runtimes the server cannot execute (MoonBit wasm-gc). */
  noFallback?: boolean;
}

/**
 * Validation function for FunctionDefinition
 *
 * Ensures all required fields are present and valid.
 *
 * @param def - Function definition to validate
 * @returns true if definition is valid
 */
/**
 * Maximum per-function timeout in milliseconds.
 * Shared constant used by both type validation and server-side registration.
 */
export const MAX_FUNCTION_TIMEOUT = 2000;

/**
 * Safe function name pattern
 * Only alphanumeric, underscore, and hyphen allowed.
 * Prevents path traversal (../../) and URL injection attacks
 * when function names are used in URL paths or file system paths.
 */
const SAFE_FUNCTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,99}$/;
const SHA256_CONTENT_HASH = /^sha256:[a-f0-9]{64}$/;

/** Whether a function name is safe to use as a manifest key and URL segment. */
export function isValidFunctionName(value: unknown): value is string {
  return typeof value === 'string' && SAFE_FUNCTION_NAME.test(value);
}

/** Whether a value is Unzen's canonical lowercase SHA-256 content identity. */
export function isValidContentHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_CONTENT_HASH.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Validate and copy a function definition across an ownership boundary. */
export function normalizeFunctionDefinition(value: unknown): FunctionDefinition | undefined {
  try {
    if (!isPlainRecord(value)) return undefined;
    if (
      !Object.hasOwn(value, 'name')
      || !Object.hasOwn(value, 'runtime')
      || !Object.hasOwn(value, 'code')
      || !Object.hasOwn(value, 'version')
      || !Object.hasOwn(value, 'hash')
    ) {
      return undefined;
    }

    const name = value.name;
    const runtime = value.runtime;
    const code = value.code;
    const version = value.version;
    const hash = value.hash;
    if (
      !isValidFunctionName(name)
      || !isRuntimeType(runtime)
      || typeof code !== 'string'
      || code.trim().length === 0
      || typeof version !== 'number'
      || !Number.isSafeInteger(version)
      || version <= 0
      || !isValidContentHash(hash)
    ) {
      return undefined;
    }

    const timeout = Object.hasOwn(value, 'timeout') ? value.timeout : undefined;
    if (
      timeout !== undefined
      && (
        typeof timeout !== 'number'
        || !Number.isInteger(timeout)
        || timeout < 1
        || timeout > MAX_FUNCTION_TIMEOUT
      )
    ) {
      return undefined;
    }

    const exportName = Object.hasOwn(value, 'exportName') ? value.exportName : undefined;
    if (
      exportName !== undefined
      && (runtime !== 'moonbit' || typeof exportName !== 'string')
    ) {
      return undefined;
    }

    const sourceMoonbitAbi = Object.hasOwn(value, 'moonbitAbi')
      ? value.moonbitAbi
      : undefined;
    const moonbitAbi = sourceMoonbitAbi === undefined
      ? undefined
      : normalizeMoonBitAbi(sourceMoonbitAbi);
    if (
      sourceMoonbitAbi !== undefined
      && (runtime !== 'moonbit' || moonbitAbi === undefined)
    ) {
      return undefined;
    }

    const noFallback = Object.hasOwn(value, 'noFallback')
      ? value.noFallback
      : undefined;
    if (noFallback !== undefined && typeof noFallback !== 'boolean') {
      return undefined;
    }

    return {
      name,
      runtime,
      code,
      version,
      hash,
      ...(exportName !== undefined && { exportName }),
      ...(moonbitAbi !== undefined && { moonbitAbi }),
      ...(timeout !== undefined && { timeout }),
      ...(noFallback !== undefined && { noFallback }),
    };
  } catch {
    return undefined;
  }
}

export function isValidFunctionDefinition(def: unknown): def is FunctionDefinition {
  return normalizeFunctionDefinition(def) !== undefined;
}

/**
 * Options for function execution
 *
 * Controls execution behavior including timeout, diagnostics, and execution mode.
 */
export interface ExecutionOptions {
  /** Maximum execution time in milliseconds (default: 50ms for QuickJS) */
  timeout?: number;
  /** Enable diagnostic information in result (execution time, cache status, etc.) */
  diagnostics?: boolean;
  /** Execution mode affecting fallback behavior */
  mode?: 'production' | 'development' | 'browser-only';
}

/**
 * Result of function execution with diagnostic information
 *
 * Returned when diagnostics are enabled in ExecutionOptions.
 * Provides transparency about where and how the function was executed.
 */
export interface ExecutionResult<T = unknown> {
  /** Function return value */
  value: T;
  /** Where the function was executed */
  executedOn: 'browser' | 'server';
  /** Which runtime was used */
  runtime: RuntimeType;
  /** Execution time in milliseconds */
  durationMs: number;
  /** Whether the function code was served from cache */
  cached: boolean;
}
