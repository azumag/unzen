import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  type CapturedAndVerifiedEvidenceEnvelope,
  type SyntheticEvidenceEnvelope,
} from '../src/evidence.js';
import type {
  WorkersCoordinatorSignedRunnerBrowserPreviewReport,
} from '../src/workers-coordinator-signed-runner-browser-preview.js';
import {
  SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND,
  runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate,
} from '../src/workers-coordinator-signed-runner-webgpu-worker-pilot-evidence-gate.js';
import type {
  WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence,
} from '../src/workers-coordinator-signed-runner-webgpu-worker-pilot.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_CONTENT = 'verified artifact';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';
const RUNNER_URL = 'https://preview.unzen-workers.example/runners/signed/runner.html';

function createPreviewReport(): WorkersCoordinatorSignedRunnerBrowserPreviewReport {
  return {
    status: 'pass',
    browserHarness: {
      runnerUrl: RUNNER_URL,
    },
  } as unknown as WorkersCoordinatorSignedRunnerBrowserPreviewReport;
}

function createPilotPayload(
  overrides: Partial<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence> = {},
): WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence {
  return {
    source: 'real-browser-webgpu-worker-pilot',
    runnerUrl: RUNNER_URL,
    capturedAtMs: 1_773_148_400_000,
    segmentExecution: {
      modelId: 'unzen-30b-q4-8seg-feasibility',
      segmentId: 'segment-03',
      runtime: 'webgpu-dedicated-worker',
      state: 'completed',
      layerStart: 24,
      layerEnd: 31,
      startedAtMs: 1_773_148_390_000,
      completedAtMs: 1_773_148_398_900,
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
    cspConnectSrc: [
      'https://coordinator.unzen.dev',
      'wss://coordinator.unzen.dev',
      'https://cdn.unzen.dev',
    ],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: [
      'https://coordinator.unzen.dev',
      'wss://coordinator.unzen.dev',
      'https://cdn.unzen.dev',
    ],
    networkAttempts: [
      {
        url: 'wss://coordinator.unzen.dev/workers/webgpu-pilot/socket',
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

function createVerifiedEnvelope(
  payload = createPilotPayload(),
  overrides: Partial<
    CapturedAndVerifiedEvidenceEnvelope<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence>
  > = {},
): CapturedAndVerifiedEvidenceEnvelope<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'verified-pilot',
    producer: {
      name: 'unzen-browser-harness',
      version: '0.1.0',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'browser-webgpu-pilot-run-1',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'chrome',
      runtimeVersion: '150.0.0.0',
      executionSurface: 'browser-document',
      os: {
        name: 'macOS',
        version: '15.5',
      },
      browser: {
        name: 'Chrome',
        version: '150.0.0.0',
      },
    },
    scenario: {
      feature: SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND,
      scenario: 'single-segment-completion',
      expectedResult: 'segment completes and checkpoint is relayed through Coordinator',
    },
    artifact: {
      locator: 'artifact://browser-webgpu-pilot-run-1/report.json',
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-07-11T13:00:00.000Z',
    },
    verification: {
      verifier: 'unzen-ci-evidence-verifier',
      version: '1.0.0',
      verifiedAt: '2026-07-10T13:05:00.000Z',
      result: 'pass',
    },
    redaction: {
      applied: true,
      policyVersion: 'browser-evidence-v1',
    },
    payload,
    ...overrides,
  };
}

function createSyntheticEnvelope(
  payload = createPilotPayload(),
): SyntheticEvidenceEnvelope<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND,
    evidenceLevel: 'synthetic-fixture',
    readinessStatus: 'contract-tested',
    producer: {
      name: 'vitest',
      version: '4.1.7',
    },
    runId: 'synthetic-webgpu-pilot-run-1',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'node',
      runtimeVersion: '22.16.0',
      executionSurface: 'unit-test',
    },
    redaction: {
      applied: false,
      policyVersion: 'none',
    },
    payload,
  };
}

const verificationOptions = {
  now: NOW,
  trustedVerifiers: [
    {
      name: 'unzen-ci-evidence-verifier',
      version: '1.0.0',
    },
  ],
  loadArtifact: async (locator: string) => {
    expect(locator).toBe('artifact://browser-webgpu-pilot-run-1/report.json');
    return ARTIFACT_CONTENT;
  },
  verifyArtifact: async ({ actualSha256 }: { actualSha256: string }) => {
    expect(actualSha256).toBe(ARTIFACT_SHA256);
    return {
      verifier: 'unzen-ci-evidence-verifier',
      version: '1.0.0',
      verifiedAt: '2026-07-10T13:05:00.000Z',
      result: 'pass' as const,
    };
  },
} as const;

describe('Workers Coordinator signed runner WebGPU pilot evidence gate', () => {
  it('passes only after verified evidence and the existing contract both pass', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(),
      validationOptions: verificationOptions,
    });

    expect(report.status).toBe('pass');
    expect(report.effectiveEvidenceLevel).toBe('captured-and-verified');
    expect(report.effectiveReadinessStatus).toBe('verified-pilot');
    expect(report.contractReport?.status).toBe('pass');
  });

  it('does not treat a passing synthetic fixture as a verified pilot', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createSyntheticEnvelope(),
      validationOptions: { now: NOW },
    });

    expect(report.status).toBe('not-evaluated');
    expect(report.failureReason).toBe(
      'webgpu-pilot-evidence-does-not-support-readiness: verified-pilot',
    );
    expect(report.contractReport).toBeUndefined();
  });

  it('does not evaluate a hand-written Level 3 envelope without an artifact loader', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(),
      validationOptions: {
        now: NOW,
        trustedVerifiers: verificationOptions.trustedVerifiers,
      },
    });

    expect(report.status).toBe('not-evaluated');
    expect(report.evidenceValidation.issues).toContainEqual(
      expect.objectContaining({ code: 'artifact-unavailable' }),
    );
    expect(report.contractReport).toBeUndefined();
  });

  it('fails closed when the captured artifact digest does not match', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(),
      validationOptions: {
        ...verificationOptions,
        loadArtifact: async () => 'tampered artifact',
      },
    });

    expect(report.status).toBe('fail');
    expect(report.evidenceValidation.issues).toContainEqual(
      expect.objectContaining({ code: 'artifact-digest-mismatch' }),
    );
    expect(report.contractReport).toBeUndefined();
  });

  it('rejects verified evidence for a different evidence kind', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(createPilotPayload(), {
        evidenceKind: 'different-browser-pilot',
      }),
      validationOptions: verificationOptions,
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-pilot-evidence-kind-mismatch: different-browser-pilot',
    );
    expect(report.contractReport).toBeUndefined();
  });

  it('rejects verified evidence whose scenario targets another feature', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(createPilotPayload(), {
        scenario: {
          feature: 'different-browser-feature',
          scenario: 'single-segment-completion',
          expectedResult: 'segment completes',
        },
      }),
      validationOptions: verificationOptions,
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-pilot-evidence-scenario-feature-mismatch: different-browser-feature',
    );
    expect(report.contractReport).toBeUndefined();
  });

  it('still fails when verified provenance wraps a payload that violates the pilot contract', async () => {
    const payload = createPilotPayload({
      segmentExecution: {
        modelId: 'unzen-30b-q4-8seg-feasibility',
        segmentId: 'segment-03',
        runtime: 'webgpu-dedicated-worker',
        state: 'started',
        layerStart: 24,
        layerEnd: 31,
        startedAtMs: 1_773_148_390_000,
      },
    });

    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(payload),
      validationOptions: verificationOptions,
    });

    expect(report.status).toBe('fail');
    expect(report.contractReport?.status).toBe('fail');
    expect(report.failureReason).toBe(
      'webgpu-pilot-contract-failed: segment-execution-not-completed: started',
    );
  });

  it('can require production-candidate evidence without accepting a verified-pilot artifact', async () => {
    const report = await runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate({
      previewReport: createPreviewReport(),
      evidenceEnvelope: createVerifiedEnvelope(),
      validationOptions: verificationOptions,
      minimumReadiness: 'production-candidate',
    });

    expect(report.status).toBe('not-evaluated');
    expect(report.failureReason).toBe(
      'webgpu-pilot-evidence-does-not-support-readiness: production-candidate',
    );
    expect(report.contractReport).toBeUndefined();
  });
});
