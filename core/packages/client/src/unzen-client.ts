/**
 * UnzenClient - Main client SDK
 *
 * Entry point for executing functions in the unzen core framework.
 * Orchestrates manifest fetching, code loading, sandbox execution,
 * and fallback to server.
 *
 * Execution modes:
 * - development: Always use server fallback (fast iteration)
 * - production: Try browser execution, fallback on runtime error
 * - browser-only: Browser execution only, no fallback
 *
 * Execution flow (production mode):
 * 1. Fetch manifest to get function metadata
 * 2. Fetch function code from URL
 * 3. Execute in browser sandbox
 * 4. If UnzenRuntimeError → fallback to server
 * 5. If UnzenFunctionError → throw immediately (no fallback)
 *
 * Design rationale:
 * - Development mode speeds up iteration (no browser execution overhead)
 * - Production mode optimizes for performance (browser execution is faster)
 * - Browser-only mode for scenarios where server is unavailable
 * - Function errors don't fallback (user code bugs should be fixed, not masked)
 * - Runtime errors fallback (environment issues are recoverable)
 */

import { UnzenFunctionError, UnzenRuntimeError } from '@unzen/shared';
import { FallbackHandler } from './fallback-handler';
import { ManifestFetcher } from './manifest-fetcher';
import { CodeFetcher } from './code-fetcher';
import type { SandboxExecutor } from './sandbox-executor';
import { WebWorkerSandboxExecutor } from './web-worker-sandbox';

/**
 * Diagnostic metadata returned with successful callWithDiagnostics() calls.
 * Provides transparency about where, how fast, and whether caching was used.
 */
export interface DiagnosticInfo {
  /** Where the function was executed: browser sandbox or server fallback */
  executedOn: 'browser' | 'server';
  /** Total execution time in milliseconds (includes fetch + sandbox/server time) */
  durationMs: number;
  /** Whether the manifest was already cached when this call was made */
  cached: boolean;
}

/**
 * Partial diagnostic info included with error results.
 * Always includes durationMs and cached (measurable regardless of success/failure).
 * executedOn is included when we know where the error occurred.
 */
export interface PartialDiagnosticInfo {
  /** Where the error occurred, if determinable */
  executedOn?: 'browser' | 'server';
  /** Total time from call start to error, in milliseconds */
  durationMs: number;
  /** Whether the manifest was already cached when this call was made */
  cached: boolean;
}

/**
 * Diagnostic result type for callWithDiagnostics
 *
 * Success case: { success: true, result: T, diagnostics: DiagnosticInfo }
 * Error case: { success: false, error: {type, message}, diagnostics: PartialDiagnosticInfo }
 *
 * Both success and error cases include diagnostics. On error, diagnostics
 * always include durationMs and cached; executedOn is included when the
 * error location is determinable.
 *
 * Error types:
 * - 'function_error': User code bug (e.g., throw in function, function not found)
 * - 'browser_runtime_error': Browser sandbox failure (Wasm issue, timeout, etc.)
 * - 'server_runtime_error': Server fallback failure (network, endpoint down)
 * - 'client_disposed': Client was disposed before this call
 */
export type DiagnosticResult<T = unknown> =
  | { success: true; result: T; diagnostics: DiagnosticInfo; error?: never }
  | { success: false; result?: never; error: { type: string; message: string }; diagnostics: PartialDiagnosticInfo };

/**
 * Client configuration options
 */
export interface UnzenClientOptions {
  /**
   * Server endpoint URL (e.g., "https://example.com")
   */
  endpoint: string;

  /**
   * Execution mode
   * - production: Try browser, fallback to server (default)
   * - development: Always use server (fast iteration)
   * - browser-only: Browser only, no fallback
   */
  mode?: 'production' | 'development' | 'browser-only';

  /**
   * URL to the QuickJS worker script (e.g., '/worker.js').
   * When provided, uses WebWorkerSandboxExecutor for browser-side execution
   * with 4-layer isolation (Web Worker + Wasm + QuickJS + API restrictions).
   * When omitted, falls back to MockSandboxExecutor (NOT secure, for testing only).
   */
  workerUrl?: string;

  /**
   * Custom SandboxExecutor instance (advanced usage).
   * Takes precedence over workerUrl if both are provided.
   * Allows injecting custom sandbox implementations for testing or
   * alternative isolation strategies.
   */
  sandbox?: SandboxExecutor;
}

/**
 * UnzenClient - Main SDK class
 *
 * Usage:
 * ```typescript
 * const client = new UnzenClient({ endpoint: 'https://example.com' });
 * const result = await client.call('add', 1, 2);
 * client.dispose();
 * ```
 */
export class UnzenClient {
  private readonly endpoint: string;
  private readonly mode: 'production' | 'development' | 'browser-only';

  // Components
  private readonly fallbackHandler: FallbackHandler;
  private readonly manifestFetcher: ManifestFetcher;
  private readonly codeFetcher: CodeFetcher;
  private readonly sandboxExecutor: SandboxExecutor;

  // Disposal tracking
  private disposed = false;

  constructor(options: UnzenClientOptions) {
    this.endpoint = options.endpoint;
    this.mode = options.mode ?? 'production';

    // Initialize components
    this.fallbackHandler = new FallbackHandler(this.endpoint);
    this.manifestFetcher = new ManifestFetcher(this.endpoint);
    this.codeFetcher = new CodeFetcher(this.endpoint);

    // Select sandbox executor: explicit sandbox > workerUrl > error
    // - options.sandbox: Custom executor (advanced usage / testing)
    // - options.workerUrl: WebWorkerSandboxExecutor with 4-layer isolation (production)
    // - error: No fallback — workerUrl or sandbox must be provided
    if (options.sandbox) {
      this.sandboxExecutor = options.sandbox;
    } else if (options.workerUrl) {
      this.sandboxExecutor = new WebWorkerSandboxExecutor({ workerUrl: options.workerUrl });
    } else {
      throw new Error(
        'UnzenClient requires either workerUrl or sandbox option. '
        + 'Use workerUrl for browser execution or provide a custom SandboxExecutor.'
      );
    }
  }

  /**
   * Call a function
   *
   * @param name - Function name
   * @param args - Function arguments
   * @returns Function result
   * @throws {UnzenFunctionError} When function execution fails
   * @throws {UnzenRuntimeError} When runtime error occurs (browser-only mode)
   *
   * Execution strategy by mode:
   * - development: Always server fallback
   * - production: Browser first, fallback on runtime error
   * - browser-only: Browser only, throw on any error
   */
  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    // Prevent use after disposal
    // Disposed client has released sandbox resources; execution would fail
    if (this.disposed) {
      throw new UnzenRuntimeError('Client has been disposed. Create a new instance.');
    }

    // Development mode: always use fallback
    if (this.mode === 'development') {
      return (await this.fallbackHandler.execute(name, args)) as T;
    }

    // Production/browser-only mode: try browser execution
    try {
      return (await this.executeBrowser(name, args)) as T;
    } catch (error) {
      // Function errors are NOT recovered by fallback
      // Rationale: User code bugs should be fixed, not masked
      if (error instanceof UnzenFunctionError) {
        throw error;
      }

      // Runtime errors in browser-only mode are fatal
      if (this.mode === 'browser-only') {
        throw error;
      }

      // Production mode: fallback on runtime error
      // Rationale: Environment issues (WASM failure, etc.) are recoverable
      return (await this.fallbackHandler.execute(name, args)) as T;
    }
  }

  /**
   * Call a function with diagnostics
   *
   * Returns DiagnosticResult with success flag, result, diagnostics, and error details.
   * Never throws (errors are captured in result).
   *
   * Unlike call(), this method implements its own execution flow to track:
   * - executedOn: whether the function ran in browser or on server
   * - durationMs: total execution time including fetch and execution
   * - cached: whether the manifest was already in cache before this call
   *
   * @param name - Function name
   * @param args - Function arguments
   * @returns DiagnosticResult with success/error info and diagnostics
   */
  async callWithDiagnostics<T = unknown>(
    name: string,
    ...args: unknown[]
  ): Promise<DiagnosticResult<T>> {
    // Check if manifest is already cached before this call starts.
    // This provides insight into whether we needed a network round-trip for the manifest.
    const wasCached = this.manifestFetcher.isCached();
    const startTime = performance.now();

    // Track where execution was attempted for error diagnostics.
    // This is set as execution progresses so we know where the error occurred.
    let lastAttemptedOn: 'browser' | 'server' | undefined;

    try {
      // Prevent use after disposal
      if (this.disposed) {
        // No execution attempted — return 'client_disposed' error type
        // with durationMs but without executedOn (no execution location applies)
        return {
          success: false,
          error: {
            type: 'client_disposed',
            message: 'Client has been disposed. Create a new instance.',
          },
          diagnostics: {
            durationMs: performance.now() - startTime,
            cached: wasCached,
          },
        };
      }

      let result: T;
      let executedOn: 'browser' | 'server';

      if (this.mode === 'development') {
        // Development mode: always use server fallback
        lastAttemptedOn = 'server';
        result = (await this.fallbackHandler.execute(name, args)) as T;
        executedOn = 'server';
      } else {
        // Production/browser-only mode: try browser execution
        try {
          lastAttemptedOn = 'browser';
          result = (await this.executeBrowser(name, args)) as T;
          executedOn = 'browser';
        } catch (error) {
          // Function errors are NOT recovered by fallback
          if (error instanceof UnzenFunctionError) {
            throw error;
          }

          // Runtime errors in browser-only mode are fatal
          if (this.mode === 'browser-only') {
            throw error;
          }

          // Production mode: fallback on runtime error
          lastAttemptedOn = 'server';
          result = (await this.fallbackHandler.execute(name, args)) as T;
          executedOn = 'server';
        }
      }

      const durationMs = performance.now() - startTime;

      return {
        success: true,
        result,
        diagnostics: {
          executedOn,
          durationMs,
          cached: wasCached,
        },
      };
    } catch (error) {
      // Determine specific error type based on error class and execution context.
      // This provides consumers with actionable information about what went wrong
      // and where it happened.
      let errorType: string;
      if (error instanceof UnzenFunctionError) {
        errorType = 'function_error';
      } else if (lastAttemptedOn === 'server') {
        errorType = 'server_runtime_error';
      } else {
        // Browser-side runtime error (Wasm failure, timeout, etc.)
        errorType = 'browser_runtime_error';
      }

      return {
        success: false,
        error: {
          type: errorType,
          message: error instanceof Error ? error.message : String(error),
        },
        diagnostics: {
          executedOn: lastAttemptedOn,
          durationMs: performance.now() - startTime,
          cached: wasCached,
        },
      };
    }
  }

  /**
   * Execute function in browser
   *
   * @param name - Function name
   * @param args - Function arguments
   * @returns Function result
   * @throws {UnzenFunctionError} When function execution fails or function not found
   * @throws {UnzenRuntimeError} When runtime error occurs
   *
   * Steps:
   * 1. Fetch manifest to get function metadata
   * 2. Check if function exists
   * 3. Fetch function code
   * 4. Execute in sandbox
   */
  private async executeBrowser(
    name: string,
    args: unknown[]
  ): Promise<unknown> {
    // 1. Fetch manifest
    // This is cached after first call, so subsequent calls are fast
    const manifest = await this.manifestFetcher.fetch();

    // 2. Get function entry
    const entry = manifest.functions[name];
    if (!entry) {
      // Function not in manifest is a user error (calling non-existent function)
      // Not a runtime error, so this will NOT trigger fallback in production mode
      throw new UnzenFunctionError(
        `Function "${name}" not found in manifest`
      );
    }

    // 3. Fetch function code
    // This is cached by hash, so identical code is fetched only once
    const code = await this.codeFetcher.fetch(entry);

    // 4. Execute in sandbox
    // Sandbox executor throws UnzenFunctionError on user code errors
    return await this.sandboxExecutor.execute(code, args);
  }

  /**
   * Clean up resources
   *
   * Should be called when client is no longer needed.
   * Idempotent (safe to call multiple times).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    // Clean up sandbox executor
    // In real implementation, this would terminate Web Worker
    this.sandboxExecutor.dispose();

    this.disposed = true;
  }
}
