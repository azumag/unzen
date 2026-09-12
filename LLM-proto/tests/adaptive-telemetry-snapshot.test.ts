import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

function mutableTelemetry(): WorkerTelemetry & { cacheHits: number[] } {
  return {
    uptimeMs: 2 * 60 * 60 * 1000,
    vramFreeMB: 4200,
    gpuBusyRatio: 0.01,
    cpuBusyRatio: 0.01,
    cacheHits: [],
    tokensPerSecond: 18,
    checkpointBytesPerSecond: 8 * 1024 * 1024,
    failureRate: 0,
    heartbeatJitterMs: 25,
  };
}

describe('AdaptiveChunkDispatcher worker telemetry ownership', () => {
  it('isolates accepted registration telemetry from later caller mutation', () => {
    const dispatcher = new AdaptiveChunkDispatcher({ segments: makeSegments(1) });
    const telemetry = mutableTelemetry();

    dispatcher.registerWorker({
      id: 'registration-snapshot-worker',
      tier: WorkerTier.TIER_2,
      telemetry,
    });

    const mutable = telemetry as WorkerTelemetry & {
      vramFreeMB: number;
      gpuBusyRatio: number;
      failureRate: number;
      cacheHits: number[];
    };
    mutable.vramFreeMB = Number.NaN;
    mutable.gpuBusyRatio = 1;
    mutable.failureRate = 1;
    mutable.cacheHits.push(0);

    const report = dispatcher.run('registration-snapshot');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0].loadReadings.gpuBusyRatio).toBe(0.01);
    expect(report.assignments[0].cacheHit).toBe(false);
  });

  it('isolates accepted heartbeat telemetry from later caller mutation', () => {
    const dispatcher = new AdaptiveChunkDispatcher({ segments: makeSegments(1) });
    dispatcher.registerWorker({
      id: 'heartbeat-snapshot-worker',
      tier: WorkerTier.TIER_2,
      telemetry: mutableTelemetry(),
    });

    const heartbeat = mutableTelemetry();
    dispatcher.updateHeartbeat('heartbeat-snapshot-worker' as never, heartbeat);

    const mutable = heartbeat as WorkerTelemetry & {
      vramFreeMB: number;
      cpuBusyRatio: number;
      failureRate: number;
      cacheHits: number[];
    };
    mutable.vramFreeMB = Number.NaN;
    mutable.cpuBusyRatio = 1;
    mutable.failureRate = 1;
    mutable.cacheHits.push(0);

    const report = dispatcher.run('heartbeat-snapshot');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0].loadReadings.cpuBusyRatio).toBe(0.01);
    expect(report.assignments[0].cacheHit).toBe(false);
  });
});
