/**
 * @unzen/client
 *
 * Browser client SDK for unzen core.
 *
 * Design principles:
 * - Zero runtime dependencies (besides @unzen/shared)
 * - Works in all modern browsers (ES2022+)
 * - Web Worker-based for non-blocking execution
 * - Transparent sandboxing via WASM
 *
 * Key responsibilities:
 * - Load and initialize WASM runtimes
 * - Execute code in sandboxed environment
 * - Communicate with server for coordination
 * - Handle function results and errors
 *
 * Main API:
 * ```typescript
 * import { UnzenClient } from '@unzen/client';
 *
 * const client = new UnzenClient({ endpoint: 'https://example.com' });
 * const result = await client.call('functionName', arg1, arg2);
 * client.dispose();
 * ```
 */

// Main client class
export {
  UnzenClient,
  type UnzenFunctionMap,
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
export {
  CodeFetcher,
  DEFAULT_MAX_CODE_CACHE_BYTES,
  type CodeFetcherOptions,
} from './code-fetcher';

// Sandbox interface (Node.js-safe, no vm dependency)
export type { SandboxExecutor, ExecuteOptions } from './sandbox-executor';

// Mock implementation (Node.js only — uses vm module)
export { MockSandboxExecutor } from './quickjs-sandbox';

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
export {
  clearUnzenCodeCache,
  registerUnzenCacheWorker,
  UNZEN_CODE_CACHE_NAME,
  type UnzenCacheWorkerOptions,
} from './unzen-cache';

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
