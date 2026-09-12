import { describe, expect, it } from 'vitest';
import { Pipeline, PipelineError, type SegmentExecutor } from '../src/pipeline.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { WorkerPool } from '../src/worker-pool.js';
import {
  inferenceRequestId,
  workerId,
  WorkerStatus,
  WorkerTier,
} from '../src/types.js';
import type { WorkerId } from '../src/types.js';
import type { SegmentAssignment, SegmentResult } from '../src/protocol.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

function registerWorker(pool: WorkerPool, id: string): WorkerId {
  const branded = workerId(id);
  pool.register({
    workerId: branded,
    tier: WorkerTier.TIER_3,
    vramMB: 4096,
  });
  return branded;
}

function validResult(
  assignedWorker: WorkerId,
  assignment: SegmentAssignment,
  totalSegments: number,
): SegmentResult {
  const segmentIndex = assignment.segment.index;
  const isFinal = segmentIndex === totalSegments - 1;
  return {
    requestId: assignment.requestId,
    segmentIndex,
    workerId: assignedWorker,
    checkpoint: isFinal
      ? undefined
      : makeCheckpoint(assignment.requestId, segmentIndex),
    output: isFinal ? { tokens: [7], text: 'ok' } : undefined,
    processingTimeMs: 1,
  };
}

describe('Pipeline SegmentResult contract', () => {
  it('disconnects a worker that echoes the wrong request and retries on another worker', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const badWorker = registerWorker(workerPool, 'bad');
    const goodWorker = registerWorker(workerPool, 'good');
    const totalSegments = 2;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => {
        const result = validResult(assignedWorker, assignment, totalSegments);
        if (assignedWorker === badWorker) {
          return {
            ...result,
            requestId: inferenceRequestId('wrong-request'),
          };
        }
        return result;
      },
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 1, retryDelayMs: 0 },
    );

    const result = await pipeline.run(makeRequest(totalSegments));

    expect(result.text).toBe('ok');
    expect(workerPool.get(badWorker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(workerPool.get(goodWorker)?.status).toBe(WorkerStatus.IDLE);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a result for a different segment before storing a checkpoint', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const worker = registerWorker(workerPool, 'wrong-segment');
    const totalSegments = 2;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => ({
        ...validResult(assignedWorker, assignment, totalSegments),
        segmentIndex: assignment.segment.index + 1,
      }),
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    );

    await expect(pipeline.run(makeRequest(totalSegments))).rejects.toThrow(PipelineError);
    expect(workerPool.get(worker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('requires a checkpoint at every non-final segment boundary', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const worker = registerWorker(workerPool, 'missing-checkpoint');
    const totalSegments = 2;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => ({
        ...validResult(assignedWorker, assignment, totalSegments),
        checkpoint: undefined,
      }),
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    );

    await expect(pipeline.run(makeRequest(totalSegments))).rejects.toThrow(PipelineError);
    expect(workerPool.get(worker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a checkpoint whose segment identity does not match the completed boundary', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const worker = registerWorker(workerPool, 'wrong-checkpoint');
    const totalSegments = 2;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => ({
        ...validResult(assignedWorker, assignment, totalSegments),
        checkpoint: makeCheckpoint(assignment.requestId, assignment.segment.index + 1),
      }),
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    );

    await expect(pipeline.run(makeRequest(totalSegments))).rejects.toThrow(PipelineError);
    expect(workerPool.get(worker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a final result that also carries a resumable checkpoint', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const worker = registerWorker(workerPool, 'final-checkpoint');
    const totalSegments = 1;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => ({
        ...validResult(assignedWorker, assignment, totalSegments),
        checkpoint: makeCheckpoint(assignment.requestId, assignment.segment.index),
      }),
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    );

    await expect(pipeline.run(makeRequest(totalSegments))).rejects.toThrow(PipelineError);
    expect(workerPool.get(worker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects non-finite processing time before accepting worker output', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const worker = registerWorker(workerPool, 'invalid-timing');
    const totalSegments = 1;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => ({
        ...validResult(assignedWorker, assignment, totalSegments),
        processingTimeMs: Number.NaN,
      }),
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    );

    await expect(pipeline.run(makeRequest(totalSegments))).rejects.toThrow(PipelineError);
    expect(workerPool.get(worker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });
});
