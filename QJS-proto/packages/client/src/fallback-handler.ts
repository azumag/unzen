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

      // Check HTTP status
      // Non-2xx status indicates server error, not function error
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Server returned ${response.status}: ${response.statusText}`
        );
      }

      // Parse response JSON
      const data = await response.json();

      // Check for function error in response
      // Function errors are returned with 200 OK but contain error field
      // This distinguishes user code errors from infrastructure errors
      if (data.error) {
        throw new UnzenFunctionError(data.error);
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
