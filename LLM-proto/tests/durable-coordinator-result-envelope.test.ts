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
  generateWorkerGeneration,
} from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { ResultIdentity } from '../src/durable-types.js';

function coordinator(
  repo: InMemoryRepository,
  totalSegments: number,
  executor: DurableSegmentExecutor = {
    async execute() {
      throw new Error('executor should not run');
    },
  },
): DurableCoordinator {
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
  repo: InMemoryRepository,
  manifestDigest: string,
  totalSegments: number,
  segmentIndex: number,
): ResultIdentity {
  const requestId = generateRequestId();
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const worker = workerId('runtime-worker');
  const workerGeneration = generateWorkerGeneration();

  repo.createRequest({
    requestId,
    prompt: 'runtime envelope',
    stage: 'accepted',
    createdAt: Date.now(),
    currentSegment: segmentIndex,
    totalSegments,
    manifestDigest,
    retryCount: 0,
  });
  repo.transitionStage(requestId, 'accepted', 'queued');
  repo.transitionStage(requestId, 'queued', 'leased');
  repo.transitionStage(requestId, 'leased', 'running');
  repo.putLease({
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration,
    segmentIndex,
    modelManifestDigest: manifestDigest,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  });

  return {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration,
    segmentIndex,
  };
}

describe('DurableCoordinator ExecutionResult runtime envelope', () => {
  it.each([null, 1, 'bad', [], Symbol('result')])(
    'rejects malformed top-level result %p before nested field access',
    async (value) => {
      const coord = coordinator(new InMemoryRepository(), 1);
      await expect(coord.handleWorkerResult(value as never)).resolves.toEqual({
        kind: 'protocol-violation',
        message: 'execution result must be a non-null, non-array object',
      });
    },
  );

  it('rejects coercion-unsafe identity and processing time fields intentionally', async () => {
    const coord = coordinator(new InMemoryRepository(), 1);
    const baseIdentity = {
      requestId: 'request',
      attemptId: 'attempt',
      leaseId: 'lease',
      workerId: 'worker',
      workerGeneration: 'generation',
      segmentIndex: 0,
    };

    await expect(coord.handleWorkerResult({
      identity: { ...baseIdentity, requestId: Symbol('request') },
      processingTimeMs: 1,
    } as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result requestId must be a non-empty string',
    });

    await expect(coord.handleWorkerResult({
      identity: baseIdentity,
      processingTimeMs: '1',
    } as never)).resolves.toEqual({
      kind: 'protocol-violation',
      message: 'execution result processingTimeMs must be a non-negative finite number',
    });
  });

  it('does not commit malformed final output tokens under a matching lease', async () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo, 1);
    const identity = placeRunning(repo, coord.manifestDigest, 1, 0);

    const acceptance = await coord.handleWorkerResult({
      identity,
      output: { tokens: [1, Symbol('token')], text: 'bad' },
      processingTimeMs: 2,
    } as never);

    expect(acceptance).toEqual({
      kind: 'protocol-violation',
      message: 'final output tokens must contain non-negative safe integers',
    });
    expect(repo.getResult(identity.requestId)).toBeUndefined();
    expect(repo.getRequest(identity.requestId)?.stage).toBe('running');
    expect(repo.getActiveLease(identity.requestId)).toBeDefined();
  });

  it('commits an ownership-isolated copy of validated final output', async () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo, 1);
    const identity = placeRunning(repo, coord.manifestDigest, 1, 0);
    const tokens = [4, 5, 6];

    const acceptance = await coord.handleWorkerResult({
      identity,
      output: { tokens, text: 'ok' },
      processingTimeMs: 2,
    });
    expect(acceptance.kind).toBe('accepted');

    tokens[0] = 999;
    expect(repo.getResult(identity.requestId)?.tokens).toEqual([4, 5, 6]);
  });

  it('validates checkpoint structure before cloning browser-owned payload fields', async () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo, 2);
    const identity = placeRunning(repo, coord.manifestDigest, 2, 0);

    const acceptance = await coord.handleWorkerResult({
      identity,
      checkpoint: { payload: Symbol('bytes') },
      processingTimeMs: 1,
    } as never);

    expect(acceptance.kind).toBe('checkpoint-rejected');
    expect(repo.getCheckpoint(identity.requestId, 0)).toBeUndefined();
  });

  it('uses trusted assignment identity when a pull executor returns a malformed result', async () => {
    const repo = new InMemoryRepository();
    const executor: DurableSegmentExecutor = {
      async execute() {
        return null as never;
      },
    };
    const coord = coordinator(repo, 1, executor);
    coord.registerWorker(
      { workerId: workerId('pull-worker'), tier: WorkerTier.TIER_3, vramMB: 8192 },
      'connection-1',
    );

    const submission = coord.submit('malformed result');
    await expect(submission.result).rejects.toMatchObject({ code: ErrorCode.ProtocolViolation });
    expect(coord.getStatus(submission.requestId)?.lastErrorCode).toBe(ErrorCode.ProtocolViolation);
    expect(coord.idleWorkerCount).toBe(0);
    expect(repo.getResult(submission.requestId)).toBeUndefined();
  });
});
