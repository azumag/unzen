import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import { generateWorkerGeneration } from '../src/ids.js';
import { WorkerStage } from '../src/durable-types.js';
import { WorkerRegistry } from '../src/worker-registry.js';
import { workerId, WorkerTier } from '../src/types.js';

function validRegistration(id = 'worker-1') {
  return {
    workerId: workerId(id),
    tier: WorkerTier.TIER_2,
    vramMB: 4096,
  };
}

describe('WorkerRegistry runtime boundaries', () => {
  it.each([
    ['null', null],
    ['string', 'worker-1'],
    ['number', 1],
    ['array', []],
    ['symbol', Symbol('registration')],
  ])('rejects a %s registration envelope before reading fields or mutating state', (_label, value) => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);

    expect(() => registry.register(value as never, 'conn-1')).toThrow(
      /worker registration must be a non-null object/,
    );
    expect(registry.size).toBe(0);
  });

  it.each([
    ['negative', -1],
    ['fractional', 0.5],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['numeric string', '0'],
    ['symbol', Symbol('segment')],
    ['object', { value: 0 }],
  ])('rejects a %s busy segment index before mutating durable worker state', (_label, value) => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const id = workerId('worker-1');
    const registration = registry.register(validRegistration(), 'conn-1');
    const before = { ...registry.get(id)! };

    expect(() => registry.markBusy(id, registration.generation, value as never)).toThrow(
      /segmentIndex must be a non-negative safe integer/,
    );
    expect(registry.get(id)).toEqual(before);
    expect(registry.get(id)?.stage).toBe(WorkerStage.Idle);
    expect(registry.get(id)?.currentSegment).toBeUndefined();
  });

  it('keeps valid stale-generation markBusy calls as no-ops', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const id = workerId('worker-1');
    registry.register(validRegistration(), 'conn-1');
    const before = { ...registry.get(id)! };

    expect(() => registry.markBusy(id, generateWorkerGeneration(), 0)).not.toThrow();
    expect(registry.get(id)).toEqual(before);
  });

  it('still accepts a non-negative safe segment index for the current generation', () => {
    const repository = new InMemoryRepository();
    const registry = new WorkerRegistry(repository);
    const id = workerId('worker-1');
    const registration = registry.register(validRegistration(), 'conn-1');

    registry.markBusy(id, registration.generation, 3);

    expect(registry.get(id)?.stage).toBe(WorkerStage.Busy);
    expect(registry.get(id)?.currentSegment).toBe(3);
  });
});
