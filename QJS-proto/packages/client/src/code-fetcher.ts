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
  UnzenNetworkError,
  type FunctionManifestEntry,
} from '@unzen/shared';

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
   * @returns JavaScript source code
   * @throws {UnzenNetworkError} When network or server error occurs
   *
   * Implementation note:
   * - Uses entry.codeUrl to fetch code
   * - Caches result using entry.hash as key
   * - Hash-based caching allows code reuse across functions
   */
  async fetch(entry: FunctionManifestEntry): Promise<string> {
    // Check cache first
    // Rationale: Hash represents content identity, so cache hit is safe
    const cached = this.cache.get(entry.hash);
    if (cached !== undefined) {
      return cached;
    }

    try {
      // Fetch code from URL
      // Note: codeUrl is absolute URL from manifest, not relative to endpoint
      const response = await globalThis.fetch(entry.codeUrl, {
        method: 'GET',
      });

      // Check HTTP status
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Failed to fetch code from ${entry.codeUrl}: ${response.status} ${response.statusText}`
        );
      }

      // Parse response as text (JavaScript source code)
      const code = await response.text();

      // Cache by hash
      // Rationale: Same hash = same content, so safe to cache indefinitely
      this.cache.set(entry.hash, code);

      return code;
    } catch (error) {
      // Re-throw UnzenNetworkError as-is
      if (error instanceof UnzenNetworkError) {
        throw error;
      }

      // Wrap other errors as network error
      throw new UnzenNetworkError(
        `Failed to fetch code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
