import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleContinuousAssuranceIndependentVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-independent-verifier.js';

const VERIFIER = { verifierName: 'strict-verifier', verifierVersion: '1.0.0' } as const;
const EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';
const RUN_ID = 'production-deployment-canary:strict-utf8';
const CAPTURED_AT_MS = Date.parse('2026-09-24T00:00:00.000Z');

function corruptMarker(bytes: Uint8Array, marker = 'X'.charCodeAt(0)): Uint8Array {
  const copy = bytes.slice();
  const index = copy.indexOf(marker);
  if (index < 0) throw new Error('test fixture marker was not encoded');
  copy[index] = 0xff;
  return copy;
}

function deployments() {
  return ['controller', 'runtime', 'engine', 'provider', 'evidence', 'pager', 'verifier'].map((role, index) => ({
    role,
    service: `service-${role}`,
    versionId: `version-${index}`,
    versionTimestamp: new Date(CAPTURED_AT_MS - index * 1_000).toISOString(),
    configFingerprintSha256: String(index + 1).repeat(64).slice(0, 64),
  }));
}

function engineBindings(items: ReturnType<typeof deployments>) {
  return Object.fromEntries(['provider', 'evidence', 'pager'].map((role) => {
    const item = items.find((deployment) => deployment.role === role)!;
    return [role, {
      service: item.service,
      versionId: item.versionId,
      configFingerprintSha256: item.configFingerprintSha256,
    }];
  }));
}

describe('continuous-assurance independent verifier UTF-8 boundaries', () => {
  it('rejects malformed UTF-8 request JSON before replacement decoding can normalize it', async () => {
    const bytes = corruptMarker(new TextEncoder().encode('{"X":1}'));
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();

    const response = await handleContinuousAssuranceIndependentVerifierRequest(new Request(
      'https://verifier.internal/verify/capture',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bytes as unknown as BodyInit,
      },
    ), VERIFIER);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'json-body-invalid' });
  });

  it('rejects a digest-matching deployment artifact with malformed UTF-8 as invalid JSON', async () => {
    const deployed = deployments();
    const triggerKey = 'artifact-X-marker';
    const runtimeResult = {
      status: 'idle',
      cycleId: 'schedule-1:strict-utf8',
      latestCycleRunId: null,
      latestAggregateRunId: null,
      actionIdempotencyKeys: [],
      runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false },
    };
    const artifactRecord = {
      schema: 'unzen-continuous-assurance-production-deployment-canary-v1',
      canaryRunId: RUN_ID,
      triggerKey,
      deployCommitSha: '0123456789abcdef0123456789abcdef01234567',
      deploymentManifestSha256: 'f'.repeat(64),
      deployments: deployed,
      engineBindings: engineBindings(deployed),
      runtimeResult,
      badDispatchSecretRejected: true,
      duplicateCompletedDispatchSuppressed: true,
    };
    const malformedArtifact = corruptMarker(new TextEncoder().encode(JSON.stringify(artifactRecord)));
    expect(() => JSON.parse(new TextDecoder().decode(malformedArtifact))).not.toThrow();
    const digest = createHash('sha256').update(malformedArtifact).digest('hex');
    const payload = {
      canaryRunId: RUN_ID,
      triggerKey,
      deployCommitSha: artifactRecord.deployCommitSha,
      deploymentManifestSha256: artifactRecord.deploymentManifestSha256,
      deployments: deployed,
      runtimeResult,
      negativeChecks: {
        badDispatchSecretRejected: true,
        duplicateCompletedDispatchSuppressed: true,
      },
      artifactSha256: digest,
      artifactLocator: 'r2://continuous-assurance-evidence/strict-utf8.json',
      capturedAtMs: CAPTURED_AT_MS,
    };
    const envelope = {
      evidenceKind: EVIDENCE_KIND,
      runId: RUN_ID,
      readinessStatus: 'production-candidate',
      artifact: { sha256: digest },
      payload,
      verification: {
        verifier: VERIFIER.verifierName,
        version: VERIFIER.verifierVersion,
        verifiedAt: new Date(CAPTURED_AT_MS + 1_000).toISOString(),
        result: 'pass',
      },
    };

    const response = await handleContinuousAssuranceIndependentVerifierRequest(new Request(
      'https://verifier.internal/verify/artifact',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          envelope,
          actualSha256: digest,
          artifactContent: { kind: 'bytes', bytes: Array.from(malformedArtifact) },
        }),
      },
    ), VERIFIER);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      result: 'fail',
      reason: 'deployment-canary-artifact-json-invalid',
    });
  });
});
