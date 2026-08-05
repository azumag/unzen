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
   * Clean up resources
   *
   * Should be called when executor is no longer needed.
   * Implementation should be idempotent (safe to call multiple times).
   */
  dispose(): void;
}
