import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
  type TrustedEvidenceVerifier,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_CONTENT = 'verified artifact';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';
const VERIFIER = 'unzen-ci-evidence-verifier';
const VERIFIER_VERSION = '1.0.0';
const VERIFIED_AT = '2026-07-10T13:05:00.000Z';

function createVerifiedEnvelope(): CapturedAndVerifiedEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'real-browser-webgpu-worker-pilot',
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: 'unzen-browser-harness',
      version: '0.1.0',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'browser-run-claim-snapshot',
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
      locator: 'artifact://browser-run-claim-snapshot/report.json',
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-07-11T13:00:00.000Z',
    },
    verification: {
      verifier: VERIFIER,
      version: VERIFIER_VERSION,
      verifiedAt: VERIFIED_AT,
      result: 'pass',
    },
    redaction: {
      applied: true,
      policyVersion: 'browser-evidence-v1',
    },
    payload: {
      status: 'pass',
    },
  };
}

function passingAttestation() {
  return {
    verifier: VERIFIER,
    version: VERIFIER_VERSION,
    verifiedAt: VERIFIED_AT,
    result: 'pass' as const,
  };
}

describe('validateEvidenceEnvelope runtime claim snapshots', () => {
  it('uses the digest claim that passed validation even if the loader mutates the envelope', async () => {
    const envelope = createVerifiedEnvelope();

    const result = await validateEvidenceEnvelope(envelope, {
      now: NOW,
      trustedVerifiers: [{ name: VERIFIER, version: VERIFIER_VERSION }],
      loadArtifact: async () => {
        envelope.artifact.sha256 = '0'.repeat(64);
        return ARTIFACT_CONTENT;
      },
      verifyArtifact: async () => passingAttestation(),
    });

    expect(envelope.artifact.sha256).toBe('0'.repeat(64));
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('keeps verification claims and trust policy stable across the verifier callback', async () => {
    const envelope = createVerifiedEnvelope();
    const trustedVerifiers: TrustedEvidenceVerifier[] = [
      { name: VERIFIER, version: VERIFIER_VERSION },
    ];

    const result = await validateEvidenceEnvelope(envelope, {
      now: NOW,
      trustedVerifiers,
      loadArtifact: async () => ARTIFACT_CONTENT,
      verifyArtifact: async () => {
        envelope.verification.verifier = 'mutated-verifier';
        envelope.verification.version = '9.9.9';
        envelope.verification.verifiedAt = '2026-07-10T13:59:00.000Z';
        trustedVerifiers.length = 0;
        return passingAttestation();
      },
    });

    expect(envelope.verification).toMatchObject({
      verifier: 'mutated-verifier',
      version: '9.9.9',
      verifiedAt: '2026-07-10T13:59:00.000Z',
    });
    expect(trustedVerifiers).toEqual([]);
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });
});
