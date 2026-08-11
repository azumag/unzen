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

interface UnzenCacheWorkerRegistrationSnapshot {
  readonly workerUrl: string;
  readonly scope?: string;
}

function snapshotRegistrationOptions(value: unknown): UnzenCacheWorkerRegistrationSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Unzen cache worker options must be an object');
  }

  let rawWorkerUrl: unknown;
  let scope: unknown;
  try {
    const record = value as Record<string, unknown>;
    rawWorkerUrl = record.workerUrl;
    scope = record.scope;
  } catch {
    throw new TypeError('Unzen cache worker options could not be read');
  }

  const workerUrl = rawWorkerUrl ?? '/unzen-cache-worker.js';
  if (typeof workerUrl !== 'string' || workerUrl.trim().length === 0) {
    throw new TypeError('workerUrl must be a non-empty string');
  }
  if (scope !== undefined && (
    typeof scope !== 'string' || scope.trim().length === 0
  )) {
    throw new TypeError('scope must be a non-empty string when provided');
  }
  return {
    workerUrl,
    ...(scope !== undefined && { scope: scope as string }),
  };
}

function snapshotRegisterMethod(value: unknown): {
  readonly target: object;
  readonly register: UnzenServiceWorkerContainer['register'];
} {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('Service Worker container must provide register()');
  }
  let register: unknown;
  try {
    register = (value as Record<string, unknown>).register;
  } catch {
    throw new TypeError('Service Worker container register() could not be read');
  }
  if (typeof register !== 'function') {
    throw new TypeError('Service Worker container must provide register()');
  }
  return {
    target: value,
    register: register as UnzenServiceWorkerContainer['register'],
  };
}

/** Injectable implementation used by the public browser guard and tests. */
export async function registerUnzenCacheWorkerWith(
  container: UnzenServiceWorkerContainer,
  options: UnzenCacheWorkerOptions = {},
): Promise<ServiceWorkerRegistration> {
  const snapshot = snapshotRegistrationOptions(options);
  const method = snapshotRegisterMethod(container);

  const registrationOptions: { scope?: string; updateViaCache: 'none' } = {
    updateViaCache: 'none',
  };
  if (snapshot.scope !== undefined) registrationOptions.scope = snapshot.scope;
  return Reflect.apply(method.register, method.target, [
    snapshot.workerUrl,
    registrationOptions,
  ]) as Promise<ServiceWorkerRegistration>;
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
  const container = navigator.serviceWorker;
  return registerUnzenCacheWorkerWith(container, options);
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
