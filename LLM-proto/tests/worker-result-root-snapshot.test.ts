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

function expectSingleReads(reads: Record<string, number>, fields: readonly string[]): void {
  for (const field of fields) {
    expect(reads[field], `${field} read count`).toBe(1);
  }
}

describe('Pipeline worker-result root snapshot', () => {
  it('fails closed when requestId changes on a hypothetical second read', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-root-id');
    const reads: Record<string, number> = {};
    const bump = (field: string): number => (reads[field] = (reads[field] ?? 0) + 1);

    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        get requestId() {
          return bump('requestId') === 1 ? 'wrong-request' : assignment.requestId;
        },
        get segmentIndex() {
          bump('segmentIndex');
          return assignment.segment.index;
        },
        get workerId() {
          bump('workerId');
          return _workerId;
        },
        get processingTimeMs() {
          bump('processingTimeMs');
          return 1;
        },
        get checkpoint() {
          bump('checkpoint');
          return undefined;
        },
        get output() {
          bump('output');
          return { tokens: [1], text: 'ok' };
        },
      }) as unknown as SegmentResult,
    };

    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1, 0, 'segment-root-request')))
      .rejects.toThrow('segment result request wrong-request does not match segment-root-request');
    expect(workerPool.get(workerId('segment-root-id'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expectSingleReads(reads, [
      'requestId',
      'segmentIndex',
      'workerId',
      'processingTimeMs',
      'checkpoint',
      'output',
    ]);
  });

  it('reads every declared root field exactly once for an accepted result', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'segment-root-stable');
    const reads: Record<string, number> = {};
    const bump = (field: string): void => {
      reads[field] = (reads[field] ?? 0) + 1;
    };

    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        get requestId() {
          bump('requestId');
          return assignment.requestId;
        },
        get segmentIndex() {
          bump('segmentIndex');
          return assignment.segment.index;
        },
        get workerId() {
          bump('workerId');
          return _workerId;
        },
        get processingTimeMs() {
          bump('processingTimeMs');
          return 1;
        },
        get checkpoint() {
          bump('checkpoint');
          return undefined;
        },
        get output() {
          bump('output');
          return { tokens: [7], text: 'stable' };
        },
      }) as unknown as SegmentResult,
    };

    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1, 0, 'segment-root-stable-request')))
      .resolves.toMatchObject({ requestId: 'segment-root-stable-request', tokens: [7], text: 'stable' });
    expectSingleReads(reads, [
      'requestId',
      'segmentIndex',
      'workerId',
      'processingTimeMs',
      'checkpoint',
      'output',
    ]);
  });
});

describe('SpanPipeline worker-result root snapshot', () => {
  it('fails closed when startSegment changes on a hypothetical second read', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-root-range', 4200);
    const reads: Record<string, number> = {};
    const bump = (field: string): number => (reads[field] = (reads[field] ?? 0) + 1);

    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        const expectedStart = assignment.segments[0].index;
        const expectedEnd = assignment.segments[assignment.segments.length - 1].index;
        return {
          get requestId() {
            bump('requestId');
            return assignment.requestId;
          },
          get workerId() {
            bump('workerId');
            return _workerId;
          },
          get startSegment() {
            return bump('startSegment') === 1 ? expectedStart + 1 : expectedStart;
          },
          get endSegment() {
            bump('endSegment');
            return expectedEnd;
          },
          get processingTimeMs() {
            bump('processingTimeMs');
            return 1;
          },
          get checkpoint() {
            bump('checkpoint');
            return undefined;
          },
          get output() {
            bump('output');
            return { tokens: [1], text: 'ok' };
          },
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

    await expect(pipeline.run(makeRequest(2, 0, 'span-root-request')))
      .rejects.toThrow('span result range 1..1 does not match assignment 0..1');
    expect(workerPool.get(workerId('span-root-range'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expectSingleReads(reads, [
      'requestId',
      'workerId',
      'startSegment',
      'endSegment',
      'processingTimeMs',
      'checkpoint',
      'output',
    ]);
  });

  it('reads every declared root field exactly once for an accepted result', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'span-root-stable', 4200);
    const reads: Record<string, number> = {};
    const bump = (field: string): void => {
      reads[field] = (reads[field] ?? 0) + 1;
    };

    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => ({
        get requestId() {
          bump('requestId');
          return assignment.requestId;
        },
        get workerId() {
          bump('workerId');
          return _workerId;
        },
        get startSegment() {
          bump('startSegment');
          return assignment.segments[0].index;
        },
        get endSegment() {
          bump('endSegment');
          return assignment.segments[assignment.segments.length - 1].index;
        },
        get processingTimeMs() {
          bump('processingTimeMs');
          return 1;
        },
        get checkpoint() {
          bump('checkpoint');
          return undefined;
        },
        get output() {
          bump('output');
          return { tokens: [9], text: 'span-stable' };
        },
      }) as unknown as SpanResult,
    };

    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'span-root-stable-request')))
      .resolves.toMatchObject({ requestId: 'span-root-stable-request', tokens: [9], text: 'span-stable' });
    expectSingleReads(reads, [
      'requestId',
      'workerId',
      'startSegment',
      'endSegment',
      'processingTimeMs',
      'checkpoint',
      'output',
    ]);
  });
});
