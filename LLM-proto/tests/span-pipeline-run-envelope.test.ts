import { describe, expect, it } from 'vitest';
import { SpanPipeline, SpanPipelineError, type SpanExecutor } from '../src/span-pipeline.js';
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
import type { SpanAssignment, SpanResult } from '../src/protocol.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

function registerOneSegmentWorkers(pool: WorkerPool): void {
  pool.register({
    workerId: workerId('run-envelope-a'),
    tier: WorkerTier.TIER_2,
    vramMB: 2100,
  });
  pool.register({
    workerId: workerId('run-envelope-b'),
    tier: WorkerTier.TIER_2,
    vramMB: 2100,
  });
}

function makeTwoSpanExecutor(
  onExecute?: (assignment: SpanAssignment, call: number) => void,
): { readonly executor: SpanExecutor; readonly assignments: SpanAssignment[] } {
  const assignments: SpanAssignment[] = [];
  let call = 0;
  const executor: SpanExecutor = {
    execute: async (assignedWorkerId, assignment): Promise<SpanResult> => {
      call++;
      assignments.push(assignment);
      onExecute?.(assignment, call);
      const startSegment = assignment.segments[0].index;
      const endSegment = assignment.segments[assignment.segments.length - 1].index;
      const isFinal = endSegment === 1;
      return {
        requestId: assignment.requestId,
        startSegment,
        endSegment,
        workerId: assignedWorkerId,
        checkpoint: isFinal ? undefined : makeCheckpoint(assignment.requestId, endSegment),
        output: isFinal ? { tokens: [7], text: 'stable-run' } : undefined,
        processingTimeMs: 1,
      };
    },
  };
  return { executor, assignments };
}

describe('SpanPipeline run envelope', () => {
  it('captures request identity and geometry fields exactly once', async () => {
    const workerPool = new WorkerPool();
    registerOneSegmentWorkers(workerPool);
    const checkpointStore = new CheckpointStore();
    const { executor, assignments } = makeTwoSpanExecutor();
    const pipeline = new SpanPipeline(
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
        return inferenceRequestId(idReads === 1 ? 'req-run-stable' : 'req-run-changed');
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

    expect(result.requestId).toBe('req-run-stable');
    expect(result.segmentsCompleted).toBe(2);
    expect(assignments.map((assignment) => assignment.requestId)).toEqual([
      'req-run-stable',
      'req-run-stable',
    ]);
    expect(idReads).toBe(1);
    expect(totalSegmentsReads).toBe(1);
    expect(currentSegmentReads).toBe(1);
    expect(progressWrites.at(-1)).toBe(2);
    expect(request.status).toBe(InferenceStatus.COMPLETED);
    expect(checkpointStore.size).toBe(0);
  });

  it('does not redirect later spans when the caller mutates readonly request fields mid-run', async () => {
    const workerPool = new WorkerPool();
    registerOneSegmentWorkers(workerPool);
    const checkpointStore = new CheckpointStore();
    const request = makeRequest(2, 0, 'req-run-original');
    const { executor, assignments } = makeTwoSpanExecutor((_assignment, call) => {
      if (call !== 1) return;
      const mutable = request as unknown as { id: string; totalSegments: number };
      mutable.id = inferenceRequestId('req-run-mutated');
      mutable.totalSegments = 999;
    });
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );

    const result = await pipeline.run(request);

    expect(request.id).toBe('req-run-mutated');
    expect(request.totalSegments).toBe(999);
    expect(result.requestId).toBe('req-run-original');
    expect(result.segmentsCompleted).toBe(2);
    expect(assignments.map((assignment) => assignment.requestId)).toEqual([
      'req-run-original',
      'req-run-original',
    ]);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects request geometry mismatch before worker or checkpoint side effects', async () => {
    const workerPool = new WorkerPool();
    registerOneSegmentWorkers(workerPool);
    const checkpointStore = new CheckpointStore();
    checkpointStore.save(makeCheckpoint('req-run-mismatch', 0));
    let executeCalls = 0;
    const executor: SpanExecutor = {
      execute: async () => {
        executeCalls++;
        throw new Error('executor must not run');
      },
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      { retryDelayMs: 0 },
    );
    const request = makeRequest(3, 0, 'req-run-mismatch');

    await expect(pipeline.run(request)).rejects.toThrow(SpanPipelineError);

    expect(executeCalls).toBe(0);
    expect(checkpointStore.size).toBe(1);
    expect(request.status).toBe(InferenceStatus.QUEUED);
    expect(workerPool.get(workerId('run-envelope-a'))?.status).toBe(WorkerStatus.IDLE);
    expect(workerPool.get(workerId('run-envelope-b'))?.status).toBe(WorkerStatus.IDLE);
  });

  it('preserves zero-segment completion when the request declares matching geometry', async () => {
    const executor: SpanExecutor = {
      execute: async () => {
        throw new Error('zero-segment request must not execute');
      },
    };
    const request = makeRequest(0, 0, 'req-run-zero');
    const pipeline = new SpanPipeline(
      [],
      new WorkerPool(),
      new CheckpointStore(),
      executor,
      { retryDelayMs: 0 },
    );

    await expect(pipeline.run(request)).resolves.toEqual({
      requestId: 'req-run-zero',
      tokens: [],
      text: '',
      totalTimeMs: 0,
      segmentsCompleted: 0,
    });
    expect(request.status).toBe(InferenceStatus.COMPLETED);
  });
});
