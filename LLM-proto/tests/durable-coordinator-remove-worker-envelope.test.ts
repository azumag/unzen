import { describe, expect, it } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode } from '../src/errors.js';
import { workerId, WorkerTier } from '../src/types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

class CountingRepository extends InMemoryRepository {
  workerReads = 0;
  activeLeaseListings = 0;

  override getWorker(
    ...args: Parameters<InMemoryRepository['getWorker']>
  ): ReturnType<InMemoryRepository['getWorker']> {
    this.workerReads += 1;
    return super.getWorker(...args);
  }

  override listActiveLeases(): ReturnType<InMemoryRepository['listActiveLeases']> {
    this.activeLeaseListings += 1;
    return super.listActiveLeases();
  }

  resetCounters(): void {
    this.workerReads = 0;
    this.activeLeaseListings = 0;
  }
}

function coordinator(repo: CountingRepository): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
}

function expectProtocolViolation(action: () => unknown): void {
  try {
    action();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toMatchObject({
      code: ErrorCode.ProtocolViolation,
      message: 'worker lookup workerId must be a non-empty string',
    });
  }
}

describe('DurableCoordinator removeWorker runtime worker-ID boundary', () => {
  it.each([
    null,
    undefined,
    42,
    true,
    [],
    {},
    Symbol('worker'),
    () => undefined,
    '',
    '   ',
  ])('rejects malformed worker ID %p before worker or lease lookup', (malformed) => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);
    const stableWorker = workerId('stable-worker');
    coord.registerWorker(
      { workerId: stableWorker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    repo.resetCounters();

    expectProtocolViolation(() => coord.removeWorker(malformed as never));

    expect(repo.workerReads).toBe(0);
    expect(repo.activeLeaseListings).toBe(0);
    expect(repo.listWorkers()).toHaveLength(1);
    expect(repo.listWorkers()[0]?.workerId).toBe(stableWorker);
    expect(coord.workerCount).toBe(1);
  });

  it('preserves valid unknown-worker no-op semantics', () => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);
    const stableWorker = workerId('stable-worker');
    coord.registerWorker(
      { workerId: stableWorker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    repo.resetCounters();

    coord.removeWorker(workerId('unknown-worker'));

    expect(repo.workerReads).toBe(1);
    expect(repo.activeLeaseListings).toBe(0);
    expect(repo.listWorkers()).toHaveLength(1);
    expect(repo.listWorkers()[0]?.workerId).toBe(stableWorker);
  });

  it('preserves known-worker revocation and generation lease-reclaim path', () => {
    const repo = new CountingRepository();
    const coord = coordinator(repo);
    const stableWorker = workerId('stable-worker');
    coord.registerWorker(
      { workerId: stableWorker, tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-a',
    );
    repo.resetCounters();

    coord.removeWorker(stableWorker);

    expect(repo.workerReads).toBe(1);
    expect(repo.activeLeaseListings).toBe(1);
    expect(repo.listWorkers()).toEqual([]);
    expect(coord.workerCount).toBe(0);
  });
});
