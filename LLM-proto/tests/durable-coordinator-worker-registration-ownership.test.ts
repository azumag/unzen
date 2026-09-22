import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { WorkerTier, workerId } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by worker-registration ownership tests');
  },
};

function coordinator() {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true },
  );
}

function hostileThrownValue(): { readonly value: object; readonly coercions: () => number } {
  let coercions = 0;
  const value = {
    toString() {
      coercions += 1;
      throw new Error('caller toString must not run');
    },
    [Symbol.toPrimitive]() {
      coercions += 1;
      throw new Error('caller Symbol.toPrimitive must not run');
    },
  };
  return { value, coercions: () => coercions };
}

describe('DurableCoordinator worker registration ownership', () => {
  it('captures caller-owned registration fields once and stores the captured values', () => {
    const coord = coordinator();
    const reads = { workerId: 0, tier: 0, vramMB: 0 };
    const firstWorkerId = workerId('owned-registration-worker');

    const registration = {
      get workerId() {
        reads.workerId += 1;
        return reads.workerId === 1 ? firstWorkerId : workerId('drifted-worker');
      },
      get tier() {
        reads.tier += 1;
        return reads.tier === 1 ? WorkerTier.TIER_2 : 99 as WorkerTier;
      },
      get vramMB() {
        reads.vramMB += 1;
        return reads.vramMB === 1 ? 8_192 : -1;
      },
    };

    expect(() => coord.registerWorker(registration, 'owned-connection')).not.toThrow();
    expect(reads).toEqual({ workerId: 1, tier: 1, vramMB: 1 });

    const stored = coord.getWorker(firstWorkerId);
    expect(stored?.workerId).toBe(firstWorkerId);
    expect(stored?.tier).toBe(WorkerTier.TIER_2);
    expect(stored?.vramMB).toBe(8_192);
    expect(coord.getWorker(workerId('drifted-worker'))).toBeUndefined();
  });

  it('preserves inherited registration field lookup while still single-reading each field', () => {
    const coord = coordinator();
    const inherited = Object.create({
      workerId: workerId('inherited-worker'),
      tier: WorkerTier.TIER_3,
      vramMB: 8_192,
    }) as {
      workerId: ReturnType<typeof workerId>;
      tier: WorkerTier;
      vramMB: number;
    };

    expect(() => coord.registerWorker(inherited, 'inherited-connection')).not.toThrow();
    expect(coord.getWorker(workerId('inherited-worker'))?.tier).toBe(WorkerTier.TIER_3);
  });

  it('rejects malformed registration containers with the existing protocol error before mutation', () => {
    const coord = coordinator();

    for (const registration of [null, [], 'worker', 1, () => undefined]) {
      try {
        coord.registerWorker(registration as never, 'connection');
        throw new Error('expected registration rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(UnzenError);
        expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
        expect((error as Error).message).toBe(
          'worker registration must be a non-null, non-array object',
        );
      }
      expect(coord.workerCount).toBe(0);
    }
  });

  it.each([
    {
      field: 'workerId' as const,
      message: 'worker registration workerId must be a non-empty string',
      expectedReads: { workerId: 1, tier: 0, vramMB: 0 },
    },
    {
      field: 'tier' as const,
      message: 'worker registration tier must be TIER_1, TIER_2, or TIER_3',
      expectedReads: { workerId: 1, tier: 1, vramMB: 0 },
    },
    {
      field: 'vramMB' as const,
      message: 'worker registration vramMB must be a positive finite number',
      expectedReads: { workerId: 1, tier: 1, vramMB: 1 },
    },
  ])('fails closed on a throwing $field getter without coercing the thrown value', ({ field, message, expectedReads }) => {
    const coord = coordinator();
    const hostile = hostileThrownValue();
    const reads = { workerId: 0, tier: 0, vramMB: 0 };
    const values = {
      workerId: workerId('hostile-registration-worker'),
      tier: WorkerTier.TIER_3,
      vramMB: 8_192,
    };
    const registration = new Proxy(values, {
      get(target, property, receiver) {
        if (property === 'workerId' || property === 'tier' || property === 'vramMB') {
          reads[property] += 1;
          if (property === field) throw hostile.value;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      coord.registerWorker(registration, 'hostile-connection');
      throw new Error('expected registration rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenError);
      expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
      expect((error as Error).message).toBe(message);
    }

    expect(reads).toEqual(expectedReads);
    expect(hostile.coercions()).toBe(0);
    expect(coord.workerCount).toBe(0);
  });

  it('does not revoke an existing generation when reconnect registration field access throws', () => {
    const coord = coordinator();
    const id = workerId('stable-hostile-reconnect-worker');
    const created = coord.registerWorker(
      { workerId: id, tier: WorkerTier.TIER_3, vramMB: 8_192 },
      'connection-a',
    );
    const before = { ...coord.getWorker(id)! };
    const hostile = hostileThrownValue();
    const reconnect = {
      workerId: id,
      tier: WorkerTier.TIER_2,
      get vramMB(): number {
        throw hostile.value;
      },
    };

    try {
      coord.registerWorker(reconnect, 'connection-b');
      throw new Error('expected reconnect rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenError);
      expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
      expect((error as Error).message).toBe(
        'worker registration vramMB must be a positive finite number',
      );
    }

    expect(hostile.coercions()).toBe(0);
    expect(coord.getWorker(id)).toEqual(before);
    expect(coord.getWorker(id)?.generation).toBe(created.generation);
    expect(coord.workerCount).toBe(1);
  });

  it('lets the existing core validator reject captured invalid values without worker mutation', () => {
    const coord = coordinator();
    let tierReads = 0;
    const registration = {
      workerId: workerId('invalid-tier-worker'),
      get tier() {
        tierReads += 1;
        return 99 as WorkerTier;
      },
      vramMB: 8_192,
    };

    try {
      coord.registerWorker(registration, 'invalid-tier-connection');
      throw new Error('expected registration rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenError);
      expect((error as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
      expect((error as Error).message).toBe(
        'worker registration tier must be TIER_1, TIER_2, or TIER_3',
      );
    }
    expect(tierReads).toBe(1);
    expect(coord.workerCount).toBe(0);
  });

  it('uses the captured VRAM value for manifest minimum enforcement', () => {
    const coord = coordinator();
    let vramReads = 0;
    const registration = {
      workerId: workerId('captured-vram-worker'),
      tier: WorkerTier.TIER_2,
      get vramMB() {
        vramReads += 1;
        return vramReads === 1 ? 8_192 : 0;
      },
    };

    expect(() => coord.registerWorker(registration, 'captured-vram-connection')).not.toThrow();
    expect(vramReads).toBe(1);
    expect(coord.getWorker(workerId('captured-vram-worker'))?.vramMB).toBe(8_192);
  });
});
