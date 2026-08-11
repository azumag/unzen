/**
 * FallbackHandler - Server fallback execution client
 *
 * When browser-side execution fails with UnzenRuntimeError, this handler
 * sends the function call to the server for execution instead.
 *
 * Design rationale:
 * - Uses fetch API for HTTP requests (standard browser API)
 * - Distinguishes between function errors and network errors
 * - Function errors should NOT trigger retry (user code bug)
 * - Network errors should be retryable by caller
 *
 * Protocol:
 * - POST /exec/:functionName
 * - Request body: { args: unknown[] }
 * - Response: { result: unknown } or { result: null, error: string }
 */

import {
  MAX_EXECUTION_ARGUMENTS,
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
  isValidFunctionName,
  normalizeExecutionResponse,
} from '@unzen/shared';
import { isAbortError, throwIfAborted } from './abort';
import { normalizeUnzenEndpoint } from './endpoint';

export class FallbackHandler {
  /**
   * Server endpoint URL (e.g., "https://example.com")
   * Used as base URL for all API requests
   */
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = normalizeUnzenEndpoint(endpoint);
  }

  /**
   * Execute function on server
   *
   * @param name - Function name to execute
   * @param args - Function arguments
   * @param signal - Optional AbortSignal that cancels the server request.
   *   When the signal aborts, the promise rejects with UnzenCancelledError.
   * @returns Function result
   * @throws {UnzenCancelledError} When the caller aborts via signal
   * @throws {UnzenFunctionError} When inputs are invalid or execution fails
   * @throws {UnzenNetworkError} When network or server error occurs
   */
  async execute(name: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    // Reject immediately if the caller already aborted before calling —
    // a cancelled request must never start (or continue on) the server.
    throwIfAborted(signal);

    if (!isValidFunctionName(name)) {
      throw new UnzenFunctionError('Invalid fallback function name');
    }

    let body: string;
    try {
      if (!Array.isArray(args)) {
        throw new Error('Arguments must be an array');
      }
      const argumentCount = args.length;
      if (
        typeof argumentCount !== 'number'
        || !Number.isSafeInteger(argumentCount)
        || argumentCount < 0
        || argumentCount > MAX_EXECUTION_ARGUMENTS
      ) {
        throw new Error(`Too many arguments (max ${MAX_EXECUTION_ARGUMENTS})`);
      }

      // Snapshot by index before serialization. This fixes the request body at
      // call time and does not invoke a caller-supplied array iterator.
      const snapshot = new Array<unknown>(argumentCount);
      for (let index = 0; index < argumentCount; index++) {
        snapshot[index] = args[index];
      }
      const serialized = JSON.stringify({ args: snapshot });
      if (serialized === undefined) {
        throw new Error('Arguments could not be serialized');
      }
      body = serialized;
    } catch {
      throw new UnzenFunctionError(
        `Fallback arguments must be JSON-serializable and contain at most ${MAX_EXECUTION_ARGUMENTS} items`,
      );
    }
    throwIfAborted(signal);

    const url = `${this.endpoint}/exec/${name}`;

    try {
      // Make HTTP request to server (signal cancels the request on abort)
      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
      throwIfAborted(signal);

      // Parse response JSON regardless of status code
      // Server returns structured error responses for both 4xx and 5xx:
      //   - 400 + { error: "..." } = UnzenFunctionError (user code bug)
      //   - 500 + { error: "..." } = runtime/server error
      //   - 200 + { error: "..." } = function error during execution
      //   - 200 + { result: ... }  = success
      //
      // We must read the body before checking status to preserve
      // the server's error classification (400 = function error,
      // not a network error)
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          throw new UnzenCancelledError('Execution cancelled by caller');
        }
        // Response body not parseable as JSON → network/infrastructure error
        throw new UnzenNetworkError(
          `Server returned ${response.status}: ${response.statusText}`
        );
      }
      throwIfAborted(signal);

      const data = normalizeExecutionResponse(payload);
      if (data === undefined) {
        throw new UnzenNetworkError('Server returned an invalid fallback response');
      }

      // Check for error in response body (present for both 4xx and 5xx)
      if (data.error !== undefined) {
        // Only 2xx edge responses and 4xx server contract errors represent a
        // function/input failure. Redirects and 5xx remain infrastructure
        // failures even when an intermediary supplies an error envelope.
        if (
          response.ok
          || response.status === 400
          || response.status === 404
          || response.status === 422
        ) {
          throw new UnzenFunctionError(data.error);
        }
        throw new UnzenNetworkError(data.error);
      }

      // Non-OK response without error body → network/infrastructure error
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Server returned ${response.status}: ${response.statusText}`
        );
      }

      return data.result;
    } catch (error) {
      // Re-throw UnzenFunctionError and UnzenNetworkError as-is
      if (
        error instanceof UnzenCancelledError ||
        error instanceof UnzenFunctionError ||
        error instanceof UnzenNetworkError
      ) {
        throw error;
      }

      // Cancellation must surface as UnzenCancelledError, never as a network
      // error (which would look recoverable and mask a user cancellation).
      if (isAbortError(error) || signal?.aborted) {
        throw new UnzenCancelledError('Execution cancelled by caller');
      }

      // Wrap other errors (fetch failure, JSON parse error, etc.) as network error
      // These are infrastructure errors, not user code errors
      throw new UnzenNetworkError(
        `Failed to execute fallback: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
