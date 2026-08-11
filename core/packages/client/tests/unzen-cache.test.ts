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
  });

  it('is a no-op in a runtime without Service Worker or CacheStorage globals', async () => {
    await expect(registerUnzenCacheWorker()).resolves.toBeNull();
    await expect(clearUnzenCodeCache()).resolves.toBe(0);
  });
});
