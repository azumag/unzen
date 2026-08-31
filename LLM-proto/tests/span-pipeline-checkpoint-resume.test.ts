import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import type { SpanAssignment, SpanResult } from '../src/protocol.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import {
  InferenceStatus,
  workerId,
  WorkerStatus,
  WorkerTier,
  type WorkerId,
} from '../src/types.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

const FAST_RETRY = { maxRetries: 1, retryDelayMs: 0 };

function finalResult(
  worker: WorkerId,
  assignment: SpanAssignment,
  text = 'resumed',
): SpanResult {
  return {
    requestId: assignment.requestId,
    startSegment: assignment.segments[0].index,
    endSegment: assignment.segments[assignment.segments.length - 1].index,
    workerId: worker,
    output: { tokens: [9], text },
    processingTimeMs: 10,
  };
}

describe('SpanPipeline nearest-checkpoint resume', () => {
  it('does not rerun completed prefix spans after a later worker fails', async () => {
    const segments = makeSegments(4);
    const pool = new WorkerPool();
    const first = workerId('a-first');
    const failing = workerId('b-failing');
    pool.register({ workerId: first, tier: WorkerTier.TIER_2, vramMB: 4_200 });
    pool.register({ workerId: failing, tier: WorkerTier.TIER_2, vramMB: 4_200 });
    const store = new CheckpointStore();
    const calls: Array<{
      readonly worker: WorkerId;
      readonly start: number;
      readonly end: number;
      readonly checkpointIndex?: number;
    }> = [];

    const executor: SpanExecutor = {
      execute: async (worker, assignment) => {
        const start = assignment.segments[0].index;
        const end = assignment.segments[assignment.segments.length - 1].index;
        calls.push({
          worker,
          start,
          end,
          checkpointIndex: assignment.checkpoint?.segmentIndex,
        });
        if (worker === failing) {
          throw new Error('browser disappeared');
        }
        if (end < segments.length - 1) {
          return {
            requestId: assignment.requestId,
            startSegment: start,
            endSegment: end,
            workerId: worker,
            checkpoint: makeCheckpoint(assignment.requestId, end),
            processingTimeMs: 10,
          };
        }
        return finalResult(worker, assignment);
      },
    };

    const request = makeRequest(segments.length, 0, 'nearest-checkpoint');
    const result = await new SpanPipeline(
      segments,
      pool,
      store,
      executor,
      FAST_RETRY,
    ).run(request);

    expect(result.text).toBe('resumed');
    expect(calls).toEqual([
      { worker: first, start: 0, end: 1, checkpointIndex: undefined },
      { worker: failing, start: 2, end: 3, checkpointIndex: 1 },
      { worker: first, start: 2, end: 3, checkpointIndex: 1 },
    ]);
    expect(calls.filter((call) => call.start === 0)).toHaveLength(1);
    expect(pool.get(failing)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(store.size).toBe(0);
    expect(request.status).toBe(InferenceStatus.COMPLETED);
  });

  it('starts from a pre-existing durable checkpoint on the first attempt', async () => {
    const segments = makeSegments(4);
    const pool = new WorkerPool();
    const worker = workerId('resume-worker');
    pool.register({ workerId: worker, tier: WorkerTier.TIER_2, vramMB: 4_200 });
    const store = new CheckpointStore();
    const request = makeRequest(segments.length, 0, 'pre-existing-checkpoint');
    store.save(makeCheckpoint(request.id, 1));
    const assignments: SpanAssignment[] = [];

    const executor: SpanExecutor = {
      execute: async (assignedWorker, assignment) => {
        assignments.push(assignment);
        return finalResult(assignedWorker, assignment, 'continued');
      },
    };

    const result = await new SpanPipeline(
      segments,
      pool,
      store,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    ).run(request);

    expect(result.text).toBe('continued');
    expect(assignments).toHaveLength(1);
    expect(assignments[0].segments.map((segment) => segment.index)).toEqual([2, 3]);
    expect(assignments[0].checkpoint?.segmentIndex).toBe(1);
    expect(store.size).toBe(0);
  });

  it('fails closed when a non-final span omits its durable checkpoint', async () => {
    const segments = makeSegments(4);
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('a'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    pool.register({ workerId: workerId('b'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    const store = new CheckpointStore();
    const executor: SpanExecutor = {
      execute: async (worker, assignment) => ({
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: worker,
        processingTimeMs: 10,
      }),
    };
    const request = makeRequest(segments.length, 0, 'missing-checkpoint');

    await expect(new SpanPipeline(
      segments,
      pool,
      store,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    ).run(request)).rejects.toThrow(/did not produce a checkpoint/);

    expect(request.status).toBe(InferenceStatus.FAILED);
    expect(store.size).toBe(0);
  });

  it('rejects a checkpoint that does not match the completed span boundary', async () => {
    const segments = makeSegments(4);
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('a'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    pool.register({ workerId: workerId('b'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    const store = new CheckpointStore();
    const executor: SpanExecutor = {
      execute: async (worker, assignment) => {
        const start = assignment.segments[0].index;
        const end = assignment.segments[assignment.segments.length - 1].index;
        return {
          requestId: assignment.requestId,
          startSegment: start,
          endSegment: end,
          workerId: worker,
          checkpoint: makeCheckpoint(assignment.requestId, end - 1),
          processingTimeMs: 10,
        };
      },
    };
    const request = makeRequest(segments.length, 0, 'wrong-checkpoint-boundary');

    await expect(new SpanPipeline(
      segments,
      pool,
      store,
      executor,
      { maxRetries: 0, retryDelayMs: 0 },
    ).run(request)).rejects.toThrow(/checkpoint segment 0 does not match span end 1/);

    expect(request.status).toBe(InferenceStatus.FAILED);
    expect(store.size).toBe(0);
  });

  it('cleans the retained checkpoint when every suffix retry fails', async () => {
    const segments = makeSegments(4);
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('a'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    pool.register({ workerId: workerId('b'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    const store = new CheckpointStore();
    const executor: SpanExecutor = {
      execute: async (worker, assignment) => {
        const start = assignment.segments[0].index;
        const end = assignment.segments[assignment.segments.length - 1].index;
        if (start === 0) {
          return {
            requestId: assignment.requestId,
            startSegment: start,
            endSegment: end,
            workerId: worker,
            checkpoint: makeCheckpoint(assignment.requestId, end),
            processingTimeMs: 10,
          };
        }
        throw new Error('suffix unavailable');
      },
    };
    const request = makeRequest(segments.length, 0, 'terminal-suffix-failure');

    await expect(new SpanPipeline(
      segments,
      pool,
      store,
      executor,
      FAST_RETRY,
    ).run(request)).rejects.toThrow(/suffix unavailable/);

    expect(store.size).toBe(0);
    expect(request.status).toBe(InferenceStatus.FAILED);
  });
});
