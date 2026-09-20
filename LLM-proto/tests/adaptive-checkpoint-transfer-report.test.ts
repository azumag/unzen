import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

const zeroCheckpointThroughputTelemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 2_100,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 0,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

describe('AdaptiveChunkDispatcher checkpoint transfer reporting', () => {
  it('keeps rolling same-worker boundaries at zero bytes and zero transfer time', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(2),
      configuredVramLimitMB: 2_100,
    });
    dispatcher.registerWorker({
      id: 'rolling-zero-throughput',
      tier: WorkerTier.TIER_2,
      telemetry: zeroCheckpointThroughputTelemetry,
    });

    const report = dispatcher.run('checkpoint-transfer-rolling');

    expect(report.assignments).toHaveLength(2);
    expect(report.assignments[0]).toMatchObject({
      startSegment: 0,
      endSegment: 0,
      rollingConsecutive: false,
      checkpointTransferBytes: 0,
      checkpointTransferMs: 0,
    });
    expect(report.assignments[1]).toMatchObject({
      startSegment: 1,
      endSegment: 1,
      workerId: 'rolling-zero-throughput',
      rollingConsecutive: true,
      checkpointTransferBytes: 0,
      checkpointTransferMs: 0,
    });
  });

  it('uses infinity only when a real cross-worker boundary has zero throughput', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(2),
      configuredVramLimitMB: 2_100,
    });
    dispatcher.registerWorker({
      id: 'visitor-a',
      tier: WorkerTier.TIER_3,
      telemetry: zeroCheckpointThroughputTelemetry,
    });
    dispatcher.registerWorker({
      id: 'visitor-b',
      tier: WorkerTier.TIER_3,
      telemetry: zeroCheckpointThroughputTelemetry,
    });

    const report = dispatcher.run('checkpoint-transfer-cross-worker');

    expect(report.assignments).toHaveLength(2);
    expect(report.assignments[0]).toMatchObject({
      workerId: 'visitor-a',
      startSegment: 0,
      endSegment: 0,
      checkpointTransferBytes: 0,
      checkpointTransferMs: 0,
    });
    expect(report.assignments[1]).toMatchObject({
      workerId: 'visitor-b',
      startSegment: 1,
      endSegment: 1,
      rollingConsecutive: false,
      checkpointTransferBytes: 4 * 1024 * 1024,
      checkpointTransferMs: Number.POSITIVE_INFINITY,
    });
  });
});