/**
 * @unzen/shared
 *
 * Shared types and utilities for unzen core framework.
 *
 * This package contains:
 * - Protocol definitions for browser-server communication
 * - Common type definitions
 * - Error classes for consistent error handling
 *
 * Design principles:
 * - No external runtime dependencies (keep lightweight)
 * - Strong typing with TypeScript
 * - ESM-only for modern browser/Node compatibility
 *
 * @module @unzen/shared
 */

// Type definitions
export {
  type RuntimeType,
  type MoonBitAbiType,
  type MoonBitAbi,
  type FunctionDefinition,
  type ExecutionOptions,
  type ExecutionResult,
  isRuntimeType,
  isValidFunctionName,
  isValidContentHash,
  isMoonBitAbiType,
  normalizeMoonBitAbi,
  isValidMoonBitAbi,
  MAX_MOONBIT_ABI_PARAMS,
  isValidFunctionDefinition,
  MAX_FUNCTION_TIMEOUT,
} from './types';

// Error classes
export {
  UnzenError,
  UnzenRuntimeError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenCancelledError,
  UnzenDeadlineExceededError,
} from './errors';

// Sandbox security hardening (shared between server and client QuickJS runtimes)
export {
  SANDBOX_DISABLED_GLOBALS,
  SANDBOX_SECURITY_INIT,
} from './sandbox-security';
export {
  SANDBOX_SYNCHRONOUS_EXECUTION,
  UNZEN_ASYNC_RESULT_ERROR,
  UNZEN_ITERATOR_RESULT_ERROR,
  assertSynchronousUnzenResult,
} from './sandbox-execution';

// Protocol types
export {
  type ManifestRequest,
  type ManifestResponse,
  type FunctionManifestEntry,
  type ExecutionRequest,
  type ExecutionResponse,
  MAX_EXECUTION_ARGUMENTS,
  createManifestResponse,
  normalizeManifestResponse,
  isValidManifestResponse,
  createExecutionResponse,
  normalizeExecutionResponse,
  isValidExecutionResponse,
} from './protocol';
