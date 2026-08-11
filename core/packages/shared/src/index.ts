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

// Protocol types
export {
  type ManifestRequest,
  type ManifestResponse,
  type FunctionManifestEntry,
  type ExecutionRequest,
  type ExecutionResponse,
  createManifestResponse,
  createExecutionResponse,
} from './protocol';
