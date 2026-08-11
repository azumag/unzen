/** Shared cache policy used by the Unzen Service Worker and its tests. */

export const UNZEN_CODE_CACHE_PREFIX = 'unzen-code-';
export const UNZEN_CODE_CACHE_NAME = `${UNZEN_CODE_CACHE_PREFIX}v1`;

const SHA256_IDENTITY = /^sha256:[a-f0-9]{64}$/;
const POSITIVE_VERSION = /^[1-9][0-9]*$/;
const CACHEABLE_CONTENT_TYPES = new Set([
  'application/javascript',
  'application/wasm',
  'text/javascript',
]);

export interface UnzenCodeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface UnzenCodeCacheStorage {
  open(cacheName: string): Promise<UnzenCodeCache>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

export interface UnzenCodeCacheRuntime {
  cacheStorage: UnzenCodeCacheStorage;
  fetch(request: Request): Promise<Response>;
  /** Returns a lowercase `sha256:<hex>` identity for the supplied bytes. */
  digest?: (bytes: ArrayBuffer) => Promise<string>;
}

/**
 * Match only the immutable Unzen code contract.
 *
 * Requiring both the process-local version and the content hash prevents a
 * cache entry from surviving a deployment where version counters restart.
 */
export function isVersionedUnzenCodeRequest(request: Request, origin: string): boolean {
  if (request.method.toUpperCase() !== 'GET') return false;

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;

  const segments = url.pathname.split('/');
  const codeIndex = segments.lastIndexOf('code');
  if (codeIndex < 0 || codeIndex !== segments.length - 2 || segments.at(-1) === '') {
    return false;
  }

  const versions = url.searchParams.getAll('v');
  const hashes = url.searchParams.getAll('h');
  if (versions.length !== 1 || hashes.length !== 1) return false;
  for (const key of url.searchParams.keys()) {
    if (key !== 'v' && key !== 'h') return false;
  }

  return POSITIVE_VERSION.test(versions[0]!) && SHA256_IDENTITY.test(hashes[0]!);
}

/** Return the hash identity from a request already accepted by the matcher. */
export function getUnzenCodeRequestHash(request: Request): string | null {
  const hash = new URL(request.url).searchParams.get('h');
  return hash !== null && SHA256_IDENTITY.test(hash) ? hash : null;
}

/** Cache only successful, non-redirected immutable JavaScript/Wasm payloads. */
export function isCacheableUnzenCodeResponse(response: Response): boolean {
  if (!response.ok || response.status !== 200 || response.redirected) return false;
  if (response.type !== 'basic' && response.type !== 'default') return false;

  const cacheControl = response.headers.get('Cache-Control') ?? '';
  const directives = cacheControl.split(',').map((value) => value.trim().toLowerCase());
  if (!directives.includes('immutable')) return false;
  if (directives.some((directive) => (
    directive === 'no-store'
    || directive === 'no-cache'
    || directive.startsWith('no-cache=')
    || directive === 'private'
    || directive.startsWith('private=')
  ))) return false;

  const contentType = (response.headers.get('Content-Type') ?? '')
    .split(';', 1)[0]!
    .trim()
    .toLowerCase();
  return CACHEABLE_CONTENT_TYPES.has(contentType);
}

/** Digest bytes with Web Crypto into the manifest's `sha256:<hex>` format. */
export async function digestUnzenCode(
  bytes: ArrayBuffer,
  subtle: Pick<SubtleCrypto, 'digest'>,
): Promise<string> {
  const digest = await subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

function integrityFailure(): Response {
  return new Response('Unzen code integrity check failed', {
    status: 502,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

/**
 * Cache-first response for one accepted versioned code request.
 *
 * Cache API failures never take down execution: they disable persistence while
 * the network response still goes through integrity verification. A verified
 * hash mismatch fails closed with 502 and is never persisted.
 */
export async function respondWithUnzenCodeCache(
  request: Request,
  runtime: UnzenCodeCacheRuntime,
): Promise<Response> {
  let cache: UnzenCodeCache | undefined;
  try {
    cache = await runtime.cacheStorage.open(UNZEN_CODE_CACHE_NAME);
    const cached = await cache.match(request);
    if (cached !== undefined) return cached;
  } catch {
    cache = undefined;
  }

  const response = await runtime.fetch(request);
  if (!isCacheableUnzenCodeResponse(response)) return response;

  const expectedHash = getUnzenCodeRequestHash(request);
  if (expectedHash === null) return response;
  if (runtime.digest) {
    try {
      const actualHash = await runtime.digest(await response.clone().arrayBuffer());
      if (actualHash !== expectedHash) return integrityFailure();
    } catch {
      // Web Crypto failure disables persistence for this response, but does
      // not turn an otherwise usable network request into an outage.
      return response;
    }
  } else {
    // Never persist bytes that could not be checked against the manifest URL.
    return response;
  }

  if (cache !== undefined) {
    try {
      await cache.put(request, response.clone());
    } catch {
      // Quota/private-mode CacheStorage failures are an optimization miss only.
    }
  }
  return response;
}

/** Delete old Unzen cache generations, or all generations when keep is null. */
export async function deleteUnzenCodeCaches(
  cacheStorage: Pick<UnzenCodeCacheStorage, 'keys' | 'delete'>,
  keep: string | null,
): Promise<string[]> {
  const names = await cacheStorage.keys();
  const candidates = names.filter(
    (name) => name.startsWith(UNZEN_CODE_CACHE_PREFIX) && name !== keep,
  );
  const results = await Promise.all(candidates.map(async (name) => ({
    name,
    deleted: await cacheStorage.delete(name),
  })));
  return results.filter((result) => result.deleted).map((result) => result.name);
}
