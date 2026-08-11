/**
 * QuickJS Sandbox - Interface and mock implementation
 *
 * Provides an interface for executing JavaScript code in a sandboxed environment.
 *
 * MVP Implementation (Phase 1):
 * - MockSandboxExecutor: Executes code using Node.js vm module
 * - NOT secure (same process, shared memory)
 * - For testing purposes only
 *
 * Future Implementation (Phase 2+):
 * - WebWorkerSandboxExecutor: Executes code in Web Worker
 * - Uses QuickJS Wasm for sandboxing
 * - True isolation via worker + wasm
 *
 * Design rationale:
 * - Interface allows swapping implementations without changing client code
 * - Mock implementation enables TDD without complex wasm setup
 * - Real implementation will be added in Phase 2
 */

import {
  UnzenCancelledError,
  UnzenFunctionError,
  assertSynchronousUnzenResult,
} from '@unzen/shared';
import { createContext, Script } from 'vm';
import type { SandboxExecutor } from './sandbox-executor';

// Re-export SandboxExecutor from its own file for backwards compatibility.
// The interface is in a separate file so browser entry points can import it
// without pulling in Node.js vm dependency.
export type { SandboxExecutor } from './sandbox-executor';

/**
 * MockSandboxExecutor - Node.js vm-based implementation for testing
 *
 * WARNING: This is NOT secure and should ONLY be used for testing.
 *
 * Limitations:
 * - Runs in same process (no true isolation)
 * - Can access Node.js APIs if not careful
 * - Not suitable for production use
 *
 * Why we use this for MVP:
 * - Enables TDD without complex wasm setup
 * - Fast to implement and test
 * - Real implementation can be swapped in later
 *
 * Implementation details:
 * - Uses Node.js vm module for code execution
 * - Creates fresh context for each execute() call
 * - Catches errors and wraps in UnzenFunctionError
 */
export class MockSandboxExecutor implements SandboxExecutor {

  /**
   * The mock is synchronously ready — no lazy Wasm/worker initialization.
   */
  isReady(): boolean {
    return true;
  }

  /**
   * Execute code in Node.js vm context
   *
   * Process:
   * 1. Create fresh VM context
   * 2. Execute code to define 'run' function
   * 3. Call 'run' function with args
   * 4. Return result
   *
   * @param code - JavaScript code defining 'run' function
   * @param args - Arguments for 'run' function
   * @param options - Optional per-execution controls (signal is accepted and
   *   honoured for interface parity, though vm execution is synchronous)
   * @returns Result from 'run' function
   * @throws {UnzenFunctionError} On any execution error
   */
  async execute(
    code: string,
    args: unknown[],
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    // Honour caller cancellation even for the synchronous mock executor:
    // a request that was already aborted must not start executing.
    if (options?.signal?.aborted) {
      throw new UnzenCancelledError('Execution cancelled by caller');
    }
    try {
      // Create fresh context for this execution
      // Rationale: Each execution should be isolated from others
      // Note: vm.createContext provides limited isolation, not security
      const context = createContext({
        // Provide minimal global environment
        // Real implementation would use QuickJS with no Node.js access
        Array,
        Object,
        String,
        Number,
        Boolean,
        Math,
        JSON,
        Error,
      });

      // Execute code to define 'run' function
      // This compiles and runs the user code in the context
      const script = new Script(code);
      script.runInContext(context);

      // Check if 'run' function was defined
      // User code must export a 'run' function
      if (typeof context.run !== 'function') {
        throw new UnzenFunctionError(
          'Code must define a function named "run"'
        );
      }

      // Call 'run' function with provided arguments
      const result = (context.run as (...a: unknown[]) => unknown)(...args);
      assertSynchronousUnzenResult(result);

      return result;
    } catch (error) {
      // Wrap all errors as UnzenFunctionError
      // Rationale: Execution errors are user code errors, not runtime errors
      if (error instanceof UnzenFunctionError) {
        throw error;
      }

      throw new UnzenFunctionError(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Clean up resources
   *
   * For MockSandboxExecutor, there's nothing to clean up
   * (vm contexts are garbage collected automatically).
   * This method exists to satisfy the interface contract.
   *
   * In real implementation (Phase 2+), this would:
   * - Terminate Web Worker
   * - Release WASM memory
   * - Clear message handlers
   */
  dispose(): void {
    // No-op for mock implementation
  }
}
