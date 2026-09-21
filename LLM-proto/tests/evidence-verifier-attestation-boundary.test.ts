import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_SCHEMA_VERSION,
  validateEvidenceEnvelope,
  type CapturedAndVerifiedEvidenceEnvelope,
  type IndependentEvidenceVerification,
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

const matchingAttestation = {
  verifier: 'unzen-ci-evidence-verifier',
  version: '1.0.0',
  verifiedAt: '2026-07-10T13:05:00.000Z',
  result: 'pass' as const,
};

function baseOptions() {
  return {
    now: NOW,
    trustedVerifiers,
    loadArtifact: async () => ARTIFACT_CONTENT,
  } as const;
}

describe('independent verifier attestation runtime boundary', () => {
  it('fails closed when a verifier return getter throws', async () => {
    const hostileAttestation = new Proxy(matchingAttestation, {
      get(target, property, receiver) {
        if (property === 'verifier') {
          throw new Error('hostile verifier getter');
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...baseOptions(),
      verifyArtifact: async () => hostileAttestation,
    });

    expect(result.status).toBe('not-evaluated');
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'verification-execution-failed',
        path: '$.verification',
        message: expect.stringContaining('hostile verifier getter'),
      }),
    );
  });

  it('captures verifier attestation fields once and never re-reads caller getters', async () => {
    const reads = new Map<string, number>();
    const values: Record<string, unknown> = {
      ...matchingAttestation,
      reason: undefined,
    };
    const runtimeAttestation = {} as Record<string, unknown>;

    for (const property of ['verifier', 'version', 'verifiedAt', 'result', 'reason'] as const) {
      Object.defineProperty(runtimeAttestation, property, {
        enumerable: true,
        get() {
          const next = (reads.get(property) ?? 0) + 1;
          reads.set(property, next);
          if (next > 1) throw new Error(`${property} getter was re-read`);
          return values[property];
        },
      });
    }

    const result = await validateEvidenceEnvelope(createVerifiedEnvelope(), {
      ...baseOptions(),
      verifyArtifact: async () => runtimeAttestation as unknown as IndependentEvidenceVerification,
    });

    expect(result.status).toBe('valid');
    expect(result.issues).toEqual([]);
    expect(Object.fromEntries(reads)).toEqual({
      verifier: 1,
      version: 1,
      verifiedAt: 1,
      result: 1,
      reason: 1,
    });
  });
});
