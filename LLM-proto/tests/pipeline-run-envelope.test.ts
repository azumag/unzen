import { describe, expect, it } from 'vitest';
import { Pipeline, PipelineError, type SegmentExecutor } from '../src/pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  inferenceRequestId,
  workerId,
  InferenceStatus,
  WorkerStatus,
  WorkerTier,
} from '../src/types.js';
import type { InferenceRequest } from '../src/types.js';
import type { SegmentAssignment, SegmentResult } from '../src/protocol.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

function registerWorker(pool: WorkerPool): void {
  pool.register({
    workerId: workerId('pipeline-envelope-worker'),
    tier: WorkerTier.TIER_2,
    vramMB: 4_200,
  });
}

function makeExecutor(
  totalSegments: number,
  onExecute?: (assignment: SegmentAssignment, call: number) => void,
): { readonly executor: SegmentExecutor; readonly assignments: SegmentAssignment[] } {
  const assignments: SegmentAssignment[] = [];
  let call = 0;
  const executor: SegmentExecutor = {
    execute: async (assignedWorkerId, assignment): Promise<SegmentResult> => {
      call++;
      assignments.push(assignment);
      onExecute?.(assignment, call);
      const index = assignment.segment.index;
      const isFinal = index === totalSegments - 1;
      return {
        requestId: assignment.requestId,
        segmentIndex: index,
        workerId: assignedWorkerId,
        checkpoint: isFinal ? undefined : makeCheckpoint(assignment.requestId, index),
        output: isFinal ? { tokens: [11], text: 'stable-basic-run' } : undefined,
        processingTimeMs: 1,
      };
    },
  };
  return { executor, assignments };
}

describe('Pipeline run envelope', () => {
  it('captures caller-owned identity and geometry exactly once', async () => {
    const workerPool = new WorkerPool();
    registerWorker(workerPool);
    const checkpointStore = new CheckpointStore();
    const { executor, assignments } = makeExecutor(2);
    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );

    let idReads = 0;
    let totalSegmentsReads = 0;
    let currentSegmentReads = 0;
    const progressWrites: number[] = [];
    const request = {
      get id() {
        idReads++;
        return inferenceRequestId(idReads === 1 ? 'req-basic-stable' : 'req-basic-changed');
      },
      prompt: 'test prompt',
      createdAt: 1,
      status: InferenceStatus.QUEUED,
      get currentSegment() {
        currentSegmentReads++;
        return currentSegmentReads === 1 ? 0 : 99;
      },
      set currentSegment(value: number) {
        progressWrites.push(value);
      },
      get totalSegments() {
        totalSegmentsReads++;
        return totalSegmentsReads === 1 ? 2 : 99;
      },
    } as unknown as InferenceRequest;

    const result = await pipeline.run(request);

    expect(result.requestId).toBe('req-basic-stable');
    expect(result.segmentsCompleted).toBe(2);
    expect(assignments.map((assignment) => assignment.requestId)).toEqual([
      'req-basic-stable',
      'req-basic-stable',
    ]);
    expect(idReads).toBe(1);
    expect(totalSegmentsReads).toBe(1);
    expect(currentSegmentReads).toBe(1);
    expect(progressWrites).toContain(1);
    expect(request.status).toBe(InferenceStatus.COMPLETED);
    expect(checkpointStore.size).toBe(0);
  });

  it('keeps later segments on the captured request when readonly fields mutate mid-run', async () => {
    const workerPool = new WorkerPool();
    registerWorker(workerPool);
    const checkpointStore = new CheckpointStore();
    const request = makeRequest(2, 0, 'req-basic-original');
    const { executor, assignments } = makeExecutor(2, (_assignment, call) => {
      if (call !== 1) return;
      const mutable = request as unknown as { id: string; totalSegments: number };
      mutable.id = inferenceRequestId('req-basic-mutated');
      mutable.totalSegments = 999;
    });
    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(request);

    expect(request.id).toBe('req-basic-mutated');
    expect(request.totalSegments).toBe(999);
    expect(result.requestId).toBe('req-basic-original');
    expect(result.segmentsCompleted).toBe(2);
    expect(assignments.map((assignment) => assignment.requestId)).toEqual([
      'req-basic-original',
      'req-basic-original',
    ]);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects request geometry mismatch before worker or checkpoint side effects', async () => {
    const workerPool = new WorkerPool();
    registerWorker(workerPool);
    const checkpointStore = new CheckpointStore();
    checkpointStore.save(makeCheckpoint('req-basic-mismatch', 0));
    let executeCalls = 0;
    const executor: SegmentExecutor = {
      execute: async () => {
        executeCalls++;
        throw new Error('executor must not run');
      },
    };
    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );
    const request = makeRequest(3, 0, 'req-basic-mismatch');

    await expect(pipeline.run(request)).rejects.toThrow(PipelineError);

    expect(executeCalls).toBe(0);
    expect(checkpointStore.size).toBe(1);
    expect(request.status).toBe(InferenceStatus.QUEUED);
    expect(workerPool.get(workerId('pipeline-envelope-worker'))?.status).toBe(WorkerStatus.IDLE);
  });

  it('owns segment membership and geometry from construction time', async () => {
    const segments = makeSegments(2);
    const workerPool = new WorkerPool();
    registerWorker(workerPool);
    const checkpointStore = new CheckpointStore();
    const { executor, assignments } = makeExecutor(2);
    const pipeline = new Pipeline(
      segments,
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );

    const mutableFirst = segments[0] as unknown as { index: number; estimatedVramMB: number };
    mutableFirst.estimatedVramMB = 99_999;
    mutableFirst.index = 99;
    segments.length = 1;

    const result = await pipeline.run(makeRequest(2, 0, 'req-basic-segments'));

    expect(result.segmentsCompleted).toBe(2);
    expect(assignments).toHaveLength(2);
    expect(assignments[0].segment.index).toBe(0);
    expect(assignments[0].segment.estimatedVramMB).toBe(2_100);
    expect(assignments[1].segment.index).toBe(1);
  });
});
