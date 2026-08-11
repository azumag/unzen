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
 * - Byte-bounded LRU retention (code remains immutable per hash after eviction)
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
  MAX_FUNCTION_PAYLOAD_BYTES,
  normalizeManifestResponse,
  type FunctionManifestEntry,
} from '@unzen/shared';
import {
  isAbortError,
  raceWithAbort,
  snapshotAbortSignalInput,
  throwIfAborted,
} from './abort';
import { assertUnzenContentIntegrity } from './content-integrity';
import { readBoundedResponseBytes } from './response-body';

interface InflightCodeRequest {
  readonly promise: Promise<string>;
  readonly controller: AbortController;
  waiters: number;
}

interface CachedCode {
  readonly code: string;
  /** Encoded size used for the browser-memory cache budget. */
  readonly byteLength: number;
}

/** Default aggregate UTF-8 weight retained by one CodeFetcher instance. */
export const DEFAULT_MAX_CODE_CACHE_BYTES = 32 * 1024 * 1024;

export interface CodeFetcherOptions {
  /** Aggregate encoded cache weight. Set to 0 to disable settled-code caching. */
  maxCacheBytes?: number;
}

function normalizeCodeCacheByteLimit(value: unknown): number {
  const normalized = value === undefined ? DEFAULT_MAX_CODE_CACHE_BYTES : value;
  if (
    typeof normalized !== 'number'
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError('maxCacheBytes must be a non-negative safe integer');
  }
  return normalized;
}

/** Validate and own the manifest fields consumed by this fetcher. */
function snapshotCodeManifestEntry(value: unknown): FunctionManifestEntry | undefined {
  const functions = Object.create(null) as Record<string, unknown>;
  functions.code = value;
  const manifest = normalizeManifestResponse({ functions });
  const entry = manifest?.functions.code;
  return entry?.runtime === 'quickjs' ? entry : undefined;
}

export class CodeFetcher {
  /**
   * Cache of source code, keyed by content hash
   * Key: hash string from manifest entry
   * Value: JavaScript source code
   */
  private readonly cache: Map<string, CachedCode> = new Map();
  private readonly maxCacheBytes: number;
  private cacheBytes = 0;

  /** Shared downloads keyed by content identity, with per-caller cancellation. */
  private readonly inflight: Map<string, InflightCodeRequest> = new Map();

  /**
   * Constructor
   *
   * @param endpoint - Server endpoint URL (currently unused)
   * @param options - Optional settled-cache byte budget
   *
   * Note: endpoint parameter is kept for API consistency with other fetchers
   * but not stored as codeUrl from manifest is already absolute.
   * May be used in Phase 2+ for relative URL resolution.
   */
  constructor(endpoint: string, options: CodeFetcherOptions = {}) {
    if (typeof options !== 'object' || options === null || Array.isArray(options)) {
      throw new TypeError('CodeFetcher options must be an object');
    }
    let maxCacheBytes: unknown;
    try {
      maxCacheBytes = options.maxCacheBytes;
    } catch {
      throw new TypeError('CodeFetcher options could not be read');
    }
    this.maxCacheBytes = normalizeCodeCacheByteLimit(maxCacheBytes);
    // endpoint is kept for API consistency; manifest codeUrl is authoritative.
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
   * - Validates and snapshots entry before any cache/network work
   * - Uses the snapshotted codeUrl to fetch code
   * - Caches result using the snapshotted hash as key
   * - Hash-based caching allows code reuse across functions
   */
  async fetch(entry: FunctionManifestEntry, signal?: AbortSignal): Promise<string> {
    let signalSnapshot: ReturnType<typeof snapshotAbortSignalInput>;
    try {
      signalSnapshot = snapshotAbortSignalInput(signal);
    } catch {
      throw new UnzenNetworkError('Code fetch signal must be an AbortSignal');
    }
    if (signalSnapshot.initiallyAborted) {
      throw new UnzenCancelledError('Execution cancelled by caller');
    }
    const requestSignal = signalSnapshot.signal;

    // Reject immediately if the caller already aborted before calling — even
    // cached code must not be handed out after cancellation.
    throwIfAborted(requestSignal);

    const entrySnapshot = snapshotCodeManifestEntry(entry);
    if (entrySnapshot === undefined) {
      throw new UnzenNetworkError('Invalid QuickJS code manifest entry');
    }
    // Reading a caller-owned entry can run getters. Preserve cancellation as
    // authoritative even when the resulting hash is already cached.
    throwIfAborted(requestSignal);
    const { codeUrl, hash } = entrySnapshot;

    // Check cache first
    // Rationale: Hash represents content identity, so cache hit is safe
    const cached = this.cache.get(hash);
    if (cached !== undefined) {
      // Map insertion order is the LRU order. Reinsert a hit as most-recent.
      this.cache.delete(hash);
      this.cache.set(hash, cached);
      return cached.code;
    }

    let pending = this.inflight.get(hash);
    if (pending === undefined) {
      const controller = new AbortController();
      pending = {
        promise: this.fetchAndCache(codeUrl, hash, controller.signal),
        controller,
        waiters: 0,
      };
      const created = pending;
      created.promise.finally(() => {
        if (this.inflight.get(hash) === created) {
          this.inflight.delete(hash);
        }
      }).catch(() => {});
      this.inflight.set(hash, created);
    }

    pending.waiters++;
    try {
      return await (requestSignal
        ? raceWithAbort(pending.promise, requestSignal)
        : pending.promise);
    } finally {
      pending.waiters--;
      if (pending.waiters === 0 && this.inflight.get(hash) === pending) {
        this.inflight.delete(hash);
        pending.controller.abort();
      }
    }
  }

  /** Fetch, verify, decode, and atomically publish one cache entry. */
  private async fetchAndCache(
    codeUrl: string,
    hash: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      // The shared signal is aborted only after the final waiter leaves.
      // Note: codeUrl is absolute URL from manifest, not relative to endpoint
      const response = await globalThis.fetch(codeUrl, {
        method: 'GET',
        signal,
      });

      // Check HTTP status
      if (!response.ok) {
        throw new UnzenNetworkError(
          `Failed to fetch code from ${codeUrl}: ${response.status} ${response.statusText}`
        );
      }

      // Read and verify raw bytes before decoding or caching. The optional
      // Service Worker cache is an optimization, not a security dependency,
      // so every normal fetch path repeats this integrity check.
      const bytes = await readBoundedResponseBytes(
        response,
        MAX_FUNCTION_PAYLOAD_BYTES,
        'Function code response',
      );
      throwIfAborted(signal);
      await assertUnzenContentIntegrity(bytes, hash);
      throwIfAborted(signal);

      let code: string;
      try {
        code = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new UnzenNetworkError('Fetched function code is not valid UTF-8');
      }

      this.cacheCode(hash, code, bytes.byteLength);

      return code;
    } catch (error) {
      // Re-throw UnzenNetworkError as-is
      if (error instanceof UnzenNetworkError) {
        throw error;
      }

      // Cancellation must surface as UnzenCancelledError, never as a network
      // error (which would look recoverable and trigger server fallback).
      if (isAbortError(error) || signal.aborted) {
        throw new UnzenCancelledError('Execution cancelled by caller');
      }

      // Wrap other errors as network error
      throw new UnzenNetworkError(
        `Failed to fetch code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** Publish one settled entry and evict least-recent hashes to stay bounded. */
  private cacheCode(hash: string, code: string, byteLength: number): void {
    if (this.maxCacheBytes === 0 || byteLength > this.maxCacheBytes) return;

    const existing = this.cache.get(hash);
    if (existing !== undefined) {
      this.cache.delete(hash);
      this.cacheBytes -= existing.byteLength;
    }

    while (
      this.cache.size > 0
      && this.cacheBytes > this.maxCacheBytes - byteLength
    ) {
      const oldestHash = this.cache.keys().next().value as string;
      const oldest = this.cache.get(oldestHash)!;
      this.cache.delete(oldestHash);
      this.cacheBytes -= oldest.byteLength;
    }

    this.cache.set(hash, { code, byteLength });
    this.cacheBytes += byteLength;
  }
}
