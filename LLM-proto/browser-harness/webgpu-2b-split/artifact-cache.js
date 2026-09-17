import { BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES } from './artifact-budget.js';
import { abortError, throwIfAborted } from './execution-lifecycle.js';

const CACHE_NAME = 'unzen-real-split-artifacts-v2';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function diagnosticValue(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      if (Number.isNaN(value)) return 'NaN';
      if (value === Number.POSITIVE_INFINITY) return 'Infinity';
      if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
      return `${value}`;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return `${value}n`;
    case 'undefined':
      return 'undefined';
    case 'symbol':
      return value.description === undefined ? 'Symbol' : `Symbol(${value.description})`;
    case 'function':
      return '[function]';
    case 'object':
    default:
      return '[object]';
  }
}

function cancelReadable(readable, reason) {
  try {
    // A tee branch's cancel promise waits for its sibling. Request cleanup,
    // but never make rejection/Stop depend on another consumer finishing.
    void Promise.resolve(readable?.cancel(reason)).catch(() => {});
  } catch {
    // Cleanup is best-effort; preserve the original load/validation failure.
  }
}

function snapshotCleanupMethod(target, property) {
  try {
    const method = target?.[property];
    return typeof method === 'function' ? method : undefined;
  } catch {
    // Cleanup capability lookup is itself best-effort. Once a callable method
    // is accepted, later cleanup uses only that owned method.
    return undefined;
  }
}

function cancelOwnedReader(reader, cancel, reason) {
  if (cancel === undefined) return;
  try {
    void Promise.resolve(cancel.call(reader, reason)).catch(() => {});
  } catch {
    // Reader cleanup must not mask the primary stream outcome.
  }
}

function releaseOwnedReader(reader, releaseLock) {
  if (releaseLock === undefined) return;
  try {
    releaseLock.call(reader);
  } catch {
    // Reader cleanup is best-effort after the primary read outcome is known.
  }
}

function snapshotAbortListenerMethods(signal) {
  if (signal === undefined || signal === null) return undefined;
  let addEventListener;
  let removeEventListener;
  try {
    addEventListener = signal.addEventListener;
    removeEventListener = signal.removeEventListener;
  } catch {
    throw new TypeError('artifact AbortSignal listener methods could not be read');
  }
  if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
    throw new TypeError('artifact AbortSignal listener methods must be functions');
  }
  return { addEventListener, removeEventListener };
}

function removeAbortListener(signal, removeEventListener, onAbort, mayBeRegistered) {
  if (!mayBeRegistered) return;
  try {
    removeEventListener.call(signal, 'abort', onAbort);
  } catch {
    // Caller-owned cleanup must not mask the artifact result/error.
  }
}

function releaseReader(reader) {
  try {
    reader.releaseLock?.();
  } catch {
    // Reader cleanup is best-effort before reader method ownership completes.
  }
}

function allowsCorruptionCleanup(signal) {
  if (signal === undefined || signal === null) return true;
  try {
    return signal.aborted === false;
  } catch {
    // If caller-owned signal state is no longer readable, avoid destructive
    // cache cleanup because cancellation cannot be ruled out safely.
    return false;
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
    throw new Error(`maxBytes must be a non-negative safe integer: ${diagnosticValue(maxBytes)}`);
  }
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw new Error(`expectedBytes must be a non-negative safe integer: ${diagnosticValue(expectedBytes)}`);
  }
  const effectiveMax = expectedBytes === undefined ? maxBytes : Math.min(maxBytes, expectedBytes);

  // Preserve the established abort/content-length fail-fast ordering. If that
  // preflight fails, capture the body once only for best-effort cleanup.
  let body;
  let bodyCaptured = false;
  const ownResponseBody = () => {
    if (!bodyCaptured) {
      bodyCaptured = true;
      body = response.body;
    }
    return body;
  };
  try {
    throwIfAborted(signal);
    const contentLength = parseContentLength(response);
    if (contentLength !== undefined && contentLength > effectiveMax) {
      throw new Error(`artifact exceeds byte limit before body read for ${url}: ${contentLength} > ${effectiveMax}`);
    }
  } catch (error) {
    if (!bodyCaptured) {
      try {
        ownResponseBody();
      } catch {
        // Preserve the primary preflight failure if the body getter is hostile.
      }
    }
    cancelReadable(body, error);
    throw error;
  }

  try {
    ownResponseBody();
  } catch {
    throw new TypeError('artifact response body could not be read');
  }

  let getReader;
  try {
    getReader = body?.getReader;
  } catch (error) {
    cancelReadable(body, error);
    throw new TypeError('artifact response getReader capability could not be read');
  }
  if (getReader === undefined || getReader === null) {
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
  if (typeof getReader !== 'function') {
    const error = new TypeError('artifact response getReader capability must be a function');
    cancelReadable(body, error);
    throw error;
  }

  let abortListenerMethods;
  try {
    abortListenerMethods = snapshotAbortListenerMethods(signal);
  } catch (error) {
    cancelReadable(body, error);
    throw error;
  }

  let reader;
  try {
    reader = getReader.call(body);
  } catch (error) {
    cancelReadable(body, error);
    throw error;
  }

  let read;
  try {
    read = reader?.read;
  } catch (error) {
    cancelReadable(reader, error);
    releaseReader(reader);
    throw new TypeError('artifact reader read capability could not be read');
  }
  if (typeof read !== 'function') {
    const error = new TypeError('artifact reader read capability must be a function');
    cancelReadable(reader, error);
    releaseReader(reader);
    throw error;
  }
  const readerCancel = snapshotCleanupMethod(reader, 'cancel');
  const readerReleaseLock = snapshotCleanupMethod(reader, 'releaseLock');

  const chunks = [];
  let total = 0;
  let listenerMayBeRegistered = false;
  const onAbort = () => {
    cancelOwnedReader(reader, readerCancel, 'artifact-load-aborted');
  };
  try {
    if (signal !== undefined && signal !== null) {
      listenerMayBeRegistered = true;
      try {
        abortListenerMethods.addEventListener.call(signal, 'abort', onAbort, { once: true });
        // Close the state-check/listener race before the first reader pull.
        throwIfAborted(signal);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        throw new TypeError('artifact AbortSignal could not be subscribed');
      }
    }

    for (;;) {
      throwIfAborted(signal);
      let next;
      try {
        next = await read.call(reader);
      } catch (error) {
        throwIfAborted(signal);
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
    cancelOwnedReader(reader, readerCancel, error);
    throw error;
  } finally {
    removeAbortListener(
      signal,
      abortListenerMethods?.removeEventListener,
      onAbort,
      listenerMayBeRegistered,
    );
    releaseOwnedReader(reader, readerReleaseLock);
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
    if (cacheHit && allowsCorruptionCleanup(signal) && error?.name !== 'AbortError') {
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
