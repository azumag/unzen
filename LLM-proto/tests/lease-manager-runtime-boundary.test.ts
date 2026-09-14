import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { LeaseManager } from '../src/lease-manager.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);

class CountingLeaseRepository extends InMemoryRepository {
  activeLeaseReads = 0;
  leaseListings = 0;
  leaseDeletes = 0;

  override getActiveLease(
    ...args: Parameters<InMemoryRepository['getActiveLease']>
  ): ReturnType<InMemoryRepository['getActiveLease']> {
    this.activeLeaseReads += 1;
    return super.getActiveLease(...args);
  }

  override listActiveLeases(): ReturnType<InMemoryRepository['listActiveLeases']> {
    this.leaseListings += 1;
    return super.listActiveLeases();
  }

  override deleteLease(
    ...args: Parameters<InMemoryRepository['deleteLease']>
  ): ReturnType<InMemoryRepository['deleteLease']> {
    this.leaseDeletes += 1;
    return super.deleteLease(...args);
  }

  resetCounters(): void {
    this.activeLeaseReads = 0;
    this.leaseListings = 0;
    this.leaseDeletes = 0;
  }
}

function activateLease(manager: LeaseManager) {
  const requestId = generateRequestId();
  const worker = workerId('worker-1');
  const generation = generateWorkerGeneration();
  const lease = manager.issue({
    requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: worker,
    workerGeneration: generation,
    segmentIndex: 0,
    modelManifestDigest: MANIFEST_DIGEST,
    issuedAt: 1_000,
    expiresAt: 10_000,
  });
  manager.setActive(lease);
  return { lease, requestId, worker, generation };
}

function expectProtocolViolation(run: () => unknown, message: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnzenError);
  expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
  expect((thrown as Error).message).toBe(message);
}

const malformedIdentities: readonly unknown[] = [
  null,
  undefined,
  42,
  true,
  [],
  {},
  Symbol('identity'),
  () => undefined,
  '',
  '   ',
];

const requestOperations = [
  {
    name: 'getActive',
    run: (manager: LeaseManager, requestId: unknown) => manager.getActive(requestId as never),
  },
  {
    name: 'isActive',
    run: (manager: LeaseManager, requestId: unknown) => manager.isActive(requestId as never),
  },
  {
    name: 'reclaimByRequest',
    run: (manager: LeaseManager, requestId: unknown) => manager.reclaimByRequest(requestId as never),
  },
] as const;

describe('LeaseManager direct runtime identity boundaries', () => {
  it.each(requestOperations)(
    '$name rejects malformed request IDs before repository lookup or deletion',
    ({ run }) => {
      for (const malformed of malformedIdentities) {
        const repository = new CountingLeaseRepository();
        const manager = new LeaseManager(repository);
        activateLease(manager);
        repository.resetCounters();

        expectProtocolViolation(
          () => run(manager, malformed),
          'lease requestId must be a non-empty string',
        );

        expect(repository.activeLeaseReads).toBe(0);
        expect(repository.leaseListings).toBe(0);
        expect(repository.leaseDeletes).toBe(0);
      }
    },
  );

  it('preserves valid unknown request lookup/reclaim semantics', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const unknown = generateRequestId();

    expect(manager.getActive(unknown)).toBeUndefined();
    expect(manager.isActive(unknown)).toBe(false);
    expect(() => manager.reclaimByRequest(unknown)).not.toThrow();
    expect(repository.leaseDeletes).toBe(0);
  });

  it('preserves known request lookup and reclaim behavior', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const { lease, requestId } = activateLease(manager);

    expect(manager.getActive(requestId)).toEqual(lease);
    expect(manager.isActive(requestId)).toBe(true);
    manager.reclaimByRequest(requestId);
    expect(manager.getActive(requestId)).toBeUndefined();
  });

  it.each(malformedIdentities)(
    'rejects malformed worker ID %p before active-lease enumeration',
    (malformed) => {
      const repository = new CountingLeaseRepository();
      const manager = new LeaseManager(repository);
      const { generation } = activateLease(manager);
      repository.resetCounters();

      expectProtocolViolation(
        () => manager.reclaimByWorkerGeneration(malformed as never, generation),
        'lease workerId must be a non-empty string',
      );

      expect(repository.leaseListings).toBe(0);
      expect(repository.leaseDeletes).toBe(0);
    },
  );

  it.each(malformedIdentities)(
    'rejects malformed worker generation %p before active-lease enumeration',
    (malformed) => {
      const repository = new CountingLeaseRepository();
      const manager = new LeaseManager(repository);
      const { worker } = activateLease(manager);
      repository.resetCounters();

      expectProtocolViolation(
        () => manager.reclaimByWorkerGeneration(worker, malformed as never),
        'lease worker generation must be a non-empty string',
      );

      expect(repository.leaseListings).toBe(0);
      expect(repository.leaseDeletes).toBe(0);
    },
  );

  it('preserves valid unknown worker-generation reclaim no-op semantics', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const { requestId } = activateLease(manager);

    manager.reclaimByWorkerGeneration(workerId('missing-worker'), generateWorkerGeneration());

    expect(manager.isActive(requestId)).toBe(true);
    expect(repository.leaseDeletes).toBe(0);
  });

  it('preserves known worker-generation reclaim behavior', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const { requestId, worker, generation } = activateLease(manager);

    manager.reclaimByWorkerGeneration(worker, generation);

    expect(manager.isActive(requestId)).toBe(false);
    expect(repository.leaseDeletes).toBe(1);
  });

  it('matches against one owned snapshot of every caller-owned result identity field', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const { lease } = activateLease(manager);
    const reads: Record<string, number> = {};
    const source: Record<string, unknown> = {};
    const values: Record<string, unknown> = {
      requestId: lease.requestId,
      attemptId: lease.attemptId,
      leaseId: lease.leaseId,
      workerId: lease.workerId,
      workerGeneration: lease.workerGeneration,
      segmentIndex: lease.segmentIndex,
    };

    for (const [field, value] of Object.entries(values)) {
      Object.defineProperty(source, field, {
        enumerable: true,
        get() {
          reads[field] = (reads[field] ?? 0) + 1;
          if (reads[field] === 1) return value;
          return field === 'segmentIndex' ? 999 : `drift-${field}`;
        },
      });
    }

    expect(manager.match(source as never, 2_000)).toEqual({ ok: true });
    expect(reads).toEqual({
      requestId: 1,
      attemptId: 1,
      leaseId: 1,
      workerId: 1,
      workerGeneration: 1,
      segmentIndex: 1,
    });
  });

  it('reclaims exactly the captured leaseId instead of re-reading a mutable accessor', () => {
    const repository = new CountingLeaseRepository();
    const manager = new LeaseManager(repository);
    const { lease: target } = activateLease(manager);

    const other = manager.issue({
      requestId: generateRequestId(),
      attemptId: generateAttemptId(),
      leaseId: generateLeaseId(),
      workerId: workerId('worker-2'),
      workerGeneration: generateWorkerGeneration(),
      segmentIndex: 0,
      modelManifestDigest: MANIFEST_DIGEST,
      issuedAt: 1_000,
      expiresAt: 10_000,
    });
    manager.setActive(other);

    let leaseIdReads = 0;
    const identity = {
      requestId: target.requestId,
      attemptId: target.attemptId,
      get leaseId() {
        leaseIdReads += 1;
        return leaseIdReads <= 2 ? target.leaseId : other.leaseId;
      },
      workerId: target.workerId,
      workerGeneration: target.workerGeneration,
      segmentIndex: target.segmentIndex,
    };

    expect(manager.reclaim(identity as never, 2_000)).toEqual({ ok: true });
    expect(leaseIdReads).toBe(1);
    expect(repository.getActiveLease(target.requestId)).toBeUndefined();
    expect(repository.getActiveLease(other.requestId)).toEqual(other);
  });
});
