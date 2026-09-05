import { BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES } from './artifact-budget.js';

const CACHE_NAME = 'unzen-real-split-artifacts-v2';

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
  { maxBytes = BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES, expectedBytes, url = 'artifact' } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`maxBytes must be a non-negative safe integer: ${maxBytes}`);
  }
  if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
    throw new Error(`expectedBytes must be a non-negative safe integer: ${expectedBytes}`);
  }
  const effectiveMax = expectedBytes === undefined ? maxBytes : Math.min(maxBytes, expectedBytes);
  const contentLength = parseContentLength(response);
  if (contentLength !== undefined && contentLength > effectiveMax) {
    throw new Error(`artifact exceeds byte limit before body read for ${url}: ${contentLength} > ${effectiveMax}`);
  }

  if (!response.body?.getReader) {
    const buffer = await response.arrayBuffer();
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
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > effectiveMax) {
        await reader.cancel('artifact-byte-limit-exceeded').catch(() => {});
        throw new Error(`artifact exceeds byte limit for ${url}: ${total} > ${effectiveMax}`);
      }
      chunks.push(chunk);
    }
  } finally {
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
  { maxBytes = BROWSER_SEGMENT_ABSOLUTE_MAX_BYTES, expectedBytes } = {},
) {
  if (!expectedSha256 || !/^[0-9a-f]{64}$/i.test(expectedSha256)) {
    throw new Error(`invalid or missing SHA-256 for ${url}`);
  }
  if (!('caches' in globalThis)) throw new Error('Browser Cache API is unavailable');

  const started = performance.now();
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKey(url, expectedSha256.toLowerCase());
  let response = await cache.match(key);
  const cacheHit = Boolean(response);

  if (!response) {
    response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`artifact fetch failed ${response.status}: ${url}`);
  }

  let bytes;
  try {
    bytes = await readResponseBytesBounded(response, { maxBytes, expectedBytes, url });
    const actualSha256 = await sha256(bytes);
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `artifact SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }

    if (!cacheHit) {
      await cache.put(key, new Response(bytes, {
        headers: {
          'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
        },
      }));
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
    await cache.delete(key);
    throw error;
  }
}

export async function clearRealSplitArtifactCache() {
  if (!('caches' in globalThis)) return false;
  return caches.delete(CACHE_NAME);
}
