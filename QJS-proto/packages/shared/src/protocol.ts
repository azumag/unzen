/**
 * Protocol definitions for client-server communication
 *
 * Defines the HTTP API contract between client and server.
 * All messages are JSON-serializable for transmission over HTTP.
 */

import { FunctionDefinition, RuntimeType } from './types';

/**
 * Request type for fetching the function manifest
 *
 * Empty request - all information is in the URL path
 */
export interface ManifestRequest {}

/**
 * Response type for manifest endpoint
 *
 * Returns metadata about all available functions including
 * their runtime type, version, hash, and URL for fetching code.
 */
export interface ManifestResponse {
  /** Map of function name to manifest entry */
  functions: Record<string, FunctionManifestEntry>;
}

/**
 * Single function entry in the manifest
 *
 * Contains all metadata needed to fetch and execute a function.
 */
export interface FunctionManifestEntry {
  /** Runtime type that can execute this function */
  runtime: RuntimeType;
  /** SHA-256 hash of function code for integrity verification */
  hash: string;
  /** Version number for cache invalidation */
  version: number;
  /** URL to fetch the function code (immutable, cacheable) */
  codeUrl: string;
}

/**
 * Request type for function execution (fallback API)
 *
 * Used when browser execution fails and server fallback is needed.
 */
export interface ExecutionRequest {
  /** Arguments to pass to the function */
  args: unknown[];
}

/**
 * Response type for function execution (fallback API)
 *
 * Contains either the result or error from server-side execution.
 */
export interface ExecutionResponse {
  /** Function return value (null if error exists) */
  result: unknown;
  /** Error message if execution failed (undefined if success) */
  error?: string;
}

/**
 * Helper function to create manifest response from function definitions
 *
 * Converts internal function definitions to manifest entries with
 * appropriate code URLs.
 *
 * @param functions - Map of function name to definition
 * @param baseUrl - Base URL for code endpoints (e.g., 'https://example.com/unzen')
 * @returns Manifest response ready for JSON serialization
 *
 * @example
 * ```ts
 * const functions = {
 *   spamCheck: {
 *     name: 'spamCheck',
 *     runtime: 'quickjs',
 *     code: 'return /spam/i.test(args[0])',
 *     version: 1,
 *     hash: 'sha256:abc123',
 *   },
 * };
 *
 * const response = createManifestResponse(functions, 'https://example.com/unzen');
 * // {
 * //   functions: {
 * //     spamCheck: {
 * //       runtime: 'quickjs',
 * //       hash: 'sha256:abc123',
 * //       version: 1,
 * //       codeUrl: 'https://example.com/unzen/code/spamCheck?v=1',
 * //     },
 * //   },
 * // }
 * ```
 */
export function createManifestResponse(
  functions: Record<string, FunctionDefinition>,
  baseUrl: string
): ManifestResponse {
  const result: ManifestResponse = { functions: {} };

  for (const [name, def] of Object.entries(functions)) {
    result.functions[name] = {
      runtime: def.runtime,
      hash: def.hash,
      version: def.version,
      // Construct immutable URL with version query parameter
      codeUrl: `${baseUrl}/code/${name}?v=${def.version}`,
    };
  }

  return result;
}

/**
 * Helper function to create execution response
 *
 * Creates a properly structured response for either success or failure cases.
 *
 * @param outcome - Execution outcome (success with result, or failure with error)
 * @returns Execution response ready for JSON serialization
 *
 * @example
 * ```ts
 * // Success case
 * const successResponse = createExecutionResponse({
 *   success: true,
 *   result: 42,
 * });
 * // { result: 42 }
 *
 * // Error case
 * const errorResponse = createExecutionResponse({
 *   success: false,
 *   error: 'Timeout exceeded',
 * });
 * // { result: null, error: 'Timeout exceeded' }
 * ```
 */
export function createExecutionResponse(
  outcome: { success: true; result: unknown } | { success: false; error: string }
): ExecutionResponse {
  if (outcome.success) {
    return { result: outcome.result };
  } else {
    return { result: null, error: outcome.error };
  }
}
