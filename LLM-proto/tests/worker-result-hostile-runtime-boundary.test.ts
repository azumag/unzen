import { describe, expect, it } from 'vitest';
import { Pipeline, type SegmentExecutor } from '../src/pipeline.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';
import type { SegmentResult, SpanResult } from '../src/protocol.js';
import { makeRequest, makeSegments } from './test-helpers.js';

const FAST_OPTIONS = { retryDelayMs: 0, maxRetries: 0 };

function registerWorker(pool: WorkerPool, id: string, vramMB = 4096): void {
  pool.register({ workerId: workerId(id), tier: WorkerTier.TIER_3, vramMB });
}

function hostileThrownValue() {
  const hooks = { toString: 0, primitive: 0 };
  return {
    hooks,
    value: {
      toString() {
        hooks.toString += 1;
        throw new Error('hostile toString must not run');
      },
      [Symbol.toPrimitive]() {
        hooks.primitive += 1;
        throw new Error('hostile primitive conversion must not run');
      },
    },
  };
}

describe('worker-result hostile runtime boundary', () => {
  it('Pipeline bounds a throwing result-root getter and disconnects the worker', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'hostile-segment');
    const hostile = hostileThrownValue();
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        get requestId() {
          throw hostile.value;
        },
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        processingTimeMs: 1,
        checkpoint: undefined,
        output: { tokens: [1], text: 'unused' },
      }) as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1, 0, 'hostile-segment-request')))
      .rejects.toThrow('segment result requestId must be a string');
    expect(hostile.hooks).toEqual({ toString: 0, primitive: 0 });
    expect(workerPool.get(workerId('hostile-segment'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('SpanPipeline bounds a throwing result-root getter and disconnects the worker', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'hostile-span', 4200);
    const hostile = hostileThrownValue();
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => ({
        get requestId() {
          throw hostile.value;
        },
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: _workerId,
        processingTimeMs: 1,
        checkpoint: undefined,
        output: { tokens: [1], text: 'unused' },
      }) as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'hostile-span-request')))
      .rejects.toThrow('span result requestId must be a string');
    expect(hostile.hooks).toEqual({ toString: 0, primitive: 0 });
    expect(workerPool.get(workerId('hostile-span'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('Pipeline preserves final-result short-circuiting without reading nested checkpoint getters', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'lazy-segment');
    let nestedReads = 0;
    const checkpoint = {
      get requestId() {
        nestedReads += 1;
        throw new Error('nested checkpoint getter must stay lazy');
      },
    };
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        processingTimeMs: 1,
        checkpoint,
        output: { tokens: [1], text: 'unused' },
      }) as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1, 0, 'lazy-segment-request')))
      .rejects.toThrow('final segment 0 must not produce a checkpoint');
    expect(nestedReads).toBe(0);
    expect(workerPool.get(workerId('lazy-segment'))?.status).toBe(WorkerStatus.DISCONNECTED);
  });

  it('SpanPipeline preserves final-result short-circuiting without reading nested checkpoint getters', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'lazy-span', 4200);
    let nestedReads = 0;
    const checkpoint = {
      get requestId() {
        nestedReads += 1;
        throw new Error('nested checkpoint getter must stay lazy');
      },
    };
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: _workerId,
        processingTimeMs: 1,
        checkpoint,
        output: { tokens: [1], text: 'unused' },
      }) as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'lazy-span-request')))
      .rejects.toThrow('final span 0..1 must not produce a checkpoint');
    expect(nestedReads).toBe(0);
    expect(workerPool.get(workerId('lazy-span'))?.status).toBe(WorkerStatus.DISCONNECTED);
  });
});
