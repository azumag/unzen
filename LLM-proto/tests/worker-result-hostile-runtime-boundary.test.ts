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

function makePromiseSafeRevokedRoot(): object {
  const revoked = Proxy.revocable({ requestId: 'unused' }, {});
  revoked.revoke();

  // Native Promise resolution probes a fulfilled object for `then` before the
  // pipeline can inspect it. A directly revoked Proxy would therefore fail in
  // Promise assimilation instead of exercising the result-envelope boundary.
  // The outer Proxy makes that probe safe while Array.isArray() still unwraps
  // into the revoked target and throws inside the boundary we intend to test.
  return new Proxy(revoked.proxy, {
    get(_target, property) {
      if (property === 'then') return undefined;
      return Reflect.get(_target, property);
    },
  });
}

describe('worker-result hostile runtime boundary', () => {
  it('Pipeline rejects a revoked result root through its stable result-envelope diagnostic', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'revoked-segment');
    const revokedRoot = makePromiseSafeRevokedRoot();
    const executor: SegmentExecutor = {
      execute: async () => revokedRoot as unknown as SegmentResult,
    };
    const pipeline = new Pipeline(
      makeSegments(1),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(1, 0, 'revoked-segment-request')))
      .rejects.toThrow('segment result must be a non-null, non-array object');
    expect(workerPool.get(workerId('revoked-segment'))?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(checkpointStore.size).toBe(0);
  });

  it('SpanPipeline rejects a revoked result root through its stable result-envelope diagnostic', async () => {
    const workerPool = new WorkerPool();
    const checkpointStore = new CheckpointStore();
    registerWorker(workerPool, 'revoked-span', 4200);
    const revokedRoot = makePromiseSafeRevokedRoot();
    const executor: SpanExecutor = {
      execute: async () => revokedRoot as unknown as SpanResult,
    };
    const pipeline = new SpanPipeline(
      makeSegments(2),
      workerPool,
      checkpointStore,
      executor,
      FAST_OPTIONS,
    );

    await expect(pipeline.run(makeRequest(2, 0, 'revoked-span-request')))
      .rejects.toThrow('span result must be a non-null, non-array object');
    expect(workerPool.get(workerId('revoked-span'))?.status).toBe(WorkerStatus.DISCONNECTED);
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

    await expect(pipeline.run(makeRequest(1, 0, 'lazy-segment-request'))
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

    await expect(pipeline.run(makeRequest(2, 0, 'lazy-span-request'))
      .rejects.toThrow('final span 0..1 must not produce a checkpoint');
    expect(nestedReads).toBe(0);
    expect(workerPool.get(workerId('lazy-span'))?.status).toBe(WorkerStatus.DISCONNECTED);
  });
});