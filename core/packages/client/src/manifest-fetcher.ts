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
 * ETag caching (Phase 3):
 * - Server returns ETag header with manifest responses
 * - Client stores ETag and sends If-None-Match on subsequent requests
 * - On 304 Not Modified, client reuses last known manifest (lastManifest)
 * - invalidate() clears in-memory cache but preserves ETag and lastManifest
 *   to allow efficient revalidation without full re-download
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
import { raceWithAbort, throwIfAborted } from './abort';

export class ManifestFetcher {
  /**
   * Server endpoint URL (e.g., "https://example.com")
   */
  private readonly endpoint: string;

  /**
   * Cached manifest data (in-memory cache)
   * null = not yet fetched or invalidated
   * ManifestResponse = cached data
   */
  private cache: ManifestResponse | null = null;

  /**
   * In-flight fetch promise for deduplication
   * Prevents multiple concurrent fetch() calls from hitting the server
   * (race condition fix: second caller awaits the same promise)
   */
  private inflight: Promise<ManifestResponse> | null = null;

  /**
   * Stored ETag from last server response for conditional requests (Phase 3)
   * Used to send If-None-Match header on subsequent fetch requests.
   * Preserved across invalidate() to allow ETag-based revalidation.
   */
  private etag: string | null = null;

  /**
   * Last fetched manifest for 304 revalidation (Phase 3)
   * Separate from in-memory cache (this.cache) because it must survive
   * invalidate() calls. When server responds 304, this value is used
   * as the manifest without re-downloading.
   */
  private lastManifest: ManifestResponse | null = null;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }

  /**
   * Fetch manifest from server (or return cached value)
   *
   * @param signal - Optional AbortSignal that cancels the network fetch.
   *   When the signal aborts, the promise rejects with UnzenCancelledError.
   * @returns Manifest response
   * @throws {UnzenCancelledError} When the caller aborts via signal
   * @throws {UnzenNetworkError} When network or server error occurs
   */
  async fetch(signal?: AbortSignal): Promise<ManifestResponse> {
    // Reject immediately if the caller already aborted before calling — even
    // a cached manifest must not be handed out after cancellation. Cancellation
    // must never be wrapped into a network error.
    throwIfAborted(signal);

    // Return cached manifest if available
    // Rationale: Manifest changes are rare, so aggressive caching is acceptable
    if (this.cache !== null) {
      return this.cache;
    }

    // Deduplicate concurrent fetch() calls: subsequent callers share the
    // in-flight request. The shared request is NOT bound to any caller's
    // signal; each caller races it against their own abort so cancelling one
    // execution settles only that caller (issue #105 AC #1 under concurrency).
    if (this.inflight === null) {
      this.inflight = this.fetchFromServer();
    }
    const inflight = this.inflight;

    try {
      if (signal) {
        return await raceWithAbort(inflight, signal);
      }
      return await inflight;
    } finally {
      // Clear inflight only if it is still the promise this caller waited on.
      if (this.inflight === inflight) {
        this.inflight = null;
      }
    }
  }

  /**
   * Internal: perform actual HTTP fetch of manifest
   *
   * Supports ETag-based conditional requests (Phase 3):
   * - Sends If-None-Match header if a previous ETag is stored
   * - Handles 304 Not Modified by returning the last known manifest
   * - Stores new ETag and manifest on 200 OK responses
   */
  private async fetchFromServer(): Promise<ManifestResponse> {
    const url = `${this.endpoint}/manifest`;

    // Build request headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Send If-None-Match header for conditional request (ETag revalidation)
    // This tells the server: "only send the full response if the manifest
    // has changed since I last saw it (identified by this ETag)"
    // Only send if we also have lastManifest to use on 304 response.
    // Without lastManifest, a 304 would have no manifest to return,
    // and 304 responses have no body per HTTP spec (can't call .json()).
    if (this.etag && this.lastManifest) {
      headers['If-None-Match'] = this.etag;
    }

    try {
      // Fetch manifest from server
      const response = await globalThis.fetch(url, {
        method: 'GET',
        headers,
      });

      // 304 Not Modified: server confirms our cached version is still current
      // Reuse the last known manifest instead of parsing a new response body
      // (304 responses have no body per HTTP spec)
      if (response.status === 304 && this.lastManifest) {
        this.cache = this.lastManifest;
        return this.lastManifest;
      }

      // Check HTTP status for other non-OK responses
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Failed to fetch manifest: ${response.status} ${response.statusText}`
        );
      }

      // Extract ETag from response for future conditional requests
      // Store it regardless of whether we had one before (may be a new value)
      // Use optional chaining for resilience: some environments or mocks
      // may not provide a headers object on the Response
      const etag = response.headers?.get('ETag');
      if (etag) {
        this.etag = etag;
      }

      // Parse and cache response
      const manifest: ManifestResponse = await response.json();
      this.cache = manifest;
      // Store in lastManifest for 304 revalidation after future invalidate() calls
      this.lastManifest = manifest;

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
   * Check if manifest is currently cached in memory.
   * Used by UnzenClient to report cache status in diagnostics.
   *
   * @returns true if manifest is cached and available without network request
   */
  isCached(): boolean {
    return this.cache !== null;
  }

  /**
   * Invalidate cached manifest
   *
   * Forces next fetch() to retrieve from server instead of cache.
   * Use this when you know the manifest has changed on the server.
   *
   * Note: etag and lastManifest are intentionally NOT cleared.
   * This allows ETag-based revalidation after cache invalidation,
   * so the client can send If-None-Match and potentially receive
   * a 304 response instead of re-downloading the full manifest.
   */
  invalidate(): void {
    this.cache = null;
    this.inflight = null;
    // etag and lastManifest are preserved to enable conditional requests
    // after invalidation. This is the key optimization: even after invalidation,
    // if the server manifest hasn't changed, the client gets a lightweight 304
    // response instead of re-downloading the full manifest JSON.
  }
}
