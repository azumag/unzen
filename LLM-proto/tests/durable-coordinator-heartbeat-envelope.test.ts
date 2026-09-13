import { describe, expect, it } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode } from '../src/errors.js';
import { generateWorkerGeneration } from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

function coordinator(): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true },
    new InMemoryRepository(),
  );
}

function expectProtocolViolation(action: () => unknown, message: string): void {
  try {
    action();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toMatchObject({ code: ErrorCode.ProtocolViolation, message });
  }
}

describe('DurableCoordinator worker-heartbeat runtime identity envelope', () => {
  it.each([null, 1, {}, [], Symbol('worker'), '', '   '])(
    'rejects malformed worker ID %p before registry lookup and diagnostics',
    (worker) => {
      const coord = coordinator();
      expectProtocolViolation(
        () => coord.workerHeartbeat(worker as never, generateWorkerGeneration()),
        'worker heartbeat workerId must be a non-empty string',
      );
      expect(coord.workerCount).toBe(0);
    },
  );

  it.each([null, 1, {}, [], Symbol('generation'), '', '   '])(
    'rejects malformed generation %p without mutating the registered worker',
    (generation) => {
      const coord = coordinator();
      const worker = workerId('heartbeat-worker');
      const registration = coord.registerWorker(
        { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
        'connection-a',
      );
      const before = { ...coord.getWorker(worker)! };

      expectProtocolViolation(
        () => coord.workerHeartbeat(worker, generation as never),
        'worker heartbeat generation must be a non-empty string',
      );

      expect(coord.getWorker(worker)).toEqual(before);
      expect(coord.getWorker(worker)?.generation).toBe(registration.generation);
    },
  );

  it('preserves structured unknown-worker semantics for a valid runtime identity', () => {
    const coord = coordinator();
    try {
      coord.workerHeartbeat(workerId('unknown-worker'), generateWorkerGeneration());
      throw new Error('expected unknown worker');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.UnknownWorker });
    }
  });

  it('preserves structured stale-generation semantics and leaves worker state unchanged', () => {
    const coord = coordinator();
    const worker = workerId('stale-worker');
    coord.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    const before = { ...coord.getWorker(worker)! };

    try {
      coord.workerHeartbeat(worker, generateWorkerGeneration());
      throw new Error('expected stale generation');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.StaleGeneration });
    }
    expect(coord.getWorker(worker)).toEqual(before);
  });

  it('preserves a valid current-generation heartbeat', () => {
    const coord = coordinator();
    const worker = workerId('valid-worker');
    const registration = coord.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    const before = coord.getWorker(worker)!.lastHeartbeat;

    expect(coord.workerHeartbeat(worker, registration.generation)).toBe(true);
    expect(coord.getWorker(worker)?.lastHeartbeat).toBeGreaterThanOrEqual(before);
    expect(coord.getWorker(worker)?.generation).toBe(registration.generation);
  });
});
