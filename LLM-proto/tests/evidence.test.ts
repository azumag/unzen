import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
  type SyntheticEvidenceEnvelope,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_CONTENT = 'verified artifact';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';

function createSyntheticEnvelope(
  overrides: Partial<SyntheticEvidenceEnvelope<{ status: string }>> = {},
): SyntheticEvidenceEnvelope<{ status: string }> {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    evidenceKind: 'unit-test-contract',
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
    payload: {
      status: 'pass',
    },
    ...overrides,
  };
}

function createVerifiedEnvelope(
  overrides: Partial<CapturedAndVerifiedEvidenceEnvelope<{ status: string }>> = {},
): CapturedAndVerifiedEvidenceEnvelope<{ status: string }> {
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
    runId: 'browser-run-1',
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
      locator: 'artifact://browser-run-1/report.json',
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
    payload: {
      status: 'pass',
    },
    ...overrides,
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
    expect(locator).toBe('artifact://browser-run-1/report.json');
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

describe('validateEvidenceEnvelope', () => {
  it('keeps a passing unit test at contract-tested readiness', async () => {
    const result = await validateEvidenceEnvelope(createSyntheticEnvelope(), { now: NOW });

    expect(result.status).toBe('valid');
    expect(result.effectiveEvidenceLevel).toBe('synthetic-fixture');
    expect(result.effectiveReadinessStatus).toBe('contract-tested');
    expect(evidenceSupportsReadiness(result)).toBe(false);
  });

  it('rejects a synthetic fixture that claims production readiness', async () => {
    const input = {
      ...createSyntheticEnvelope(),
      readinessStatus: 'production-candidate',
    };

    const result = await validateEvidenceEnvelope(input, { now: NOW });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'readiness-exceeds-evidence-level',
      }),
    );
    expect(evidenceSupportsReadiness(result)).toBe(false);
  });

  it('does not trust a hand-written captured-and-verified literal without an artifact loader', async () => {
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      now: NOW,
      trustedVerifiers: verificationOptions.trustedVerifiers,
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.effectiveEvidenceLevel).toBeUndefined();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'artifact-unavailable',
      }),
    );
    expect(evidenceSupportsReadiness(result)).toBe(false);
  });

  it('does not accept a matching digest without an independent verifier callback', async () => {
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      now: NOW,
      trustedVerifiers: verificationOptions.trustedVerifiers,
      loadArtifact: verificationOptions.loadArtifact,
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'verification-unavailable',
      }),
    );
    expect(evidenceSupportsReadiness(result)).toBe(false);
  });

  it('accepts captured evidence only after trusted verifier, freshness, digest, and attestation checks pass', async () => {
    const result = await validateEvidenceEnvelope(
      createVerifiedEnvelope(),
      verificationOptions,
    );

    expect(result.status).toBe('valid');
    expect(result.effectiveEvidenceLevel).toBe('captured-and-verified');
    expect(result.effectiveReadinessStatus).toBe('production-candidate');
    expect(result.issues).toEqual([]);
    expect(evidenceSupportsReadiness(result)).toBe(true);
  });

  it('rejects an independent attestation that does not match the envelope', async () => {
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      verifyArtifact: async () => ({
        verifier: 'unzen-ci-evidence-verifier',
        version: '1.0.0',
        verifiedAt: '2026-07-10T13:06:00.000Z',
        result: 'pass',
      }),
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'verification-attestation-mismatch',
      }),
    );
  });

  it('rejects a digest mismatch even when the envelope claims verification passed', async () => {
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      loadArtifact: async () => 'tampered artifact',
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'artifact-digest-mismatch',
      }),
    );
    expect(evidenceSupportsReadiness(result)).toBe(false);
  });

  it('fails closed when the artifact loader returns a Proxy-wrapped Uint8Array', async () => {
    const proxied = new Proxy(new TextEncoder().encode(ARTIFACT_CONTENT), {});
    let verifierCalled = false;

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      loadArtifact: async () => proxied as unknown as Uint8Array,
      verifyArtifact: async () => {
        verifierCalled = true;
        return {
          verifier: 'unzen-ci-evidence-verifier',
          version: '1.0.0',
          verifiedAt: '2026-07-10T13:05:00.000Z',
          result: 'pass' as const,
        };
      },
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'artifact-load-failed',
      }),
    );
    expect(verifierCalled).toBe(false);
  });

  it('copies hostile Uint8Array subclasses without invoking caller-defined byte hooks', async () => {
    class HostileBytes extends Uint8Array {}

    const hooks = {
      byteLength: 0,
      buffer: 0,
      byteOffset: 0,
      slice: 0,
      iterator: 0,
      constructor: 0,
    };
    const hostile = new HostileBytes(new TextEncoder().encode(ARTIFACT_CONTENT));
    Object.defineProperties(hostile, {
      byteLength: {
        get() {
          hooks.byteLength += 1;
          throw new Error('byteLength hook must not run');
        },
      },
      buffer: {
        get() {
          hooks.buffer += 1;
          throw new Error('buffer hook must not run');
        },
      },
      byteOffset: {
        get() {
          hooks.byteOffset += 1;
          throw new Error('byteOffset hook must not run');
        },
      },
      slice: {
        value() {
          hooks.slice += 1;
          throw new Error('slice hook must not run');
        },
      },
      constructor: {
        get() {
          hooks.constructor += 1;
          throw new Error('constructor hook must not run');
        },
      },
    });
    Object.defineProperty(hostile, Symbol.iterator, {
      value() {
        hooks.iterator += 1;
        throw new Error('iterator hook must not run');
      },
    });

    let verifierContent: unknown;
    let verifierSha256: string | undefined;
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      loadArtifact: async () => hostile,
      verifyArtifact: async ({ artifactContent, actualSha256 }) => {
        verifierContent = artifactContent;
        verifierSha256 = actualSha256;
        return {
          verifier: 'unzen-ci-evidence-verifier',
          version: '1.0.0',
          verifiedAt: '2026-07-10T13:05:00.000Z',
          result: 'pass' as const,
        };
      },
    });

    expect(result.status).toBe('valid');
    expect(verifierSha256).toBe(ARTIFACT_SHA256);
    expect(verifierContent).toBeInstanceOf(Uint8Array);
    expect(verifierContent).not.toBe(hostile);
    expect(Object.getPrototypeOf(verifierContent)).toBe(Uint8Array.prototype);
    expect(new TextDecoder().decode(verifierContent as Uint8Array)).toBe(ARTIFACT_CONTENT);
    expect(hooks).toEqual({
      byteLength: 0,
      buffer: 0,
      byteOffset: 0,
      slice: 0,
      iterator: 0,
      constructor: 0,
    });
  });

  it('passes the same owned ArrayBuffer snapshot bytes to digest and independent verification', async () => {
    const sourceBytes = new TextEncoder().encode(ARTIFACT_CONTENT);
    const sourceBuffer = sourceBytes.buffer.slice(
      sourceBytes.byteOffset,
      sourceBytes.byteOffset + sourceBytes.byteLength,
    ) as ArrayBuffer;

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      loadArtifact: async () => sourceBuffer,
      verifyArtifact: async ({ artifactContent, actualSha256 }) => {
        new Uint8Array(sourceBuffer).fill(0);
        expect(actualSha256).toBe(ARTIFACT_SHA256);
        expect(artifactContent).toBeInstanceOf(Uint8Array);
        expect(new TextDecoder().decode(artifactContent as Uint8Array)).toBe(ARTIFACT_CONTENT);
        return {
          verifier: 'unzen-ci-evidence-verifier',
          version: '1.0.0',
          verifiedAt: '2026-07-10T13:05:00.000Z',
          result: 'pass' as const,
        };
      },
    });

    expect(result.status).toBe('valid');
  });

  it('fails closed when the artifact loader returns detached bytes', async () => {
    const detached = new TextEncoder().encode(ARTIFACT_CONTENT);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      loadArtifact: async () => detached,
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'artifact-load-failed',
      }),
    );
  });

  it('rejects expired captured evidence', async () => {
    const result = await validateEvidenceEnvelope(
      createVerifiedEnvelope({
        artifact: {
          locator: 'artifact://browser-run-1/report.json',
          sha256: ARTIFACT_SHA256,
          expiresAt: '2026-07-10T13:59:59.000Z',
        },
      }),
      verificationOptions,
    );

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'expired-artifact',
      }),
    );
  });

  it('rejects an unsupported schema version', async () => {
    const result = await validateEvidenceEnvelope(
      createVerifiedEnvelope({ schemaVersion: '2.0.0' }),
      verificationOptions,
    );

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-schema-version',
      }),
    );
  });

  it('rejects a verifier that is not explicitly trusted', async () => {
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...verificationOptions,
      trustedVerifiers: [],
    });

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'untrusted-verifier',
      }),
    );
  });

  it('requires browser metadata for captured browser execution evidence', async () => {
    const result = await validateEvidenceEnvelope(
      createVerifiedEnvelope({
        environment: {
          runtime: 'chrome',
          runtimeVersion: '150.0.0.0',
          executionSurface: 'browser-document',
          os: {
            name: 'macOS',
            version: '15.5',
          },
        },
      }),
      verificationOptions,
    );

    expect(result.status).toBe('invalid');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'missing-browser-metadata',
      }),
    );
  });
});
