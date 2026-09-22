import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import { WorkerRegistry } from '../src/worker-registry.js';
import { workerId, WorkerTier } from '../src/types.js';

function validRegistration(id = 'worker-1') {
  return {
    workerId: workerId(id),
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
  return {
    value: target,
    coercionCount: () => coercionCount,
  };
}

describe('WorkerRegistry registration envelope boundary', () => {
  it('maps a revoked registration root to the owned envelope diagnostic', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    expect(() => registry.register(revoked.proxy as never, 'conn-1')).toThrow(
      'worker registration must be a non-null object',
    );
    expect(registry.size).toBe(0);
  });

  it('stops after an unreadable workerId without inspecting the thrown value or later fields', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const thrown = hostileValue('object');
    let workerIdReads = 0;
    let tierReads = 0;
    let vramReads = 0;
    const registration = Object.defineProperties({}, {
      workerId: {
        get() {
          workerIdReads += 1;
          throw thrown.value;
        },
      },
      tier: {
        get() {
          tierReads += 1;
          return WorkerTier.TIER_2;
        },
      },
      vramMB: {
        get() {
          vramReads += 1;
          return 4096;
        },
      },
    });

    expect(() => registry.register(registration as never, 'conn-1')).toThrow(
      'worker registration workerId could not be read',
    );
    expect(workerIdReads).toBe(1);
    expect(tierReads).toBe(0);
    expect(vramReads).toBe(0);
    expect(thrown.coercionCount()).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('stops after an unreadable tier without inspecting the thrown value or vramMB', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const thrown = hostileValue('function');
    let workerIdReads = 0;
    let tierReads = 0;
    let vramReads = 0;
    const registration = Object.defineProperties({}, {
      workerId: {
        get() {
          workerIdReads += 1;
          return 'worker-tier-getter';
        },
      },
      tier: {
        get() {
          tierReads += 1;
          throw thrown.value;
        },
      },
      vramMB: {
        get() {
          vramReads += 1;
          return 4096;
        },
      },
    });

    expect(() => registry.register(registration as never, 'conn-1')).toThrow(
      'worker registration tier could not be read',
    );
    expect(workerIdReads).toBe(1);
    expect(tierReads).toBe(1);
    expect(vramReads).toBe(0);
    expect(thrown.coercionCount()).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('maps an unreadable vramMB to a stable field diagnostic', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const thrown = hostileValue('object');
    let workerIdReads = 0;
    let tierReads = 0;
    let vramReads = 0;
    const registration = Object.defineProperties({}, {
      workerId: {
        get() {
          workerIdReads += 1;
          return 'worker-vram-getter';
        },
      },
      tier: {
        get() {
          tierReads += 1;
          return WorkerTier.TIER_2;
        },
      },
      vramMB: {
        get() {
          vramReads += 1;
          throw thrown.value;
        },
      },
    });

    expect(() => registry.register(registration as never, 'conn-1')).toThrow(
      'worker registration vramMB could not be read',
    );
    expect(workerIdReads).toBe(1);
    expect(tierReads).toBe(1);
    expect(vramReads).toBe(1);
    expect(thrown.coercionCount()).toBe(0);
    expect(registry.size).toBe(0);
  });

  it('captures each registration field once and stores only the validated snapshot', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    let workerIdReads = 0;
    let tierReads = 0;
    let vramReads = 0;
    const registration = Object.defineProperties({}, {
      workerId: {
        get() {
          workerIdReads += 1;
          return workerIdReads === 1 ? 'worker-snapshot' : 'worker-replaced';
        },
      },
      tier: {
        get() {
          tierReads += 1;
          return tierReads === 1 ? WorkerTier.TIER_2 : WorkerTier.TIER_3;
        },
      },
      vramMB: {
        get() {
          vramReads += 1;
          return vramReads === 1 ? 4096 : 1;
        },
      },
    });

    const outcome = registry.register(registration as never, 'conn-1', 1234);

    expect(outcome.kind).toBe('created');
    expect(workerIdReads).toBe(1);
    expect(tierReads).toBe(1);
    expect(vramReads).toBe(1);
    expect(registry.get(workerId('worker-snapshot'))).toMatchObject({
      workerId: workerId('worker-snapshot'),
      tier: WorkerTier.TIER_2,
      vramMB: 4096,
      connectionId: 'conn-1',
      registeredAt: 1234,
    });
    expect(registry.get(workerId('worker-replaced'))).toBeUndefined();
  });

  it.each(['object', 'function'] as const)(
    'does not coerce a hostile %s invalid tier while formatting the rejection',
    (kind) => {
      const repository = new InMemoryRepository();
      const registry = new WorkerRegistry(repository);
      const hostile = hostileValue(kind);

      expect(() => registry.register({
        ...validRegistration(),
        tier: hostile.value as never,
      }, 'conn-1')).toThrow('worker tier must be 1, 2, or 3; found unknown');
      expect(hostile.coercionCount()).toBe(0);
      expect(registry.size).toBe(0);
    },
  );

  it.each(['object', 'function'] as const)(
    'does not coerce a hostile %s invalid vramMB while formatting the rejection',
    (kind) => {
      const repository = new InMemoryRepository();
      const registry = new WorkerRegistry(repository);
      const hostile = hostileValue(kind);

      expect(() => registry.register({
        ...validRegistration(),
        vramMB: hostile.value as never,
      }, 'conn-1')).toThrow('worker vramMB must be a positive finite number; found unknown');
      expect(hostile.coercionCount()).toBe(0);
      expect(registry.size).toBe(0);
    },
  );

  it('preserves useful primitive tier and vramMB diagnostics', () => {
    const registry = new WorkerRegistry(new InMemoryRepository());

    expect(() => registry.register({ ...validRegistration(), tier: 4 as never }, 'conn-1')).toThrow(
      'worker tier must be 1, 2, or 3; found 4',
    );
    expect(() => registry.register({
      ...validRegistration(),
      tier: Symbol('tier') as never,
    }, 'conn-1')).toThrow('worker tier must be 1, 2, or 3; found Symbol(tier)');
    expect(() => registry.register({ ...validRegistration(), vramMB: 0 }, 'conn-1')).toThrow(
      'worker vramMB must be a positive finite number; found 0',
    );
    expect(() => registry.register({
      ...validRegistration(),
      vramMB: Symbol('vram') as never,
    }, 'conn-1')).toThrow('worker vramMB must be a positive finite number; found Symbol(vram)');
  });

  it.each(['conn-1', 'conn-2'])('preserves an existing worker on rejected registration via %s', (connectionId) => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const id = workerId('worker-existing');
    const created = registry.register(validRegistration(id), 'conn-1', 1000);
    const before = { ...registry.get(id)! };
    const hostile = hostileValue('object');

    expect(() => registry.register({
      workerId: id,
      tier: hostile.value as never,
      vramMB: 8192,
    }, connectionId, 2000)).toThrow('worker tier must be 1, 2, or 3; found unknown');

    expect(hostile.coercionCount()).toBe(0);
    expect(registry.get(id)).toEqual(before);
    expect(registry.getByGeneration(created.generation)).toEqual(before);
    expect(registry.size).toBe(1);
  });
});
