import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Pipeline, PipelineError, type SegmentExecutor } from '../src/pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  workerId,
  inferenceRequestId,
  WorkerTier,
  WorkerStatus,
  InferenceStatus,
} from '../src/types.js';
import type {
  InferenceRequest,
  SegmentConfig,
  Checkpoint,
  WorkerId,
} from '../src/types.js';
import type { SegmentAssignment, SegmentResult } from '../src/protocol.js';

// --- Test helpers ---

function makeSegments(count: number): SegmentConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    layerStart: i * 8,
    layerEnd: (i + 1) * 8 - 1,
    modelWeightHash: `sha256:seg-${i}`,
    estimatedVramMB: 2100,
  }));
}

function makeRequest(
  totalSegments: number,
  currentSegment = 0,
): InferenceRequest {
  return {
    id: inferenceRequestId('req-test'),
    prompt: 'test prompt',
    createdAt: Date.now(),
    status: InferenceStatus.QUEUED,
    currentSegment,
    totalSegments,
  };
}

function makeCheckpoint(requestId: string, segmentIndex: number): Checkpoint {
  return {
    requestId: inferenceRequestId(requestId),
    segmentIndex,
    hiddenStates: new Uint8Array([segmentIndex]),
    metadata: {
      shape: [1, 128, 4096],
      dtype: 'float16',
      sequenceLength: 128,
      timestamp: Date.now(),
    },
  };
}

/**
 * Mock executor that succeeds for all segments.
 * Intermediate segments produce a checkpoint; the final segment produces output.
 */
function createSuccessExecutor(totalSegments: number): SegmentExecutor {
  return {
    execute: async (_workerId: WorkerId, assignment: SegmentAssignment): Promise<SegmentResult> => {
      const isFinal = assignment.segment.index === totalSegments - 1;
      return {
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        checkpoint: isFinal ? undefined : makeCheckpoint(
          assignment.requestId,
          assignment.segment.index,
        ),
        output: isFinal ? { tokens: [1, 2, 3], text: 'hello world' } : undefined,
        processingTimeMs: 100,
      };
    },
  };
}

// Use retryDelayMs: 0 in tests to avoid real delays
const FAST_OPTIONS = { retryDelayMs: 0 };

describe('Pipeline', () => {
  let workerPool: WorkerPool;
  let checkpointStore: CheckpointStore;
  const totalSegments = 4; // Use 4 segments in tests for speed
  const segments = makeSegments(totalSegments);

  beforeEach(() => {
    workerPool = new WorkerPool();
    checkpointStore = new CheckpointStore();
  });

  it('should complete a full inference through all segments', async () => {
    // Register enough workers
    for (let i = 0; i < totalSegments; i++) {
      workerPool.register({
        workerId: workerId(`w${i}`),
        tier: WorkerTier.TIER_3,
        vramMB: 4096,
      });
    }

    const executor = createSuccessExecutor(totalSegments);
    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const request = makeRequest(totalSegments);

    const result = await pipeline.run(request);

    expect(result.requestId).toBe(request.id);
    expect(result.text).toBe('hello world');
    expect(result.tokens).toEqual([1, 2, 3]);
    expect(result.segmentsCompleted).toBe(totalSegments);
    expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('should pass checkpoints between segments', async () => {
    // Register one worker that gets reused (marked idle after each segment)
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    const receivedAssignments: SegmentAssignment[] = [];
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => {
        receivedAssignments.push(assignment);
        const isFinal = assignment.segment.index === totalSegments - 1;
        return {
          requestId: assignment.requestId,
          segmentIndex: assignment.segment.index,
          workerId: _workerId,
          checkpoint: isFinal ? undefined : makeCheckpoint(
            assignment.requestId,
            assignment.segment.index,
          ),
          output: isFinal ? { tokens: [42], text: 'done' } : undefined,
          processingTimeMs: 50,
        };
      },
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    await pipeline.run(makeRequest(totalSegments));

    // First segment should have no checkpoint
    expect(receivedAssignments[0].checkpoint).toBeUndefined();
    // Subsequent segments should receive checkpoint from previous segment
    for (let i = 1; i < totalSegments; i++) {
      expect(receivedAssignments[i].checkpoint).toBeDefined();
      expect(receivedAssignments[i].checkpoint?.segmentIndex).toBe(i - 1);
    }
  });

  it('should retry with a different worker on failure and mark failed worker disconnected', async () => {
    workerPool.register({
      workerId: workerId('w-fail'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });
    workerPool.register({
      workerId: workerId('w-ok'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    const executedWorkers: string[] = [];
    let callCount = 0;
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => {
        callCount++;
        executedWorkers.push(_workerId);
        // First call fails, subsequent calls succeed
        if (callCount === 1) {
          throw new Error('WebGPU context lost');
        }
        const isFinal = assignment.segment.index === totalSegments - 1;
        return {
          requestId: assignment.requestId,
          segmentIndex: assignment.segment.index,
          workerId: _workerId,
          checkpoint: isFinal ? undefined : makeCheckpoint(
            assignment.requestId,
            assignment.segment.index,
          ),
          output: isFinal ? { tokens: [1], text: 'ok' } : undefined,
          processingTimeMs: 50,
        };
      },
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 2,
    });
    const result = await pipeline.run(makeRequest(totalSegments));

    expect(result.text).toBe('ok');
    // First call failed, so we have totalSegments + 1 calls total
    expect(callCount).toBe(totalSegments + 1);
    // The failed worker should be marked DISCONNECTED
    expect(workerPool.get(workerId('w-fail'))?.status).toBe(WorkerStatus.DISCONNECTED);
    // The retry should have used a different worker
    expect(executedWorkers[1]).not.toBe(executedWorkers[0]);
  });

  it('should throw PipelineError when all retries are exhausted', async () => {
    // Register enough workers so retries can try different ones
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });
    workerPool.register({
      workerId: workerId('w2'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    const executor: SegmentExecutor = {
      execute: async () => {
        throw new Error('always fails');
      },
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 1,
    });

    await expect(pipeline.run(makeRequest(totalSegments)))
      .rejects.toThrow(PipelineError);
  });

  it('should throw PipelineError when no workers are available', async () => {
    // No workers registered
    const executor = createSuccessExecutor(totalSegments);
    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
    });

    await expect(pipeline.run(makeRequest(totalSegments)))
      .rejects.toThrow(PipelineError);
  });

  it('should set request status to completed on success', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    const executor = createSuccessExecutor(totalSegments);
    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const request = makeRequest(totalSegments);

    await pipeline.run(request);
    expect(request.status).toBe(InferenceStatus.COMPLETED);
  });

  it('should set request status to failed on error', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    const executor: SegmentExecutor = {
      execute: async () => { throw new Error('fail'); },
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
    });
    const request = makeRequest(totalSegments);

    await expect(pipeline.run(request)).rejects.toThrow();
    expect(request.status).toBe(InferenceStatus.FAILED);
  });

  it('should clean up checkpoints after successful completion', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    const executor = createSuccessExecutor(totalSegments);
    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);

    await pipeline.run(makeRequest(totalSegments));

    // All checkpoints should be cleaned up after success
    expect(checkpointStore.size).toBe(0);
  });

  it('should clean up checkpoints after failure', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    // Executor that succeeds for segment 0, then always fails
    let segmentsDone = 0;
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => {
        if (segmentsDone === 0) {
          segmentsDone++;
          return {
            requestId: assignment.requestId,
            segmentIndex: 0,
            workerId: _workerId,
            checkpoint: makeCheckpoint(assignment.requestId, 0),
            processingTimeMs: 50,
          };
        }
        throw new Error('fail on segment 1');
      },
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
    });

    await expect(pipeline.run(makeRequest(totalSegments))).rejects.toThrow();

    // Checkpoints should be cleaned up even on failure
    expect(checkpointStore.size).toBe(0);
  });

  it('should throw PipelineError when final segment produces no output', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    // Executor that never produces output (even for the final segment)
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => ({
        requestId: assignment.requestId,
        segmentIndex: assignment.segment.index,
        workerId: _workerId,
        checkpoint: makeCheckpoint(assignment.requestId, assignment.segment.index),
        processingTimeMs: 50,
      }),
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);

    await expect(pipeline.run(makeRequest(totalSegments)))
      .rejects.toThrow('Final segment did not produce output');
  });

  it('should resume from a non-zero currentSegment (checkpoint-resume)', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    // Pre-populate checkpoint for segment 1 (as if segments 0-1 already completed)
    const resumeFrom = 2;
    checkpointStore.save(makeCheckpoint('req-test', resumeFrom - 1));

    const executedSegments: number[] = [];
    const executor: SegmentExecutor = {
      execute: async (_workerId, assignment) => {
        executedSegments.push(assignment.segment.index);
        const isFinal = assignment.segment.index === totalSegments - 1;
        return {
          requestId: assignment.requestId,
          segmentIndex: assignment.segment.index,
          workerId: _workerId,
          checkpoint: isFinal ? undefined : makeCheckpoint(
            assignment.requestId,
            assignment.segment.index,
          ),
          output: isFinal ? { tokens: [99], text: 'resumed' } : undefined,
          processingTimeMs: 50,
        };
      },
    };

    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, FAST_OPTIONS);
    const request = makeRequest(totalSegments, resumeFrom);
    const result = await pipeline.run(request);

    expect(result.text).toBe('resumed');
    // Should only have executed segments 2 and 3 (not 0 and 1)
    expect(executedSegments).toEqual([2, 3]);
  });

  it('should timeout a segment that takes too long', async () => {
    workerPool.register({
      workerId: workerId('w1'),
      tier: WorkerTier.TIER_3,
      vramMB: 4096,
    });

    // Executor that never resolves - the timeout will trigger before it completes
    const executor: SegmentExecutor = {
      execute: async () => new Promise(() => {
        // intentionally never resolves
      }),
    };

    // maxRetries: 0 means the timeout causes the segment to fail immediately,
    // resulting in a PipelineError. The timeout itself is what causes the failure.
    const pipeline = new Pipeline(segments, workerPool, checkpointStore, executor, {
      ...FAST_OPTIONS,
      maxRetries: 0,
      segmentTimeoutMs: 50, // 50ms timeout
    });

    await expect(pipeline.run(makeRequest(totalSegments)))
      .rejects.toThrow(PipelineError);
  });
});
