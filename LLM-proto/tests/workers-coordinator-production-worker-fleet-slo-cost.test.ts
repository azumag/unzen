import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport,
} from '../src/workers-coordinator-signed-runner-webgpu-worker-pilot.js';
import {
  runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry,
  type WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidencePayload,
  type WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport,
} from '../src/workers-coordinator-webgpu-worker-performance-telemetry.js';
import {
  runWorkersCoordinatorProductionWorkerFleetSloCostGate,
  type WorkersCoordinatorProductionWorkerFleetEvidence,
} from '../src/workers-coordinator-production-worker-fleet-slo-cost.js';
import {
  createSyntheticEnvelope,
  type WorkersCoordinatorSignedRunnerEvidenceProvenance,
} from './evidence-envelope-helpers.js';

function createPilotReport(
  overrides: Partial<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport> = {},
  evidence: Partial<WorkersCoordinatorSignedRunnerEvidenceProvenance> = {},
): WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport {
  const base: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport = {
    runtime: 'signed-runner-webgpu-worker-pilot',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    evidence: {
      validationStatus: 'valid',
      evidenceKind: 'signed-runner-contract',
      evidenceLevel: 'synthetic-fixture',
      readinessStatus: 'contract-tested',
      producerName: 'vitest',
      producerVersion: '4.1.7',
      runId: 'synthetic-run-1',
      capturedAt: '2026-07-10T13:00:00.000Z',
      issueCodes: [],
      ...evidence,
    },
    segmentExecution: {
      modelId: 'unzen-30b-q4-8seg-feasibility',
      segmentId: 'segment-03',
      runtime: 'webgpu-dedicated-worker',
      state: 'completed',
      layerStart: 24,
      layerEnd: 31,
      startedAtMs: 1_779_667_250_000,
      completedAtMs: 1_779_667_258_900,
      outputCheckpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
    },
    indexedDbCache: {
      backend: 'indexeddb',
      databaseName: 'unzen-model-cache',
      segmentWeightKey: 'models/unzen-30b-q4/segment-03.bin',
      cacheHit: true,
      topLevelStorageAccessed: false,
    },
    checkpointRelay: {
      owner: 'coordinator-storage',
      checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
      relayUrl: 'https://coordinator.unzen.dev/checkpoints/signed-runner-webgpu-pilot/segment-03',
      directWorkerNetworking: false,
      topLevelDomAccessed: false,
      topLevelCookieAccessed: false,
      topLevelStorageAccessed: false,
    },
    securityBoundaryDuringExecution: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/segment-metrics',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['webgpu-worker-performance-and-fallback-telemetry'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createTelemetryEvidencePayload(
  overrides: Partial<WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidencePayload> = {},
): WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidencePayload {
  return {
    runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    segmentLatencySamplesMs: [8_900, 8_720, 9_040, 8_830, 9_180],
    indexedDbCacheTiming: {
      backend: 'indexeddb',
      cacheHit: true,
      hitLoadMs: 18,
      topLevelStorageAccessed: false,
    },
    checkpointRelayTiming: {
      owner: 'coordinator-storage',
      durationMs: 42,
      retryCount: 0,
      failureReasons: [],
      directWorkerNetworking: false,
      topLevelDomAccessed: false,
      topLevelCookieAccessed: false,
      topLevelStorageAccessed: false,
    },
    webGpuDeviceLoss: {
      state: 'not-lost',
    },
    cpuFallbackRouting: {
      decision: 'not-needed',
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/workers/webgpu-telemetry/socket',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/models/unzen-30b-q4/segment-03.bin',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/segment-metrics',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
    ...overrides,
  };
}

function createFleetEvidence(
  overrides: Partial<WorkersCoordinatorProductionWorkerFleetEvidence> = {},
): WorkersCoordinatorProductionWorkerFleetEvidence {
  return {
    source: 'production-worker-fleet-slo-cost-aggregation',
    capturedAtMs: 1_779_667_620_000,
    deviceTierSlo: [
      {
        tier: 'desktop-discrete-gpu',
        sampleCount: 980,
        p95SegmentLatencyMs: 8_900,
        targetP95SegmentLatencyMs: 10_000,
      },
      {
        tier: 'desktop-integrated-gpu',
        sampleCount: 640,
        p95SegmentLatencyMs: 14_200,
        targetP95SegmentLatencyMs: 16_000,
      },
      {
        tier: 'mobile-gpu',
        sampleCount: 420,
        p95SegmentLatencyMs: 21_500,
        targetP95SegmentLatencyMs: 24_000,
      },
      {
        tier: 'cpu-fallback',
        sampleCount: 90,
        p95SegmentLatencyMs: 38_000,
        targetP95SegmentLatencyMs: 45_000,
      },
    ],
    fallbackBudget: {
      webGpuDeviceLossRate: 0.006,
      cpuFallbackRate: 0.018,
      maxWebGpuDeviceLossRate: 0.01,
      maxCpuFallbackRate: 0.03,
    },
    cacheCost: {
      currency: 'USD',
      indexedDbWarmupCostUsd: 38.42,
      hitMedianLoadMs: 19,
      missMedianLoadMs: 880,
      maxIndexedDbWarmupCostUsd: 50,
      maxMissPenaltyMs: 1_200,
    },
    checkpointRelaySpend: {
      currency: 'USD',
      coordinatorRelaySpendUsd: 74.12,
      retryRate: 0.012,
      failureRate: 0.002,
      maxCoordinatorRelaySpendUsd: 100,
      maxRetryRate: 0.02,
      maxFailureRate: 0.005,
    },
    optInImpact: {
      optedInWorkerCount: 18_400,
      eligibleWorkerCount: 40_000,
      optInRate: 0.46,
      minOptInRate: 0.35,
      estimatedPublisherRevenueLiftPct: 7.4,
      minPublisherRevenueLiftPct: 5,
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/fleet/slo-cost/socket',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/models/unzen-30b-q4/segment-03.bin',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/fleet-slo-cost',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
    ...overrides,
  };
}

async function createPassingTelemetryReport(): Promise<WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport> {
  return runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry({
    pilotReport: createPilotReport(),
    telemetryEvidenceEnvelope: createSyntheticEnvelope(createTelemetryEvidencePayload()),
    evidenceValidation: { now: '2026-07-10T14:00:00.000Z' },
  });
}

describe('Workers Coordinator production worker fleet SLO and cost gate', () => {
  it('promotes when fleet p95 latency, fallback, cost, opt-in, and signed runner boundary are within threshold', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence(),
    });

    expect(report.runtime).toBe('production-worker-fleet-slo-cost-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.deviceTierP95Latency).toEqual([
      expect.objectContaining({
        tier: 'desktop-discrete-gpu',
        p95SegmentLatencyMs: 8_900,
        targetP95SegmentLatencyMs: 10_000,
      }),
      expect.objectContaining({
        tier: 'desktop-integrated-gpu',
        p95SegmentLatencyMs: 14_200,
      }),
      expect.objectContaining({
        tier: 'mobile-gpu',
        p95SegmentLatencyMs: 21_500,
      }),
      expect.objectContaining({
        tier: 'cpu-fallback',
        p95SegmentLatencyMs: 38_000,
      }),
    ]);
    expect(report.fallbackBudget).toMatchObject({
      webGpuDeviceLossRate: 0.006,
      cpuFallbackRate: 0.018,
    });
    expect(report.cacheWarmupCost).toMatchObject({
      indexedDbWarmupCostUsd: 38.42,
      hitMedianLoadMs: 19,
      missMedianLoadMs: 880,
    });
    expect(report.checkpointRelaySpend).toMatchObject({
      coordinatorRelaySpendUsd: 74.12,
      retryRate: 0.012,
      failureRate: 0.002,
    });
    expect(report.userOptInImpact).toMatchObject({
      optInRate: 0.46,
      estimatedPublisherRevenueLiftPct: 7.4,
    });
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringFleetAggregation).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringFleetAggregation.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/fleet-slo-cost',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-and-abuse-resistant-settlement-gate']);
  });

  it('holds when a device tier p95 latency misses the fleet SLO', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence({
        deviceTierSlo: [
          {
            tier: 'mobile-gpu',
            sampleCount: 420,
            p95SegmentLatencyMs: 28_000,
            targetP95SegmentLatencyMs: 24_000,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.decision).toBe('hold');
    expect(report.failureReason).toBe('device-tier-p95-latency-over-slo: mobile-gpu');
    expect(report.bottlenecksToIssue).toEqual(['production-fleet-device-tier-slo-hardening']);
  });

  it('holds when WebGPU device loss or CPU fallback rate exceeds budget', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence({
        fallbackBudget: {
          webGpuDeviceLossRate: 0.006,
          cpuFallbackRate: 0.06,
          maxWebGpuDeviceLossRate: 0.01,
          maxCpuFallbackRate: 0.03,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('fleet-webgpu-device-loss-or-cpu-fallback-rate-over-budget');
    expect(report.bottlenecksToIssue).toEqual(['production-fleet-fallback-budget-hardening']);
  });

  it('holds when IndexedDB warmup cost or miss penalty exceeds budget', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence({
        cacheCost: {
          currency: 'USD',
          indexedDbWarmupCostUsd: 62,
          hitMedianLoadMs: 19,
          missMedianLoadMs: 1_480,
          maxIndexedDbWarmupCostUsd: 50,
          maxMissPenaltyMs: 1_200,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('fleet-cache-warmup-cost-or-miss-penalty-over-budget');
    expect(report.bottlenecksToIssue).toEqual(['production-fleet-cache-cost-hardening']);
  });

  it('holds when checkpoint relay spend or retry/failure rate exceeds budget', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence({
        checkpointRelaySpend: {
          currency: 'USD',
          coordinatorRelaySpendUsd: 140,
          retryRate: 0.012,
          failureRate: 0.002,
          maxCoordinatorRelaySpendUsd: 100,
          maxRetryRate: 0.02,
          maxFailureRate: 0.005,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('fleet-checkpoint-relay-spend-retry-or-failure-over-budget');
    expect(report.bottlenecksToIssue).toEqual(['production-fleet-checkpoint-relay-cost-hardening']);
  });

  it('holds when user opt-in impact is below production threshold', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence({
        optInImpact: {
          optedInWorkerCount: 12_000,
          eligibleWorkerCount: 40_000,
          optInRate: 0.3,
          minOptInRate: 0.35,
          estimatedPublisherRevenueLiftPct: 4.4,
          minPublisherRevenueLiftPct: 5,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('fleet-user-opt-in-impact-below-production-threshold');
    expect(report.bottlenecksToIssue).toEqual(['production-fleet-opt-in-threshold-hardening']);
  });

  it('holds when fleet aggregation leaks a non-Coordinator/CDN network attempt', async () => {
    const report = runWorkersCoordinatorProductionWorkerFleetSloCostGate({
      telemetryReport: await createPassingTelemetryReport(),
      fleetEvidence: createFleetEvidence({
        networkAttempts: [
          {
            url: 'wss://coordinator.unzen.dev/fleet/slo-cost/socket',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/fleet-slo-cost',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'fleet-slo-cost-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual([
      'production-worker-fleet-slo-cost-failure: fleet-slo-cost-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    ]);
  });
});
