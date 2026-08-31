import { describe, expect, it } from 'vitest';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import { CheckpointStore } from '../src/checkpoint.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import type { SpanAssignment, SpanResult } from '../src/protocol.js';
import { SpanPipeline, type SpanExecutor } from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier, type SegmentConfig, type WorkerId } from '../src/types.js';
import { makeCheckpoint, makeRequest } from './test-helpers.js';

function makeInventory(count: number): {
  readonly artifacts: SegmentArtifact[];
  readonly segments: SegmentConfig[];
} {
  const artifacts = Array.from({ length: count }, (_, index): SegmentArtifact => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize: (index + 1) * 100,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/span/segment-${index}.onnx`,
    estimatedMemoryMB: 2_100,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  }));
  return {
    artifacts,
    segments: artifacts.map((artifact) => ({
      index: artifact.index,
      layerStart: artifact.layerStart,
      layerEnd: artifact.layerEnd,
      modelWeightHash: artifact.sha256,
      estimatedVramMB: artifact.estimatedMemoryMB,
    })),
  };
}

function successResult(
  worker: WorkerId,
  assignment: SpanAssignment,
  totalSegments: number,
): SpanResult {
  const lastSegment = assignment.segments[assignment.segments.length - 1].index;
  const isFinal = lastSegment === totalSegments - 1;
  return {
    requestId: assignment.requestId,
    startSegment: assignment.segments[0].index,
    endSegment: lastSegment,
    workerId: worker,
    checkpoint: isFinal ? undefined : makeCheckpoint(assignment.requestId, lastSegment),
    output: isFinal ? { tokens: [7], text: 'resident route' } : undefined,
    processingTimeMs: assignment.segments.length,
  };
}

describe('SpanPipeline artifact residency integration', () => {
  it('groups an adjacent cached prefix into the first span and commits later spans', async () => {
    const { artifacts, segments } = makeInventory(4);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const pool = new WorkerPool();
    const cached = workerId('cached-visitor');
    const stable = workerId('cold-stable');
    pool.register({ workerId: stable, tier: WorkerTier.TIER_1, vramMB: 4_200 });
    pool.register({ workerId: cached, tier: WorkerTier.TIER_3, vramMB: 4_200 });
    ledger.synchronizeWorker(cached, [0, 1]);

    const assignments: { readonly worker: WorkerId; readonly indexes: readonly number[] }[] = [];
    const executor: SpanExecutor = {
      execute: async (worker, assignment) => {
        assignments.push({
          worker,
          indexes: assignment.segments.map((segment) => segment.index),
        });
        return successResult(worker, assignment, segments.length);
      },
    };
    const pipeline = new SpanPipeline(
      segments,
      pool,
      new CheckpointStore(),
      executor,
      { retryDelayMs: 0, artifactResidencyLedger: ledger },
    );

    const result = await pipeline.run(makeRequest(segments.length, 0, 'residency-span'));

    expect(result.text).toBe('resident route');
    expect(assignments).toEqual([
      { worker: cached, indexes: [0, 1] },
      { worker: stable, indexes: [2, 3] },
    ]);
    expect(ledger.snapshot(cached).residentSegmentIndexes).toEqual([0, 1]);
    expect(ledger.snapshot(stable).residentSegmentIndexes).toEqual([2, 3]);
  });

  it('clears an unreachable worker cache claim before rerouting its span', async () => {
    const { artifacts, segments } = makeInventory(2);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const pool = new WorkerPool();
    const failing = workerId('cached-but-lost');
    const backup = workerId('backup');
    pool.register({ workerId: failing, tier: WorkerTier.TIER_1, vramMB: 4_200 });
    pool.register({ workerId: backup, tier: WorkerTier.TIER_2, vramMB: 4_200 });
    ledger.synchronizeWorker(failing, [0, 1]);

    let attempts = 0;
    const executor: SpanExecutor = {
      execute: async (worker, assignment) => {
        attempts++;
        if (worker === failing) {
          throw new Error('browser disconnected');
        }
        return successResult(worker, assignment, segments.length);
      },
    };
    const pipeline = new SpanPipeline(
      segments,
      pool,
      new CheckpointStore(),
      executor,
      {
        maxRetries: 1,
        retryDelayMs: 0,
        artifactResidencyLedger: ledger,
      },
    );

    const result = await pipeline.run(makeRequest(segments.length, 0, 'residency-retry'));

    expect(result.text).toBe('resident route');
    expect(attempts).toBe(2);
    expect(ledger.snapshot(failing).residentSegmentIndexes).toEqual([]);
    expect(ledger.snapshot(backup).residentSegmentIndexes).toEqual([0, 1]);
  });
});
