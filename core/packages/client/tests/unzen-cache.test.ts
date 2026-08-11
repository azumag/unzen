import { describe, expect, it, vi } from 'vitest';
import {
  clearUnzenCodeCache,
  registerUnzenCacheWorker,
  registerUnzenCacheWorkerWith,
} from '../src/unzen-cache';

describe('Unzen cache worker browser API', () => {
  it('registers the classic worker without consulting the HTTP cache', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);

    await expect(registerUnzenCacheWorkerWith({ register }, {
      workerUrl: '/assets/unzen-cache-worker.js',
      scope: '/',
    })).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith('/assets/unzen-cache-worker.js', {
      scope: '/',
      updateViaCache: 'none',
    });
  });

  it('uses root-level defaults and rejects empty registration values', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const register = vi.fn().mockResolvedValue(registration);
    const container = { register };

    await registerUnzenCacheWorkerWith(container);
    expect(register).toHaveBeenCalledWith('/unzen-cache-worker.js', {
      updateViaCache: 'none',
    });
    await expect(registerUnzenCacheWorkerWith(container, { workerUrl: ' ' }))
      .rejects.toThrow(TypeError);
    await expect(registerUnzenCacheWorkerWith(container, { scope: '' }))
      .rejects.toThrow(TypeError);
    await expect(registerUnzenCacheWorkerWith(container, [] as never))
      .rejects.toThrow(TypeError);
    await expect(registerUnzenCacheWorkerWith(container, null as never))
      .rejects.toThrow(TypeError);
  });

  it('snapshots registration options and the container method once', async () => {
    const registration = {} as ServiceWorkerRegistration;
    const reads = { workerUrl: 0, scope: 0, register: 0 };
    const register = vi.fn().mockResolvedValue(registration);
    const container = {
      get register() {
        reads.register += 1;
        if (reads.register > 1) throw new Error('register read more than once');
        return register;
      },
    };
    const options = {
      get workerUrl() {
        reads.workerUrl += 1;
        if (reads.workerUrl > 1) throw new Error('workerUrl read more than once');
        return '/assets/unzen-cache-worker.js';
      },
      get scope() {
        reads.scope += 1;
        if (reads.scope > 1) throw new Error('scope read more than once');
        return '/app/';
      },
    };

    await expect(registerUnzenCacheWorkerWith(container, options))
      .resolves.toBe(registration);
    expect(reads).toEqual({ workerUrl: 1, scope: 1, register: 1 });
    expect(register).toHaveBeenCalledWith('/assets/unzen-cache-worker.js', {
      scope: '/app/',
      updateViaCache: 'none',
    });
  });

  it('maps unreadable registration inputs to stable TypeErrors before register', async () => {
    const register = vi.fn();
    const container = { register };
    const options = {
      get workerUrl(): string {
        throw new Error('access denied');
      },
    };

    await expect(registerUnzenCacheWorkerWith(container, options))
      .rejects.toThrow(TypeError);
    expect(register).not.toHaveBeenCalled();
  });

  it('is a no-op in a runtime without Service Worker or CacheStorage globals', async () => {
    await expect(registerUnzenCacheWorker()).resolves.toBeNull();
    await expect(clearUnzenCodeCache()).resolves.toBe(0);
  });
});
