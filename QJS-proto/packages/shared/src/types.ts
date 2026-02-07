/**
 * Core type definitions for QJS-proto framework
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
}

/**
 * Validation function for FunctionDefinition
 *
 * Ensures all required fields are present and valid.
 *
 * @param def - Function definition to validate
 * @returns true if definition is valid
 */
export function isValidFunctionDefinition(def: unknown): def is FunctionDefinition {
  if (typeof def !== 'object' || def === null) {
    return false;
  }

  const d = def as Partial<FunctionDefinition>;

  return (
    typeof d.name === 'string' &&
    d.name.length > 0 &&
    isRuntimeType(d.runtime) &&
    typeof d.code === 'string' &&
    d.code.length > 0 &&
    typeof d.version === 'number' &&
    d.version > 0 &&
    typeof d.hash === 'string' &&
    d.hash.length > 0
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
