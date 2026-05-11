import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type WorkerTelemetry,
} from '../src/adaptive-chunk-dispatcher.js';
import { AllowlistedPrototypeTransport } from '../src/two-worker-prototype.js';
import { WorkerTier } from '../src/types.js';
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

describe('AdaptiveChunkDispatcher', () => {
  it('computes adaptive chunk length and emits score inputs in the run report', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(4),
    });
    dispatcher.registerWorker({
      id: 'stable-t2',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        cacheHits: [0, 1, 2, 3],
      },
    });
    dispatcher.registerWorker({
      id: 'small-t3',
      tier: WorkerTier.TIER_3,
      telemetry: {
        ...baseTelemetry,
        uptimeMs: 60_000,
        vramFreeMB: 2100,
        tokensPerSecond: 7,
      },
    });

    const report = dispatcher.run('adaptive-score');

    expect(report.assignments[0]).toMatchObject({
      workerId: 'stable-t2',
      startSegment: 0,
      endSegment: 3,
      selectedChunkLength: 4,
      cacheHit: true,
      retryCount: 0,
      loadReadings: {
        gpuBusyRatio: 0.01,
        cpuBusyRatio: 0.01,
      },
    });
    expect(report.assignments[0].scoreInputs.capacityScore).toBeGreaterThan(0);
    expect(report.assignments[0].scoreInputs.cacheScore).toBeGreaterThan(0);
    expect(report.assignments[0].checkpointTransferMs).toBe(500);
  });

  it('lets a long-lived worker continue with a contiguous rolling chunk without a cold reload', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(4),
      configuredVramLimitMB: 4200,
    });
    dispatcher.registerWorker({
      id: 'long-lived',
      tier: WorkerTier.TIER_2,
      telemetry: baseTelemetry,
    });
    dispatcher.registerWorker({
      id: 'backup',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        tokensPerSecond: 4,
      },
    });

    const report = dispatcher.run('adaptive-rolling');

    expect(report.assignments).toHaveLength(2);
    expect(report.assignments.map((assignment) => assignment.workerId)).toEqual([
      'long-lived',
      'long-lived',
    ]);
    expect(report.assignments.map((assignment) => assignment.selectedChunkLength)).toEqual([2, 2]);
    expect(report.assignments[0].coldLoad).toBe(true);
    expect(report.assignments[1].rollingConsecutive).toBe(true);
    expect(report.assignments[1].coldLoad).toBe(false);
  });

  it('throttles a near-budget worker to a smaller chunk and skips an over-budget worker', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(4),
      configuredVramLimitMB: 8400,
    });
    dispatcher.registerWorker({
      id: 'over-budget',
      tier: WorkerTier.TIER_1,
      telemetry: {
        ...baseTelemetry,
        gpuBusyRatio: 0.05,
        cpuBusyRatio: 0.01,
        tokensPerSecond: 50,
      },
    });
    dispatcher.registerWorker({
      id: 'near-budget',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        gpuBusyRatio: 0.024,
        cpuBusyRatio: 0.01,
      },
    });

    const report = dispatcher.run('adaptive-throttle');

    expect(report.assignments[0]).toMatchObject({
      workerId: 'near-budget',
      startSegment: 0,
      endSegment: 1,
      selectedChunkLength: 2,
    });
    expect(report.assignments).toHaveLength(2);
    expect(report.assignments.every((assignment) => assignment.workerId === 'near-budget')).toBe(
      true,
    );
    expect(report.skippedWorkers).toEqual([
      {
        workerId: 'over-budget',
        reason: 'load-budget-exceeded',
        loadReadings: {
          gpuBusyRatio: 0.05,
          cpuBusyRatio: 0.01,
        },
      },
    ]);
    expect(report.assignments[0].scoreInputs.loadPenalty).toBeGreaterThan(0);
  });

  it('prevents short-lived Tier 3 workers from receiving rolling consecutive assignments', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(2),
    });
    dispatcher.registerWorker({
      id: 'visitor-a',
      tier: WorkerTier.TIER_3,
      telemetry: {
        ...baseTelemetry,
        uptimeMs: 90_000,
        vramFreeMB: 4200,
        tokensPerSecond: 20,
      },
    });
    dispatcher.registerWorker({
      id: 'visitor-b',
      tier: WorkerTier.TIER_3,
      telemetry: {
        ...baseTelemetry,
        uptimeMs: 120_000,
        vramFreeMB: 4200,
        tokensPerSecond: 12,
      },
    });

    const report = dispatcher.run('adaptive-tier3');

    expect(report.assignments).toHaveLength(2);
    expect(report.assignments[0].workerId).toBe('visitor-a');
    expect(report.assignments[1].workerId).toBe('visitor-b');
    expect(report.assignments.every((assignment) => assignment.selectedChunkLength === 1)).toBe(
      true,
    );
    expect(report.assignments.every((assignment) => assignment.rollingConsecutive === false)).toBe(
      true,
    );
  });

  it('keeps adaptive scheduling inside Coordinator and CDN transport allowlists', () => {
    const transport = new AllowlistedPrototypeTransport([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]);
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(2),
      transport,
    });
    dispatcher.registerWorker({
      id: 'network-safe',
      tier: WorkerTier.TIER_2,
      telemetry: baseTelemetry,
    });

    const report = dispatcher.run('adaptive-network');

    expect(new Set(report.transport.connections)).toEqual(new Set([
      'https://coordinator.unzen.local',
      'https://cdn.unzen.local',
    ]));
    expect(() => transport.connect('https://worker-peer.example/direct')).toThrow(
      /outside prototype allowlist/,
    );
  });

  it('uses custom Coordinator and CDN origins in the default transport allowlist', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
      coordinatorUrl: 'https://custom-coordinator.unzen.local',
      cdnUrl: 'https://custom-cdn.unzen.local',
    });
    dispatcher.registerWorker({
      id: 'custom-origin-worker',
      tier: WorkerTier.TIER_2,
      telemetry: baseTelemetry,
    });

    const report = dispatcher.run('adaptive-custom-origin');

    expect(report.transport.allowlist).toEqual([
      'https://custom-coordinator.unzen.local',
      'https://custom-cdn.unzen.local',
    ]);
    expect(new Set(report.transport.connections)).toEqual(new Set([
      'https://custom-coordinator.unzen.local',
      'https://custom-cdn.unzen.local',
    ]));
  });
});
