import { describe, expect, it } from 'vitest';
import type { WorkerRegistration } from '../src/protocol.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier } from '../src/types.js';

function hostileValue(counter: { count: number }): object {
  const fail = () => {
    counter.count += 1;
    throw new Error('coercion hook must not run');
  };
  return {
    [Symbol.toPrimitive]: fail,
    valueOf: fail,
    toString: fail,
  };
}

describe('WorkerPool registration runtime boundary', () => {
  it('fails closed on a revoked registration Proxy before pool mutation', () => {
    const revocable = Proxy.revocable({
      workerId: workerId('worker-a'),
      tier: WorkerTier.TIER_1,
      vramMB: 2048,
    }, {});
    const registration = revocable.proxy as unknown as WorkerRegistration;
    revocable.revoke();
    const pool = new WorkerPool();

    expect(() => pool.register(registration))
      .toThrow('worker registration must be a non-null object');
    expect(pool.size).toBe(0);
    expect(pool.idleCount).toBe(0);
  });

  it('does not inspect or coerce a value thrown by a registration getter', () => {
    const coercions = { count: 0 };
    let tierReads = 0;
    let vramReads = 0;
    const registration = {
      get workerId() {
        throw hostileValue(coercions);
      },
      get tier() {
        tierReads += 1;
        return WorkerTier.TIER_2;
      },
      get vramMB() {
        vramReads += 1;
        return 4096;
      },
    } as unknown as WorkerRegistration;
    const pool = new WorkerPool();

    expect(() => pool.register(registration)).toThrow('workerId could not be read');
    expect(coercions.count).toBe(0);
    expect(tierReads).toBe(0);
    expect(vramReads).toBe(0);
    expect(pool.size).toBe(0);
  });

  it('does not coerce an invalid object-valued tier and preserves fail-fast field order', () => {
    const coercions = { count: 0 };
    let vramReads = 0;
    const registration = {
      workerId: workerId('worker-a'),
      tier: hostileValue(coercions),
      get vramMB() {
        vramReads += 1;
        return 4096;
      },
    } as unknown as WorkerRegistration;
    const pool = new WorkerPool();

    expect(() => pool.register(registration))
      .toThrow('worker tier must be 1, 2, or 3; found unknown');
    expect(coercions.count).toBe(0);
    expect(vramReads).toBe(0);
    expect(pool.size).toBe(0);
  });

  it('does not coerce an invalid object-valued vramMB', () => {
    const coercions = { count: 0 };
    const registration = {
      workerId: workerId('worker-a'),
      tier: WorkerTier.TIER_2,
      vramMB: hostileValue(coercions),
    } as unknown as WorkerRegistration;
    const pool = new WorkerPool();

    expect(() => pool.register(registration))
      .toThrow('worker vramMB must be a positive finite number; found unknown');
    expect(coercions.count).toBe(0);
    expect(pool.size).toBe(0);
  });

  it('keeps useful primitive diagnostics for invalid tier and vramMB values', () => {
    const tierPool = new WorkerPool();
    expect(() => tierPool.register({
      workerId: workerId('worker-a'),
      tier: 99,
      vramMB: 2048,
    } as unknown as WorkerRegistration)).toThrow('worker tier must be 1, 2, or 3; found 99');
    expect(tierPool.size).toBe(0);

    const vramPool = new WorkerPool();
    expect(() => vramPool.register({
      workerId: workerId('worker-b'),
      tier: WorkerTier.TIER_1,
      vramMB: Number.NaN,
    } as unknown as WorkerRegistration))
      .toThrow('worker vramMB must be a positive finite number; found NaN');
    expect(vramPool.size).toBe(0);
  });
});
