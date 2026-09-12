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

describe('AdaptiveChunkDispatcher telemetry validation', () => {
  it.each([0, -0.01, Number.NaN, Number.POSITIVE_INFINITY, 1.01])(
    'rejects invalid loadBudgetRatio %s at construction',
    (loadBudgetRatio) => {
      expect(() => new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
        loadBudgetRatio,
      })).toThrow(/loadBudgetRatio/);
    },
  );

  it.each([
    ['uptimeMs', Number.NaN],
    ['uptimeMs', Number.POSITIVE_INFINITY],
    ['uptimeMs', -1],
    ['vramFreeMB', Number.NaN],
    ['vramFreeMB', Number.POSITIVE_INFINITY],
    ['vramFreeMB', -1],
    ['gpuBusyRatio', Number.NaN],
    ['gpuBusyRatio', Number.POSITIVE_INFINITY],
    ['gpuBusyRatio', -0.01],
    ['gpuBusyRatio', 1.01],
    ['cpuBusyRatio', Number.NaN],
    ['cpuBusyRatio', -0.01],
    ['cpuBusyRatio', 1.01],
    ['tokensPerSecond', Number.NaN],
    ['tokensPerSecond', Number.POSITIVE_INFINITY],
    ['tokensPerSecond', -1],
    ['checkpointBytesPerSecond', Number.NaN],
    ['checkpointBytesPerSecond', Number.POSITIVE_INFINITY],
    ['checkpointBytesPerSecond', -1],
    ['failureRate', Number.NaN],
    ['failureRate', Number.POSITIVE_INFINITY],
    ['failureRate', -0.01],
    ['failureRate', 1.01],
    ['heartbeatJitterMs', Number.NaN],
    ['heartbeatJitterMs', Number.POSITIVE_INFINITY],
    ['heartbeatJitterMs', -1],
  ] as const)(
    'rejects invalid %s telemetry before registration',
    (field, value) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });
      const telemetry = {
        ...baseTelemetry,
        [field]: value,
      } as WorkerTelemetry;

      expect(() => dispatcher.registerWorker({
        id: `invalid-${field}`,
        tier: WorkerTier.TIER_2,
        telemetry,
      })).toThrow(new RegExp(field));

      expect(() => dispatcher.run(`invalid-${field}`)).toThrow(
        /No eligible adaptive worker/,
      );
    },
  );

  it('keeps the last known-good telemetry and cache state after an invalid heartbeat', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    });
    dispatcher.registerWorker({
      id: 'stable-worker',
      tier: WorkerTier.TIER_2,
      telemetry: baseTelemetry,
    });

    expect(() => dispatcher.updateHeartbeat(workerId('stable-worker'), {
      ...baseTelemetry,
      gpuBusyRatio: Number.NaN,
      cacheHits: [],
    })).toThrow(/gpuBusyRatio/);

    const report = dispatcher.run('after-invalid-heartbeat');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({
      workerId: 'stable-worker',
      cacheHit: true,
      loadReadings: {
        gpuBusyRatio: 0.01,
        cpuBusyRatio: 0.01,
      },
    });
    expect(Number.isFinite(report.assignments[0].scoreInputs.total)).toBe(true);
  });

  it('accepts finite boundary values and preserves scheduling semantics', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
      loadBudgetRatio: 1,
    });
    dispatcher.registerWorker({
      id: 'boundary-worker',
      tier: WorkerTier.TIER_2,
      telemetry: {
        ...baseTelemetry,
        uptimeMs: 0,
        vramFreeMB: 2100,
        gpuBusyRatio: 0,
        cpuBusyRatio: 0,
        tokensPerSecond: 0,
        checkpointBytesPerSecond: 0,
        failureRate: 0,
        heartbeatJitterMs: 0,
      },
    });

    const report = dispatcher.run('valid-boundaries');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0].workerId).toBe('boundary-worker');
    expect(report.assignments[0].checkpointTransferMs).toBe(Number.POSITIVE_INFINITY);
  });
});