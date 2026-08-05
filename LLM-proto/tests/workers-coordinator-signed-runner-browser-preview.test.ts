import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorProductionObservabilityCanaryReport,
} from '../src/workers-coordinator-production-observability-canary.js';
import {
  runWorkersCoordinatorSignedRunnerBrowserPreviewVerification,
  type WorkersCoordinatorSignedRunnerBrowserEvidencePayload,
  type WorkersCoordinatorSignedRunnerBrowserPreviewReport,
  type WorkersCoordinatorSignedRunnerBrowserPreviewTarget,
} from '../src/workers-coordinator-signed-runner-browser-preview.js';
import {
  createCapturedAndVerifiedEnvelope,
  createProductionClaimingSyntheticEnvelope,
  createSyntheticEnvelope,
  createVerifiedValidationOptions,
} from './evidence-envelope-helpers.js';

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

function createBrowserEvidencePayload(
  overrides: Partial<WorkersCoordinatorSignedRunnerBrowserEvidencePayload> = {},
): WorkersCoordinatorSignedRunnerBrowserEvidencePayload {
  return {
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
    ...overrides,
  };
}

async function runPreviewVerification(options: {
  target?: WorkersCoordinatorSignedRunnerBrowserPreviewTarget;
  productionGateReport?: WorkersCoordinatorProductionObservabilityCanaryReport;
  browserEvidencePayload?: WorkersCoordinatorSignedRunnerBrowserEvidencePayload;
  browserEvidenceEnvelope?: Parameters<typeof runWorkersCoordinatorSignedRunnerBrowserPreviewVerification>[0]['browserEvidenceEnvelope'];
  evidenceValidation?: Parameters<typeof runWorkersCoordinatorSignedRunnerBrowserPreviewVerification>[0]['evidenceValidation'];
} = {}): Promise<WorkersCoordinatorSignedRunnerBrowserPreviewReport> {
  return runWorkersCoordinatorSignedRunnerBrowserPreviewVerification({
    target: options.target ?? createTarget(),
    productionGateReport: options.productionGateReport ?? createProductionGateReport(),
    browserEvidenceEnvelope: options.browserEvidenceEnvelope
      ?? createSyntheticEnvelope(options.browserEvidencePayload ?? createBrowserEvidencePayload()),
    evidenceValidation: options.evidenceValidation ?? { now: '2026-07-10T14:00:00.000Z' },
  });
}

describe('Workers Coordinator signed runner browser preview verification contract', () => {
  it('passes a synthetic-fixture envelope at contract-tested without claiming production readiness', async () => {
    const report = await runPreviewVerification();

    expect(report.runtime).toBe('signed-runner-browser-preview-verification');
    expect(report.status).toBe('pass');
    expect(report.target).toMatchObject({
      runtime: 'wrangler-preview',
      authHeaderPresent: true,
    });
    // Provenance comes from the validator: synthetic fixtures stay capped at
    // contract-tested and are never reported as production-ready.
    expect(report.evidence).toMatchObject({
      validationStatus: 'valid',
      evidenceLevel: 'synthetic-fixture',
      readinessStatus: 'contract-tested',
      runId: 'synthetic-run-1',
      issueCodes: [],
    });
    expect(report.browserHarness).toMatchObject({
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
    expect(report.releaseGateReport?.sandboxIframe).toMatchObject({
      allowScriptsOnly: true,
      topLevelDomAccessDenied: true,
      topLevelCookieAccessDenied: true,
      topLevelStorageAccessDenied: true,
    });
    expect(report.releaseGateReport?.coopCoepHeaders).toMatchObject({
      isolated: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-real-webgpu-worker-pilot']);
  });

  it('fails before release-gate promotion when the authenticated preview header is missing', async () => {
    const report = await runPreviewVerification({
      target: createTarget({ authHeaderPresent: false }),
    });

    expect(report.status).toBe('fail');
    expect(report.releaseGateReport?.status).toBe('pass');
    expect(report.failureReason).toBe('authenticated-preview-header-missing: Authorization');
    expect(report.bottlenecksToIssue).toEqual(['signed-runner-preview-auth-preflight']);
  });

  it('fails when browser-captured CSP omits an allowed Coordinator or CDN origin', async () => {
    const report = await runPreviewVerification({
      browserEvidencePayload: createBrowserEvidencePayload({
        responseHeaders: {
          'content-security-policy': "connect-src https://coordinator.unzen.dev; script-src 'self'",
          'cross-origin-opener-policy': 'same-origin',
          'cross-origin-embedder-policy': 'require-corp',
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.browserHarness?.cspConnectSrc).toEqual(['https://coordinator.unzen.dev']);
    expect(report.failureReason).toBe('csp-connect-src-missing-coordinator-or-cdn-origin');
    expect(report.bottlenecksToIssue).toEqual([
      'signed-runner-browser-preview-failure: csp-connect-src-missing-coordinator-or-cdn-origin',
    ]);
  });

  it('fails when a browser network attempt escapes the Coordinator/CDN boundary', async () => {
    const report = await runPreviewVerification({
      browserEvidencePayload: createBrowserEvidencePayload({
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
    expect(report.releaseGateReport?.networkBoundary.attempts).toContainEqual({
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

describe('Workers Coordinator signed runner browser preview integration gate', () => {
  it('rejects a hand-written captured-and-verified envelope without artifact loader and verifier callbacks', async () => {
    // A fixture that writes evidenceLevel/readinessStatus by hand must not pass
    // production readiness: without an external loader + verifier the validator
    // returns not-evaluated and the gate refuses the evidence.
    const report = await runPreviewVerification({
      browserEvidenceEnvelope: createCapturedAndVerifiedEnvelope(
        createBrowserEvidencePayload(),
      ),
      evidenceValidation: {
        now: '2026-07-10T14:00:00.000Z',
        trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
      },
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'signed-runner-preview-evidence-not-validated: artifact-unavailable',
    );
    expect(report.evidence.validationStatus).toBe('not-evaluated');
    expect(report.evidence.evidenceLevel).toBe('captured-and-verified');
    expect(report.evidence.readinessStatus).toBe('production-candidate');
    expect(report.evidence.issueCodes).toContain('artifact-unavailable');
    // Payload-derived fields are absent because the evidence was not trusted.
    expect(report.browserHarness).toBeUndefined();
    expect(report.releaseGateReport).toBeUndefined();
  });

  it('rejects a synthetic-fixture envelope that claims production readiness', async () => {
    const report = await runPreviewVerification({
      browserEvidenceEnvelope: createProductionClaimingSyntheticEnvelope(
        createBrowserEvidencePayload(),
      ),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'signed-runner-preview-evidence-not-validated: readiness-exceeds-evidence-level',
    );
    expect(report.evidence.issueCodes).toContain('readiness-exceeds-evidence-level');
  });

  it('accepts captured-and-verified evidence only with trusted loader, verifier, and attestation', async () => {
    const report = await runPreviewVerification({
      browserEvidenceEnvelope: createCapturedAndVerifiedEnvelope(
        createBrowserEvidencePayload(),
      ),
      evidenceValidation: createVerifiedValidationOptions(),
    });

    expect(report.status).toBe('pass');
    expect(report.evidence).toMatchObject({
      validationStatus: 'valid',
      evidenceLevel: 'captured-and-verified',
      readinessStatus: 'production-candidate',
      producerName: 'unzen-browser-harness',
    });
    expect(report.failureReason).toBeUndefined();
  });

  it('keeps the contract decision independent of the evidence provenance', async () => {
    // The same clean contract input must fail the same way regardless of
    // whether the envelope is synthetic or captured-and-verified.
    const synthetic = await runPreviewVerification({
      browserEvidencePayload: createBrowserEvidencePayload({
        networkAttempts: [
          {
            url: 'https://collector.example.test/leak',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });
    const captured = await runPreviewVerification({
      browserEvidenceEnvelope: createCapturedAndVerifiedEnvelope(
        createBrowserEvidencePayload({
          networkAttempts: [
            {
              url: 'https://collector.example.test/leak',
              initiator: 'dedicated-worker',
              blocked: false,
            },
          ],
        }),
      ),
      evidenceValidation: createVerifiedValidationOptions(),
    });

    expect(synthetic.status).toBe('fail');
    expect(captured.status).toBe('fail');
    expect(synthetic.failureReason).toBe(
      'non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(captured.failureReason).toBe(synthetic.failureReason);
  });
});
