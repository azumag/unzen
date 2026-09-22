import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import { WorkerRegistry } from '../src/worker-registry.js';
import { workerId, WorkerTier, type WorkerId } from '../src/types.js';

class CountingRepository extends InMemoryRepository {
  workerReads = 0;
  workerListings = 0;

  override getWorker(
    ...args: Parameters<InMemoryRepository['getWorker']>
  ): ReturnType<InMemoryRepository['getWorker']> {
    this.workerReads += 1;
    return super.getWorker(...args);
  }

  override listWorkers(): ReturnType<InMemoryRepository['listWorkers']> {
    this.workerListings += 1;
    return super.listWorkers();
  }

  resetCounts(): void {
    this.workerReads = 0;
    this.workerListings = 0;
  }
}

function validRegistration(id: WorkerId) {
  return {
    workerId: id,
    tier: WorkerTier.TIER_2,
    vramMB: 4096,
  };
}

function hostileValue(kind: 'object' | 'function') {
  let coercionCount = 0;
  const target = kind === 'function' ? (() => undefined) : {};
  Object.defineProperties(target, {
    [Symbol.toPrimitive]: {
      value: () => {
        coercionCount += 1;
        throw new Error('Symbol.toPrimitive must not run');
      },
    },
    valueOf: {
      value: () => {
        coercionCount += 1;
        throw new Error('valueOf must not run');
      },
    },
    toString: {
      value: () => {
        coercionCount += 1;
        throw new Error('toString must not run');
      },
    },
  });
  return { value: target, coercionCount: () => coercionCount };
}

describe('WorkerRegistry numeric diagnostics runtime boundary', () => {
  it.each(['object', 'function'] as const)(
    'does not coerce a hostile %s heartbeat timestamp before repository access',
    (kind) => {
      const repository = new CountingRepository();
      const registry = new WorkerRegistry(repository);
      const id = workerId('heartbeat-numeric-boundary');
      const created = registry.register(validRegistration(id), 'conn-1', 1000);
      const before = { ...registry.get(id)! };
      repository.resetCounts();
      const hostile = hostileValue(kind);

      expect(() => registry.heartbeat(id, created.generation, hostile.value as never)).toThrow(
        'heartbeat now must be a non-negative finite number; found unknown',
      );
      expect(hostile.coercionCount()).toBe(0);
      expect(repository.workerReads).toBe(0);
      expect(registry.get(id)).toEqual(before);
    },
  );

  it.each(['object', 'function'] as const)(
    'does not coerce a hostile %s VRAM requirement before worker enumeration',
    (kind) => {
      const repository = new CountingRepository();
      const registry = new WorkerRegistry(repository);
      const hostile = hostileValue(kind);

      expect(() => registry.getAvailableWorker(hostile.value as never)).toThrow(
        'requiredVramMB must be a positive finite number; found unknown',
      );
      expect(hostile.coercionCount()).toBe(0);
      expect(repository.workerListings).toBe(0);
    },
  );

  it.each(['object', 'function'] as const)(
    'does not coerce a hostile %s heartbeat timeout before worker enumeration',
    (kind) => {
      const repository = new CountingRepository();
      const registry = new WorkerRegistry(repository);
      const hostile = hostileValue(kind);

      expect(() => registry.listTimedOut(hostile.value as never, 1000)).toThrow(
        'timeoutMs must be a positive finite number; found unknown',
      );
      expect(hostile.coercionCount()).toBe(0);
      expect(repository.workerListings).toBe(0);
    },
  );

  it.each(['object', 'function'] as const)(
    'does not coerce a hostile %s busy segment index before worker lookup or mutation',
    (kind) => {
      const repository = new CountingRepository();
      const registry = new WorkerRegistry(repository);
      const id = workerId('segment-numeric-boundary');
      const created = registry.register(validRegistration(id), 'conn-1', 1000);
      const before = { ...registry.get(id)! };
      repository.resetCounts();
      const hostile = hostileValue(kind);

      expect(() => registry.markBusy(id, created.generation, hostile.value as never)).toThrow(
        'segmentIndex must be a non-negative safe integer; found unknown',
      );
      expect(hostile.coercionCount()).toBe(0);
      expect(repository.workerReads).toBe(0);
      expect(registry.get(id)).toEqual(before);
    },
  );

  it('does not inspect a revoked Proxy while formatting a numeric rejection', () => {
    const registry = new WorkerRegistry(new InMemoryRepository());
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(() => registry.getAvailableWorker(revoked.proxy as never)).toThrow(
      'requiredVramMB must be a positive finite number; found unknown',
    );
  });

  it('preserves useful primitive numeric diagnostics', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const id = workerId('primitive-diagnostics');
    const created = registry.register(validRegistration(id), 'conn-1', 1000);

    expect(() => registry.heartbeat(id, created.generation, Number.POSITIVE_INFINITY)).toThrow(
      'heartbeat now must be a non-negative finite number; found Infinity',
    );
    expect(() => registry.getAvailableWorker(Number.NaN)).toThrow(
      'requiredVramMB must be a positive finite number; found NaN',
    );
    expect(() => registry.listTimedOut(0, 1000)).toThrow(
      'timeoutMs must be a positive finite number; found 0',
    );
    expect(() => registry.markBusy(id, created.generation, -1)).toThrow(
      'segmentIndex must be a non-negative safe integer; found -1',
    );
  });
});
