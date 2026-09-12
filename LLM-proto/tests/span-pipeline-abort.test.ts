import { describe, it, expect } from 'vitest';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  workerId,
  WorkerTier,
  WorkerStatus,
  InferenceStatus,
} from '../src/types.js';
import type { SpanResult } from '../src/protocol.js';
import { makeSegments, makeRequest } from './test-helpers.js';

describe('SpanPipeline abortable timeout', () => {
  it('aborts the executor signal when a span times out', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    const id = workerId('abortable-span-worker');
    workerPool.register({
      workerId: id,
      tier: WorkerTier.TIER_1,
      vramMB: 2100,
    });

    let observedSignal: AbortSignal | undefined;
    const executor: SpanExecutor = {
      execute: async (_workerId, _assignment, signal): Promise<SpanResult> => {
        observedSignal = signal;
        return new Promise<SpanResult>(() => {
          // Intentionally never settles. SpanPipeline must abort `signal` and
          // settle its own timeout rather than leaving the caller blocked.
        });
      },
    };

    const pipeline = new SpanPipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      {
        maxRetries: 0,
        retryDelayMs: 0,
        perSegmentTimeoutMs: 10,
      },
    );
    const request = makeRequest(1, 0, 'req-span-abort');

    await expect(pipeline.run(request)).rejects.toThrow(/timed out/);

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(workerPool.get(id)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(request.status).toBe(InferenceStatus.FAILED);
  });
});
