/**
 * UnzenClient - Main client SDK
 *
 * Entry point for executing functions in the QJS-proto framework.
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
import { MockSandboxExecutor, type SandboxExecutor } from './quickjs-sandbox';

/**
 * Diagnostic result type for callWithDiagnostics
 *
 * Success case: { success: true, result: T }
 * Error case: { success: false, error: {type, message} }
 */
export type DiagnosticResult<T = unknown> =
  | { success: true; result: T; error?: never }
  | { success: false; result?: never; error: { type: string; message: string } };

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

    // Use mock sandbox for MVP
    // In Phase 2+, this will be WebWorkerSandboxExecutor
    this.sandboxExecutor = new MockSandboxExecutor();
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
   * Returns DiagnosticResult with success flag, result, and error details.
   * Never throws (errors are captured in result).
   *
   * @param name - Function name
   * @param args - Function arguments
   * @returns DiagnosticResult with success/error info
   */
  async callWithDiagnostics<T = unknown>(
    name: string,
    ...args: unknown[]
  ): Promise<DiagnosticResult<T>> {
    try {
      const result = await this.call<T>(name, ...args);
      return {
        success: true,
        result,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          type:
            error instanceof UnzenFunctionError
              ? 'function_error'
              : 'runtime_error',
          message: error instanceof Error ? error.message : String(error),
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
