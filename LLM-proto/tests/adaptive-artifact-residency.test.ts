import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type CachedArtifactIdentity,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { AllowlistedPrototypeTransport } from '../src/two-worker-prototype.js';
import { workerId, WorkerTier, type SegmentConfig } from '../src/types.js';

function makeInventory(
  byteSizes: readonly number[],
  vramSizes: readonly number[] = byteSizes.map(() => 100),
): { readonly artifacts: SegmentArtifact[]; readonly segments: SegmentConfig[] } {
  const artifacts = byteSizes.map((byteSize, index): SegmentArtifact => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/residency/segment-${index}.onnx`,
    estimatedMemoryMB: vramSizes[index],
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

function cacheIdentity(artifact: SegmentArtifact): CachedArtifactIdentity {
  return {
    segmentIndex: artifact.index,
    sha256: artifact.sha256,
  };
}

const baseTelemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 8_000,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

describe('AdaptiveChunkDispatcher artifact residency', () => {
  it('reports exact bytes, fetches only missing artifacts and reuses them on the next run', () => {
    const { artifacts, segments } = makeInventory([100, 200, 300, 400]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      artifactResidencyLedger: ledger,
      transport,
    });
    dispatcher.registerWorker({
      id: 'resident-worker',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0, 1],
        cacheArtifacts: [cacheIdentity(artifacts[0]), cacheIdentity(artifacts[1])],
      },
    });

    const cold = dispatcher.run('artifact-cold');
    expect(cold.assignments).toHaveLength(1);
    expect(cold.assignments[0]).toMatchObject({
      startSegment: 0,
      endSegment: 3,
      cacheHit: false,
      artifactResidency: {
        totalArtifactBytes: 1_000,
        residentArtifactBytesBeforeAssignment: 300,
        downloadedArtifactBytes: 700,
        missingSegmentIndexes: [2, 3],
      },
    });
    expect(cold.transport.connections).toEqual([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
      'https://cdn.unzen.local',
    ]);
    expect(ledger.snapshot(workerId('resident-worker')).residentSegmentIndexes).toEqual([
      0, 1, 2, 3,
    ]);

    const warm = dispatcher.run('artifact-warm');
    expect(warm.assignments[0]).toMatchObject({
      cacheHit: true,
      artifactResidency: {
        totalArtifactBytes: 1_000,
        residentArtifactBytesBeforeAssignment: 1_000,
        downloadedArtifactBytes: 0,
        missingSegmentIndexes: [],
      },
    });
    expect(warm.transport.connections).toEqual(['https://coordinator.unzen.local']);
  });

  it('does not commit partial residency when a later artifact locator is rejected', () => {
    const inventory = makeInventory([100, 200]);
    const artifacts = [
      inventory.artifacts[0],
      {
        ...inventory.artifacts[1],
        artifactLocator: 'https://outside.example/models/segment-1.onnx',
      },
    ];
    const ledger = new ArtifactResidencyLedger(artifacts);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: inventory.segments,
      artifactResidencyLedger: ledger,
    });
    const worker = workerId('atomic-worker');
    dispatcher.registerWorker({
      id: worker,
      tier: WorkerTier.TIER_2,
      telemetry: baseTelemetry,
    });

    expect(() => dispatcher.run('rejected-origin')).toThrow(/outside prototype allowlist/);
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([]);
  });

  it('removes stale cache entries when a heartbeat no longer advertises them', () => {
    const { artifacts, segments } = makeInventory([100, 200]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      artifactResidencyLedger: ledger,
    });
    const worker = workerId('heartbeat-worker');
    dispatcher.registerWorker({
      id: worker,
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0, 1],
        cacheArtifacts: [cacheIdentity(artifacts[0]), cacheIdentity(artifacts[1])],
      },
    });

    dispatcher.updateHeartbeat(worker, { ...baseTelemetry, cacheHits: [] });
    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([]);

    const report = dispatcher.run('heartbeat-eviction');
    expect(report.assignments[0].artifactResidency).toMatchObject({
      residentArtifactBytesBeforeAssignment: 0,
      downloadedArtifactBytes: 300,
      missingSegmentIndexes: [0, 1],
    });
  });

  it('requires exact artifact identities for manifest-backed cache hits', () => {
    const { artifacts, segments } = makeInventory([100, 200]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      artifactResidencyLedger: ledger,
    });

    expect(() => dispatcher.registerWorker({
      id: 'unbound-cache-worker',
      tier: WorkerTier.TIER_2,
      telemetry: { ...baseTelemetry, cacheHits: [0] },
    })).toThrow(/one cacheArtifacts identity per segment index/);

    expect(ledger.snapshot(workerId('unbound-cache-worker')).residentSegmentIndexes).toEqual([]);
  });

  it('rejects a stale same-index digest without replacing the previous residency snapshot', () => {
    const { artifacts, segments } = makeInventory([100, 200]);
    const ledger = new ArtifactResidencyLedger(artifacts);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      artifactResidencyLedger: ledger,
    });
    const worker = workerId('revision-bound-worker');
    dispatcher.registerWorker({
      id: worker,
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0],
        cacheArtifacts: [cacheIdentity(artifacts[0])],
      },
    });

    expect(() => dispatcher.updateHeartbeat(worker, {
      ...baseTelemetry,
      cacheHits: [0, 1],
      cacheArtifacts: [
        cacheIdentity(artifacts[0]),
        { segmentIndex: 1, sha256: 'f'.repeat(64) },
      ],
    })).toThrow(/does not match active manifest/);

    expect(ledger.snapshot(worker).residentSegmentIndexes).toEqual([0]);
    const report = dispatcher.run('stale-revision-rejected');
    expect(report.assignments[0].artifactResidency).toMatchObject({
      residentArtifactBytesBeforeAssignment: 100,
      downloadedArtifactBytes: 200,
      missingSegmentIndexes: [1],
    });
  });

  it('computes contiguous chunk capacity from unequal segment VRAM estimates', () => {
    const { artifacts, segments } = makeInventory(
      [100, 200, 300],
      [1_000, 3_000, 1_000],
    );
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      artifactResidencyLedger: new ArtifactResidencyLedger(artifacts),
      configuredVramLimitMB: 4_000,
    });
    dispatcher.registerWorker({
      id: 'variable-vram-worker',
      tier: WorkerTier.TIER_2,
      telemetry: { ...baseTelemetry, vramFreeMB: 4_000 },
    });

    const report = dispatcher.run('variable-vram');
    expect(report.assignments.map((assignment) => assignment.selectedChunkLength)).toEqual([2, 1]);
    expect(report.assignments.map((assignment) => [
      assignment.startSegment,
      assignment.endSegment,
    ])).toEqual([[0, 1], [2, 2]]);
  });

  it('fails closed when the artifact inventory does not match execution segments', () => {
    const inventory = makeInventory([100, 200]);
    const mismatchedSegments = inventory.segments.map((segment, index) =>
      index === 1 ? { ...segment, modelWeightHash: 'f'.repeat(64) } : segment,
    );

    expect(() => new AdaptiveChunkDispatcher({
      segments: mismatchedSegments,
      artifactResidencyLedger: new ArtifactResidencyLedger(inventory.artifacts),
    })).toThrow(/hash does not match/);
  });
});
