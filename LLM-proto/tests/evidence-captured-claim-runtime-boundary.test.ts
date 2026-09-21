import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const VERIFIER = 'unzen-ci-evidence-verifier';
const VERSION = '1.0.0';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';

function envelope(): CapturedAndVerifiedEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'captured-claim-runtime-boundary',
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: 'vitest',
      version: '4.1.7',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'captured-claim-runtime-boundary-run',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'chrome',
      runtimeVersion: '150.0.0.0',
      executionSurface: 'browser-document',
      os: { name: 'macOS', version: '15.5' },
      browser: { name: 'Chrome', version: '150.0.0.0' },
    },
    scenario: {
      feature: 'captured-claim-runtime-boundary',
      scenario: 'bounded-property-capture',
      expectedResult: 'hostile claim getters fail closed',
    },
    artifact: {
      locator: 'artifact://captured-claim-runtime-boundary/report.json',
      sha256: ARTIFACT_SHA256,
      expiresAt: '2026-07-11T13:00:00.000Z',
    },
    verification: {
      verifier: VERIFIER,
      version: VERSION,
      verifiedAt: '2026-07-10T13:05:00.000Z',
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'test-v1' },
    payload: { status: 'pass' },
  };
}

function hostileThrownValue(): object {
  return new Proxy({}, {
    getPrototypeOf() {
      throw new Error('thrown value must not be inspected');
    },
    get() {
      throw new Error('thrown value must not be stringified');
    },
  });
}

const options = {
  now: NOW,
  trustedVerifiers: [{ name: VERIFIER, version: VERSION }],
} as const;

describe('validateEvidenceEnvelope captured-claim runtime boundary', () => {
  it.each([
    ['artifact', 'missing-artifact', '$.artifact', 'artifact is required'],
    ['verification', 'missing-verification', '$.verification', 'verification is required'],
  ] as const)('fails closed when the top-level %s getter throws', async (field, code, path, message) => {
    const input = envelope();
    let reads = 0;
    Object.defineProperty(input, field, {
      configurable: true,
      get() {
        reads += 1;
        throw hostileThrownValue();
      },
    });

    const result = await validateEvidenceEnvelope(input, options);

    expect(reads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual({ code, path, message });
  });

  it.each([
    ['locator', 'invalid-envelope', '$.artifact.locator', 'locator must be a non-empty string'],
    ['sha256', 'invalid-artifact-digest', '$.artifact.sha256', 'sha256 must be a hexadecimal SHA-256 digest'],
    ['expiresAt', 'invalid-timestamp', '$.artifact.expiresAt', 'expiresAt must be a valid timestamp'],
  ] as const)('fails closed when artifact.%s throws', async (field, code, path, message) => {
    const input = envelope();
    const artifact = input.artifact;
    let reads = 0;
    Object.defineProperty(artifact, field, {
      configurable: true,
      get() {
        reads += 1;
        throw hostileThrownValue();
      },
    });

    const result = await validateEvidenceEnvelope(input, options);

    expect(reads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual({ code, path, message });
  });

  it.each([
    ['verifier', 'invalid-envelope', '$.verification.verifier', 'verifier must be a non-empty string'],
    ['version', 'invalid-envelope', '$.verification.version', 'version must be a non-empty string'],
    ['verifiedAt', 'invalid-timestamp', '$.verification.verifiedAt', 'verifiedAt must be a valid timestamp'],
    ['result', 'verification-failed', '$.verification.result', 'verification must pass'],
  ] as const)('fails closed when verification.%s throws', async (field, code, path, message) => {
    const input = envelope();
    const verification = input.verification;
    let reads = 0;
    Object.defineProperty(verification, field, {
      configurable: true,
      get() {
        reads += 1;
        throw hostileThrownValue();
      },
    });

    const result = await validateEvidenceEnvelope(input, options);

    expect(reads).toBe(1);
    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual({ code, path, message });
  });
});
