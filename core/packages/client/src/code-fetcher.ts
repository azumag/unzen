/**
 * CodeFetcher - Function source code retrieval and caching
 *
 * Retrieves JavaScript source code from URLs specified in the manifest.
 * Implements hash-based caching to avoid redundant downloads.
 *
 * Design rationale:
 * - Cache by content hash, not by function name or URL
 * - Hash-based caching allows code reuse across functions
 * - If two functions have identical code (same hash), fetch only once
 * - No TTL expiration (code is immutable per hash)
 *
 * Caching strategy:
 * - Key: content hash from manifest entry
 * - Value: source code string
 * - Cache hit: Same hash requested again → return cached code
 * - Cache miss: New hash → fetch from URL and cache
 *
 * Why hash-based caching:
 * - Content-addressed caching is more efficient than URL-based
 * - Hash collision is intentional (same code = same hash = reuse)
 * - Supports code deduplication across multiple functions
 */

import {
  UnzenCancelledError,
  UnzenNetworkError,
  type FunctionManifestEntry,
} from '@unzen/shared';
import { isAbortError, throwIfAborted } from './abort';
import {
  assertUnzenContentIntegrity,
  isValidUnzenContentHash,
} from './content-integrity';

export class CodeFetcher {
  /**
   * Cache of source code, keyed by content hash
   * Key: hash string from manifest entry
   * Value: JavaScript source code
   */
  private readonly cache: Map<string, string> = new Map();

  /**
   * Constructor
   *
   * @param endpoint - Server endpoint URL (currently unused)
   *
   * Note: endpoint parameter is kept for API consistency with other fetchers
   * but not stored as codeUrl from manifest is already absolute.
   * May be used in Phase 2+ for relative URL resolution.
   */
  constructor(endpoint: string) {
    // Intentionally empty - endpoint parameter is for API consistency only
    // Suppress unused parameter warning by not storing it
    void endpoint;
  }

  /**
   * Fetch function source code (or return cached value)
   *
   * @param entry - Manifest entry containing codeUrl and hash
   * @param signal - Optional AbortSignal that cancels the network fetch.
   *   When the signal aborts, the promise rejects with UnzenCancelledError.
   * @returns JavaScript source code
   * @throws {UnzenCancelledError} When the caller aborts via signal
   * @throws {UnzenNetworkError} When network or server error occurs
   *
   * Implementation note:
   * - Uses entry.codeUrl to fetch code
   * - Caches result using entry.hash as key
   * - Hash-based caching allows code reuse across functions
   */
  async fetch(entry: FunctionManifestEntry, signal?: AbortSignal): Promise<string> {
    // Reject immediately if the caller already aborted before calling — even
    // cached code must not be handed out after cancellation.
    throwIfAborted(signal);

    // The hash is the trust anchor for both verification and cache identity.
    // Reject malformed manifests before performing any network request.
    if (!isValidUnzenContentHash(entry.hash)) {
      throw new UnzenNetworkError('Invalid code hash in manifest');
    }

    // Check cache first
    // Rationale: Hash represents content identity, so cache hit is safe
    const cached = this.cache.get(entry.hash);
    if (cached !== undefined) {
      return cached;
    }

    try {
      // Fetch code from URL (signal cancels the request on abort)
      // Note: codeUrl is absolute URL from manifest, not relative to endpoint
      const response = await globalThis.fetch(entry.codeUrl, {
        method: 'GET',
        signal,
      });

      // Check HTTP status
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Failed to fetch code from ${entry.codeUrl}: ${response.status} ${response.statusText}`
        );
      }

      // Read and verify raw bytes before decoding or caching. The optional
      // Service Worker cache is an optimization, not a security dependency,
      // so every normal fetch path repeats this integrity check.
      const bytes = await response.arrayBuffer();
      throwIfAborted(signal);
      await assertUnzenContentIntegrity(bytes, entry.hash);
      throwIfAborted(signal);

      let code: string;
      try {
        code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new UnzenNetworkError('Fetched function code is not valid UTF-8');
      }

      // Cache by hash
      // Rationale: Same hash = same content, so safe to cache indefinitely
      this.cache.set(entry.hash, code);

      return code;
    } catch (error) {
      // Re-throw UnzenNetworkError as-is
      if (error instanceof UnzenNetworkError) {
        throw error;
      }

      // Cancellation must surface as UnzenCancelledError, never as a network
      // error (which would look recoverable and trigger server fallback).
      if (isAbortError(error) || signal?.aborted) {
        throw new UnzenCancelledError('Execution cancelled by caller');
      }

      // Wrap other errors as network error
      throw new UnzenNetworkError(
        `Failed to fetch code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
