/**
 * QuickJSRuntime - Server-side JavaScript execution using QuickJS Wasm
 *
 * This class provides a sandboxed JavaScript runtime for server-side fallback execution.
 * It uses quickjs-emscripten to run JavaScript in a memory-safe, isolated environment.
 *
 * Design rationale:
 * - Each execution creates a fresh context to prevent state leakage
 * - eval() and Function constructor are removed for security
 * - Memory and timeout limits prevent DoS attacks
 * - Manual memory management (.dispose()) required due to QuickJS's C memory model
 *
 * Security constraints:
 * - Memory limit: 16MB (prevents excessive memory consumption)
 * - Timeout: 50ms default (prevents infinite loops)
 * - No eval/Function: prevents arbitrary code injection
 * - Synchronous materialized results only (no thenables or iterators)
 * - Fresh context per execution: prevents cross-execution pollution
 */

import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';
import {
  MAX_EXECUTION_ARGUMENTS,
  MAX_FUNCTION_TIMEOUT,
  SANDBOX_SECURITY_INIT,
  SANDBOX_SYNCHRONOUS_EXECUTION,
  UnzenFunctionError,
  UnzenRuntimeError,
  type ExecutionOptions,
} from '@unzen/shared';

interface QuickJSExecutionSnapshot {
  code: string;
  argsJson: string;
  timeout: number;
}

/** Validate and own direct-call inputs before allocating a QuickJS context. */
function snapshotExecution(
  code: unknown,
  args: unknown,
  options: unknown,
): QuickJSExecutionSnapshot {
  let requestedTimeout: unknown;
  if (options !== undefined) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new UnzenFunctionError('QuickJS execution options must be an object');
    }
    try {
      requestedTimeout = (options as Record<string, unknown>).timeout;
    } catch {
      throw new UnzenFunctionError('QuickJS execution options could not be read');
    }
  }
  const timeout = requestedTimeout === undefined ? 50 : requestedTimeout;
  if (
    typeof timeout !== 'number'
    || !Number.isInteger(timeout)
    || timeout < 1
    || timeout > MAX_FUNCTION_TIMEOUT
  ) {
    throw new UnzenFunctionError(
      `QuickJS timeout must be an integer between 1 and ${MAX_FUNCTION_TIMEOUT}ms`,
    );
  }

  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new UnzenFunctionError('QuickJS code must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new UnzenFunctionError('QuickJS arguments must be an array');
  }

  let argumentCount: unknown;
  try {
    argumentCount = args.length;
  } catch {
    throw new UnzenFunctionError('QuickJS arguments could not be read');
  }
  if (
    typeof argumentCount !== 'number'
    || !Number.isSafeInteger(argumentCount)
    || argumentCount < 0
    || argumentCount > MAX_EXECUTION_ARGUMENTS
  ) {
    throw new UnzenFunctionError(
      `QuickJS supports at most ${MAX_EXECUTION_ARGUMENTS} arguments`,
    );
  }

  try {
    const snapshotArgs = new Array<unknown>(argumentCount);
    for (let index = 0; index < argumentCount; index += 1) {
      snapshotArgs[index] = args[index];
    }
    const argsJson = JSON.stringify(snapshotArgs);
    if (typeof argsJson !== 'string') {
      throw new Error('serialization returned no payload');
    }
    return { code, argsJson, timeout };
  } catch {
    throw new UnzenFunctionError(
      `QuickJS arguments must be JSON-serializable and contain at most `
      + `${MAX_EXECUTION_ARGUMENTS} items`,
    );
  }
}

export class QuickJSRuntime {
  private quickJS: QuickJSWASMModule | null = null;

  /**
   * Initialize QuickJS Wasm module
   *
   * Must be called before execute(). Loads the QuickJS Wasm binary
   * and prepares the runtime for execution.
   */
  async initialize(): Promise<void> {
    // getQuickJS() returns a singleton WASM module instance
    // This is a one-time initialization that loads the ~505KB Wasm binary
    this.quickJS = await getQuickJS();
  }

  /**
   * Execute JavaScript code with given arguments
   *
   * Creates a fresh QuickJS context for each execution to ensure isolation.
   * The code is wrapped in a function with 'args' parameter for argument passing.
   *
   * @param code - JavaScript code to execute (should use 'return' statement)
   * @param args - Arguments to pass to the function
   * @param options - Execution options (timeout, etc.)
   * @returns Function result
   * @throws UnzenRuntimeError for runtime errors (timeout, disposed runtime)
   * @throws UnzenFunctionError for syntax/execution errors
   */
  async execute(code: string, args: unknown[], options?: ExecutionOptions): Promise<unknown> {
    if (!this.quickJS) {
      throw new UnzenRuntimeError('QuickJS runtime not initialized. Call initialize() first.');
    }

    const execution = snapshotExecution(code, args, options);

    // Create a fresh context for this execution
    // This ensures complete isolation between executions
    const context = this.quickJS.newContext();

    // Set memory limit to 16MB (design.md §3.3)
    // This prevents DoS attacks via excessive memory consumption
    context.runtime.setMemoryLimit(16 * 1024 * 1024);

    try {
      // Apply security hardening from shared module.
      // This cuts Function constructor chains, removes dangerous globals,
      // and freezes built-in prototypes. See sandbox-security.ts for details.
      const removeResult = context.evalCode(SANDBOX_SECURITY_INIT);
      if (removeResult.error) {
        removeResult.error.dispose();
        throw new UnzenRuntimeError('Failed to remove unsafe globals');
      }
      removeResult.value.dispose();

      // Load the user's code (which defines a `run` function)
      // The code is expected to define: function run(...args) { ... }
      const loadCodeResult = context.evalCode(execution.code);
      if (loadCodeResult.error) {
        const error = context.dump(loadCodeResult.error);
        loadCodeResult.error.dispose();
        throw new UnzenFunctionError(`Failed to load function code: ${JSON.stringify(error)}`);
      }
      loadCodeResult.value.dispose();

      // Inject arguments into QuickJS context using JSON encoding
      // Note: This encoding doesn't preserve undefined in arrays, but that's acceptable
      // for the function execution use case (undefined becomes null in JSON)
      const argsResult = context.evalCode(`globalThis.__args__ = ${execution.argsJson}`);
      if (argsResult.error) {
        argsResult.error.dispose();
        throw new UnzenRuntimeError('Failed to inject arguments into context');
      }
      argsResult.value.dispose();

      // Set timeout by configuring interrupt handler
      // QuickJS will check this periodically during execution
      const startTime = Date.now();
      let timeoutTriggered = false;
      context.runtime.setInterruptHandler(() => {
        const exceeded = Date.now() - startTime > execution.timeout;
        if (exceeded) timeoutTriggered = true;
        return exceeded;
      });

      // Execute and reject deferred or iterator results at the sandbox boundary
      const result = context.evalCode(SANDBOX_SYNCHRONOUS_EXECUTION);

      // Check if execution failed
      if (result.error) {
        const error = context.dump(result.error);
        result.error.dispose();

        // Check if this was a timeout
        if (timeoutTriggered || JSON.stringify(error).includes('interrupted')) {
          throw new UnzenRuntimeError(`Execution timeout exceeded (${execution.timeout}ms)`);
        }

        throw new UnzenFunctionError(`Function execution failed: ${JSON.stringify(error)}`);
      }

      // Dump the result to JavaScript value
      const value = context.dump(result.value);
      result.value.dispose();

      return value;
    } catch (error) {
      // Re-throw our custom errors as-is
      if (error instanceof UnzenRuntimeError || error instanceof UnzenFunctionError) {
        throw error;
      }

      // Wrap unknown errors
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new UnzenFunctionError(`Function execution failed: ${errorMessage}`);
    } finally {
      // Clean up context resources
      // QuickJS uses manual memory management, so we must dispose
      context.dispose();
    }
  }

  /**
   * Clean up runtime resources
   *
   * Must be called when the runtime is no longer needed.
   * After disposal, the runtime cannot be used for execution.
   */
  dispose(): void {
    // Mark as disposed by setting to null
    // Subsequent execute() calls will throw error
    this.quickJS = null;
  }
}
