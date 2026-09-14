import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type AdaptiveWorkerRegistration,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import type { SegmentArtifact } from '../src/model-manifest.js';
import { workerId, WorkerTier, type SegmentConfig } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

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
    sha256: 'a'.repeat(64),
    contentType: 'application/onnx',
    artifactLocator: 'https://cdn.unzen.local/models/registration/segment-0.onnx',
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

describe('AdaptiveChunkDispatcher worker registration runtime envelope', () => {
  it.each([
    null,
    undefined,
    42,
    'worker',
    [],
    () => undefined,
    Symbol('registration'),
  ])('rejects malformed top-level registration before worker state is created', (registration) => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    });

    expect(() => dispatcher.registerWorker(
      registration as unknown as AdaptiveWorkerRegistration,
    )).toThrow(/adaptive worker registration must be a non-null object/);

    expect(() => dispatcher.run('after-malformed-registration')).toThrow(
      /No eligible adaptive worker/,
    );
  });

  it.each(['', '   ', 42, null, {}, [], Symbol('worker-id')])(
    'preserves workerId runtime validation for malformed registration IDs',
    (id) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });

      expect(() => dispatcher.registerWorker({
        id,
        tier: WorkerTier.TIER_2,
        telemetry: baseTelemetry,
      } as unknown as AdaptiveWorkerRegistration)).toThrow(
        /workerId must be a non-empty string/,
      );

      expect(() => dispatcher.run('after-malformed-id')).toThrow(
        /No eligible adaptive worker/,
      );
    },
  );

  it('captures tier once and stores the same validated tier', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    });
    let tierReads = 0;
    const registration = Object.defineProperty({
      id: 'single-read-tier-worker',
      telemetry: baseTelemetry,
    }, 'tier', {
      configurable: true,
      get() {
        tierReads += 1;
        return tierReads === 1 ? WorkerTier.TIER_2 : 99;
      },
    });

    expect(() => dispatcher.registerWorker(
      registration as unknown as AdaptiveWorkerRegistration,
    )).not.toThrow();
    expect(tierReads).toBe(1);

    const report = dispatcher.run('after-single-read-tier-registration');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0].tier).toBe(WorkerTier.TIER_2);
  });

  it('rejects an invalid tier before replacing worker or manifest-backed residency state', () => {
    const { artifact, segment } = manifestBackedFixture();
    const ledger = new ArtifactResidencyLedger([artifact]);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: [segment],
      artifactResidencyLedger: ledger,
    });
    const stableWorker = workerId('stable-registration-worker');
    dispatcher.registerWorker({
      id: stableWorker,
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0],
        cacheArtifacts: [{ segmentIndex: 0, sha256: artifact.sha256 }],
      },
    });

    expect(() => dispatcher.registerWorker({
      id: stableWorker,
      tier: 99 as WorkerTier,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [],
      },
    })).toThrow(/worker tier must be one of 1, 2, or 3/);

    expect(ledger.snapshot(stableWorker).residentSegmentIndexes).toEqual([0]);
    const report = dispatcher.run('after-rejected-reregistration');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({
      workerId: stableWorker,
      tier: WorkerTier.TIER_2,
      cacheHit: true,
      loadReadings: {
        gpuBusyRatio: 0.01,
        cpuBusyRatio: 0.01,
      },
    });
  });
});
