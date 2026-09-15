import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';

describe('WorkerPool guarded live-view prototype fence', () => {
  it('rejects direct prototype replacement before an inherited segment can appear', () => {
    const pool = new WorkerPool();
    const view = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });
    const canonicalPrototype = Object.getPrototypeOf(view);
    const hostilePrototype = { currentSegment: -1 };

    expect(canonicalPrototype).toBe(Object.prototype);
    expect(view.currentSegment).toBeUndefined();
    expect(() => Object.setPrototypeOf(view, hostilePrototype)).toThrow(/prototype is immutable/);
    expect(Object.getPrototypeOf(view)).toBe(canonicalPrototype);
    expect(view.currentSegment).toBeUndefined();

    pool.markBusy(workerId('w1'), 2);
    expect(view.status).toBe(WorkerStatus.BUSY);
    expect(view.currentSegment).toBe(2);
  });

  it('rejects __proto__ mutation through the generic property traps', () => {
    const pool = new WorkerPool();
    const view = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 2048,
    });
    const canonicalPrototype = Object.getPrototypeOf(view);
    const hostilePrototype = { currentSegment: Number.MAX_SAFE_INTEGER + 1 };

    expect(() => Reflect.set(view, '__proto__', hostilePrototype)).toThrow(/prototype is immutable/);
    expect(() =>
      Reflect.defineProperty(view, '__proto__', {
        value: hostilePrototype,
        writable: true,
        configurable: true,
        enumerable: false,
      }),
    ).toThrow(/prototype is immutable/);
    expect(() => Reflect.deleteProperty(view, '__proto__')).toThrow(/prototype is immutable/);

    expect(Object.getPrototypeOf(view)).toBe(canonicalPrototype);
    expect(view.currentSegment).toBeUndefined();
    expect(pool.getAvailableWorker(1024)).toBe(view);
  });
});
