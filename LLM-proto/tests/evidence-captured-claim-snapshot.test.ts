import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_CONTENT = 'verified artifact';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';
const VERIFIER = 'unzen-ci-evidence-verifier';
const VERSION = '1.0.0';
const VERIFIED_AT = '2026-07-10T13:05:00.000Z';
const LOCATOR = 'artifact://captured-claim-snapshot/report.json';

function capturedEnvelope(): CapturedAndVerifiedEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'captured-claim-snapshot',
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: 'vitest',
      version: '4.1.7',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'captured-claim-snapshot',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'chrome',
      runtimeVersion: '150.0.0.0',
      executionSurface: 'browser-document',
      os: { name: 'macOS', version: '15.5' },
      browser: { name: 'Chrome', version: '150.0.0.0' },
    },
    scenario: {
      feature: 'captured-claim-snapshot',
      scenario: 'single validation operation',
      expectedResult: 'validated claims stay bound to their first reads',
    },
    artifact: {
      locator: LOCATOR,
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-07-11T13:00:00.000Z',
    },
    verification: {
      verifier: VERIFIER,
      version: VERSION,
      verifiedAt: VERIFIED_AT,
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'test-v1' },
    payload: { status: 'pass' },
  };
}

describe('validateEvidenceEnvelope captured claim snapshot', () => {
  it('uses one artifact digest read for syntax validation and loaded-content comparison', async () => {
    const envelope = capturedEnvelope();
    let digestReads = 0;
    Object.defineProperty(envelope.artifact, 'sha256', {
      configurable: true,
      get() {
        digestReads += 1;
        return digestReads === 1
          ? ARTIFACT_SHA256
          : 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, {
      now: NOW,
      trustedVerifiers: [{ name: VERIFIER, version: VERSION }],
      loadArtifact: async () => ARTIFACT_CONTENT,
      verifyArtifact: async () => ({
        verifier: VERIFIER,
        version: VERSION,
        verifiedAt: VERIFIED_AT,
        result: 'pass',
      }),
    });

    expect(digestReads).toBe(1);
    expect(result.status).toBe('valid');
  });

  it('binds trusted verifier and attestation matching to the same nested claim reads', async () => {
    const envelope = capturedEnvelope();
    let verifierReads = 0;
    let versionReads = 0;
    let verifiedAtReads = 0;
    Object.defineProperties(envelope.verification, {
      verifier: {
        configurable: true,
        get() {
          verifierReads += 1;
          return verifierReads === 1 ? VERIFIER : 'other-verifier';
        },
      },
      version: {
        configurable: true,
        get() {
          versionReads += 1;
          return versionReads === 1 ? VERSION : '9.9.9';
        },
      },
      verifiedAt: {
        configurable: true,
        get() {
          verifiedAtReads += 1;
          return verifiedAtReads === 1 ? VERIFIED_AT : '2026-07-10T13:59:00.000Z';
        },
      },
    });

    const result = await validateEvidenceEnvelope(envelope, {
      now: NOW,
      trustedVerifiers: [{ name: VERIFIER, version: VERSION }],
      loadArtifact: async () => ARTIFACT_CONTENT,
      verifyArtifact: async () => ({
        verifier: VERIFIER,
        version: VERSION,
        verifiedAt: VERIFIED_AT,
        result: 'pass',
      }),
    });

    expect(verifierReads).toBe(1);
    expect(versionReads).toBe(1);
    expect(verifiedAtReads).toBe(1);
    expect(result.status).toBe('valid');
  });

  it('uses the validated artifact locator for the later loader call without rereading it', async () => {
    const envelope = capturedEnvelope();
    let locatorReads = 0;
    let loadedLocator: string | undefined;
    Object.defineProperty(envelope.artifact, 'locator', {
      configurable: true,
      get() {
        locatorReads += 1;
        return locatorReads === 1 ? LOCATOR : 'artifact://other/report.json';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, {
      now: NOW,
      trustedVerifiers: [{ name: VERIFIER, version: VERSION }],
      loadArtifact: async (locator) => {
        loadedLocator = locator;
        return ARTIFACT_CONTENT;
      },
      verifyArtifact: async () => ({
        verifier: VERIFIER,
        version: VERSION,
        verifiedAt: VERIFIED_AT,
        result: 'pass',
      }),
    });

    expect(locatorReads).toBe(1);
    expect(loadedLocator).toBe(LOCATOR);
    expect(result.status).toBe('valid');
  });
});
