import { describe, expect, it } from 'vitest';
import { Pipeline, PipelineError, type SegmentExecutor } from '../src/pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  InferenceStatus,
  WorkerStatus,
  WorkerTier,
  workerId,
} from '../src/types.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

describe('Pipeline terminal request geometry', () => {
  it('completes a zero-segment request as a no-op, clears stale checkpoints, and does not execute workers', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    checkpointStore.save(makeCheckpoint('req-basic-zero', 0));

    let executeCalls = 0;
    const executor: SegmentExecutor = {
      execute: async () => {
        executeCalls++;
        throw new Error('zero-segment requests must not execute');
      },
    };
    const pipeline = new Pipeline([], workerPool, checkpointStore, executor, {
      retryDelayMs: 0,
    });
    const request = makeRequest(0, 0, 'req-basic-zero');

    await expect(pipeline.run(request)).resolves.toEqual({
      requestId: 'req-basic-zero',
      tokens: [],
      text: '',
      totalTimeMs: 0,
      segmentsCompleted: 0,
    });

    expect(executeCalls).toBe(0);
    expect(workerPool.size).toBe(0);
    expect(checkpointStore.size).toBe(0);
    expect(request.status).toBe(InferenceStatus.COMPLETED);
    expect(request.currentSegment).toBe(0);
  });

  it('validates geometry before taking the zero-segment success path', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    checkpointStore.save(makeCheckpoint('req-basic-zero-invalid', 0));

    let executeCalls = 0;
    const executor: SegmentExecutor = {
      execute: async () => {
        executeCalls++;
        throw new Error('invalid geometry must not execute');
      },
    };
    const pipeline = new Pipeline([], workerPool, checkpointStore, executor, {
      retryDelayMs: 0,
    });
    const request = makeRequest(0, 1, 'req-basic-zero-invalid');

    await expect(pipeline.run(request)).rejects.toThrow(PipelineError);

    expect(executeCalls).toBe(0);
    expect(checkpointStore.size).toBe(1);
    expect(request.status).toBe(InferenceStatus.QUEUED);
  });

  it('rejects an exhausted non-zero request before status, checkpoint, worker, or executor side effects', async () => {
    const workerPool = new WorkerPool();
    const id = workerId('pipeline-exhausted-worker');
    workerPool.register({
      workerId: id,
      tier: WorkerTier.TIER_2,
      vramMB: 4_200,
    });
    const checkpointStore = new CheckpointStore();
    checkpointStore.save(makeCheckpoint('req-basic-exhausted', 0));

    let executeCalls = 0;
    const executor: SegmentExecutor = {
      execute: async () => {
        executeCalls++;
        throw new Error('exhausted request geometry must not execute');
      },
    };
    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );
    const request = makeRequest(2, 2, 'req-basic-exhausted');

    await expect(pipeline.run(request)).rejects.toThrow(
      'Pipeline request currentSegment 2 has no executable segment for totalSegments 2',
    );

    expect(executeCalls).toBe(0);
    expect(checkpointStore.size).toBe(1);
    expect(request.status).toBe(InferenceStatus.QUEUED);
    expect(request.currentSegment).toBe(2);
    expect(workerPool.get(id)?.status).toBe(WorkerStatus.IDLE);
    expect(workerPool.get(id)?.currentSegment).toBeUndefined();
  });
});
