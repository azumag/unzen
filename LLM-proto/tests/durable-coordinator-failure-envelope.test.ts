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
import { WorkerStage } from '../src/durable-types.js';
import type { ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

function coordinator(repo: InMemoryRepository, totalSegments = 1): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments }),
    {
      allowFixtureManifest: true,
      maxRetries: 0,
      retryDelayMs: 0,
      segmentTimeoutMs: 5_000,
    },
    repo,
  );
}

function placeRunning(
  coord: DurableCoordinator,
  repo: InMemoryRepository,
  segmentIndex = 0,
): ResultIdentity {
  const worker = workerId('failure-envelope-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8192 },
    'failure-envelope-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'failure envelope',
    stage: 'accepted',
    createdAt: now,
    currentSegment: segmentIndex,
    totalSegments: 1,
    manifestDigest: coord.manifestDigest,
    retryCount: 0,
  });
  repo.transitionStage(requestId, 'accepted', 'queued');
  repo.transitionStage(requestId, 'queued', 'leased');
  repo.transitionStage(requestId, 'leased', 'running');
  repo.appendAttempt(requestId, {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex,
    startedAt: now,
  });
  repo.putLease({
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex,
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
    segmentIndex,
  };
}

function expectProtocolViolation(action: () => void, message: string): void {
  try {
    action();
    throw new Error('expected protocol violation');
  } catch (error) {
    expect(error).toMatchObject({
      code: ErrorCode.ProtocolViolation,
      message,
    });
  }
}

describe('DurableCoordinator ExecutionFailure runtime envelope', () => {
  it.each([null, 1, 'bad', [], Symbol('failure')])(
    'rejects malformed top-level failure %p before nested field access',
    (value) => {
      const coord = coordinator(new InMemoryRepository());
      expectProtocolViolation(
        () => coord.handleWorkerFailure(value as never),
        'execution failure must be a non-null, non-array object',
      );
    },
  );

  it('rejects malformed identity fields, segment indices, codes, and messages intentionally', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const identity = placeRunning(coord, repo);
    const base = {
      identity,
      code: ErrorCode.InvalidInput,
      message: 'bad input',
    };

    expectProtocolViolation(
      () => coord.handleWorkerFailure({ ...base, identity: Symbol('identity') } as never),
      'execution failure identity must be a non-null, non-array object',
    );
    expectProtocolViolation(
      () => coord.handleWorkerFailure({
        ...base,
        identity: { ...identity, requestId: Symbol('request') },
      } as never),
      'execution failure requestId must be a non-empty string',
    );
    expectProtocolViolation(
      () => coord.handleWorkerFailure({
        ...base,
        identity: { ...identity, segmentIndex: '0' },
      } as never),
      'execution failure segmentIndex must be a non-negative safe integer',
    );
    expectProtocolViolation(
      () => coord.handleWorkerFailure({ ...base, code: 'not-an-error-code' } as never),
      'execution failure code must be a recognized ErrorCode',
    );
    expectProtocolViolation(
      () => coord.handleWorkerFailure({ ...base, message: Symbol('message') } as never),
      'execution failure message must be a string',
    );
  });

  it('does not mutate a running request, lease, attempt, or worker for a malformed failure', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const identity = placeRunning(coord, repo);
    const beforeRequest = { ...repo.getRequest(identity.requestId)! };
    const beforeLease = { ...repo.getActiveLease(identity.requestId)! };
    const beforeAttempts = repo.listAttempts(identity.requestId).map((attempt) => ({ ...attempt }));
    const beforeWorker = { ...coord.getWorker(identity.workerId)! };

    expectProtocolViolation(
      () => coord.handleWorkerFailure({
        identity,
        code: 'made-up-code',
        message: 'must not mutate durable state',
      } as never),
      'execution failure code must be a recognized ErrorCode',
    );

    expect(repo.getRequest(identity.requestId)).toEqual(beforeRequest);
    expect(repo.getActiveLease(identity.requestId)).toEqual(beforeLease);
    expect(repo.listAttempts(identity.requestId)).toEqual(beforeAttempts);
    expect(coord.getWorker(identity.workerId)).toEqual(beforeWorker);
    expect(coord.getSuppressions(identity.requestId)).toEqual([]);
  });

  it('preserves task-level failure behavior without isolating a healthy worker', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const identity = placeRunning(coord, repo);

    coord.handleWorkerFailure({
      identity,
      code: ErrorCode.InvalidInput,
      message: 'request payload is invalid',
    });

    expect(repo.getActiveLease(identity.requestId)).toBeUndefined();
    expect(repo.listAttempts(identity.requestId)[0]).toMatchObject({
      outcome: 'failed',
      errorCode: ErrorCode.InvalidInput,
    });
    expect(coord.getWorker(identity.workerId)?.stage).toBe(WorkerStage.Idle);
  });

  it('preserves isolatable failure behavior for the matching worker generation', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const identity = placeRunning(coord, repo);

    coord.handleWorkerFailure({
      identity,
      code: ErrorCode.ProtocolViolation,
      message: 'worker broke the protocol',
    });

    expect(repo.getActiveLease(identity.requestId)).toBeUndefined();
    expect(repo.listAttempts(identity.requestId)[0]).toMatchObject({
      outcome: 'failed',
      errorCode: ErrorCode.ProtocolViolation,
    });
    expect(coord.getWorker(identity.workerId)?.stage).toBe(WorkerStage.Revoked);
  });
});
