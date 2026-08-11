/**
 * @unzen/client — Browser entry point
 *
 * Self-contained bundle for direct <script type="module"> usage in browsers.
 * Excludes MockSandboxExecutor (Node.js vm dependency) which is only for testing.
 * Use this entry when importing via a script tag rather than a bundler.
 */

// Main client class
export {
  UnzenClient,
  type UnzenClientOptions,
  type DiagnosticResult,
  type DiagnosticInfo,
  type PartialDiagnosticInfo,
  type UnzenExecutionRequest,
  type UnzenExecutionEvent,
  type ExecutionAttemptDiagnostic,
  type ExecutionDiagnostics,
  type ExecutionDiagnosticResult,
  type ExecutionErrorCode,
} from './unzen-client';

// Component classes (advanced usage)
export { FallbackHandler } from './fallback-handler';
export { ManifestFetcher } from './manifest-fetcher';
export { CodeFetcher } from './code-fetcher';

// Sandbox interface (no Node.js dependency)
export type { SandboxExecutor, ExecuteOptions } from './sandbox-executor';

// Browser-only sandbox implementation
export {
  WebWorkerSandboxExecutor,
  type WebWorkerSandboxOptions,
  type ExecutorDiagnostics,
} from './web-worker-sandbox';
export {
  MoonBitSandboxExecutor,
  type MoonBitSandboxOptions,
  type PreparedMoonBitModule,
} from './moonbit-sandbox';
export {
  MoonBitWorkerSandboxExecutor,
  type MoonBitWorkerSandboxOptions,
  type MoonBitExecutorDiagnostics,
} from './moonbit-worker-sandbox';
export type { MoonBitImportedStringConstants } from './moonbit-compile-options';

// Re-export commonly used types from @unzen/shared for convenience
export type {
  RuntimeType,
  MoonBitAbiType,
  MoonBitAbi,
  FunctionDefinition,
  ExecutionOptions,
  ExecutionResult,
  ManifestResponse,
  FunctionManifestEntry,
  ExecutionRequest,
  ExecutionResponse,
} from '@unzen/shared';

// Re-export error classes
export {
  UnzenError,
  UnzenRuntimeError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenCancelledError,
  UnzenDeadlineExceededError,
} from '@unzen/shared';
