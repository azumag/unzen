import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorDeployedSmokeReport,
} from '../src/workers-coordinator-deployed-smoke.js';
import {
  runWorkersCoordinatorProductionObservabilityCanaryGate,
  type WorkersCoordinatorCanaryState,
  type WorkersCoordinatorProductionGateThresholds,
} from '../src/workers-coordinator-production-observability-canary.js';
import { WorkerTier } from '../src/types.js';

const thresholds: WorkersCoordinatorProductionGateThresholds = {
  maxBrowserP95FanoutLatencyMs: 80,
  maxEdgePlacementVarianceMs: 40,
  requireDirectWorkerNetworkingRejected: true,
  maxUpstreamRetryCount: 1,
};

const canary: WorkersCoordinatorCanaryState = {
  stableVersion: 'workers-coordinator-2026-05-24',
  canaryVersion: 'workers-coordinator-2026-05-25',
  sampleRate: 0.05,
  minHealthyRequests: 25,
  observedHealthyRequests: 32,
  rollbackErrorBudget: 0,
  observedErrorCount: 0,
  checkpointBoundaryKeys: ['checkpoint:production-observability-canary:boundary'],
};

function createDeployedReport(
  overrides: Partial<WorkersCoordinatorDeployedSmokeReport> = {},
): WorkersCoordinatorDeployedSmokeReport {
  const base: WorkersCoordinatorDeployedSmokeReport = {
    runtime: 'deployed-workers-smoke',
    status: 'pass',
    requestId: 'production-observability-canary',
    target: {
      baseUrl: 'https://preview.unzen-workers.example',
      runtime: 'wrangler-preview',
      environment: 'preview',
      authHeaderName: 'Authorization',
      authHeaderPresent: true,
      durableObjectMigrationTag: 'workers-coordinator-v1',
      edgePlacementHints: ['NRT', 'SJC'],
    },
    requestLifecycle: {
      endpoint: '/api/requests',
      acceptedAtMs: 1_779_408_000_000,
      plannedSegmentCount: 3,
      promptTokens: 128,
      completedAtMs: 1_779_408_000_050,
      httpStatus: 202,
      edgeColo: 'NRT',
      deployedFetchLatencyMs: 18,
    },
    browserWebSocketTiming: {
      source: 'real-browser-websocket-client',
      heartbeatBursts: 4,
      attemptedHeartbeatCount: 12,
      acceptedHeartbeatCount: 12,
      fanoutLatencySamplesMs: [21, 24, 30, 33],
      p95FanoutLatencyMs: 33,
    },
    edgePlacement: {
      observations: [
        {
          edgeColo: 'NRT',
          apiLatencyMs: 18,
        },
        {
          edgeColo: 'SJC',
          webSocketLatencyMs: 33,
        },
      ],
      varianceMs: 15,
    },
    directWorkerNetworking: {
      attemptedEndpoint: 'https://worker-peer.example/direct',
      rejected: true,
      reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
      httpStatus: 403,
    },
    upstreamReport: {
      runtime: 'miniflare',
      requestId: 'production-observability-canary',
      status: 'pass',
      requestLifecycle: {
        endpoint: '/api/requests',
        acceptedAtMs: 1_779_408_000_000,
        plannedSegmentCount: 3,
        promptTokens: 128,
        completedAtMs: 1_779_408_000_050,
        httpStatus: 202,
      },
      durableObjectStorageFields: {
        owner: 'durable-object',
        singleWriter: true,
        storageKeys: [
          'manifest:production-observability-canary',
          'request:production-observability-canary:assignments',
          'request:production-observability-canary:lifecycle',
        ],
        registeredWorkers: [
          {
            workerId: 'deployed-t2-a',
            tier: WorkerTier.TIER_2,
            heartbeatAtMs: 1_779_408_000_000,
            eligible: true,
            maxChunkLength: 2,
          },
        ],
        eligibleWorkers: ['deployed-t2-a'],
        checkpointMetadata: [],
      },
      assignmentReport: {
        source: 'AdaptiveChunkDispatcher',
        importedByRuntime: true,
        assignments: [],
      },
      checkpointRelay: {
        owner: 'coordinator-storage',
        directWorkerNetworking: false,
        bytes: 256_000,
        relayMs: 45,
        storageKeys: ['checkpoint:production-observability-canary:seg0-1'],
      },
      retryResumeImpact: {
        retryCount: 0,
        resumeCount: 0,
        estimatedDelayMs: 0,
        resumedFromSegment: null,
      },
      webSocketHeartbeatPath: {
        upgradeEndpoint: '/workers/:workerId/socket',
        acceptedStatus: 101,
        processedHeartbeatCount: 12,
        fanoutLatencySamplesMs: [21, 24, 30, 33],
        p95FanoutLatencyMs: 33,
        concurrentHeartbeatBursts: 4,
      },
      directWorkerNetworking: {
        attemptedEndpoint: 'https://worker-peer.example/direct',
        rejected: true,
        reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
        httpStatus: 403,
      },
      fanoutLatencyMs: 33,
      bottlenecksToIssue: ['production-observability-and-canary-release'],
    },
    bottlenecksToIssue: ['production-observability-and-canary-release'],
  };
  return {
    ...base,
    ...overrides,
  };
}

describe('Workers Coordinator production observability canary gate', () => {
  it('exports durable per-request metrics, evaluates alerts, and promotes a clean canary', () => {
    const report = runWorkersCoordinatorProductionObservabilityCanaryGate({
      deployedReport: createDeployedReport(),
      thresholds,
      canary,
      exportedAtMs: 1_779_408_060_000,
    });

    expect(report.runtime).toBe('production-observability-canary-gate');
    expect(report.status).toBe('pass');
    expect(report.metricsExport).toMatchObject({
      sink: 'durable-per-request-metrics',
      requestId: 'production-observability-canary',
      storageKeys: [
        'metrics:production-observability-canary:request',
        'metrics:production-observability-canary:alerts',
        'metrics:production-observability-canary:canary',
      ],
      fields: {
        browserWebSocketP95Ms: 33,
        edgePlacementVarianceMs: 15,
        directWorkerNetworkingRejected: true,
        upstreamFailureReason: null,
        upstreamRetryCount: 0,
        checkpointRelayOwner: 'coordinator-storage',
      },
    });
    expect(report.alertThresholds.map((alert) => alert.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(report.canaryRelease).toMatchObject({
      decision: 'promote',
      reason: 'all production observability thresholds are clean',
    });
    expect(report.rollbackCheckpointBoundary).toMatchObject({
      owner: 'coordinator-storage',
      preserved: true,
      directWorkerNetworking: false,
    });
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-csp-coop-coep-release-gate']);
  });

  it('holds a canary on warning thresholds without failing the production gate', () => {
    const report = runWorkersCoordinatorProductionObservabilityCanaryGate({
      deployedReport: createDeployedReport({
        edgePlacement: {
          observations: [],
          varianceMs: 55,
        },
      }),
      thresholds,
      canary: {
        ...canary,
        observedHealthyRequests: 24,
      },
      exportedAtMs: 1_779_408_060_000,
    });

    expect(report.status).toBe('pass');
    expect(report.alertThresholds.find((alert) => alert.name === 'edge-placement-variance'))
      .toMatchObject({
        status: 'warn',
        reason: 'edge placement variance exceeded',
      });
    expect(report.canaryRelease).toMatchObject({
      decision: 'hold',
      reason: 'waiting for healthy request floor and clean warnings',
    });
    expect(report.bottlenecksToIssue).toEqual(['canary-sample-size-and-warning-budget']);
  });

  it('fails and rolls back when checkpoint ownership would leave the Coordinator boundary', () => {
    const deployedReport = createDeployedReport();
    const report = runWorkersCoordinatorProductionObservabilityCanaryGate({
      deployedReport: {
        ...deployedReport,
        upstreamReport: {
          ...deployedReport.upstreamReport,
          checkpointRelay: {
            ...deployedReport.upstreamReport.checkpointRelay,
            directWorkerNetworking: true,
          },
        },
      },
      thresholds,
      canary,
      exportedAtMs: 1_779_408_060_000,
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('rollback-checkpoint-boundary-broken');
    expect(report.canaryRelease).toMatchObject({
      decision: 'rollback',
      reason: 'checkpoint boundary is not Coordinator-owned',
    });
    expect(report.rollbackCheckpointBoundary).toMatchObject({
      preserved: false,
      directWorkerNetworking: false,
    });
  });
});
