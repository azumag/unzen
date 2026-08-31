import { describe, expect, it } from 'vitest';
import { AdaptiveChunkDispatcher, type WorkerTelemetry } from '../src/adaptive-chunk-dispatcher.js';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId, WorkerTier, type SegmentConfig } from '../src/types.js';

const telemetry: WorkerTelemetry = {
  uptimeMs: 60 * 60 * 1000,
  vramFreeMB: 4_000,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [],
  tokensPerSecond: 12,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 20,
};

function bundleArtifact(
  externalLocator = 'https://cdn.unzen.local/models/test/segment0.onnx_data',
): SegmentArtifact {
  return {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize: 300,
    sha256: 'a'.repeat(64),
    contentType: 'application/vnd.unzen.onnx-segment-bundle',
    artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx',
    estimatedMemoryMB: 512,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
    components: [
      {
        role: 'graph',
        path: 'segment0.onnx',
        byteSize: 100,
        sha256: '1'.repeat(64),
        contentType: 'application/onnx',
        artifactLocator: 'https://cdn.unzen.local/models/test/segment0.onnx',
      },
      {
        role: 'external-data',
        path: 'segment0.onnx_data',
        byteSize: 200,
        sha256: '2'.repeat(64),
        contentType: 'application/octet-stream',
        artifactLocator: externalLocator,
      },
    ],
  };
}

function segmentConfig(artifact: SegmentArtifact): SegmentConfig {
  return {
    index: artifact.index,
    layerStart: artifact.layerStart,
    layerEnd: artifact.layerEnd,
    modelWeightHash: artifact.sha256,
    estimatedVramMB: artifact.estimatedMemoryMB,
  };
}

describe('AdaptiveChunkDispatcher multi-file artifacts', () => {
  it('fetches every missing component before marking the logical segment resident', () => {
    const artifact = bundleArtifact();
    const ledger = new ArtifactResidencyLedger([artifact]);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: [segmentConfig(artifact)],
      artifactResidencyLedger: ledger,
    });
    const worker = workerId('bundle-worker');
    dispatcher.registerWorker({ id: worker, tier: WorkerTier.TIER_2, telemetry });

    const cold = dispatcher.run('bundle-cold');
    expect(cold.transport.connections).toEqual([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
      'https://cdn.unzen.local',
    ]);
    expect(cold.assignments[0].artifactResidency).toMatchObject({
      totalArtifactBytes: 300,
      downloadedArtifactBytes: 300,
      missingSegmentIndexes: [0],
    });
    expect(ledger.isResident(worker, 0)).toBe(true);

    const warm = dispatcher.run('bundle-warm');
    expect(warm.transport.connections).toEqual(['https://coordinator.unzen.local']);
    expect(warm.assignments[0].cacheHit).toBe(true);
  });

  it('does not mark a bundle resident when a later component origin is rejected', () => {
    const artifact = bundleArtifact(
      'https://outside.example/models/test/segment0.onnx_data',
    );
    const ledger = new ArtifactResidencyLedger([artifact]);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: [segmentConfig(artifact)],
      artifactResidencyLedger: ledger,
    });
    const worker = workerId('rejected-bundle-worker');
    dispatcher.registerWorker({ id: worker, tier: WorkerTier.TIER_2, telemetry });

    expect(() => dispatcher.run('bundle-rejected')).toThrow(/outside prototype allowlist/);
    expect(ledger.isResident(worker, 0)).toBe(false);
  });
});
