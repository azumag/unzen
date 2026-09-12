import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

const stableTelemetry: WorkerTelemetry = {
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

describe('AdaptiveChunkDispatcher segment configuration ownership', () => {
  it('keeps validated routing geometry after caller-owned segments are mutated', () => {
    const segments = makeSegments(2);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments,
      configuredVramLimitMB: 4200,
    });

    (segments[0] as { estimatedVramMB: number }).estimatedVramMB = Number.NaN;
    segments.push({
      index: 2,
      layerStart: 16,
      layerEnd: 23,
      modelWeightHash: 'sha256:late-segment',
      estimatedVramMB: 2100,
    });

    dispatcher.registerWorker({
      id: 'snapshot-worker',
      tier: WorkerTier.TIER_2,
      telemetry: stableTelemetry,
    });

    const report = dispatcher.run('snapshot-routing');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({
      startSegment: 0,
      endSegment: 1,
      selectedChunkLength: 2,
    });
  });

  it('uses the validated snapshot for cache-hit range validation', () => {
    const segments = makeSegments(2);
    const dispatcher = new AdaptiveChunkDispatcher({ segments });

    segments.push({
      index: 2,
      layerStart: 16,
      layerEnd: 23,
      modelWeightHash: 'sha256:late-segment',
      estimatedVramMB: 2100,
    });

    expect(() => dispatcher.registerWorker({
      id: 'late-cache-worker',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...stableTelemetry,
        cacheHits: [2],
      },
    })).toThrow(/outside 0\.\.1/);
  });
});
