import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
} from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { WorkerTier, workerId } from '../src/types.js';
import type { ResultIdentity } from '../src/durable-types.js';

const executor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('not used by failure ownership tests');
  },
};

function coordinator(repo: InMemoryRepository) {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
}

function placeRunning(coord: DurableCoordinator, repo: InMemoryRepository): ResultIdentity {
  const worker = workerId('failure-ownership-worker');
  const registration = coord.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 8_192 },
    'failure-ownership-connection',
  );
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();

  repo.createRequest({
    requestId,
    prompt: 'failure ownership',
    stage: 'accepted',
    createdAt: now,
    currentSegment: 0,
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

describe('DurableCoordinator worker failure ownership', () => {
  it('captures the failure and identity fields once and mutates state from the captured values', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const expected = placeRunning(coord, repo);
    const reads: Record<string, number> = {};
    const count = (field: string) => {
      reads[field] = (reads[field] ?? 0) + 1;
      return reads[field];
    };

    const identity = {
      get requestId() {
        return count('requestId') === 1 ? expected.requestId : generateRequestId();
      },
      get attemptId() {
        return count('attemptId') === 1 ? expected.attemptId : generateAttemptId();
      },
      get leaseId() {
        return count('leaseId') === 1 ? expected.leaseId : generateLeaseId();
      },
      get workerId() {
        return count('workerId') === 1 ? expected.workerId : workerId('drifted-worker');
      },
      get workerGeneration() {
        return count('workerGeneration') === 1 ? expected.workerGeneration : 'drifted-generation' as never;
      },
      get segmentIndex() {
        return count('segmentIndex') === 1 ? 0 : 999;
      },
    };
    const failure = {
      get identity() {
        count('identity');
        return identity;
      },
      get code() {
        return count('code') === 1 ? ErrorCode.InvalidInput : 'not-an-error-code';
      },
      get message() {
        return count('message') === 1 ? 'captured failure' : Symbol('drifted-message');
      },
    };

    coord.handleWorkerFailure(failure as never);

    expect(reads).toEqual({
      identity: 1,
      requestId: 1,
      attemptId: 1,
      leaseId: 1,
      workerId: 1,
      workerGeneration: 1,
      segmentIndex: 1,
      code: 1,
      message: 1,
    });
    expect(repo.getActiveLease(expected.requestId)).toBeUndefined();
    expect(repo.listAttempts(expected.requestId)[0]).toMatchObject({
      outcome: 'failed',
      errorCode: ErrorCode.InvalidInput,
    });
    expect(coord.getWorker(expected.workerId)).toBeDefined();
  });

  it('preserves identity fail-fast ordering without touching later caller getters', () => {
    const coord = coordinator(new InMemoryRepository());
    const reads = { attemptId: 0, code: 0, message: 0 };
    const failure = {
      identity: {
        requestId: Symbol('bad-request'),
        get attemptId() {
          reads.attemptId += 1;
          throw new Error('attemptId must not be read');
        },
      },
      get code() {
        reads.code += 1;
        throw new Error('code must not be read');
      },
      get message() {
        reads.message += 1;
        throw new Error('message must not be read');
      },
    };

    expect(() => coord.handleWorkerFailure(failure as never)).toThrow(
      'execution failure requestId must be a non-empty string',
    );
    expect(reads).toEqual({ attemptId: 0, code: 0, message: 0 });
  });

  it('preserves code-before-message fail-fast ordering', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const identity = placeRunning(coord, repo);
    let codeReads = 0;
    let messageReads = 0;
    const failure = {
      identity,
      get code() {
        codeReads += 1;
        return 'not-an-error-code';
      },
      get message() {
        messageReads += 1;
        throw new Error('message must not be read');
      },
    };

    expect(() => coord.handleWorkerFailure(failure as never)).toThrow(
      'execution failure code must be a recognized ErrorCode',
    );
    expect(codeReads).toBe(1);
    expect(messageReads).toBe(0);
    expect(repo.getActiveLease(identity.requestId)).toBeDefined();
  });
});
