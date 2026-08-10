/**
 * Error class definitions for unzen core framework
 *
 * Provides hierarchical error types for different failure scenarios.
 * All errors extend from a base UnzenError class with error codes for
 * discriminated union patterns.
 */

/**
 * Base error class for all unzen framework errors
 *
 * Extends the built-in Error class with an error code for programmatic
 * error handling and categorization.
 *
 * @example
 * ```ts
 * try {
 *   // ...
 * } catch (e) {
 *   if (e instanceof UnzenError) {
 *     console.error(`[${e.code}] ${e.message}`);
 *   }
 * }
 * ```
 */
export class UnzenError extends Error {
  /**
   * Error code for categorization
   * Allows discriminated union patterns without instanceof checks
   */
  readonly code: string;

  /**
   * Create a new UnzenError
   *
   * @param message - Human-readable error message
   * @param code - Machine-readable error code for categorization
   */
  constructor(message: string, code: string) {
    super(message);
    this.name = 'UnzenError';
    this.code = code;

    // Maintains proper stack trace for where our error was thrown (V8-only)
    // Uses this.constructor so subclass constructors are excluded from trace
    // (e.g., UnzenRuntimeError stack starts at throw site, not constructor)
    const errorConstructor = Error as unknown as {
      captureStackTrace?: (target: Error, ctor: Function) => void;
    };

    if (typeof errorConstructor.captureStackTrace === 'function') {
      errorConstructor.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Runtime-level errors that trigger fallback behavior
 *
 * These errors occur when the runtime environment fails to execute the function.
 * They typically trigger fallback to server-side execution in production mode.
 *
 * Examples:
 * - Timeout exceeded (50ms default for QuickJS)
 * - Memory limit exceeded (16MB default)
 * - Wasm module load failure
 * - Worker initialization failure
 *
 * @example
 * ```ts
 * try {
 *   await unzen.call('myFunction', args);
 * } catch (e) {
 *   if (e instanceof UnzenRuntimeError) {
 *     // Framework will automatically fallback to server
 *     console.warn('Runtime error, falling back:', e.message);
 *   }
 * }
 * ```
 */
export class UnzenRuntimeError extends UnzenError {
  /**
   * Create a new runtime error
   *
   * @param message - Human-readable error message
   */
  constructor(message: string) {
    super(message, 'RUNTIME_ERROR');
    this.name = 'UnzenRuntimeError';
  }
}

/**
 * Function-level errors that do NOT trigger fallback
 *
 * These errors occur within the user-defined function itself.
 * They are propagated to the caller without triggering fallback behavior.
 *
 * Examples:
 * - User function throws an exception
 * - Type errors in function arguments
 * - Validation failures
 * - Business logic errors
 *
 * @example
 * ```ts
 * try {
 *   await unzen.call('validate', input);
 * } catch (e) {
 *   if (e instanceof UnzenFunctionError) {
 *     // This is a real error in the function logic
 *     console.error('Function error:', e.message);
 *   }
 * }
 * ```
 */
export class UnzenFunctionError extends UnzenError {
  /**
   * Create a new function error
   *
   * @param message - Human-readable error message
   */
  constructor(message: string) {
    super(message, 'FUNCTION_ERROR');
    this.name = 'UnzenFunctionError';
  }
}

/**
 * Network-level errors for communication failures
 *
 * These errors occur when client-server communication fails.
 * They may or may not be recoverable depending on the specific failure.
 *
 * Examples:
 * - Manifest fetch failure (404, 500, network error)
 * - Function code fetch failure
 * - Fallback API execution failure
 * - CORS issues
 *
 * @example
 * ```ts
 * try {
 *   await unzen.call('myFunction', args);
 * } catch (e) {
 *   if (e instanceof UnzenNetworkError) {
 *     // Network error - may be transient
 *     console.error('Network error:', e.message);
 *   }
 * }
 * ```
 */
export class UnzenNetworkError extends UnzenError {
  /**
   * Create a new network error
   *
   * @param message - Human-readable error message
   */
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
    this.name = 'UnzenNetworkError';
  }
}

/**
 * Cancellation errors raised when the caller aborts execution
 *
 * These errors occur when the caller deliberately cancels a request via an
 * AbortSignal. They are semantically distinct from runtime errors:
 * cancellation is an intentional caller decision, not an environment failure.
 *
 * The distinct code ('CANCELLED') lets orchestrators (e.g. UnzenClient) skip
 * server fallback for cancelled requests — a user who pressed "cancel" does not
 * want the work silently continued elsewhere.
 *
 * @example
 * ```ts
 * const controller = new AbortController();
 * try {
 *   await unzen.call('myFunction', args, { signal: controller.signal });
 * } catch (e) {
 *   if (e instanceof UnzenCancelledError) {
 *     // Caller aborted — do NOT retry or fallback
 *   }
 * }
 * ```
 */
export class UnzenCancelledError extends UnzenError {
  /**
   * Create a new cancellation error
   *
   * @param message - Human-readable error message
   */
  constructor(message: string) {
    super(message, 'CANCELLED');
    this.name = 'UnzenCancelledError';
  }
}

/**
 * Deadline-exceeded errors raised when a sandbox execution exceeds its time
 * budget (cooperative timeout or hard kill).
 *
 * A distinct code ('DEADLINE_EXCEEDED') lets the client report the failure
 * precisely instead of folding it into a generic runtime error: the user-visible
 * error code becomes `deadline_exceeded` rather than `browser_runtime_failed`.
 * Like all runtime errors it may trigger server fallback in production mode.
 */
export class UnzenDeadlineExceededError extends UnzenRuntimeError {
  /**
   * Create a new deadline-exceeded error
   *
   * @param message - Human-readable error message
   */
  constructor(message: string) {
    super(message);
    this.name = 'UnzenDeadlineExceededError';
    // Distinct stable code while remaining an UnzenRuntimeError so callers can
    // (a) instanceof-check it as a runtime failure (fallback-eligible) and
    // (b) route on the exact `DEADLINE_EXCEEDED` code (not a generic runtime).
    // The base `code` is declared readonly for the generic error classes; the
    // subclass narrows it in its own constructor.
    (this as { code: string }).code = 'DEADLINE_EXCEEDED';
  }
}
