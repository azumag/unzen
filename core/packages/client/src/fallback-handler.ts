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
 * - Response: { result?: unknown, error?: { type: string, message: string } }
 */

import {
  UnzenCancelledError,
  UnzenFunctionError,
  UnzenNetworkError,
} from '@unzen/shared';
import { isAbortError, throwIfAborted } from './abort';

export class FallbackHandler {
  /**
   * Server endpoint URL (e.g., "https://example.com")
   * Used as base URL for all API requests
   */
  private readonly endpoint: string;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
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
   * @throws {UnzenFunctionError} When function execution fails (user code error)
   * @throws {UnzenNetworkError} When network or server error occurs
   */
  async execute(name: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    // Reject immediately if the caller already aborted before calling —
    // a cancelled request must never start (or continue on) the server.
    throwIfAborted(signal);

    const url = `${this.endpoint}/exec/${name}`;
    const body = JSON.stringify({ args });

    try {
      // Make HTTP request to server (signal cancels the request on abort)
      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });

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
      let data: { result?: unknown; error?: string };
      try {
        data = await response.json();
      } catch {
        // Response body not parseable as JSON → network/infrastructure error
        throw new UnzenNetworkError(
          `Server returned ${response.status}: ${response.statusText}`
        );
      }

      // Check for error in response body (present for both 4xx and 5xx)
      if (data.error) {
        // HTTP 5xx = server/runtime issues → NetworkError (retryable)
        // Server sends 500 for UnzenRuntimeError (timeout, OOM).
        // These are infrastructure problems, not user code bugs.
        if (response.status >= 500) {
          throw new UnzenNetworkError(data.error);
        }
        // HTTP 4xx or 2xx with error body → FunctionError (not retryable)
        // Server sends 400 for UnzenFunctionError (user code bug).
        // 2xx with error is an edge case but treated as function error.
        throw new UnzenFunctionError(data.error);
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
