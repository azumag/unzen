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

export function isValidFunctionDefinition(def: unknown): def is FunctionDefinition {
  if (typeof def !== 'object' || def === null) {
    return false;
  }

  // Use Record<string, unknown> for safe property access without type assertion lies
  const d = def as Record<string, unknown>;

  // Validate optional timeout: must be integer in range [1, 2000]
  if (d.timeout !== undefined) {
    if (
      typeof d.timeout !== 'number' ||
      !Number.isInteger(d.timeout) ||
      d.timeout < 1 ||
      d.timeout > MAX_FUNCTION_TIMEOUT
    ) {
      return false;
    }
  }

  return (
    typeof d.name === 'string' &&
    SAFE_FUNCTION_NAME.test(d.name) &&
    isRuntimeType(d.runtime) &&
    typeof d.code === 'string' &&
    d.code.length > 0 &&
    typeof d.version === 'number' &&
    Number.isInteger(d.version) &&
    d.version > 0 &&
    typeof d.hash === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(d.hash)
  );
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
