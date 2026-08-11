import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  deleteUnzenCodeCaches,
  digestUnzenCode,
  isCacheableUnzenCodeResponse,
  isVersionedUnzenCodeRequest,
  respondWithUnzenCodeCache,
  UNZEN_CODE_CACHE_NAME,
  type UnzenCodeCache,
  type UnzenCodeCacheStorage,
} from '../src/unzen-cache-worker';

const ORIGIN = 'https://example.com';

function hashBytes(bytes: ArrayBuffer): string {
  const hex = createHash('sha256').update(Buffer.from(bytes)).digest('hex');
  return `sha256:${hex}`;
}

function hashText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function codeRequest(body = 'function run() {}'): Request {
  const hash = encodeURIComponent(hashText(body));
  return new Request(`${ORIGIN}/unzen/code/run?v=1&h=${hash}`);
}

function immutableCodeResponse(body = 'function run() {}'): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Type': 'text/javascript; charset=utf-8',
    },
  });
}

class MemoryCodeCache implements UnzenCodeCache {
  readonly entries = new Map<string, Response>();
  putCount = 0;

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone();
  }

  async put(request: Request, response: Response): Promise<void> {
    this.putCount++;
    this.entries.set(request.url, response.clone());
  }
}

class MemoryCacheStorage implements UnzenCodeCacheStorage {
  readonly cache = new MemoryCodeCache();
  readonly names = new Set<string>();

  async open(cacheName: string): Promise<UnzenCodeCache> {
    this.names.add(cacheName);
    return this.cache;
  }

  async keys(): Promise<string[]> {
    return [...this.names];
  }

  async delete(cacheName: string): Promise<boolean> {
    return this.names.delete(cacheName);
  }
}

describe('Unzen cache worker policy', () => {
  it('matches only same-origin version+SHA-256 code requests', () => {
    expect(isVersionedUnzenCodeRequest(codeRequest(), ORIGIN)).toBe(true);

    const validHash = hashText('function run() {}');
    const invalid = [
      new Request(`${ORIGIN}/unzen/code/run?v=1`),
      new Request(`${ORIGIN}/unzen/code/run?h=${encodeURIComponent(validHash)}`),
      new Request(`${ORIGIN}/unzen/code/run?v=0&h=${encodeURIComponent(validHash)}`),
      new Request(`${ORIGIN}/unzen/code/run?v=1&h=sha256%3Ashort`),
      new Request(`${ORIGIN}/unzen/code/run?v=1&v=2&h=${encodeURIComponent(validHash)}`),
      new Request(`${ORIGIN}/unzen/code/run?v=1&h=${encodeURIComponent(validHash)}&x=1`),
      new Request(`${ORIGIN}/unzen/manifest?v=1&h=${encodeURIComponent(validHash)}`),
      new Request(`https://other.example/unzen/code/run?v=1&h=${encodeURIComponent(validHash)}`),
      new Request(`${ORIGIN}/unzen/code/run?v=1&h=${encodeURIComponent(validHash)}`, {
        method: 'POST',
      }),
    ];
    for (const request of invalid) {
      expect(isVersionedUnzenCodeRequest(request, ORIGIN)).toBe(false);
    }
  });

  it('accepts only immutable JavaScript/Wasm success responses', () => {
    expect(isCacheableUnzenCodeResponse(immutableCodeResponse())).toBe(true);
    expect(isCacheableUnzenCodeResponse(new Response('wasm', {
      status: 200,
      headers: {
        'Cache-Control': 'immutable, public',
        'Content-Type': 'application/wasm',
      },
    }))).toBe(true);
    expect(isCacheableUnzenCodeResponse(new Response('code', {
      status: 200,
      headers: { 'Content-Type': 'text/javascript' },
    }))).toBe(false);
    for (const cacheControl of ['private, immutable', 'private="Set-Cookie", immutable']) {
      expect(isCacheableUnzenCodeResponse(new Response('private', {
        status: 200,
        headers: {
          'Cache-Control': cacheControl,
          'Content-Type': 'text/javascript',
        },
      }))).toBe(false);
    }
    expect(isCacheableUnzenCodeResponse(new Response('missing', {
      status: 404,
      headers: {
        'Cache-Control': 'immutable',
        'Content-Type': 'text/javascript',
      },
    }))).toBe(false);
  });

  it('verifies and caches a network response, then serves it offline', async () => {
    const storage = new MemoryCacheStorage();
    const request = codeRequest();
    const fetcher = vi.fn(async () => immutableCodeResponse());
    const runtime = {
      cacheStorage: storage,
      fetch: fetcher,
      digest: async (bytes: ArrayBuffer) => hashBytes(bytes),
    };

    const first = await respondWithUnzenCodeCache(request, runtime);
    expect(await first.text()).toBe('function run() {}');
    expect(storage.cache.putCount).toBe(1);

    const second = await respondWithUnzenCodeCache(request, runtime);
    expect(await second.text()).toBe('function run() {}');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails closed and never caches when response bytes do not match the URL hash', async () => {
    const storage = new MemoryCacheStorage();
    const response = await respondWithUnzenCodeCache(codeRequest('expected'), {
      cacheStorage: storage,
      fetch: async () => immutableCodeResponse('tampered'),
      digest: async (bytes) => hashBytes(bytes),
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(storage.cache.putCount).toBe(0);
  });

  it('uses the network without persistence when CacheStorage or digest is unavailable', async () => {
    const network = immutableCodeResponse();
    const brokenStorage: UnzenCodeCacheStorage = {
      open: async () => { throw new Error('quota'); },
      keys: async () => [],
      delete: async () => false,
    };
    await expect(respondWithUnzenCodeCache(codeRequest(), {
      cacheStorage: brokenStorage,
      fetch: async () => network,
    })).resolves.toBe(network);

    const storage = new MemoryCacheStorage();
    await respondWithUnzenCodeCache(codeRequest(), {
      cacheStorage: storage,
      fetch: async () => immutableCodeResponse(),
    });
    expect(storage.cache.putCount).toBe(0);
  });

  it('still rejects a hash mismatch when CacheStorage is unavailable', async () => {
    const brokenStorage: UnzenCodeCacheStorage = {
      open: async () => { throw new Error('quota'); },
      keys: async () => [],
      delete: async () => false,
    };

    const response = await respondWithUnzenCodeCache(codeRequest('expected'), {
      cacheStorage: brokenStorage,
      fetch: async () => immutableCodeResponse('tampered'),
      digest: async (bytes) => hashBytes(bytes),
    });

    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('deletes only stale Unzen cache generations', async () => {
    const storage = new MemoryCacheStorage();
    storage.names.add('unzen-code-v0');
    storage.names.add(UNZEN_CODE_CACHE_NAME);
    storage.names.add('other-app-cache');

    await expect(deleteUnzenCodeCaches(storage, UNZEN_CODE_CACHE_NAME))
      .resolves.toEqual(['unzen-code-v0']);
    expect(await storage.keys()).toEqual([UNZEN_CODE_CACHE_NAME, 'other-app-cache']);
  });

  it('formats Web Crypto SHA-256 output as the manifest identity', async () => {
    const bytes = new TextEncoder().encode('unzen').buffer;
    await expect(digestUnzenCode(bytes, globalThis.crypto.subtle))
      .resolves.toBe(hashText('unzen'));
  });
});
