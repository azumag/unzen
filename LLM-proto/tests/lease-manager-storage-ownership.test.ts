import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import { LeaseManager } from '../src/lease-manager.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);

function leaseValues() {
  return {
    leaseId: generateLeaseId(),
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    workerId: workerId('storage-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 2,
    modelManifestDigest: MANIFEST_DIGEST,
    issuedAt: 1_000,
    expiresAt: 10_000,
  };
}

describe('LeaseManager active-lease storage ownership', () => {
  it('stores an owned lease copy that is isolated from later caller mutation', () => {
    const repository = new InMemoryRepository();
    const manager = new LeaseManager(repository);
    const values = leaseValues();
    const callerLease = { ...values };

    manager.setActive(callerLease);

    const mutable = callerLease as unknown as Record<string, unknown>;
    mutable.leaseId = generateLeaseId();
    mutable.requestId = generateRequestId();
    mutable.attemptId = generateAttemptId();
    mutable.workerId = workerId('mutated-worker');
    mutable.workerGeneration = generateWorkerGeneration();
    mutable.segmentIndex = 99;
    mutable.modelManifestDigest = 'e'.repeat(64);
    mutable.issuedAt = 20_000;
    mutable.expiresAt = 30_000;

    expect(repository.getActiveLease(values.requestId)).toEqual(values);
  });

  it('reads each caller-owned lease field once before repository storage', () => {
    const repository = new InMemoryRepository();
    const manager = new LeaseManager(repository);
    const values = leaseValues();
    const reads: Record<string, number> = {};
    const callerLease: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(values)) {
      Object.defineProperty(callerLease, field, {
        enumerable: true,
        get() {
          reads[field] = (reads[field] ?? 0) + 1;
          return reads[field] === 1 ? value : `drift-${field}`;
        },
      });
    }

    manager.setActive(callerLease as never);

    expect(reads).toEqual({
      leaseId: 1,
      requestId: 1,
      attemptId: 1,
      workerId: 1,
      workerGeneration: 1,
      segmentIndex: 1,
      modelManifestDigest: 1,
      issuedAt: 1,
      expiresAt: 1,
    });
    expect(repository.getActiveLease(values.requestId)).toEqual(values);
    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
  });
});
