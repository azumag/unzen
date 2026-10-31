import { describe, expect, it } from 'vitest';
import { validateEvidenceEnvelopeForConsumption } from '../src/evidence-consumption.js';
import {
  runWorkersCoordinatorSignedRunnerBrowserPreviewVerification,
  type WorkersCoordinatorSignedRunnerBrowserEvidencePayload,
} from '../src/workers-coordinator-signed-runner-browser-preview.js';
import type { WorkersCoordinatorProductionObservabilityCanaryReport } from '../src/workers-coordinator-production-observability-canary.js';
import {
  ARTIFACT_SHA256,
  createCapturedAndVerifiedEnvelope,
  createVerifiedValidationOptions,
} from './evidence-envelope-helpers.js';

function browserPayload(): WorkersCoordinatorSignedRunnerBrowserEvidencePayload {
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
  };
}

function productionGateReport(): WorkersCoordinatorProductionObservabilityCanaryReport {
  return {
    runtime: 'production-observability-canary-gate',
    status: 'pass',
    requestId: 'evidence-consumption-ownership',
    metricsExport: {
      sink: 'durable-per-request-metrics',
      requestId: 'evidence-consumption-ownership',
      storageKeys: [
        'metrics:evidence-consumption-ownership:request',
        'metrics:evidence-consumption-ownership:alerts',
        'metrics:evidence-consumption-ownership:canary',
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
      storageKeys: ['checkpoint:evidence-consumption-ownership:boundary'],
      directWorkerNetworking: false,
    },
    bottlenecksToIssue: ['signed-runner-csp-coop-coep-release-gate'],
  };
}

describe('evidence async consumption ownership', () => {
  it('returns the pre-loader envelope generation when the loader mutates caller-owned evidence', async () => {
    const envelope = createCapturedAndVerifiedEnvelope({ decision: 'initial' });
    const options = createVerifiedValidationOptions();
    const loadArtifact = options.loadArtifact!;

    const validation = await validateEvidenceEnvelopeForConsumption<{ decision: string }>(
      envelope,
      {
        ...options,
        async loadArtifact(locator) {
          envelope.payload.decision = 'mutated-by-loader';
          envelope.artifact.sha256 = '0'.repeat(64);
          return loadArtifact(locator);
        },
      },
    );

    expect(validation.status).toBe('valid');
    expect(validation.envelope).not.toBe(envelope);
    expect(validation.envelope?.payload).toEqual({ decision: 'initial' });
    expect(validation.envelope?.artifact?.sha256).toBe(ARTIFACT_SHA256);
    expect(envelope.payload.decision).toBe('mutated-by-loader');
  });

  it('returns the pre-verifier envelope generation when the verifier mutates caller-owned evidence', async () => {
    const envelope = createCapturedAndVerifiedEnvelope({ decision: 'initial' });
    const options = createVerifiedValidationOptions();
    const verifyArtifact = options.verifyArtifact!;

    const validation = await validateEvidenceEnvelopeForConsumption<{ decision: string }>(
      envelope,
      {
        ...options,
        async verifyArtifact(context) {
          envelope.payload.decision = 'mutated-by-verifier';
          envelope.artifact.sha256 = 'f'.repeat(64);
          return verifyArtifact(context);
        },
      },
    );

    expect(validation.status).toBe('valid');
    expect(validation.envelope?.payload).toEqual({ decision: 'initial' });
    expect(validation.envelope?.artifact?.sha256).toBe(ARTIFACT_SHA256);
    expect(envelope.payload.decision).toBe('mutated-by-verifier');
  });

  it('keeps the browser-preview gate bound to the pre-loader payload generation', async () => {
    const payload = browserPayload();
    const envelope = createCapturedAndVerifiedEnvelope(payload);
    const options = createVerifiedValidationOptions();
    const loadArtifact = options.loadArtifact!;

    const report = await runWorkersCoordinatorSignedRunnerBrowserPreviewVerification({
      target: {
        baseUrl: 'https://preview.unzen-workers.example',
        runtime: 'wrangler-preview',
        environment: 'preview',
        authHeaderName: 'Authorization',
        authHeaderPresent: true,
      },
      productionGateReport: productionGateReport(),
      browserEvidenceEnvelope: envelope,
      evidenceValidation: {
        ...options,
        async loadArtifact(locator) {
          payload.runnerUrl = 'https://attacker.example/runner.html';
          payload.networkAttempts = [{
            url: 'https://collector.example.test/leak',
            initiator: 'dedicated-worker',
            blocked: false,
          }];
          return loadArtifact(locator);
        },
      },
    });

    expect(report.status).toBe('pass');
    expect(report.failureReason).toBeUndefined();
    expect(report.browserHarness?.runnerUrl).toBe(
      'https://preview.unzen-workers.example/runners/signed/runner.html',
    );
    expect(report.releaseGateReport?.networkBoundary.attempts).not.toContainEqual(
      expect.objectContaining({ url: 'https://collector.example.test/leak' }),
    );
  });
});
