/** Classic Service Worker entry for persistent versioned Unzen code caching. */

import {
  deleteUnzenCodeCaches,
  digestUnzenCode,
  isVersionedUnzenCodeRequest,
  respondWithUnzenCodeCache,
  UNZEN_CODE_CACHE_NAME,
  type UnzenCodeCacheStorage,
} from '../unzen-cache-worker';

interface LifecycleEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike {
  request: Request;
  respondWith(response: Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

interface UnzenServiceWorkerScope {
  location: Location;
  caches: UnzenCodeCacheStorage;
  crypto: Crypto;
  clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  addEventListener(type: 'install', listener: (event: LifecycleEventLike) => void): void;
  addEventListener(type: 'activate', listener: (event: LifecycleEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

const scope = globalThis as unknown as UnzenServiceWorkerScope;

scope.addEventListener('install', (event) => {
  event.waitUntil(scope.skipWaiting());
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    deleteUnzenCodeCaches(scope.caches, UNZEN_CODE_CACHE_NAME).catch(() => []),
    scope.clients.claim(),
  ]).then(() => undefined));
});

scope.addEventListener('fetch', (event) => {
  if (!isVersionedUnzenCodeRequest(event.request, scope.location.origin)) return;
  let persistence = Promise.resolve();
  const response = respondWithUnzenCodeCache(event.request, {
    cacheStorage: scope.caches,
    fetch: (request) => scope.fetch(request),
    digest: (bytes) => digestUnzenCode(bytes, scope.crypto.subtle),
    waitUntil: (task) => {
      persistence = task;
    },
  });
  event.respondWith(response);
  // Register the lifetime extension synchronously. `persistence` is assigned
  // before the response promise settles, after integrity verification.
  event.waitUntil(response.then(
    () => persistence,
    () => undefined,
  ));
});
