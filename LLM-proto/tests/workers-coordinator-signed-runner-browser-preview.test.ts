import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorProductionObservabilityCanaryReport,
} from '../src/workers-coordinator-production-observability-canary.js';
import {
  runWorkersCoordinatorSignedRunnerBrowserPreviewVerification,
  type WorkersCoordinatorSignedRunnerBrowserEvidence,
  type WorkersCoordinatorSignedRunnerBrowserPreviewTarget,
} from '../src/workers-coordinator-signed-runner-browser-preview.js';

function createProductionGateReport(
  overrides: Partial<WorkersCoordinatorProductionObservabilityCanaryReport> = {},
): WorkersCoordinatorProductionObservabilityCanaryReport {
  const base: WorkersCoordinatorProductionObservabilityCanaryReport = {
    runtime: 'production-observability-canary-gate',
    status: 'pass',
    requestId: 'signed-runner-browser-preview',
    metricsExport: {
      sink: 'durable-per-request-metrics',
      requestId: 'signed-runner-browser-preview',
      storageKeys: [
        'metrics:signed-runner-browser-preview:request',
        'metrics:signed-runner-browser-preview:alerts',
        'metrics:signed-runner-browser-preview:canary',
      ],
      fields: {
        browserWebSocketP95Ms: 31,
        edgePlacementVarianceMs: 10,
        directWorkerNetworkingRejected: true,
        upstreamFailureReason: null,
        upstreamRetryCount: 0,
        checkpointRelayOwner: 'coordinator-storage',
        exportedAtMs: 1_779_580_800_000,
      },
    },
    alertThresholds: [],
    canaryRelease: {
      stableVersion: 'workers-coordinator-2026-05-26',
      canaryVersion: 'workers-coordinator-2026-05-27',
      sampleRate: 0.05,
      decision: 'promote',
      reason: 'all production observability thresholds are clean',
    },
    rollbackCheckpointBoundary: {
      owner: 'coordinator-storage',
      preserved: true,
      storageKeys: ['checkpoint:signed-runner-browser-preview:boundary'],
      directWorkerNetworking: false,
    },
    bottlenecksToIssue: ['signed-runner-csp-coop-coep-release-gate'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createTarget(
  overrides: Partial<WorkersCoordinatorSignedRunnerBrowserPreviewTarget> = {},
): WorkersCoordinatorSignedRunnerBrowserPreviewTarget {
  return {
    baseUrl: 'https://preview.unzen-workers.example',
    runtime: 'wrangler-preview',
    environment: 'preview',
    authHeaderName: 'Authorization',
    authHeaderPresent: true,
    ...overrides,
  };
}

function createBrowserEvidence(
  overrides: Partial<WorkersCoordinatorSignedRunnerBrowserEvidence> = {},
): WorkersCoordinatorSignedRunnerBrowserEvidence {
  return {
    source: 'real-browser-harness',
    runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    responseHeaders: {
      'content-security-policy': [
        "default-src 'none'",
        "connect-src https://coordinator.unzen.dev wss://coordinator.unzen.dev https://cdn.unzen.dev",
        "script-src 'self'",
        "worker-src 'self'",
      ].join('; '),
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    },
    coordinatorOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev'],
    cdnOrigins: ['https://cdn.unzen.dev'],
    scriptSrc: ["'self'"],
    workerSrc: ["'self'"],
    sandboxIframe: {
      flags: ['allow-scripts'],
      topLevelDomAccessDenied: true,
      topLevelCookieAccessDenied: true,
      topLevelStorageAccessDenied: true,
    },
    signature: {
      keyId: 'unzen-runner-release-key-2026-05',
      runnerSha256: 'sha256:eb8fa4d2ae6f7f733b12b8237658ea9bb219a8e41ec8fe4e6e844a368c1d9e6c',
      verified: true,
    },
    networkAttempts: [
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
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
    capturedAtMs: 1_779_580_860_000,
    ...overrides,
  };
}

describe('Workers Coordinator signed runner browser preview verification', () => {
  it('passes real-browser Wrangler preview evidence through the signed runner release gate', () => {
    const report = runWorkersCoordinatorSignedRunnerBrowserPreviewVerification({
      target: createTarget(),
      productionGateReport: createProductionGateReport(),
      browserEvidence: createBrowserEvidence(),
    });

    expect(report.runtime).toBe('signed-runner-browser-preview-verification');
    expect(report.status).toBe('pass');
    expect(report.target).toMatchObject({
      runtime: 'wrangler-preview',
      authHeaderPresent: true,
    });
    expect(report.browserHarness).toMatchObject({
      source: 'real-browser-harness',
      runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
    });
    expect(report.allowedOrigins).toEqual([
      'https://coordinator.unzen.dev',
      'wss://coordinator.unzen.dev',
      'https://cdn.unzen.dev',
    ]);
    expect(report.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://analytics.example.test/beacon',
      blocked: true,
      reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
    });
    expect(report.releaseGateReport.sandboxIframe).toMatchObject({
      allowScriptsOnly: true,
      topLevelDomAccessDenied: true,
      topLevelCookieAccessDenied: true,
      topLevelStorageAccessDenied: true,
    });
    expect(report.releaseGateReport.coopCoepHeaders).toMatchObject({
      isolated: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-real-webgpu-worker-pilot']);
  });

  it('fails before release-gate promotion when the authenticated preview header is missing', () => {
    const report = runWorkersCoordinatorSignedRunnerBrowserPreviewVerification({
      target: createTarget({
        authHeaderPresent: false,
      }),
      productionGateReport: createProductionGateReport(),
      browserEvidence: createBrowserEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.releaseGateReport.status).toBe('pass');
    expect(report.failureReason).toBe('authenticated-preview-header-missing: Authorization');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-preview-auth-preflight']);
  });

  it('fails when browser-captured CSP omits an allowed Coordinator or CDN origin', () => {
    const report = runWorkersCoordinatorSignedRunnerBrowserPreviewVerification({
      target: createTarget(),
      productionGateReport: createProductionGateReport(),
      browserEvidence: createBrowserEvidence({
        responseHeaders: {
          'content-security-policy': "connect-src https://coordinator.unzen.dev; script-src 'self'",
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.browserHarness.cspConnectSrc).toEqual(['https://coordinator.unzen.dev']);
    expect(report.failureReason).toBe('csp-connect-src-missing-coordinator-or-cdn-origin');
    expect(report.bottlenecksToIssue).toEqual([
      'signed-runner-browser-preview-failure: csp-connect-src-missing-coordinator-or-cdn-origin',
    ]);
  });

  it('fails when a browser network attempt escapes the Coordinator/CDN boundary', () => {
    const report = runWorkersCoordinatorSignedRunnerBrowserPreviewVerification({
      target: createTarget(),
      productionGateReport: createProductionGateReport(),
      browserEvidence: createBrowserEvidence({
        networkAttempts: [
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
    expect(report.releaseGateReport.networkBoundary.attempts).toContainEqual({
      url: 'https://collector.example.test/leak',
      initiator: 'dedicated-worker',
      blocked: false,
      origin: 'https://collector.example.test',
      allowed: false,
    });
    expect(report.failureReason).toBe(
      'non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
  });
});
