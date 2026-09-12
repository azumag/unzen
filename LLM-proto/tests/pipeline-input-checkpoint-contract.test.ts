import { describe, expect, it } from 'vitest';
import { Pipeline, type SegmentExecutor } from '../src/pipeline.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';
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
    output: isFinal ? { tokens: [11], text: 'resumed' } : undefined,
    processingTimeMs: 1,
  };
}

describe('Pipeline input checkpoint contract', () => {
  it('fails a non-zero resume before dispatch when its predecessor checkpoint is missing', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const worker = registerWorker(workerPool, 'idle-worker');
    const totalSegments = 2;
    let executeCalls = 0;

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => {
        executeCalls++;
        return validResult(assignedWorker, assignment, totalSegments);
      },
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 1, retryDelayMs: 0 },
    );
    const request = makeRequest(totalSegments, 1);

    await expect(pipeline.run(request)).rejects.toThrow('missing checkpoint before segment 1');
    expect(executeCalls).toBe(0);
    expect(workerPool.get(worker)?.status).toBe(WorkerStatus.IDLE);
    expect(request.status).toBe('failed');
    expect(checkpointStore.size).toBe(0);
  });

  it('reuses the validated predecessor snapshot across worker retries', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const badWorker = registerWorker(workerPool, 'bad');
    registerWorker(workerPool, 'good');
    const totalSegments = 3;
    const request = makeRequest(totalSegments, 1);
    checkpointStore.save(makeCheckpoint(request.id, 0));
    const receivedCheckpointSegments: Array<number | undefined> = [];

    const executor: SegmentExecutor = {
      execute: async (assignedWorker, assignment) => {
        receivedCheckpointSegments.push(assignment.checkpoint?.segmentIndex);
        if (assignedWorker === badWorker) {
          // Simulate mutable shared durability state disappearing after dispatch.
          // The retry must retain the validated input snapshot captured before
          // worker attempts began.
          checkpointStore.deleteAll(request.id);
          throw new Error('worker disconnected');
        }
        return validResult(assignedWorker, assignment, totalSegments);
      },
    };

    const pipeline = new Pipeline(
      makeSegments(totalSegments),
      workerPool,
      checkpointStore,
      executor,
      { maxRetries: 1, retryDelayMs: 0 },
    );

    const result = await pipeline.run(request);

    expect(result.text).toBe('resumed');
    expect(receivedCheckpointSegments).toEqual([0, 0, 1]);
    expect(workerPool.get(badWorker)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });
});
