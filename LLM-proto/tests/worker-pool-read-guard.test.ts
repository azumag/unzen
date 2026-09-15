import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';

describe('WorkerPool guarded live views', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects routing identity/capability mutation from register() without changing selection', () => {
    const guarded = pool.register({
      workerId: workerId('attacker'),
      tier: WorkerTier.TIER_3,
      vramMB: 1024,
    });
    pool.register({
      workerId: workerId('healthy'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });

    expect(() => Reflect.set(guarded, 'id', workerId('spoofed'))).toThrow(
      /protected field id is immutable/,
    );
    expect(() => Reflect.set(guarded, 'tier', WorkerTier.TIER_1)).toThrow(
      /protected field tier is immutable/,
    );
    expect(() => Reflect.set(guarded, 'vramMB', 16384)).toThrow(
      /protected field vramMB is immutable/,
    );

    expect(pool.get(workerId('attacker'))).toBe(guarded);
    expect(pool.get(workerId('spoofed'))).toBeUndefined();
    expect(pool.getAvailableWorker(2100)?.id).toBe(workerId('healthy'));
  });

  it('guards protected fields on every public read path, including timed-out workers', () => {
    const registered = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });

    expect(pool.get(workerId('w1'))).toBe(registered);
    expect(pool.getAvailableWorker(1024)).toBe(registered);
    expect([...pool.allWorkers()][0]).toBe(registered);

    vi.advanceTimersByTime(20_000);
    const timedOut = pool.getTimedOutWorkers(15_000);
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toBe(registered);

    for (const view of [registered, pool.get(workerId('w1'))!, timedOut[0]!]) {
      expect(() => Reflect.deleteProperty(view, 'id')).toThrow(/protected field id is immutable/);
      expect(() =>
        Reflect.defineProperty(view, 'tier', {
          value: WorkerTier.TIER_1,
          writable: true,
          configurable: true,
          enumerable: true,
        }),
      ).toThrow(/protected field tier is immutable/);
      expect(() => Reflect.set(view, 'vramMB', 8192)).toThrow(
        /protected field vramMB is immutable/,
      );
    }
  });

  it('preserves operational write-through compatibility on guarded views', () => {
    const view = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });

    view.status = WorkerStatus.BUSY;
    view.currentSegment = 7;
    view.lastHeartbeat = 1234;

    const reread = pool.get(workerId('w1'))!;
    expect(reread).toBe(view);
    expect(reread.status).toBe(WorkerStatus.BUSY);
    expect(reread.currentSegment).toBe(7);
    expect(reread.lastHeartbeat).toBe(1234);
    expect(pool.getAvailableWorker(1024)).toBeNull();

    expect(Reflect.deleteProperty(view, 'currentSegment')).toBe(true);
    expect(pool.get(workerId('w1'))?.currentSegment).toBeUndefined();
    expect(
      Reflect.defineProperty(view, 'status', {
        value: WorkerStatus.IDLE,
        writable: true,
        configurable: true,
        enumerable: true,
      }),
    ).toBe(true);
    expect(pool.getAvailableWorker(1024)).toBe(view);
  });

  it('rejects malformed operational assignments before stored routing state changes', () => {
    const view = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });
    const initialHeartbeat = view.lastHeartbeat;

    expect(() => Reflect.set(view, 'status', 'idle-ish')).toThrow(/valid WorkerStatus/);
    expect(() => Reflect.set(view, 'status', Symbol('idle'))).toThrow(/valid WorkerStatus/);
    expect(() => Reflect.set(view, 'lastHeartbeat', Number.NaN)).toThrow(/non-negative finite number/);
    expect(() => Reflect.set(view, 'lastHeartbeat', Number.POSITIVE_INFINITY)).toThrow(
      /non-negative finite number/,
    );
    expect(() => Reflect.set(view, 'lastHeartbeat', -1)).toThrow(/non-negative finite number/);
    expect(() => Reflect.set(view, 'lastHeartbeat', '1234')).toThrow(/non-negative finite number/);
    expect(() => Reflect.set(view, 'currentSegment', -1)).toThrow(/non-negative safe integer/);
    expect(() => Reflect.set(view, 'currentSegment', 1.5)).toThrow(/non-negative safe integer/);
    expect(() => Reflect.set(view, 'currentSegment', Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /non-negative safe integer/,
    );
    expect(() => Reflect.set(view, 'currentSegment', '1')).toThrow(/non-negative safe integer/);

    expect(view.status).toBe(WorkerStatus.IDLE);
    expect(view.lastHeartbeat).toBe(initialHeartbeat);
    expect(view.currentSegment).toBeUndefined();
    expect(pool.getAvailableWorker(1024)).toBe(view);
  });

  it('rejects deletion, hostile descriptors, and object locking for operational state', () => {
    const view = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });
    const initialHeartbeat = view.lastHeartbeat;

    expect(() => Reflect.deleteProperty(view, 'status')).toThrow(/required field status cannot be deleted/);
    expect(() => Reflect.deleteProperty(view, 'lastHeartbeat')).toThrow(
      /required field lastHeartbeat cannot be deleted/,
    );
    expect(() =>
      Reflect.defineProperty(view, 'status', {
        get: () => WorkerStatus.IDLE,
      }),
    ).toThrow(/cannot be an accessor/);
    expect(() =>
      Reflect.defineProperty(view, 'lastHeartbeat', {
        value: initialHeartbeat,
        writable: false,
      }),
    ).toThrow(/must remain mutable/);
    expect(() =>
      Reflect.defineProperty(view, 'currentSegment', {
        value: -1,
      }),
    ).toThrow(/non-negative safe integer/);
    expect(() => Object.preventExtensions(view)).toThrow(/live view must remain extensible/);
    expect(Object.isExtensible(view)).toBe(true);

    expect(view.status).toBe(WorkerStatus.IDLE);
    expect(view.lastHeartbeat).toBe(initialHeartbeat);
    expect(view.currentSegment).toBeUndefined();

    pool.markBusy(workerId('w1'), 3);
    expect(view.status).toBe(WorkerStatus.BUSY);
    expect(view.currentSegment).toBe(3);
    pool.markIdle(workerId('w1'));
    expect(view.status).toBe(WorkerStatus.IDLE);
    expect(view.currentSegment).toBeUndefined();
  });

  it('keeps a retained pre-reregistration view bound to the replaced record only', () => {
    const oldView = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 2048,
    });
    const replacement = pool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_1,
      vramMB: 8192,
    });

    expect(replacement).not.toBe(oldView);
    oldView.status = WorkerStatus.DISCONNECTED;
    oldView.lastHeartbeat = 1;

    expect(() => Reflect.set(oldView, 'tier', WorkerTier.TIER_1)).toThrow(
      /protected field tier is immutable/,
    );
    expect(pool.get(workerId('w1'))).toBe(replacement);
    expect(replacement.status).toBe(WorkerStatus.IDLE);
    expect(replacement.lastHeartbeat).not.toBe(1);
    expect(replacement.tier).toBe(WorkerTier.TIER_1);
    expect(replacement.vramMB).toBe(8192);
  });
});
