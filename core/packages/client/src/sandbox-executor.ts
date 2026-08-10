/**
 * SandboxExecutor interface
 *
 * Defines contract for code execution in sandboxed environment.
 * Extracted into its own file so both Node.js and browser entry points
 * can import it without pulling in Node.js-only dependencies (vm module).
 *
 * All implementations must:
 * - Execute code with provided arguments
 * - Return function result
 * - Throw UnzenFunctionError on execution error
 * - Support cleanup via dispose()
 */

/**
 * Optional per-execution controls passed to execute().
 *
 * `signal` lets the caller cancel a queued or running request. Implementations
 * must settle the returned promise with UnzenCancelledError on abort, and must
 * never treat cancellation as a recoverable runtime failure.
 */
export interface ExecuteOptions {
  /** AbortSignal that cancels this request (queued or running) */
  signal?: AbortSignal;
  /** Export to call on a module-based runtime (e.g. MoonBit wasm-gc); ignored
   * by source-based runtimes (QuickJS). */
  exportName?: string;
}

export interface SandboxExecutor {
  /**
   * Execute code in sandbox
   *
   * @param code - JavaScript code to execute (must define 'run' function)
   * @param args - Arguments to pass to the 'run' function
   * @param options - Optional per-execution controls (e.g. AbortSignal)
   * @returns Function result
   * @throws {UnzenFunctionError} When code execution fails
   * @throws {UnzenCancelledError} When the caller aborts via options.signal
   *
   * Contract:
   * - Code must define a function named 'run'
   * - The 'run' function will be called with args
   * - Any error during execution becomes UnzenFunctionError
   * - Aborting options.signal rejects with UnzenCancelledError
   */
  execute(code: string, args: unknown[], options?: ExecuteOptions): Promise<unknown>;

  /**
   * Optional: fetch and prepare a module ahead of execution.
   *
   * Used by runtimes whose `code` is a module URL rather than source text
   * (e.g. MoonBit wasm-gc). The client calls this during the code-fetch phase
   * so the module is ready before browser-execution-started. Implementations
   * without a separate preparation step can omit it.
   */
  prepare?(code: string, signal?: AbortSignal): Promise<unknown>;

  /**
   * Whether the sandbox runtime is ready to execute without (re)initialization.
   *
   * Implementations that lazily initialize (e.g. WebWorkerSandboxExecutor)
   * return false until their runtime is ready; the client uses this to surface
   * a `sandbox-initializing` lifecycle event. Optional: a sandbox without lazy
   * initialization can omit it and is treated as always ready.
   */
  isReady?(): boolean;

  /**
   * Clean up resources
   *
   * Should be called when executor is no longer needed.
   * Implementation should be idempotent (safe to call multiple times).
   */
  dispose(): void;
}
