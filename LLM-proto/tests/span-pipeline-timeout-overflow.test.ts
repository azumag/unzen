import { describe, expect, it, vi } from 'vitest';
import type { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import { CheckpointStore } from '../src/checkpoint.js';
import { MAX_TIMER_DELAY_MS } from '../src/pipeline-utils.js';
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
  it.each(['perSegmentTimeoutMs', 'retryDelayMs'] as const)(
    'rejects %s above the host timer maximum before residency side effects',
    (field) => {
      const assertCompatibleSegments = vi.fn();
      const ledger = { assertCompatibleSegments } as unknown as ArtifactResidencyLedger;
      const executor: SpanExecutor = {
        execute: vi.fn(async () => {
          throw new Error('executor must not run during option preflight');
        }),
      };

      expect(() => new SpanPipeline(
        [],
        new WorkerPool(),
        new CheckpointStore(),
        executor,
        {
          artifactResidencyLedger: ledger,
          [field]: MAX_TIMER_DELAY_MS + 1,
        },
      )).toThrow(`${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`);
      expect(assertCompatibleSegments).not.toHaveBeenCalled();
    },
  );

  it('rejects a finite effective deadline above the host timer maximum before executor or worker-state mutation', async () => {
    const workerPool = new WorkerPool();
    const id = workerId('timeout-overflow-worker');
    workerPool.register({
      workerId: id,
      tier: WorkerTier.TIER_2,
      vramMB: 10_000,
    });
    const checkpointStore = new CheckpointStore();
    const execute = vi.fn(async () => {
      throw new Error('executor must not run for an unsupported effective timeout');
    });
    const executor: SpanExecutor = { execute };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      {
        maxRetries: 0,
        perSegmentTimeoutMs: Math.floor(MAX_TIMER_DELAY_MS / 2) + 1,
        retryDelayMs: 0,
      },
    );
    const request = makeRequest(2, 0, 'req-timeout-overflow');

    await expect(pipeline.run(request)).rejects.toThrow(
      new RegExp(
        `effective timeout for span 0\\.\\.1 exceeds host timer maximum ${MAX_TIMER_DELAY_MS}ms`,
        'i',
      ),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(workerPool.get(id)?.status).toBe(WorkerStatus.IDLE);
    expect(workerPool.get(id)?.currentSegment).toBeUndefined();
    expect(request.status).toBe(InferenceStatus.FAILED);
    expect(checkpointStore.size).toBe(0);
  });
});
