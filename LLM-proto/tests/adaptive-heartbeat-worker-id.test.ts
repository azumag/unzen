import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId, WorkerTier, type SegmentConfig, type WorkerId } from '../src/types.js';

const baseTelemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 8400,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

function manifestBackedFixture(): {
  readonly artifact: SegmentArtifact;
  readonly segment: SegmentConfig;
} {
  const artifact: SegmentArtifact = {
    index: 0,
    layerStart: 0,
    layerEnd: 3,
    byteSize: 128,
    sha256: 'b'.repeat(64),
    contentType: 'application/onnx',
    artifactLocator: 'https://cdn.unzen.local/models/heartbeat/segment-0.onnx',
    estimatedMemoryMB: 100,
    memoryBasis: 'measured',
    compatibleRuntimes: ['onnxruntime-web'],
    minimumRuntimeVersion: '1.20.0',
  };
  return {
    artifact,
    segment: {
      index: artifact.index,
      layerStart: artifact.layerStart,
      layerEnd: artifact.layerEnd,
      modelWeightHash: artifact.sha256,
      estimatedVramMB: artifact.estimatedMemoryMB,
    },
  };
}

describe('AdaptiveChunkDispatcher heartbeat worker-ID runtime boundary', () => {
  it('rejects malformed worker IDs before telemetry or cache-residency mutation', () => {
    const { artifact, segment } = manifestBackedFixture();
    const ledger = new ArtifactResidencyLedger([artifact]);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: [segment],
      artifactResidencyLedger: ledger,
    });
    const stableWorker = workerId('stable-heartbeat-worker');
    dispatcher.registerWorker({
      id: stableWorker,
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0],
        cacheArtifacts: [{ segmentIndex: 0, sha256: artifact.sha256 }],
      },
    });

    const malformedIds: readonly unknown[] = [
      '',
      '   ',
      42,
      null,
      {},
      [],
      Symbol('heartbeat-worker'),
    ];
    for (const malformedId of malformedIds) {
      expect(() => dispatcher.updateHeartbeat(
        malformedId as WorkerId,
        {
          ...baseTelemetry,
          gpuBusyRatio: 0.9,
          cacheHits: [],
        },
      )).toThrow(/workerId must be a non-empty string/);
      expect(ledger.snapshot(stableWorker).residentSegmentIndexes).toEqual([0]);
    }

    const report = dispatcher.run('after-rejected-heartbeats');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({
      workerId: stableWorker,
      cacheHit: true,
      loadReadings: {
        gpuBusyRatio: 0.01,
        cpuBusyRatio: 0.01,
      },
    });
  });

  it('preserves the existing unknown-worker diagnostic for a valid worker ID', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: [{
        index: 0,
        layerStart: 0,
        layerEnd: 3,
        modelWeightHash: 'sha256:heartbeat-segment-0',
        estimatedVramMB: 100,
      }],
    });

    expect(() => dispatcher.updateHeartbeat(
      workerId('unknown-heartbeat-worker'),
      null as unknown as WorkerTelemetry,
    )).toThrow('Unknown adaptive worker: unknown-heartbeat-worker');
  });
});
