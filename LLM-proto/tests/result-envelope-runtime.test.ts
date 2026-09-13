import { describe, expect, it } from 'vitest';
import { Pipeline, type SegmentExecutor } from '../src/pipeline.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';
import type { SegmentResult, SpanResult } from '../src/protocol.js';
import { makeCheckpoint, makeRequest, makeSegments } from './test-helpers.js';

const FAST_OPTIONS = { retryDelayMs: 0, maxRetries: 0 };

function registerWorker(pool: WorkerPool, id: string, vramMB = 4096): void {
  pool.register({ workerId: workerId(id), tier: WorkerTier.TIER_3, vramMB });
}

describe('Pipeline worker-result runtime envelope', () => {
  it('rejects a non-object result before field access and disconnects the worker', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-null');
    const executor: SegmentExecutor = {
      execute: async () => null as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1)))
      .rejects.toThrow('segment result must be a non-null, non-array object');
    expect(workerPool.get(workerId('segment-null'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects coercion-unsafe identity fields with an intentional contract error', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-symbol');
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: Symbol('request'),
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        output: { tokens: [1], text: 'ignored' },
        processingTimeMs: 1,
      }) as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1)))
      .rejects.toThrow('segment result requestId must be a string');
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a malformed non-final checkpoint container before durable commit', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-checkpoint');
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        checkpoint: Symbol('checkpoint'),
        processingTimeMs: 1,
      }) as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2)))
      .rejects.toThrow('segment result checkpoint must be a non-null, non-array object');
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a malformed checkpoint payload before worker reuse', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-payload');
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => {
        const checkpoint = makeCheckpoint(assignment.requestId, assignment.segment.index);
        return {
          requestId: assignment.requestId,
          segmentIndex: assignment.segment.index,
          workerId: _workerId,
          checkpoint: {
            ...checkpoint,
            hiddenStates: 'not-bytes',
          },
          processingTimeMs: 1,
        } as unknown as SegmentResult;
      },
    };
    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2)))
      .rejects.toThrow(
        'invalid checkpoint from segment 0: checkpoint hiddenStates must be a non-empty Uint8Array',
      );
    expect(workerPool.get(workerId('segment-payload'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a malformed final output before returning it to the caller', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-output');
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        output: ['not-an-output-envelope'],
        processingTimeMs: 1,
      }) as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1)))
      .rejects.toThrow('final segment output must be a non-null, non-array object');
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects malformed final token values before returning them to the caller', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-token');
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        output: { tokens: [Symbol('token')], text: 'bad token' },
        processingTimeMs: 1,
      }) as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1)))
      .rejects.toThrow('final segment output tokens must contain non-negative safe integers');
    expect(checkpointStore.size).toBe(0);
  });
});

describe('SpanPipeline worker-result runtime envelope', () => {
  it('rejects a non-object result before field access and disconnects the worker', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-null', 4200);
    const executor: SpanExecutor = {
      execute: async () => null as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-null-request')))
      .rejects.toThrow('span result must be a non-null, non-array object');
    expect(workerPool.get(workerId('span-null'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects coercion-unsafe range fields with an intentional contract error', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-symbol', 4200);
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        startSegment: Symbol('start'),
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: _workerId,
        output: { tokens: [1], text: 'ignored' },
        processingTimeMs: 1,
      }) as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-symbol-request')))
      .rejects.toThrow('span result startSegment must be a non-negative safe integer');
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a malformed non-final checkpoint container before durable commit', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-cp-a', 2100);
    registerWorker(workerPool, 'span-cp-b', 2100);
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        const lastSegment = assignment.segments[assignment.segments.length - 1].index;
        return {
          requestId: assignment.requestId,
          startSegment: assignment.segments[0].index,
          endSegment: lastSegment,
          workerId: _workerId,
          checkpoint: Symbol('checkpoint'),
          processingTimeMs: 1,
        } as unknown as SpanResult;
      },
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-checkpoint-request')))
      .rejects.toThrow('span result checkpoint must be a non-null, non-array object');
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a malformed checkpoint payload before worker reuse or residency commit', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-payload-a', 2100);
    registerWorker(workerPool, 'span-payload-b', 2100);
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        const lastSegment = assignment.segments[assignment.segments.length - 1].index;
        const checkpoint = makeCheckpoint(assignment.requestId, lastSegment);
        return {
          requestId: assignment.requestId,
          startSegment: assignment.segments[0].index,
          endSegment: lastSegment,
          workerId: _workerId,
          checkpoint: {
            ...checkpoint,
            hiddenStates: 'not-bytes',
          },
          processingTimeMs: 1,
        } as unknown as SpanResult;
      },
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-payload-request')))
      .rejects.toThrow(
        'invalid checkpoint from span 0..0: checkpoint hiddenStates must be a non-empty Uint8Array',
      );
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects a malformed final output before returning it to the caller', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-output', 4200);
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: _workerId,
        output: 'not-an-output-envelope',
        processingTimeMs: 1,
      }) as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-output-request')))
      .rejects.toThrow('final span output must be a non-null, non-array object');
    expect(checkpointStore.size).toBe(0);
  });

  it('rejects malformed final token values before returning them to the caller', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-token', 4200);
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: assignment.segments[assignment.segments.length - 1].index,
        workerId: _workerId,
        output: { tokens: [1.5], text: 'bad token' },
        processingTimeMs: 1,
      }) as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-token-request')))
      .rejects.toThrow('final span output tokens must contain non-negative safe integers');
    expect(checkpointStore.size).toBe(0);
  });
});
