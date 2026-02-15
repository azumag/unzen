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
 * - Fresh context per execution: prevents cross-execution pollution
 */

import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';
import { UnzenRuntimeError, UnzenFunctionError, SANDBOX_SECURITY_INIT, type ExecutionOptions } from '@unzen/shared';

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

    const timeout = options?.timeout ?? 50; // Default 50ms timeout

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
      const loadCodeResult = context.evalCode(code);
      if (loadCodeResult.error) {
        const error = context.dump(loadCodeResult.error);
        loadCodeResult.error.dispose();
        throw new UnzenFunctionError(`Failed to load function code: ${JSON.stringify(error)}`);
      }
      loadCodeResult.value.dispose();

      // Inject arguments into QuickJS context using JSON encoding
      // Note: This encoding doesn't preserve undefined in arrays, but that's acceptable
      // for the function execution use case (undefined becomes null in JSON)
      const argsJson = JSON.stringify(args);
      const argsResult = context.evalCode(`globalThis.__args__ = ${argsJson}`);
      if (argsResult.error) {
        argsResult.error.dispose();
        throw new UnzenRuntimeError('Failed to inject arguments into context');
      }
      argsResult.value.dispose();

      // Call the run() function with spread arguments
      const wrappedCode = `run(...globalThis.__args__)`;

      // Set timeout by configuring interrupt handler
      // QuickJS will check this periodically during execution
      const startTime = Date.now();
      let timeoutTriggered = false;
      context.runtime.setInterruptHandler(() => {
        const exceeded = Date.now() - startTime > timeout;
        if (exceeded) timeoutTriggered = true;
        return exceeded;
      });

      // Execute the wrapped code
      const result = context.evalCode(wrappedCode);

      // Check if execution failed
      if (result.error) {
        const error = context.dump(result.error);
        result.error.dispose();

        // Check if this was a timeout
        if (timeoutTriggered || JSON.stringify(error).includes('interrupted')) {
          throw new UnzenRuntimeError(`Execution timeout exceeded (${timeout}ms)`);
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
