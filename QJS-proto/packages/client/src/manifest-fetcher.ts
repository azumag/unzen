/**
 * ManifestFetcher - Function manifest retrieval and caching
 *
 * Retrieves the list of available functions from the server's manifest endpoint.
 * Implements in-memory caching to minimize network requests.
 *
 * Design rationale:
 * - Cache manifest in memory to reduce server load
 * - Cache is per-instance (allows multiple clients with different endpoints)
 * - Explicit invalidation allows forced refresh when needed
 * - getEntry provides convenient lookup without exposing full manifest
 *
 * Caching strategy:
 * - First fetch() retrieves from server and caches
 * - Subsequent fetch() returns cached value immediately
 * - invalidate() clears cache, forcing next fetch() to hit server
 * - No TTL expiration (manifest changes should be explicit via invalidate)
 *
 * Protocol:
 * - GET /manifest
 * - Response: ManifestResponse (see @unzen/shared/protocol.ts)
 */

import {
  UnzenNetworkError,
  type ManifestResponse,
  type FunctionManifestEntry,
} from '@unzen/shared';

export class ManifestFetcher {
  /**
   * Server endpoint URL (e.g., "https://example.com")
   */
  private readonly endpoint: string;

  /**
   * Cached manifest data
   * null = not yet fetched
   * ManifestResponse = cached data
   */
  private cache: ManifestResponse | null = null;

  /**
   * In-flight fetch promise for deduplication
   * Prevents multiple concurrent fetch() calls from hitting the server
   * (race condition fix: second caller awaits the same promise)
   */
  private inflight: Promise<ManifestResponse> | null = null;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  /**
   * Fetch manifest from server (or return cached value)
   *
   * @returns Manifest response
   * @throws {UnzenNetworkError} When network or server error occurs
   */
  async fetch(): Promise<ManifestResponse> {
    // Return cached manifest if available
    // Rationale: Manifest changes are rare, so aggressive caching is acceptable
    if (this.cache !== null) {
      return this.cache;
    }

    // Deduplicate concurrent fetch() calls
    // If a fetch is already in progress, return the same promise
    // This prevents N concurrent callers from making N HTTP requests
    if (this.inflight !== null) {
      return this.inflight;
    }

    // Create and store the fetch promise before awaiting
    this.inflight = this.fetchFromServer();

    try {
      const manifest = await this.inflight;
      return manifest;
    } finally {
      // Clear inflight regardless of success/failure
      // On failure, next call will retry
      this.inflight = null;
    }
  }

  /**
   * Internal: perform actual HTTP fetch of manifest
   */
  private async fetchFromServer(): Promise<ManifestResponse> {
    const url = `${this.endpoint}/manifest`;

    try {
      // Fetch manifest from server
      const response = await globalThis.fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      // Check HTTP status
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Failed to fetch manifest: ${response.status} ${response.statusText}`
        );
      }

      // Parse and cache response
      const manifest: ManifestResponse = await response.json();
      this.cache = manifest;

      return manifest;
    } catch (error) {
      // Re-throw UnzenNetworkError as-is
      if (error instanceof UnzenNetworkError) {
        throw error;
      }

      // Wrap other errors as network error
      throw new UnzenNetworkError(
        `Failed to fetch manifest: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get manifest entry for specific function
   *
   * @param name - Function name
   * @returns Manifest entry or undefined if not found
   *
   * Note: Returns undefined if manifest hasn't been fetched yet.
   * Call fetch() first to ensure manifest is loaded.
   */
  getEntry(name: string): FunctionManifestEntry | undefined {
    // Return undefined if manifest not yet loaded
    // Rationale: Caller should explicitly fetch() before using getEntry()
    if (this.cache === null) {
      return undefined;
    }

    return this.cache.functions[name];
  }

  /**
   * Invalidate cached manifest
   *
   * Forces next fetch() to retrieve from server instead of cache.
   * Use this when you know the manifest has changed on the server.
   */
  invalidate(): void {
    this.cache = null;
    this.inflight = null;
  }
}
