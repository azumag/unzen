import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
  type EvidenceValidationOptions,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_CONTENT = 'verified artifact';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';
const VERIFIER = 'unzen-ci-evidence-verifier';
const VERSION = '1.0.0';
const VERIFIED_AT = '2026-07-10T13:05:00.000Z';

function envelope(): CapturedAndVerifiedEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'callback-reference-snapshot',
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: 'vitest',
      version: '4.1.7',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'callback-reference-snapshot-run',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'chrome',
      runtimeVersion: '150.0.0.0',
      executionSurface: 'browser-document',
      os: { name: 'macOS', version: '15.5' },
      browser: { name: 'Chrome', version: '150.0.0.0' },
    },
    scenario: {
      feature: 'callback-reference-snapshot',
      scenario: 'single-validation-operation',
      expectedResult: 'callbacks stay fixed across awaited runtime boundaries',
    },
    artifact: {
      locator: 'artifact://callback-reference-snapshot/report.json',
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

function passingAttestation() {
  return {
    verifier: VERIFIER,
    version: VERSION,
    verifiedAt: VERIFIED_AT,
    result: 'pass' as const,
  };
}

function baseOptions(): EvidenceValidationOptions {
  return {
    now: NOW,
    trustedVerifiers: [{ name: VERIFIER, version: VERSION }],
    verifyArtifact: async () => passingAttestation(),
  };
}

describe('validateEvidenceEnvelope callback-reference snapshots', () => {
  it('reads an accessor-backed artifact loader only once', async () => {
    const options = baseOptions();
    let reads = 0;
    Object.defineProperty(options, 'loadArtifact', {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error('loadArtifact getter must not be read twice');
        return async () => ARTIFACT_CONTENT;
      },
    });

    const result = await validateEvidenceEnvelope(envelope(), options);

    expect(reads).toBe(1);
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('fails closed when the artifact-loader getter throws', async () => {
    const options = baseOptions();
    let reads = 0;
    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('thrown value must not be inspected');
      },
      get() {
        throw new Error('thrown value must not be stringified');
      },
    });
    Object.defineProperty(options, 'loadArtifact', {
      configurable: true,
      get() {
        reads += 1;
        throw hostileThrownValue;
      },
    });

    const result = await validateEvidenceEnvelope(envelope(), options);

    expect(reads).toBe(1);
    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toEqual([
      {
        code: 'artifact-unavailable',
        path: '$.artifact.locator',
        message: 'captured-and-verified evidence requires an external artifact loader',
      },
    ]);
  });

  it('captures the independent verifier before the artifact loader can replace it', async () => {
    let originalCalls = 0;
    let replacementCalls = 0;
    const options = baseOptions();
    const originalVerifier = async () => {
      originalCalls += 1;
      return passingAttestation();
    };
    const replacementVerifier = async () => {
      replacementCalls += 1;
      return {
        ...passingAttestation(),
        result: 'fail' as const,
      };
    };
    options.verifyArtifact = originalVerifier;
    options.loadArtifact = async () => {
      options.verifyArtifact = replacementVerifier;
      return ARTIFACT_CONTENT;
    };

    const result = await validateEvidenceEnvelope(envelope(), options);

    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('reads an accessor-backed independent verifier only once before loading', async () => {
    const options = baseOptions();
    options.loadArtifact = async () => ARTIFACT_CONTENT;
    let reads = 0;
    Object.defineProperty(options, 'verifyArtifact', {
      configurable: true,
      get() {
        reads += 1;
        if (reads > 1) throw new Error('verifyArtifact getter must not be read twice');
        return async () => passingAttestation();
      },
    });

    const result = await validateEvidenceEnvelope(envelope(), options);

    expect(reads).toBe(1);
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });

  it('fails closed when the independent-verifier getter throws before loading', async () => {
    const options = baseOptions();
    let verifierReads = 0;
    let loaderCalls = 0;
    options.loadArtifact = async () => {
      loaderCalls += 1;
      return ARTIFACT_CONTENT;
    };
    const hostileThrownValue = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('thrown value must not be inspected');
      },
      get() {
        throw new Error('thrown value must not be stringified');
      },
    });
    Object.defineProperty(options, 'verifyArtifact', {
      configurable: true,
      get() {
        verifierReads += 1;
        throw hostileThrownValue;
      },
    });

    const result = await validateEvidenceEnvelope(envelope(), options);

    expect(verifierReads).toBe(1);
    expect(loaderCalls).toBe(0);
    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toEqual([
      {
        code: 'verification-unavailable',
        path: '$.verification',
        message: 'captured-and-verified evidence requires an independent verifier callback',
      },
    ]);
  });

  it('does not inspect artifact callbacks for synthetic evidence', async () => {
    const options = baseOptions();
    let loaderReads = 0;
    let verifierReads = 0;
    Object.defineProperty(options, 'loadArtifact', {
      configurable: true,
      get() {
        loaderReads += 1;
        throw new Error('synthetic evidence must not inspect loadArtifact');
      },
    });
    Object.defineProperty(options, 'verifyArtifact', {
      configurable: true,
      get() {
        verifierReads += 1;
        throw new Error('synthetic evidence must not inspect verifyArtifact');
      },
    });
    const synthetic = {
      ...envelope(),
      evidenceLevel: 'synthetic-fixture',
      readinessStatus: 'contract-tested',
    };

    const result = await validateEvidenceEnvelope(synthetic, options);

    expect(loaderReads).toBe(0);
    expect(verifierReads).toBe(0);
    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
  });
});
