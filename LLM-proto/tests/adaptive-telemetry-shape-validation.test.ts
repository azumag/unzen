import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { workerId, WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

const baseTelemetry: WorkerTelemetry = {
  uptimeMs: 2 * 60 * 60 * 1000,
  vramFreeMB: 8400,
  gpuBusyRatio: 0.01,
  cpuBusyRatio: 0.01,
  cacheHits: [0],
  tokensPerSecond: 18,
  checkpointBytesPerSecond: 8 * 1024 * 1024,
  failureRate: 0,
  heartbeatJitterMs: 25,
};

const malformedTelemetryCases: readonly [unknown, RegExp][] = [
  [null, /worker telemetry must be a non-null object/],
  [42, /worker telemetry must be a non-null object/],
  [[], /worker telemetry must be a non-null object/],
  [{ ...baseTelemetry, cacheHits: '0' }, /cacheHits must be an array/],
  [{ ...baseTelemetry, cacheHits: [Symbol('bad-cache-hit')] }, /cache hit segment must be a number/],
  [{ ...baseTelemetry, cacheHits: ['0'] }, /cache hit segment must be a number/],
  [{ ...baseTelemetry, cacheHits: [{}] }, /cache hit segment must be a number/],
  [{ ...baseTelemetry, cacheHits: [0.5] }, /cache hit segment 0\.5 is outside 0\.\.0/],
  [{ ...baseTelemetry, cacheArtifacts: {} }, /cacheArtifacts must be an array when present/],
  [{ ...baseTelemetry, cacheArtifacts: [null] }, /cacheArtifacts\[0\] must be a non-null object/],
  [{ ...baseTelemetry, cacheArtifacts: [[]] }, /cacheArtifacts\[0\] must be a non-null object/],
  [{
    ...baseTelemetry,
    cacheArtifacts: [{ segmentIndex: '0', sha256: 'a'.repeat(64) }],
  }, /cacheArtifacts\[0\]\.segmentIndex must be a number/],
  [{
    ...baseTelemetry,
    cacheArtifacts: [{ segmentIndex: 0, sha256: Symbol('bad-sha') }],
  }, /cacheArtifacts\[0\]\.sha256 must be a string/],
];

describe('AdaptiveChunkDispatcher telemetry container validation', () => {
  it.each(malformedTelemetryCases)(
    'rejects malformed telemetry before registration state is created',
    (malformedTelemetry, expectedError) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });

      expect(() => dispatcher.registerWorker({
        id: 'malformed-registration-worker',
        tier: WorkerTier.TIER_2,
        telemetry: malformedTelemetry as WorkerTelemetry,
      })).toThrow(expectedError);

      expect(() => dispatcher.run('after-malformed-registration')).toThrow(
        /No eligible adaptive worker/,
      );
    },
  );

  it.each(malformedTelemetryCases)(
    'preserves last-known-good worker state after a malformed heartbeat',
    (malformedTelemetry, expectedError) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });
      const worker = workerId('stable-shape-worker');
      dispatcher.registerWorker({
        id: worker,
        tier: WorkerTier.TIER_2,
        telemetry: baseTelemetry,
      });

      expect(() => dispatcher.updateHeartbeat(
        worker,
        malformedTelemetry as WorkerTelemetry,
      )).toThrow(expectedError);

      const report = dispatcher.run('after-malformed-heartbeat');
      expect(report.assignments).toHaveLength(1);
      expect(report.assignments[0]).toMatchObject({
        workerId: worker,
        cacheHit: true,
        loadReadings: {
          gpuBusyRatio: 0.01,
          cpuBusyRatio: 0.01,
        },
      });
      expect(Number.isFinite(report.assignments[0].scoreInputs.total)).toBe(true);
    },
  );
});
