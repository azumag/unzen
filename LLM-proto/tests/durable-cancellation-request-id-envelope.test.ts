import { describe, expect, it } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
} from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { InferenceRequestId } from '../src/types.js';
import type { ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

class CountingRepository extends InMemoryRepository {
  requestLookups = 0;

  override getRequest(requestId: InferenceRequestId) {
    this.requestLookups += 1;
    return super.getRequest(requestId);
  }
}

function coordinator(repo: InMemoryRepository): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    {
      allowFixtureManifest: true,
      maxRetries: 0,
      retryDelayMs: 0,
      segmentTimeoutMs: 5_000,
    },
    repo,
  );
}

function placeRunning(coord: DurableCoordinator, repo: InMemoryRepository): ResultIdentity {
  const worker = workerId('cancel-envelope-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
    'cancel-envelope-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'cancel request id envelope',
    stage: 'accepted',
    createdAt: now,
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: coord.manifestDigest,
    retryCount: 0,
  });
  expect(repo.transitionStage(requestId, 'accepted', 'queued')).toBe(true);
  expect(repo.transitionStage(requestId, 'queued', 'leased')).toBe(true);
  expect(repo.transitionStage(requestId, 'leased', 'running')).toBe(true);
  repo.appendAttempt(requestId, {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
    startedAt: now,
  });
  repo.putLease({
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
    modelManifestDigest: coord.manifestDigest,
    issuedAt: now,
    expiresAt: now + 60_000,
  });

  return {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
  };
}

function expectProtocolViolation(action: () => void): void {
  try {
    action();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toMatchObject({
      code: ErrorCode.ProtocolViolation,
      message: 'cancellation requestId must be a non-empty string',
    });
  }
}

describe('DurableCoordinator cancellation requestId runtime envelope', () => {
  it.each([null, undefined, 0, true, [], {}, Symbol('request'), '', '   '])(
    'rejects malformed request id %p before durable lookup or mutation',
    (value) => {
      const repo = new CountingRepository();
      const coord = coordinator(repo);
      const identity = placeRunning(coord, repo);
      const beforeRequest = { ...repo.getRequest(identity.requestId)! };
      const beforeLease = { ...repo.getActiveLease(identity.requestId)! };
      const beforeAttempts = repo.listAttempts(identity.requestId).map((attempt) => ({ ...attempt }));
      const beforeWorker = { ...coord.getWorker(identity.workerId)! };
      const requestLookupsBeforeCancel = repo.requestLookups;

      expectProtocolViolation(() => coord.cancel(value as never));

      expect(repo.requestLookups).toBe(requestLookupsBeforeCancel);
      expect(repo.getRequest(identity.requestId)).toEqual(beforeRequest);
      expect(repo.getActiveLease(identity.requestId)).toEqual(beforeLease);
      expect(repo.listAttempts(identity.requestId)).toEqual(beforeAttempts);
      expect(repo.getCancellation(identity.requestId)).toBeUndefined();
      expect(coord.getWorker(identity.workerId)).toEqual(beforeWorker);
      expect(coord.getSuppressions(identity.requestId)).toEqual([]);
    },
  );

  it('preserves RequestNotFound for a valid non-empty unknown request id', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const unknown = generateRequestId();

    try {
      coord.cancel(unknown);
      throw new Error('expected RequestNotFound');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.RequestNotFound });
    }
    expect(repo.getCancellation(unknown)).toBeUndefined();
  });

  it('preserves exact accepted string identity without trimming', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const requestId = ' request-with-padding ' as never;
    const now = Date.now();
    repo.createRequest({
      requestId,
      prompt: 'preserve exact identity',
      stage: 'accepted',
      createdAt: now,
      currentSegment: 0,
      totalSegments: 1,
      manifestDigest: coord.manifestDigest,
      retryCount: 0,
    });
    expect(repo.transitionStage(requestId, 'accepted', 'queued')).toBe(true);

    const ack = coord.cancel(requestId);

    expect(ack.requestId).toBe(' request-with-padding ');
    expect(repo.getCancellation(requestId)?.requestId).toBe(' request-with-padding ');
    expect(repo.getRequest(requestId)?.stage).toBe('cancelled');
  });
});
