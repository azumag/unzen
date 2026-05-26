import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorProductionObservabilityCanaryReport,
} from '../src/workers-coordinator-production-observability-canary.js';
import {
  runWorkersCoordinatorSignedRunnerReleaseGate,
  type WorkersCoordinatorSignedRunnerContract,
} from '../src/workers-coordinator-signed-runner-release-gate.js';

function createProductionGateReport(
  overrides: Partial<WorkersCoordinatorProductionObservabilityCanaryReport> = {},
): WorkersCoordinatorProductionObservabilityCanaryReport {
  const base: WorkersCoordinatorProductionObservabilityCanaryReport = {
    runtime: 'production-observability-canary-gate',
    status: 'pass',
    requestId: 'signed-runner-release-gate',
    metricsExport: {
      sink: 'durable-per-request-metrics',
      requestId: 'signed-runner-release-gate',
      storageKeys: [
        'metrics:signed-runner-release-gate:request',
        'metrics:signed-runner-release-gate:alerts',
        'metrics:signed-runner-release-gate:canary',
      ],
      fields: {
        browserWebSocketP95Ms: 33,
        edgePlacementVarianceMs: 12,
        directWorkerNetworkingRejected: true,
        upstreamFailureReason: null,
        upstreamRetryCount: 0,
        checkpointRelayOwner: 'coordinator-storage',
        exportedAtMs: 1_779_494_400_000,
      },
    },
    alertThresholds: [],
    canaryRelease: {
      stableVersion: 'workers-coordinator-2026-05-25',
      canaryVersion: 'workers-coordinator-2026-05-26',
      sampleRate: 0.05,
      decision: 'promote',
      reason: 'all production observability thresholds are clean',
    },
    rollbackCheckpointBoundary: {
      owner: 'coordinator-storage',
      preserved: true,
      storageKeys: ['checkpoint:signed-runner-release-gate:boundary'],
      directWorkerNetworking: false,
    },
    bottlenecksToIssue: ['signed-runner-csp-coop-coep-release-gate'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createRunnerContract(
  overrides: Partial<WorkersCoordinatorSignedRunnerContract> = {},
): WorkersCoordinatorSignedRunnerContract {
  const base: WorkersCoordinatorSignedRunnerContract = {
    runnerUrl: 'https://runner.unzen.dev/workers-coordinator/runner.html',
    coordinatorOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev'],
    cdnOrigins: ['https://cdn.unzen.dev'],
    csp: {
      connectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      scriptSrc: ["'self'"],
      workerSrc: ["'self'"],
    },
    sandboxIframe: {
      flags: ['allow-scripts'],
      topLevelDomAccessDenied: true,
      topLevelCookieAccessDenied: true,
      topLevelStorageAccessDenied: true,
    },
    headers: {
      'content-security-policy': "connect-src https://coordinator.unzen.dev wss://coordinator.unzen.dev https://cdn.unzen.dev; script-src 'self'; worker-src 'self'",
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    },
    signature: {
      keyId: 'unzen-runner-release-key-2026-05',
      runnerSha256: 'sha256:9c8c5c6c19b5821fe5f05d82c7c56b24636f2d9e8fdcc21e7e2e3acb3a979f27',
      verified: true,
    },
    observedNetworkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/workers/tier-2/socket',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/models/llama-segment-00.bin',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://analytics.example.test/beacon',
        initiator: 'iframe',
        blocked: true,
        reason: 'CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
  };

  return {
    ...base,
    ...overrides,
  };
}

describe('Workers Coordinator signed runner release gate', () => {
  it('passes when CSP, sandbox, COOP/COEP, signature, and network boundary are clean', () => {
    const report = runWorkersCoordinatorSignedRunnerReleaseGate({
      productionGateReport: createProductionGateReport(),
      runner: createRunnerContract(),
    });

    expect(report.runtime).toBe('signed-runner-csp-coop-coep-release-gate');
    expect(report.status).toBe('pass');
    expect(report.csp).toMatchObject({
      connectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.sandboxIframe).toMatchObject({
      flags: ['allow-scripts'],
      allowScriptsOnly: true,
      topLevelDomAccessDenied: true,
      topLevelCookieAccessDenied: true,
      topLevelStorageAccessDenied: true,
    });
    expect(report.coopCoepHeaders).toEqual({
      coop: 'same-origin',
      coep: 'require-corp',
      isolated: true,
    });
    expect(report.signature).toMatchObject({
      keyId: 'unzen-runner-release-key-2026-05',
      verified: true,
    });
    expect(report.networkBoundary.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://analytics.example.test/beacon',
      blocked: true,
      reason: 'CSP connect-src rejected non-Coordinator/CDN origin',
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-browser-poc-and-wrangler-preview-verification']);
  });

  it('fails when iframe sandbox can depend on the top-level page', () => {
    const report = runWorkersCoordinatorSignedRunnerReleaseGate({
      productionGateReport: createProductionGateReport(),
      runner: createRunnerContract({
        sandboxIframe: {
          flags: ['allow-scripts', 'allow-same-origin'],
          topLevelDomAccessDenied: true,
          topLevelCookieAccessDenied: false,
          topLevelStorageAccessDenied: true,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.sandboxIframe.allowScriptsOnly).toBe(false);
    expect(report.failureReason).toBe('sandbox-iframe-must-be-allow-scripts-only');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-iframe-isolation-hardening']);
  });

  it('fails release when a non-Coordinator/CDN network attempt is not blocked', () => {
    const report = runWorkersCoordinatorSignedRunnerReleaseGate({
      productionGateReport: createProductionGateReport(),
      runner: createRunnerContract({
        observedNetworkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/api/requests',
            initiator: 'iframe',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/leak',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.networkBoundary.attempts).toContainEqual({
      url: 'https://collector.example.test/leak',
      initiator: 'dedicated-worker',
      blocked: false,
      origin: 'https://collector.example.test',
      allowed: false,
    });
    expect(report.failureReason).toBe(
      'non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-network-policy-hardening']);
  });

  it('fails when COOP/COEP headers do not isolate the runner response', () => {
    const report = runWorkersCoordinatorSignedRunnerReleaseGate({
      productionGateReport: createProductionGateReport(),
      runner: createRunnerContract({
        headers: {
          'content-security-policy': "connect-src https://coordinator.unzen.dev https://cdn.unzen.dev; script-src 'self'",
          'cross-origin-opener-policy': 'unsafe-none',
          'cross-origin-embedder-policy': 'require-corp',
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.coopCoepHeaders).toEqual({
      coop: 'unsafe-none',
      coep: 'require-corp',
      isolated: false,
    });
    expect(report.failureReason).toBe('coop-header-must-be-same-origin');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-cross-origin-isolation-hardening']);
  });
});
