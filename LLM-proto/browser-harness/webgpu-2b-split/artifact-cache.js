import { BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES } from './artifact-budget.js';
import { abortError, throwIfAborted } from './execution-lifecycle.js';

const CACHE_NAME = 'unzen-real-split-artifacts-v2';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function cancelReadable(readable, reason) {
  try {
    // A tee branch's cancel promise waits for its sibling. Request cleanup,
    // but never make rejection/Stop depend on another consumer finishing.
    void Promise.resolve(readable?.cancel(reason)).catch(() => {});
  } catch {
    // Cleanup is best-effort; preserve the original load/validation failure.
  }
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(buffer) {
  if (!crypto?.subtle) throw new Error('Web Crypto is required for artifact digest verification');
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return hex(new Uint8Array(digest));
}

function cacheKey(url, expectedSha256) {
  const key = new URL(url, location.href);
  key.searchParams.set('__unzen_sha256', expectedSha256);
  return key.href;
}

function parseContentLength(response) {
  const raw = response.headers.get('content-length');
  if (raw == null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid Content-Length: ${raw}`);
  }
  return value;
}

export async function readResponseBytesBounded(
  response,
  {
    maxBytes = BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES,
    expectedBytes,
    url = 'artifact',
    signal,
  } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`maxBytes must be a non-negative safe integer: ${maxBytes}`);
  }
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw new Error(`expectedBytes must be a non-negative safe integer: ${expectedBytes}`);
  }
  const effectiveMax = expectedBytes === undefined ? maxBytes : Math.min(maxBytes, expectedBytes);
  try {
    throwIfAborted(signal);
    const contentLength = parseContentLength(response);
    if (contentLength !== undefined && contentLength > effectiveMax) {
      throw new Error(`artifact exceeds byte limit before body read for ${url}: ${contentLength} > ${effectiveMax}`);
    }
  } catch (error) {
    cancelReadable(response.body, error);
    throw error;
  }

  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
    throwIfAborted(signal);
    if (buffer.byteLength > effectiveMax) {
      throw new Error(`artifact exceeds byte limit for ${url}: ${buffer.byteLength} > ${effectiveMax}`);
    }
    if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) {
      throw new Error(`artifact byte size mismatch for ${url}: expected ${expectedBytes}, got ${buffer.byteLength}`);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  const onAbort = () => {
    cancelReadable(reader, 'artifact-load-aborted');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      let next;
      try {
        next = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      }
      throwIfAborted(signal);
      const { done, value } = next;
      if (done) break;
      // Native getters accept cross-realm bytes without trusting a forged
      // byteLength or coercing a non-byte value into a potentially huge buffer.
      if (typedArrayTag.call(value) !== 'Uint8Array') {
        throw new Error(`artifact body returned a non-byte chunk for ${url}`);
      }
      const chunkBytes = typedArrayByteLength.call(value);
      if (chunkBytes > effectiveMax - total) {
        throw new Error(`artifact exceeds byte limit for ${url}: ${total + chunkBytes} > ${effectiveMax}`);
      }
      total += chunkBytes;
      // Producers may reuse their buffer on the next pull. Own accepted bytes
      // now, before another read can mutate data awaiting digest verification.
      if (chunkBytes > 0) chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    cancelReadable(reader, error);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }

  if (expectedBytes !== undefined && total !== expectedBytes) {
    throw new Error(`artifact byte size mismatch for ${url}: expected ${expectedBytes}, got ${total}`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  throwIfAborted(signal);
  return bytes;
}

/**
 * Load one immutable split artifact from the browser Cache API, enforce a byte
 * ceiling on both cache hits and network misses, and verify SHA-256 before
 * exposing the bytes to ONNX Runtime Web. Network responses are cached only
 * after size and digest validation succeeds.
 */
export async function loadVerifiedArtifact(
  url,
  expectedSha256,
  { maxBytes = BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES, expectedBytes, signal } = {},
) {
  if (!expectedSha256 || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new Error(`invalid or missing SHA-256 for ${url}`);
  }
  if (!('caches' in globalThis)) throw new Error('Browser Cache API is unavailable');
  throwIfAborted(signal);

  const started = performance.now();
  const cache = await caches.open(CACHE_NAME);
  throwIfAborted(signal);
  const key = cacheKey(url, expectedSha256.toLowerCase());
  let response = await cache.match(key);
  try {
    throwIfAborted(signal);
  } catch (error) {
    cancelReadable(response?.body, error);
    throw error;
  }
  const cacheHit = Boolean(response);

  if (!response) {
    response = await fetch(url, { cache: 'no-store', signal });
    if (!response.ok) {
      cancelReadable(response.body, 'artifact-fetch-failed');
      throw new Error(`artifact fetch failed ${response.status}: ${url}`);
    }
  }

  let bytes;
  try {
    bytes = await readResponseBytesBounded(response, { maxBytes, expectedBytes, url, signal });
    throwIfAborted(signal);
    const actualSha256 = await sha256(bytes);
    throwIfAborted(signal);
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `artifact SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }

    if (!cacheHit) {
      throwIfAborted(signal);
      await cache.put(key, new Response(bytes, {
        headers: {
          'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
        },
      }));
      throwIfAborted(signal);
    }

    return {
      bytes,
      report: {
        backend: 'cache-api',
        url,
        cacheHit,
        bytes: bytes.byteLength,
        expectedBytes: expectedBytes ?? null,
        maxBytes,
        sha256: actualSha256,
        digestVerified: true,
        loadMs: Math.round((performance.now() - started) * 10) / 10,
      },
    };
  } catch (error) {
    // Cancellation is not evidence of corruption. A failed cache miss also
    // owns no old entry: deleting its key could evict another caller's newly
    // verified download (including a put that completed as Stop arrived).
    if (cacheHit && !signal?.aborted && error?.name !== 'AbortError') {
      try {
        await cache.delete(key);
      } catch {
        // A cache-storage failure must not hide the original integrity error.
        // Any remaining entry is still size/digest-checked on the next load.
      }
    }
    throw error;
  }
}

export async function clearRealSplitArtifactCache() {
  if (!('caches' in globalThis)) return false;
  return caches.delete(CACHE_NAME);
}
