import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
  type EvidenceValidationOptions,
  type SyntheticEvidenceEnvelope,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';
const VERIFIER = 'unzen-ci-evidence-verifier';
const VERSION = '1.0.0';

function syntheticEnvelope(): SyntheticEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'validation-policy-snapshot',
    evidenceLevel: 'synthetic-fixture',
    readinessStatus: 'contract-tested',
    producer: { name: 'vitest', version: '4.1.7' },
    runId: 'validation-policy-snapshot-synthetic',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'node',
      runtimeVersion: '24',
      executionSurface: 'test-runner',
    },
    redaction: { applied: true, policyVersion: 'test-v1' },
    payload: { status: 'pass' },
  };
}

function capturedEnvelope(): CapturedAndVerifiedEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'validation-policy-snapshot',
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: {
      name: 'vitest',
      version: '4.1.7',
      commitSha: '0123456789abcdef0123456789abcdef01234567',
    },
    runId: 'validation-policy-snapshot-captured',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'chrome',
      runtimeVersion: '150.0.0.0',
      executionSurface: 'browser-document',
      os: { name: 'macOS', version: '15.5' },
      browser: { name: 'Chrome', version: '150.0.0.0' },
    },
    scenario: {
      feature: 'validation-policy-snapshot',
      scenario: 'single validation operation',
      expectedResult: 'caller envelope cannot rewrite validation policy',
    },
    artifact: {
      locator: 'artifact://validation-policy-snapshot/report.json',
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

describe('validateEvidenceEnvelope synchronous policy snapshot', () => {
  it('does not let envelope inspection broaden supported schema versions', async () => {
    const supportedSchemaVersions = [EVIDENCE_SCHEMA_VERSION];
    const options: EvidenceValidationOptions = {
      now: NOW,
      supportedSchemaVersions,
    };
    const envelope = syntheticEnvelope() as SyntheticEvidenceEnvelope<{ status: string }> & {
      evidenceLevel: 'synthetic-fixture';
    };
    envelope.schemaVersion = '2.0.0';
    Object.defineProperty(envelope, 'evidenceLevel', {
      configurable: true,
      get() {
        supportedSchemaVersions.push('2.0.0');
        return 'synthetic-fixture';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, options);

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'unsupported-schema-version', path: '$.schemaVersion' }),
    );
  });

  it('does not let envelope inspection broaden trusted verifier policy', async () => {
    const trustedVerifiers = [{ name: 'other-verifier', version: VERSION }];
    const options: EvidenceValidationOptions = {
      now: NOW,
      trustedVerifiers,
      loadArtifact: async () => {
        throw new Error('loader must not run after trust validation fails');
      },
      verifyArtifact: async () => {
        throw new Error('verifier must not run after trust validation fails');
      },
    };
    const envelope = capturedEnvelope();
    Object.defineProperty(envelope, 'evidenceLevel', {
      configurable: true,
      get() {
        trustedVerifiers.push({ name: VERIFIER, version: VERSION });
        return 'captured-and-verified';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, options);

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'untrusted-verifier', path: '$.verification.verifier' }),
    );
  });

  it('captures policy array membership and verifier entry fields once before envelope getters run', async () => {
    let schemaEntryReads = 0;
    const supportedSchemaVersions: string[] = [];
    Object.defineProperty(supportedSchemaVersions, '0', {
      configurable: true,
      enumerable: true,
      get() {
        schemaEntryReads += 1;
        if (schemaEntryReads > 1) throw new Error('schema policy entry must not be reread');
        return EVIDENCE_SCHEMA_VERSION;
      },
    });
    supportedSchemaVersions.length = 1;

    let verifierNameReads = 0;
    let verifierVersionReads = 0;
    const verifierEntry = {} as { name: string; version: string };
    Object.defineProperties(verifierEntry, {
      name: {
        configurable: true,
        enumerable: true,
        get() {
          verifierNameReads += 1;
          if (verifierNameReads > 1) throw new Error('verifier name must not be reread');
          return VERIFIER;
        },
      },
      version: {
        configurable: true,
        enumerable: true,
        get() {
          verifierVersionReads += 1;
          if (verifierVersionReads > 1) throw new Error('verifier version must not be reread');
          return VERSION;
        },
      },
    });
    const trustedVerifiers = [verifierEntry];

    const options: EvidenceValidationOptions = {
      now: NOW,
      supportedSchemaVersions,
      trustedVerifiers,
    };
    const envelope = capturedEnvelope();
    Object.defineProperty(envelope, 'evidenceLevel', {
      configurable: true,
      get() {
        supportedSchemaVersions.length = 0;
        trustedVerifiers.length = 0;
        return 'captured-and-verified';
      },
    });

    const result = await validateEvidenceEnvelope(envelope, options);

    expect(schemaEntryReads).toBe(1);
    expect(verifierNameReads).toBe(1);
    expect(verifierVersionReads).toBe(1);
    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'artifact-unavailable', path: '$.artifact.locator' }),
    );
  });

  it('keeps artifact callbacks lazy for synthetic evidence', async () => {
    const options: EvidenceValidationOptions = { now: NOW };
    let loaderReads = 0;
    let verifierReads = 0;
    Object.defineProperties(options, {
      loadArtifact: {
        configurable: true,
        get() {
          loaderReads += 1;
          throw new Error('synthetic evidence must not inspect loadArtifact');
        },
      },
      verifyArtifact: {
        configurable: true,
        get() {
          verifierReads += 1;
          throw new Error('synthetic evidence must not inspect verifyArtifact');
        },
      },
    });

    const result = await validateEvidenceEnvelope(syntheticEnvelope(), options);

    expect(loaderReads).toBe(0);
    expect(verifierReads).toBe(0);
    expect(result.status).toBe('valid');
  });
});
