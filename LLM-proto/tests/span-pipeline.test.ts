import { describe, it, expect, beforeEach } from 'vitest';
import { SpanPipeline, SpanPipelineError, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  workerId,
  WorkerTier,
  WorkerStatus,
  InferenceStatus,
} from '../src/types.js';
import type { WorkerId } from '../src/types.js';
import type { SpanAssignment, SpanResult } from '../src/protocol.js';
import { makeSegments, makeRequest, makeCheckpoint } from './test-helpers.js';

/**
 * Mock span executor that successfully processes any span.
 * Produces a checkpoint for non-final spans, and output for the final span.
 */
function createSuccessSpanExecutor(totalSegments: number): SpanExecutor {
  return {
    execute: async (_workerId: WorkerId, assignment: SpanAssignment): Promise<SpanResult> => {
      const lastSegment = assignment.segments[assignment.segments.length - 1].index;
      const isFinal = lastSegment === totalSegments - 1;
      return {
        requestId: assignment.requestId,
        startSegment: assignment.segments[0].index,
        endSegment: lastSegment,
        workerId: _workerId,
        checkpoint: isFinal ? undefined : makeCheckpoint(assignment.requestId, lastSegment),
        output: isFinal ? { tokens: [1, 2, 3], text: 'span result' } : undefined,
        processingTimeMs: assignment.segments.length * 100,
      };
    },
  };
}

const FAST_OPTIONS = { retryDelayMs: 0 };

describe('SpanPipeline', () => {
  let workerPool: WorkerPool;
  let checkpointStore: CheckpointStore;
  const totalSegments = 8;
  const segments = makeSegments(totalSegments);

  beforeEach(() => {
    workerPool = new WorkerPool();
    checkpointStore = new CheckpointStore();
  });

  it('should complete with a single worker handling all segments as one span', async () => {
    workerPool.register({
      workerId: workerId('big'),
      tier: WorkerTier.TIER_1,
      vramMB: 8 * 2100,
    });

    const executor = createSuccessSpanExecutor(totalSegments);
    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const request = makeRequest(totalSegments, 0, 'req-span');
    const result = await pipeline.run(request);

    expect(result.text).toBe('span result');
    expect(result.segmentsCompleted).toBe(totalSegments);
    expect(checkpointStore.size).toBe(0);
    expect(request.status).toBe(InferenceStatus.COMPLETED);
  });

  it('should split across multiple workers and pass checkpoints between spans', async () => {
    workerPool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 4 * 2100 });
    workerPool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_2, vramMB: 4 * 2100 });

    const receivedAssignments: SpanAssignment[] = [];
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        receivedAssignments.push(assignment);
        const lastSeg = assignment.segments[assignment.segments.length - 1].index;
        const isFinal = lastSeg === totalSegments - 1;
        return {
          requestId: assignment.requestId,
          startSegment: assignment.segments[0].index,
          endSegment: lastSeg,
          workerId: _workerId,
          checkpoint: isFinal ? undefined : makeCheckpoint(assignment.requestId, lastSeg),
          output: isFinal ? { tokens: [42], text: 'done' } : undefined,
          processingTimeMs: 200,
        };
      },
    };

    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const result = await pipeline.run(makeRequest(totalSegments, 0, 'req-span'));

    expect(result.text).toBe('done');
    expect(receivedAssignments).toHaveLength(2);

    // First span: segments 0-3, no checkpoint
    expect(receivedAssignments[0].segments).toHaveLength(4);
    expect(receivedAssignments[0].segments[0].index).toBe(0);
    expect(receivedAssignments[0].segments[3].index).toBe(3);
    expect(receivedAssignments[0].checkpoint).toBeUndefined();

    // Second span: segments 4-7, with checkpoint from segment 3
    expect(receivedAssignments[1].segments).toHaveLength(4);
    expect(receivedAssignments[1].segments[0].index).toBe(4);
    expect(receivedAssignments[1].checkpoint).toBeDefined();
    expect(receivedAssignments[1].checkpoint?.segmentIndex).toBe(3);
  });

  it('should handle 8 workers with 1 segment each (degenerates to basic pipeline)', async () => {
    for (let i = 0; i < 8; i++) {
      workerPool.register({
        workerId: workerId(`w${i}`),
        tier: WorkerTier.TIER_3,
        vramMB: 2100,
      });
    }

    const executor = createSuccessSpanExecutor(totalSegments);
    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const result = await pipeline.run(makeRequest(totalSegments, 0, 'req-span'));

    expect(result.text).toBe('span result');
    expect(result.segmentsCompleted).toBe(totalSegments);
  });

  it('should mark failed worker as disconnected and retry with new route', async () => {
    workerPool.register({ workerId: workerId('w-fail'), tier: WorkerTier.TIER_1, vramMB: 8 * 2100 });
    workerPool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 4 * 2100 });
    workerPool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_2, vramMB: 4 * 2100 });

    let callCount = 0;
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('GPU overheated');
        }
        const lastSeg = assignment.segments[assignment.segments.length - 1].index;
        const isFinal = lastSeg === totalSegments - 1;
        return {
          requestId: assignment.requestId,
          startSegment: assignment.segments[0].index,
          endSegment: lastSeg,
          workerId: _workerId,
          checkpoint: isFinal ? undefined : makeCheckpoint(assignment.requestId, lastSeg),
          output: isFinal ? { tokens: [1], text: 'recovered' } : undefined,
          processingTimeMs: 100,
        };
      },
    };

    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 2,
    });
    const result = await pipeline.run(makeRequest(totalSegments, 0, 'req-span'));

    expect(result.text).toBe('recovered');
    expect(workerPool.get(workerId('w-fail'))?.status).toBe(WorkerStatus.DISCONNECTED);
  });

  it('should throw SpanPipelineError when no route is possible', async () => {
    const executor = createSuccessSpanExecutor(totalSegments);
    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
    });

    const request = makeRequest(totalSegments, 0, 'req-span');
    await expect(pipeline.run(request)).rejects.toThrow(SpanPipelineError);
    expect(request.status).toBe(InferenceStatus.FAILED);
  });

  it('should clean up checkpoints on failure', async () => {
    workerPool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_2, vramMB: 4 * 2100 });
    workerPool.register({ workerId: workerId('w2'), tier: WorkerTier.TIER_2, vramMB: 4 * 2100 });

    let spanCount = 0;
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        spanCount++;
        if (spanCount === 2) throw new Error('second span fails');
        const lastSeg = assignment.segments[assignment.segments.length - 1].index;
        return {
          requestId: assignment.requestId,
          startSegment: assignment.segments[0].index,
          endSegment: lastSeg,
          workerId: _workerId,
          checkpoint: makeCheckpoint(assignment.requestId, lastSeg),
          processingTimeMs: 100,
        };
      },
    };

    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
    });

    await expect(pipeline.run(makeRequest(totalSegments, 0, 'req-span'))).rejects.toThrow();
    expect(checkpointStore.size).toBe(0);
  });

  it('should use fewer checkpoint transfers with larger spans', async () => {
    workerPool.register({ workerId: workerId('big'), tier: WorkerTier.TIER_1, vramMB: 6 * 2100 });
    workerPool.register({ workerId: workerId('small'), tier: WorkerTier.TIER_3, vramMB: 2 * 2100 });

    const checkpointsCreated: number[] = [];
    const executor: SpanExecutor = {
      execute: async (_workerId, assignment) => {
        const lastSeg = assignment.segments[assignment.segments.length - 1].index;
        const isFinal = lastSeg === totalSegments - 1;
        const cp = isFinal ? undefined : makeCheckpoint(assignment.requestId, lastSeg);
        if (cp) checkpointsCreated.push(lastSeg);
        return {
          requestId: assignment.requestId,
          startSegment: assignment.segments[0].index,
          endSegment: lastSeg,
          workerId: _workerId,
          checkpoint: cp,
          output: isFinal ? { tokens: [1], text: 'efficient' } : undefined,
          processingTimeMs: assignment.segments.length * 50,
        };
      },
    };

    const pipeline = new SpanPipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const result = await pipeline.run(makeRequest(totalSegments, 0, 'req-span'));

    expect(result.text).toBe('efficient');
    // Only 1 checkpoint transfer (at the span boundary between big and small)
    expect(checkpointsCreated).toHaveLength(1);
  });

  it('should timeout a span that takes too long', async () => {
    // Use 1 segment to keep the timeout short (1 * 50ms = 50ms, not 8 * 50ms = 400ms)
    const singleSegment = makeSegments(1);
    workerPool.register({ workerId: workerId('w1'), tier: WorkerTier.TIER_1, vramMB: 2100 });

    const executor: SpanExecutor = {
      execute: async () => new Promise(() => {
        // intentionally never resolves
      }),
    };

    const pipeline = new SpanPipeline(singleSegment, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
      perSegmentTimeoutMs: 50,
    });

    const request = makeRequest(1, 0, 'req-span');
    await expect(pipeline.run(request)).rejects.toThrow(/timed out/);
    expect(request.status).toBe(InferenceStatus.FAILED);
  });

  it('should return immediately for 0 segments', async () => {
    const executor = createSuccessSpanExecutor(0);
    const pipeline = new SpanPipeline([], workerPool, checkpointStore, executor, FAST_OPTIONS);
    const request = makeRequest(0, 0, 'req-span');
    const result = await pipeline.run(request);

    expect(result.segmentsCompleted).toBe(0);
    expect(result.text).toBe('');
    expect(request.status).toBe(InferenceStatus.COMPLETED);
  });
});
