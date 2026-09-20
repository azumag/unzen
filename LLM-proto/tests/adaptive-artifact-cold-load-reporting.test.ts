import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { WorkerTier, type SegmentConfig } from '../src/types.js';

function makeInventory(): {
  readonly artifacts: SegmentArtifact[];
  readonly segments: SegmentConfig[];
} {
  const byteSizes = [100, 200, 300, 400] as const;
  const artifacts = byteSizes.map((byteSize, index): SegmentArtifact => ({
    index,
    layerStart: index * 4,
    layerEnd: index * 4 + 3,
    byteSize,
    sha256: (index + 1).toString(16).padStart(64, '0'),
    contentType: 'application/onnx',
    artifactLocator: `https://cdn.unzen.local/models/cold-load/segment-${index}.onnx`,
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

const telemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 4_200,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

describe('AdaptiveChunkDispatcher manifest-backed cold-load reporting', () => {
  it('reports a rolling assignment as cold when it still downloads artifacts', () => {
    const { artifacts, segments } = makeInventory();
    const ledger = new ArtifactResidencyLedger(artifacts);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      artifactResidencyLedger: ledger,
      configuredVramLimitMB: 4_200,
    });
    dispatcher.registerWorker({
      id: 'rolling-cache-worker',
      tier: WorkerTier.TIER_2,
      telemetry,
    });

    const cold = dispatcher.run('manifest-cold-rolling');

    expect(cold.assignments).toHaveLength(2);
    expect(cold.assignments[0]).toMatchObject({
      startSegment: 0,
      endSegment: 1,
      rollingConsecutive: false,
      cacheHit: false,
      coldLoad: true,
      artifactResidency: {
        downloadedArtifactBytes: 300,
        missingSegmentIndexes: [0, 1],
      },
    });
    expect(cold.assignments[1]).toMatchObject({
      startSegment: 2,
      endSegment: 3,
      rollingConsecutive: true,
      cacheHit: false,
      coldLoad: true,
      artifactResidency: {
        downloadedArtifactBytes: 700,
        missingSegmentIndexes: [2, 3],
      },
    });

    const warm = dispatcher.run('manifest-warm-rolling');

    expect(warm.assignments).toHaveLength(2);
    expect(warm.assignments[0]).toMatchObject({
      cacheHit: true,
      coldLoad: false,
      artifactResidency: {
        downloadedArtifactBytes: 0,
        missingSegmentIndexes: [],
      },
    });
    expect(warm.assignments[1]).toMatchObject({
      rollingConsecutive: true,
      cacheHit: true,
      coldLoad: false,
      artifactResidency: {
        downloadedArtifactBytes: 0,
        missingSegmentIndexes: [],
      },
    });
  });
});
