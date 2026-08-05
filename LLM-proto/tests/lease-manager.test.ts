/**
 * Tests for the lease manager and identity matching (issue #103 deliverable 4).
 *
 * The Coordinator commits a result/failure/checkpoint ONLY when its identity
 * matches the active lease exactly. Any mismatch — wrong attempt, wrong lease,
 * wrong worker, wrong generation, wrong segment, expired lease, or a request
 * with no active lease (already completed/retried) — must be suppressed and
 * recorded, never committed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LeaseManager } from '../src/lease-manager.js';
import { generateRequestId, generateAttemptId, generateLeaseId, generateWorkerGeneration } from '../src/ids.js';
import { workerId } from '../src/types.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import type { Lease, ResultIdentity } from '../src/durable-types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);

function makeIdentity(overrides: Partial<ResultIdentity> = {}): ResultIdentity {
  return {
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('w1'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 2,
    ...overrides,
  };
}

describe('LeaseManager', () => {
  let manager: LeaseManager;
  let lease: Lease;
  let identity: ResultIdentity;

  beforeEach(() => {
    manager = new LeaseManager(new InMemoryRepository());
    const requestId = generateRequestId();
    const attemptId = generateAttemptId();
    const leaseId = generateLeaseId();
    const generation = generateWorkerGeneration();
    identity = {
      requestId,
      attemptId,
      leaseId,
      workerId: workerId('w1'),
      workerGeneration: generation,
      segmentIndex: 2,
    };
    lease = manager.issue({
      requestId,
      attemptId,
      leaseId,
      workerId: workerId('w1'),
      workerGeneration: generation,
      segmentIndex: 2,
      modelManifestDigest: MANIFEST_DIGEST,
      issuedAt: 1_000,
      expiresAt: 10_000,
    });
    manager.setActive(lease);
  });

  it('issues a lease carrying the full identity', () => {
    expect(lease.requestId).toBe(identity.requestId);
    expect(lease.attemptId).toBe(identity.attemptId);
    expect(lease.leaseId).toBe(identity.leaseId);
    expect(lease.workerGeneration).toBe(identity.workerGeneration);
    expect(lease.modelManifestDigest).toBe(MANIFEST_DIGEST);
  });

  it('matches an exact identity echo', () => {
    expect(manager.match(identity, 5_000).ok).toBe(true);
  });

  it('rejects each mismatched identity field', () => {
    const cases: Array<[Partial<ResultIdentity>, string]> = [
      [{ attemptId: generateAttemptId() }, 'attempt-mismatch'],
      [{ leaseId: generateLeaseId() }, 'lease-mismatch'],
      [{ workerId: workerId('other') }, 'worker-mismatch'],
      [{ workerGeneration: generateWorkerGeneration() }, 'generation-mismatch'],
      [{ segmentIndex: 0 }, 'segment-mismatch'],
    ];
    for (const [patch, reason] of cases) {
      const result = manager.match({ ...identity, ...patch }, 5_000);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  it('rejects results arriving after lease expiry (late completion)', () => {
    const result = manager.match(identity, 10_001);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('lease-expired');
  });

  it('rejects results for a request with no active lease (already completed/retried)', () => {
    manager.reclaimByRequest(identity.requestId);
    const result = manager.match(identity, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-active-lease');
  });

  it('a request with no active lease rejects even in-TTL results', () => {
    const lonely = makeIdentity();
    const result = manager.match(lonely, 5_000);
    expect(result.ok).toBe(false);
  });

  it('reclaimByWorkerGeneration revokes leases of a revoked generation', () => {
    manager.reclaimByWorkerGeneration(workerId('w1'), identity.workerGeneration);
    const result = manager.match(identity, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no-active-lease');
  });

  it('reclaimByWorkerGeneration does not touch other workers', () => {
    const otherId = makeIdentity({ requestId: identity.requestId, workerId: workerId('other') });
    manager.setActive(
      manager.issue({
        ...otherId,
        modelManifestDigest: MANIFEST_DIGEST,
        issuedAt: 1_000,
        expiresAt: 10_000,
      }),
    );
    // Reclaiming w1's generation leaves the other worker's lease active.
    manager.reclaimByWorkerGeneration(workerId('w1'), identity.workerGeneration);
    expect(manager.match(otherId, 5_000).ok).toBe(true);
  });

  it('isActive reports the active lease and expiry', () => {
    expect(manager.isActive(identity.requestId)).toBe(true);
    manager.reclaimByRequest(identity.requestId);
    expect(manager.isActive(identity.requestId)).toBe(false);
  });

  it('match returns a result-identity-mismatch mapped reason', () => {
    const result = manager.match({ ...identity, workerId: workerId('x') }, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('worker-mismatch');
  });
});
