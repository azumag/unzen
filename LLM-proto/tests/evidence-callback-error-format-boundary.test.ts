import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
} from '../src/evidence.js';

const NOW = '2026-07-10T14:00:00.000Z';
const ARTIFACT_CONTENT = 'verified artifact';
const ARTIFACT_SHA256 = '2127de9293abf1503418b9f78b3d530cdd2263417064815ee46b7ecdf1215ddc';

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
    runId: 'browser-run-1',
    capturedAt: '2026-07-10T13:00:00.000Z',
    environment: {
      runtime: 'chrome',
      runtimeVersion: '150.0.0.0',
      executionSurface: 'browser-document',
      os: { name: 'macOS', version: '15.5' },
      browser: { name: 'Chrome', version: '150.0.0.0' },
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
    redaction: { applied: true, policyVersion: 'browser-evidence-v1' },
    payload: { status: 'pass' },
  };
}

const trustedVerifiers = [
  {
    name: 'unzen-ci-evidence-verifier',
    version: '1.0.0',
  },
] as const;

describe('evidence callback error formatting boundary', () => {
  it('fails closed when the artifact loader throws a value whose prototype trap throws', async () => {
    const hostileThrownValue = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile prototype trap');
        },
      },
    );

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      now: NOW,
      trustedVerifiers,
      loadArtifact: async () => {
        throw hostileThrownValue;
      },
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'artifact-load-failed',
        path: '$.artifact.locator',
        message: expect.stringContaining('uninspectable thrown value'),
      }),
    );
  });

  it('fails closed when the verifier throws a value whose primitive conversion throws', async () => {
    const hostileThrownValue = {
      [Symbol.toPrimitive]() {
        throw new Error('hostile primitive conversion');
      },
      toString() {
        throw new Error('hostile toString');
      },
    };

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      now: NOW,
      trustedVerifiers,
      loadArtifact: async () => ARTIFACT_CONTENT,
      verifyArtifact: async () => {
        throw hostileThrownValue;
      },
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'verification-execution-failed',
        path: '$.verification',
        message: expect.stringContaining('uninspectable thrown value'),
      }),
    );
  });

  it('preserves a normal Error message when safe to inspect', async () => {
    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      now: NOW,
      trustedVerifiers,
      loadArtifact: async () => {
        throw new Error('ordinary loader failure');
      },
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'artifact-load-failed',
        message: expect.stringContaining('ordinary loader failure'),
      }),
    );
  });
});
