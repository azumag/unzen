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

import { UnzenFunctionError, UnzenNetworkError } from '@unzen/shared';

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
   * @returns Function result
   * @throws {UnzenFunctionError} When function execution fails (user code error)
   * @throws {UnzenNetworkError} When network or server error occurs
   */
  async execute(name: string, args: unknown[]): Promise<unknown> {
    const url = `${this.endpoint}/exec/${name}`;
    const body = JSON.stringify({ args });

    try {
      // Make HTTP request to server
      const response = await globalThis.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
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
        // 4xx errors indicate user code / request issues → FunctionError
        // This preserves the server's UnzenFunctionError classification
        if (response.status >= 400 && response.status < 500) {
          throw new UnzenFunctionError(data.error);
        }
        // 5xx or other errors with error body → FunctionError (server wrapped it)
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

      // Wrap other errors (fetch failure, JSON parse error, etc.) as network error
      // These are infrastructure errors, not user code errors
      throw new UnzenNetworkError(
        `Failed to execute fallback: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
