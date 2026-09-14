import { describe, expect, it } from 'vitest';
import type { WorkerRegistration } from '../src/protocol.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier } from '../src/types.js';

describe('WorkerPool registration owned snapshot', () => {
  it('reads each declared field once and commits the exact validated values', () => {
    const reads = { workerId: 0, tier: 0, vramMB: 0 };
    const registration = {
      get workerId() {
        reads.workerId++;
        return reads.workerId === 1 ? workerId('worker-a') : workerId('worker-b');
      },
      get tier() {
        reads.tier++;
        return reads.tier === 1 ? WorkerTier.TIER_2 : 99;
      },
      get vramMB() {
        reads.vramMB++;
        return reads.vramMB === 1 ? 4096 : Number.NaN;
      },
    } as unknown as WorkerRegistration;

    const pool = new WorkerPool();
    const registered = pool.register(registration);

    expect(reads).toEqual({ workerId: 1, tier: 1, vramMB: 1 });
    expect(registered).toMatchObject({
      id: workerId('worker-a'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
    });
    expect(pool.get(workerId('worker-a'))).toBe(registered);
    expect(pool.get(workerId('worker-b'))).toBeUndefined();
  });

  it('does not enumerate or read unrelated caller properties', () => {
    let ownKeysReads = 0;
    let unrelatedReads = 0;
    const target = {
      workerId: workerId('worker-a'),
      tier: WorkerTier.TIER_1,
      vramMB: 2048,
      get unrelated() {
        unrelatedReads++;
        throw new Error('unrelated getter must not run');
      },
    };
    const registration = new Proxy(target, {
      ownKeys() {
        ownKeysReads++;
        throw new Error('registration keys must not be enumerated');
      },
    }) as unknown as WorkerRegistration;

    const pool = new WorkerPool();
    expect(() => pool.register(registration)).not.toThrow();
    expect(ownKeysReads).toBe(0);
    expect(unrelatedReads).toBe(0);
  });

  it('stops field reads at the first invalid captured value without mutation', () => {
    const reads = { workerId: 0, tier: 0, vramMB: 0 };
    const registration = {
      get workerId() {
        reads.workerId++;
        return '   ';
      },
      get tier() {
        reads.tier++;
        return WorkerTier.TIER_2;
      },
      get vramMB() {
        reads.vramMB++;
        return 4096;
      },
    } as unknown as WorkerRegistration;

    const pool = new WorkerPool();
    expect(() => pool.register(registration)).toThrow(/workerId must be a non-empty string/);
    expect(reads).toEqual({ workerId: 1, tier: 0, vramMB: 0 });
    expect(pool.size).toBe(0);
  });
});
