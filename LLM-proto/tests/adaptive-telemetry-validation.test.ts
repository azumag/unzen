import { describe, expect, it } from 'vitest';
import {
  AdaptiveChunkDispatcher,
  type AdaptiveChunkDispatcherOptions,
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
    ['longLivedWorkerMs', Number.NaN],
    ['longLivedWorkerMs', Number.POSITIVE_INFINITY],
    ['longLivedWorkerMs', -1],
    ['configuredVramLimitMB', Number.NaN],
    ['configuredVramLimitMB', Number.NEGATIVE_INFINITY],
    ['configuredVramLimitMB', -1],
    ['checkpointBytes', 0],
    ['checkpointBytes', -1],
    ['checkpointBytes', Number.NaN],
    ['checkpointBytes', Number.POSITIVE_INFINITY],
  ] as const)(
    'rejects invalid dispatcher option %s=%s',
    (field, value) => {
      const options: AdaptiveChunkDispatcherOptions = {
        segments: makeSegments(1),
        [field]: value,
      };
      expect(() => new AdaptiveChunkDispatcher(options)).toThrow(new RegExp(field));
    },
  );

  it('accepts the documented dispatcher configuration boundaries', () => {
    expect(() => new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
      longLivedWorkerMs: 0,
      configuredVramLimitMB: Number.POSITIVE_INFINITY,
      checkpointBytes: 1,
    })).not.toThrow();
  });

  it.each([
    ['loadBudgetRatio', 0.5, Number.NaN],
    ['longLivedWorkerMs', 1_000, Number.NaN],
    ['configuredVramLimitMB', 4_096, -1],
    ['checkpointBytes', 1_024, 0],
  ] as const)(
    'reads explicit dispatcher option %s exactly once',
    (field, acceptedValue, alteredValue) => {
      let reads = 0;
      const options = { segments: makeSegments(1) } as AdaptiveChunkDispatcherOptions;
      Object.defineProperty(options, field, {
        enumerable: true,
        get: () => {
          reads++;
          return reads === 1 ? acceptedValue : alteredValue;
        },
      });

      expect(() => new AdaptiveChunkDispatcher(options)).not.toThrow();
      expect(reads).toBe(1);
    },
  );

  it.each([
    'loadBudgetRatio',
    'longLivedWorkerMs',
    'configuredVramLimitMB',
    'checkpointBytes',
  ] as const)(
    'reads omitted/defaulted dispatcher option %s exactly once',
    (field) => {
      let reads = 0;
      const options = { segments: makeSegments(1) } as AdaptiveChunkDispatcherOptions;
      Object.defineProperty(options, field, {
        enumerable: true,
        get: () => {
          reads++;
          return undefined;
        },
      });

      expect(() => new AdaptiveChunkDispatcher(options)).not.toThrow();
      expect(reads).toBe(1);
    },
  );

  it.each([0, 4, 99, 'tier-1'])(
    'rejects invalid worker tier %s before registration',
    (tier) => {
      const dispatcher = new AdaptiveChunkDispatcher({
        segments: makeSegments(1),
      });

      expect(() => dispatcher.registerWorker({
        id: 'invalid-tier-worker',
        tier: tier as WorkerTier,
        telemetry: baseTelemetry,
      })).toThrow(/worker tier/);

      expect(() => dispatcher.run('after-invalid-tier')).toThrow(
        /No eligible adaptive worker/,
      );
    },
  );

  it('keeps the previous worker state when an invalid tier re-registration is rejected', () => {
    const dispatcher = new AdaptiveChunkDispatcher({
      segments: makeSegments(1),
    });
    dispatcher.registerWorker({
      id: 'stable-tier-worker',
      tier: WorkerTier.TIER_2,
      telemetry: baseTelemetry,
    });

    expect(() => dispatcher.registerWorker({
      id: 'stable-tier-worker',
      tier: 99 as WorkerTier,
      telemetry: {
        ...baseTelemetry,
        gpuBusyRatio: 0.99,
        cacheHits: [],
      },
    })).toThrow(/worker tier/);

    const report = dispatcher.run('after-invalid-tier-reregistration');
    expect(report.assignments).toHaveLength(1);
    expect(report.assignments[0]).toMatchObject({
      workerId: 'stable-tier-worker',
      tier: WorkerTier.TIER_2,
      cacheHit: true,
      loadReadings: {
        gpuBusyRatio: 0.01,
        cpuBusyRatio: 0.01,
      },
    });
  });

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