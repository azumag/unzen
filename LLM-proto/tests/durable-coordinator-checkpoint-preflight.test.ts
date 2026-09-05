import { describe, expect, it } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import type { CheckpointStoreResult } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import type { CheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { ErrorCode } from '../src/errors.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { InferenceRequestId } from '../src/types.js';
import { WorkerStage } from '../src/durable-types.js';
import type { ExecutionAssignment, ExecutionResult, ResultIdentity } from '../src/durable-types.js';

const WORKER_ID = workerId('checkpoint-preflight-worker');

class MissingOnResumeRepository extends InMemoryRepository {
  private dropNextResume = false;

  override putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const result = super.putCheckpoint(envelope);
    if (envelope.segmentIndex === 0 && result !== 'conflict') this.dropNextResume = true;
    return result;
  }

  override getCheckpoint(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): CheckpointEnvelope | undefined {
    if (this.dropNextResume && segmentIndex === 0) {
      this.dropNextResume = false;
      super.deleteCheckpoint(requestId, segmentIndex);
      return undefined;
    }
    return super.getCheckpoint(requestId, segmentIndex);
  }
}

class ExpiredOnResumeRepository extends InMemoryRepository {
  private expireNextResume = false;

  override putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const result = super.putCheckpoint(envelope);
    if (envelope.segmentIndex === 0 && result !== 'conflict') this.expireNextResume = true;
    return result;
  }

  override getCheckpoint(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): CheckpointEnvelope | undefined {
    const checkpoint = super.getCheckpoint(requestId, segmentIndex);
    if (!checkpoint || !this.expireNextResume || segmentIndex !== 0) return checkpoint;
    this.expireNextResume = false;
    return {
      ...checkpoint,
      createdAt: Date.now() - checkpoint.ttlMs - 1,
    };
  }
}

class WrongIdentityOnResumeRepository extends InMemoryRepository {
  private corruptNextResume = false;

  override putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const result = super.putCheckpoint(envelope);
    if (envelope.segmentIndex === 0 && result !== 'conflict') this.corruptNextResume = true;
    return result;
  }

  override getCheckpoint(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): CheckpointEnvelope | undefined {
    const checkpoint = super.getCheckpoint(requestId, segmentIndex);
    if (!checkpoint || !this.corruptNextResume || segmentIndex !== 0) return checkpoint;
    this.corruptNextResume = false;
    return {
      ...checkpoint,
      modelManifestDigest: 'f'.repeat(64),
    };
  }
}

function createExecutor(manifestDigest: string) {
  const calls: ExecutionAssignment[] = [];
  const executor: DurableSegmentExecutor = {
    async execute(_workerId, assignment): Promise<ExecutionResult> {
      calls.push(assignment);
      const identity: ResultIdentity = {
        requestId: assignment.requestId,
        attemptId: assignment.attemptId,
        leaseId: assignment.leaseId,
        workerId: assignment.workerId,
        workerGeneration: assignment.workerGeneration,
        segmentIndex: assignment.segmentIndex,
      };
      const isFinal = assignment.segmentIndex === 1;
      return {
        identity,
        checkpoint: isFinal
          ? undefined
          : await createCheckpointEnvelope({
              requestId: identity.requestId,
              attemptId: identity.attemptId,
              segmentIndex: identity.segmentIndex,
              workerId: identity.workerId,
              workerGeneration: identity.workerGeneration,
              modelManifestDigest: manifestDigest,
              formatVersion: 'float16',
              payload: new Uint8Array([1, 2, 3, 4]),
              ttlMs: 60_000,
            }),
        output: isFinal ? { tokens: [7], text: 'ok' } : undefined,
        processingTimeMs: 1,
      };
    },
  };
  return { executor, calls };
}

function createCoordinator(repository: InMemoryRepository) {
  const manifest = createFixtureModelManifest({ totalSegments: 2 });
  const { executor, calls } = createExecutor(manifest.manifestDigest);
  const coordinator = new DurableCoordinator(
    executor,
    manifest,
    {
      allowFixtureManifest: true,
      retryDelayMs: 0,
      maxRetries: 0,
      segmentTimeoutMs: 5_000,
      leaseTtlMs: 60_000,
      checkpointTtlMs: 60_000,
    },
    repository,
  );
  coordinator.registerWorker(
    { workerId: WORKER_ID, tier: WorkerTier.TIER_3, vramMB: 8192 },
    'checkpoint-preflight-connection',
  );
  return { coordinator, calls };
}

async function expectResumePreflightFailure(repository: InMemoryRepository, message: RegExp) {
  const { coordinator, calls } = createCoordinator(repository);
  const submission = coordinator.submit('resume preflight');

  await expect(submission.result).rejects.toMatchObject({
    code: ErrorCode.CheckpointIntegrityMismatch,
    message: expect.stringMatching(message),
  });

  expect(calls).toHaveLength(1);
  expect(repository.getActiveLease(submission.requestId)).toBeUndefined();
  expect(repository.listAttempts(submission.requestId)).toHaveLength(1);
  expect(repository.listAttempts(submission.requestId)[0]?.outcome).toBe('completed');
  expect(coordinator.getWorker(WORKER_ID)?.stage).toBe(WorkerStage.Idle);
  expect(coordinator.getStatus(submission.requestId)).toMatchObject({
    stage: 'failed',
    lastErrorCode: ErrorCode.CheckpointIntegrityMismatch,
  });
}

describe('DurableCoordinator resume checkpoint preflight', () => {
  it('fails before reserving a worker when cleanup already removed the predecessor checkpoint', async () => {
    await expectResumePreflightFailure(
      new MissingOnResumeRepository(),
      /checkpoint for segment 0 missing before resume/,
    );
  });

  it('fails before reserving a worker when the predecessor checkpoint is expired but not yet cleaned up', async () => {
    await expectResumePreflightFailure(
      new ExpiredOnResumeRepository(),
      /checkpoint for segment 0 expired before resume/,
    );
  });

  it('fails before reserving a worker when the stored predecessor identity no longer matches the run', async () => {
    await expectResumePreflightFailure(
      new WrongIdentityOnResumeRepository(),
      /checkpoint identity mismatch for segment 0 before resume/,
    );
  });

  it('continues normally when the predecessor checkpoint is present, current, and identity-bound', async () => {
    const repository = new InMemoryRepository();
    const { coordinator, calls } = createCoordinator(repository);
    const submission = coordinator.submit('normal resume');

    await expect(submission.result).resolves.toMatchObject({ text: 'ok', segmentsCompleted: 2 });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.checkpoint).toMatchObject({
      requestId: submission.requestId,
      segmentIndex: 0,
      modelManifestDigest: coordinator.manifestDigest,
    });
    expect(repository.getActiveLease(submission.requestId)).toBeUndefined();
    expect(coordinator.getWorker(WORKER_ID)?.stage).toBe(WorkerStage.Idle);
  });
});
