import { describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import {
  InferenceStatus,
  WorkerStatus,
  WorkerTier,
  workerId,
} from '../src/types.js';
import { makeRequest, makeSegments } from './test-helpers.js';

describe('SpanPipeline effective timeout arithmetic', () => {
  it('rejects overflow before executor or worker-state mutation', async () => {
    const workerPool = new WorkerPool();
    const id = workerId('timeout-overflow-worker');
    workerPool.register({
      workerId: id,
      tier: WorkerTier.TIER_2,
      vramMB: 10_000,
    });
    const checkpointStore = new CheckpointStore();
    const execute = vi.fn(async () => {
      throw new Error('executor must not run for an overflowed timeout');
    });
    const executor: SpanExecutor = { execute };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      {
        maxRetries: 0,
        perSegmentTimeoutMs: Number.MAX_VALUE,
        retryDelayMs: 0,
      },
    );
    const request = makeRequest(2, 0, 'req-timeout-overflow');

    await expect(pipeline.run(request)).rejects.toThrow(
      /effective timeout for span 0\.\.1 must be finite/i,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(workerPool.get(id)?.status).toBe(WorkerStatus.IDLE);
    expect(workerPool.get(id)?.currentSegment).toBeUndefined();
    expect(request.status).toBe(InferenceStatus.FAILED);
    expect(checkpointStore.size).toBe(0);
  });
});
