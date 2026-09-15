import { describe, expect, it } from 'vitest';
import { Pipeline, type SegmentExecutor } from '../src/pipeline.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { SegmentResult, SpanResult } from '../src/protocol.js';
import { makeRequest, makeSegments } from './test-helpers.js';

const FAST_OPTIONS = { retryDelayMs: 0, maxRetries: 0 };

interface HostileCheckpointSource {
  readonly checkpoint: object;
  readonly payload: Uint8Array;
  readonly shape: number[];
  readonly metadata: { dtype: string };
  readonly reads: Record<string, number>;
}

function makeHostileCheckpoint(requestId: string, segmentIndex: number): HostileCheckpointSource {
  const reads: Record<string, number> = {};
  const bump = (field: string): number => (reads[field] = (reads[field] ?? 0) + 1);
  const payload = new Uint8Array([1, 2, 3]);
  const shape = [1, 3];
  const metadata = {
    dtype: 'float16',
    get shape() {
      bump('metadata.shape');
      return shape;
    },
    get sequenceLength() {
      return bump('metadata.sequenceLength') === 1 ? 3 : -1;
    },
    get timestamp() {
      return bump('metadata.timestamp') === 1 ? 123 : -1;
    },
  };
  const checkpoint = {
    get requestId() {
      return bump('checkpoint.requestId') === 1 ? requestId : `${requestId}-changed`;
    },
    get segmentIndex() {
      return bump('checkpoint.segmentIndex') === 1 ? segmentIndex : segmentIndex + 100;
    },
    get hiddenStates() {
      return bump('checkpoint.hiddenStates') === 1 ? payload : new Uint8Array([9]);
    },
    get metadata() {
      bump('checkpoint.metadata');
      return metadata;
    },
  };
  return { checkpoint, payload, shape, metadata, reads };
}

function expectSourceReadOnce(source: HostileCheckpointSource): void {
  expect(source.reads).toEqual({
    'checkpoint.requestId': 1,
    'checkpoint.segmentIndex': 1,
    'checkpoint.hiddenStates': 1,
    'checkpoint.metadata': 1,
    'metadata.shape': 1,
    'metadata.sequenceLength': 1,
    'metadata.timestamp': 1,
  });
}

function mutateSource(source: HostileCheckpointSource): void {
  source.payload[0] = 99;
  source.shape[0] = 99;
  source.metadata.dtype = 'mutated';
}

function expectStableCheckpoint(checkpoint: unknown, requestId: string): void {
  expect(checkpoint).toMatchObject({
    requestId,
    segmentIndex: 0,
    metadata: {
      shape: [1, 3],
      dtype: 'float16',
      sequenceLength: 3,
      timestamp: 123,
    },
  });
  expect([...(checkpoint as { hiddenStates: Uint8Array }).hiddenStates]).toEqual([1, 2, 3]);
}

describe('legacy pipeline checkpoint snapshot integration', () => {
  it('persists the first validated Pipeline checkpoint identity and payload', async () => {
    const requestId = 'req-pipeline-checkpoint-snapshot';
    const source = makeHostileCheckpoint(requestId, 0);
    const workerPool = new WorkerPool();
    workerPool.register({
      workerId: workerId('pipeline-checkpoint-worker'),
      tier: WorkerTier.TIER_3,
      vramMB: 2100,
    });
    const checkpointStore = new CheckpointStore();
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => {
        if (assignment.segment.index === 0) {
          return {
            requestId: assignment.requestId,
            segmentIndex: 0,
            workerId: _workerId,
            processingTimeMs: 1,
            checkpoint: source.checkpoint,
          } as unknown as SegmentResult;
        }

        mutateSource(source);
        expectStableCheckpoint(assignment.checkpoint, requestId);
        return {
          requestId: assignment.requestId,
          segmentIndex: 1,
          workerId: _workerId,
          processingTimeMs: 1,
          output: { tokens: [7], text: 'pipeline-stable' },
        };
      },
    };

    const pipeline = new Pipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );
    await expect(pipeline.run(makeRequest(2, 0, requestId)))
      .resolves.toMatchObject({ requestId, tokens: [7], text: 'pipeline-stable' });
    expectSourceReadOnce(source);
  });

  it('persists the first validated SpanPipeline checkpoint identity and payload', async () => {
    const requestId = 'req-span-checkpoint-snapshot';
    const source = makeHostileCheckpoint(requestId, 0);
    const workerPool = new WorkerPool();
    workerPool.register({
      workerId: workerId('span-checkpoint-worker'),
      tier: WorkerTier.TIER_3,
      vramMB: 2100,
    });
    const checkpointStore = new CheckpointStore();
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        const startSegment = assignment.segments[0].index;
        const endSegment = assignment.segments[assignment.segments.length - 1].index;
        if (endSegment === 0) {
          return {
            requestId: assignment.requestId,
            startSegment,
            endSegment,
            workerId: _workerId,
            processingTimeMs: 1,
            checkpoint: source.checkpoint,
          } as unknown as SpanResult;
        }

        mutateSource(source);
        expectStableCheckpoint(assignment.checkpoint, requestId);
        return {
          requestId: assignment.requestId,
          startSegment,
          endSegment,
          workerId: _workerId,
          processingTimeMs: 1,
          output: { tokens: [9], text: 'span-stable' },
        };
      },
    };

    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );
    await expect(pipeline.run(makeRequest(2, 0, requestId)))
      .resolves.toMatchObject({ requestId, tokens: [9], text: 'span-stable' });
    expectSourceReadOnce(source);
  });
});
