const CACHE_NAME = 'unzen-real-split-artifacts-v1';

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

/**
 * Load one immutable split artifact from the browser Cache API and verify the
 * manifest SHA-256 before exposing the bytes to ONNX Runtime Web.
 */
export async function loadVerifiedArtifact(url, expectedSha256) {
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
    const fetched = await fetch(url, { cache: 'no-store' });
    if (!fetched.ok) throw new Error(`artifact fetch failed ${fetched.status}: ${url}`);
    // Cache before consuming the body. The digest is still verified below; if
    // it fails, the cache entry is deleted before the error escapes.
    await cache.put(key, fetched.clone());
    response = fetched;
  }

  const buffer = await response.arrayBuffer();
  const actualSha256 = await sha256(buffer);
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    await cache.delete(key);
    throw new Error(
      `artifact SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }

  return {
    bytes: new Uint8Array(buffer),
    report: {
      backend: 'cache-api',
      url,
      cacheHit,
      bytes: buffer.byteLength,
      sha256: actualSha256,
      digestVerified: true,
      loadMs: Math.round((performance.now() - started) * 10) / 10,
    },
  };
}

export async function clearRealSplitArtifactCache() {
  if (!('caches' in globalThis)) return false;
  return caches.delete(CACHE_NAME);
}
