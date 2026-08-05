import {
  EVIDENCE_SCHEMA_VERSION,
  type CapturedAndVerifiedEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
  type SyntheticEvidenceEnvelope,
} from '../src/evidence.js';
import type { WorkersCoordinatorSignedRunnerEvidenceProvenance } from '../src/workers-coordinator-signed-runner-evidence.js';

export type { WorkersCoordinatorSignedRunnerEvidenceProvenance };

// Fixed validation clock shared by the signed-runner gate tests so captured
// evidence is not rejected as future-dated or expired.
export const EVIDENCE_NOW = '2026-07-10T14:00:00.000Z';
export const ARTIFACT_CONTENT = 'verified artifact';
export const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';
export const TRUSTED_VERIFIER = {
  name: 'unzen-ci-evidence-verifier',
  version: '1.0.0',
};

export function createSyntheticEnvelope<TPayload>(
  payload: TPayload,
  overrides: Partial<SyntheticEvidenceEnvelope<TPayload>> = {},
): SyntheticEvidenceEnvelope<TPayload> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'signed-runner-contract',
    evidenceLevel: 'synthetic-fixture',
    readinessStatus: 'contract-tested',
    producer: {
      name: 'vitest',
      version: '4.1.7',
    },
    runId: 'synthetic-run-1',
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
    ...overrides,
  };
}

// Deliberately constructs an invalid envelope: a synthetic fixture that claims
// production readiness. The validator must reject it (readiness-exceeds-
// evidence-level), proving that a hand-written fixture cannot be promoted.
export function createProductionClaimingSyntheticEnvelope<TPayload>(
  payload: TPayload,
): EvidenceEnvelope<TPayload> {
  return {
    ...createSyntheticEnvelope(payload),
    readinessStatus: 'production-candidate',
  } as unknown as EvidenceEnvelope<TPayload>;
}

export function createCapturedAndVerifiedEnvelope<TPayload>(
  payload: TPayload,
  overrides: Partial<CapturedAndVerifiedEvidenceEnvelope<TPayload>> = {},
  runId = 'browser-run-1',
): CapturedAndVerifiedEvidenceEnvelope<TPayload> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'real-browser-signed-runner',
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: 'unzen-browser-harness',
      version: '0.1.0',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId,
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
      feature: 'signed-runner-webgpu-worker',
      scenario: 'single-segment-completion',
      expectedResult: 'segment completes and checkpoint is relayed through Coordinator',
    },
    artifact: {
      locator: `artifact://${runId}/report.json`,
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-07-11T13:00:00.000Z',
    },
    verification: {
      verifier: TRUSTED_VERIFIER.name,
      version: TRUSTED_VERIFIER.version,
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

// Trust boundary used to accept captured-and-verified envelopes: the verifier
// trust list, artifact loader, and independent verification callback live
// outside the evidence payload and must be supplied by the caller.
export function createVerifiedValidationOptions(): EvidenceValidationOptions {
  return {
    now: EVIDENCE_NOW,
    trustedVerifiers: [TRUSTED_VERIFIER],
    loadArtifact: async () => ARTIFACT_CONTENT,
    verifyArtifact: async ({ actualSha256 }) => ({
      verifier: TRUSTED_VERIFIER.name,
      version: TRUSTED_VERIFIER.version,
      verifiedAt: '2026-07-10T13:05:00.000Z',
      result: 'pass' as const,
    }),
  };
}
