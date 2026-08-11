/** Browser-facing registration and maintenance API for Unzen code caching. */

import {
  deleteUnzenCodeCaches,
  UNZEN_CODE_CACHE_NAME,
  type UnzenCodeCacheStorage,
} from './unzen-cache-worker';

export interface UnzenCacheWorkerOptions {
  /** Same-origin classic Service Worker bundle. Defaults to `/unzen-cache-worker.js`. */
  workerUrl?: string;
  /** Registration scope. A root-level worker defaults to `/`. */
  scope?: string;
}

interface UnzenServiceWorkerContainer {
  register(
    scriptURL: string,
    options: { scope?: string; updateViaCache: 'none' },
  ): Promise<ServiceWorkerRegistration>;
}

/** Injectable implementation used by the public browser guard and tests. */
export async function registerUnzenCacheWorkerWith(
  container: UnzenServiceWorkerContainer,
  options: UnzenCacheWorkerOptions = {},
): Promise<ServiceWorkerRegistration> {
  const workerUrl = options.workerUrl ?? '/unzen-cache-worker.js';
  if (typeof workerUrl !== 'string' || workerUrl.trim().length === 0) {
    throw new TypeError('workerUrl must be a non-empty string');
  }
  if (options.scope !== undefined && (
    typeof options.scope !== 'string' || options.scope.trim().length === 0
  )) {
    throw new TypeError('scope must be a non-empty string when provided');
  }

  const registrationOptions: { scope?: string; updateViaCache: 'none' } = {
    updateViaCache: 'none',
  };
  if (options.scope !== undefined) registrationOptions.scope = options.scope;
  return container.register(workerUrl, registrationOptions);
}

/**
 * Register the classic Unzen cache worker, or return null outside a supported
 * secure browser context. Registration failures remain rejected for callers
 * to report explicitly.
 */
export function registerUnzenCacheWorker(
  options: UnzenCacheWorkerOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  if (
    typeof navigator === 'undefined'
    || !('serviceWorker' in navigator)
    || navigator.serviceWorker === undefined
  ) {
    return Promise.resolve(null);
  }
  return registerUnzenCacheWorkerWith(navigator.serviceWorker, options);
}

/** Delete every Unzen code cache generation. Returns the number removed. */
export async function clearUnzenCodeCache(): Promise<number> {
  if (typeof caches === 'undefined') return 0;
  const deleted = await deleteUnzenCodeCaches(
    caches as unknown as UnzenCodeCacheStorage,
    null,
  );
  return deleted.length;
}

export { UNZEN_CODE_CACHE_NAME };
