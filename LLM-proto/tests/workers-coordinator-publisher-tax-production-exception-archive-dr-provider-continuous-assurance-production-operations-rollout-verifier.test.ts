import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
  type ProductionOperationsRolloutAuthorization,
  type ProductionOperationsRolloutPhasePayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.js';
import {
  handleProductionOperationsRolloutVerifierRequest,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-verifier.js';

const NOW = Date.parse('2026-08-20T06:00:00.000Z');
const VERIFIER = { verifierName: 'unzen-production-rollout-verifier', verifierVersion: '1.0.0' };
const DIGEST = 'c'.repeat(64);
const versions = { controller: 'v-controller', runtime: 'v-runtime', engine: 'v-engine', provider: 'v-provider', evidence: 'v-evidence', pager: 'v-pager', verifier: 'v-verifier' };
const fingerprints = { controller: '1'.repeat(64), runtime: '2'.repeat(64), engine: '3'.repeat(64), provider: '4'.repeat(64), evidence: '5'.repeat(64), pager: '6'.repeat(64), verifier: '7'.repeat(64) };

function authorization(): ProductionOperationsRolloutAuthorization {
  return {
    rolloutId: 'rollout-1', authorizationId: 'auth-1', changeTicketId: 'CHG-1', authorizedAtMs: NOW - 100_000,
    startsAtMs: NOW - 80_000, expiresAtMs: NOW + 500_000, approvers: ['a', 'b'], providerName: 'provider', accountId: 'account',
    primaryStorageId: 'primary', backupStorageId: 'backup', archiveId: 'archive', archiveContentDigest: DIGEST,
    deploymentVersionIds: versions, deploymentConfigFingerprints: fingerprints, rollbackControlId: 'rollback', emergencyHoldControlId: 'hold',
    phasePlan: [
      { phase: 'observe-only', sequence: 1, startsAtMs: NOW - 80_000, expiresAtMs: NOW + 10_000, minimumObservationMs: 40_000, maximumActions: 10 },
      { phase: 'maintenance-enabled', sequence: 2, startsAtMs: NOW + 10_000, expiresAtMs: NOW + 100_000, minimumObservationMs: 40_000, maximumActions: 12 },
      { phase: 'dr-exercise-enabled', sequence: 3, startsAtMs: NOW + 100_000, expiresAtMs: NOW + 200_000, minimumObservationMs: 40_000, maximumActions: 12 },
      { phase: 'steady-state-enabled', sequence: 4, startsAtMs: NOW + 200_000, expiresAtMs: NOW + 300_000, minimumObservationMs: 40_000, maximumActions: 10 },
    ],
    maintenance: { required: true, authorizationId: 'rotation-auth', rotationDueAtMs: NOW + 60_000, previousCredentialSetId: 'cred-old', previousSigningKeyId: 'sign-old', previousEncryptionKeyId: 'enc-old' },
    drExercise: { authorizationId: 'dr-auth', changeWindowStartMs: NOW + 120_000, changeWindowEndMs: NOW + 180_000 },
  };
}

function payload(): ProductionOperationsRolloutPhasePayload {
  const auth = authorization();
  return {
    rolloutId: auth.rolloutId, authorizationId: auth.authorizationId, phase: 'observe-only', sequence: 1,
    providerCanaryRunId: 'provider-canary-1', providerCanaryArtifactSha256: 'd'.repeat(64), startedAtMs: NOW - 70_000,
    completedAtMs: NOW - 20_000, actionBudget: 10, observedActionCount: 5, replayCount: 0,
    executedActions: ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'],
    actionIdempotencyKeys: ['k1', 'k2', 'k3', 'k4', 'k5'],
    identity: { providerName: auth.providerName, accountId: auth.accountId, primaryStorageId: auth.primaryStorageId,
      backupStorageId: auth.backupStorageId, archiveId: auth.archiveId, archiveContentDigest: auth.archiveContentDigest,
      deploymentVersionIds: auth.deploymentVersionIds, deploymentConfigFingerprints: auth.deploymentConfigFingerprints },
    slo: { operationCount: 20, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0,
      providerAvailabilityPct: 100, minimumProviderAvailabilityPct: 99, allowedFailureBudget: 3, remainingFailureBudget: 3 },
    alerts: [], incidents: [], controlInvocations: [], capturedAtMs: NOW - 20_000,
  };
}

function receipts() {
  return payload().executedActions.map((action, index) => ({
    action, idempotencyKey: `k${index + 1}`, operationId: `op-${index + 1}`, observedAtMs: NOW - 20_000, status: 'success' as const,
  }));
}

function stable(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(sort(value));
}

function captureBody() {
  return { evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
    runId: 'rollout-1:1:observe-only', requestedReadinessStatus: 'production-approved', artifactSha256: 'a'.repeat(64),
    payload: payload(), authorization: authorization(), actionReceipts: receipts() };
}

function artifactRecord(body: any) {
  return { schema: 'unzen-continuous-assurance-production-rollout-phase-v1', runId: body.runId,
    authorization: body.authorization, payload: body.payload, actionReceipts: body.actionReceipts };
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function malformedArtifactBytes(body: any): Uint8Array {
  const content = stable(artifactRecord(body));
  return concatBytes(
    new TextEncoder().encode(`${content.slice(0, -1)},"note":"`),
    Uint8Array.of(0xc3, 0x28),
    new TextEncoder().encode('"}'),
  );
}

function malformedRequestBytes(): Uint8Array {
  return concatBytes(
    new TextEncoder().encode('{"note":"'),
    Uint8Array.of(0xc3, 0x28),
    new TextEncoder().encode('"}'),
  );
}

function bomArtifactBytes(body: any): Uint8Array {
  return concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), new TextEncoder().encode(stable(artifactRecord(body))));
}

function artifactEnvelope(body: any, sha: string) {
  return { schemaVersion: '1.0.0', evidenceKind: body.evidenceKind, evidenceLevel: 'captured-and-verified', readinessStatus: 'production-approved',
    producer: { name: 'controller', version: '1.0.0', commitSha: 'a'.repeat(40) }, runId: body.runId,
    capturedAt: new Date(body.payload.completedAtMs).toISOString(), environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'rollout' },
    artifact: { locator: 'r2://continuous-assurance-evidence/test.json', sha256: sha },
    verification: { verifier: VERIFIER.verifierName, version: VERIFIER.verifierVersion, verifiedAt: new Date(body.payload.completedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true }, payload: body.payload };
}

async function verifyArtifactBytes(body: any, bytes: Uint8Array) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  return handleProductionOperationsRolloutVerifierRequest(new Request('https://rollout-verifier.internal/verify/artifact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      envelope: artifactEnvelope(body, sha), actualSha256: sha, artifactContent: { kind: 'bytes', bytes: Array.from(bytes) },
    }),
  }), VERIFIER);
}

async function capture() {
  const body = captureBody();
  const response = await handleProductionOperationsRolloutVerifierRequest(new Request('https://rollout-verifier.internal/verify/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), VERIFIER);
  return { response, body };
}

describe('production operations rollout verifier', () => {
  it('accepts a clean independently checked phase capture', async () => {
    const { response } = await capture();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass', readinessStatus: 'production-approved', runId: 'rollout-1:1:observe-only' });
  });

  it('rejects malformed UTF-8 request JSON before semantic verification', async () => {
    const bytes = malformedRequestBytes();
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
    const response = await handleProductionOperationsRolloutVerifierRequest(new Request('https://rollout-verifier.internal/verify/capture', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes,
    }), VERIFIER);
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty('reason');
  });

  it('preserves UTF-8 BOM compatibility for request JSON', async () => {
    const body = captureBody();
    const bytes = concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), new TextEncoder().encode(JSON.stringify(body)));
    const response = await handleProductionOperationsRolloutVerifierRequest(new Request('https://rollout-verifier.internal/verify/capture', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes,
    }), VERIFIER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass' });
  });

  it('rejects an artifact digest mismatch', async () => {
    const { body } = await capture();
    const content = stable(artifactRecord(body));
    const sha = createHash('sha256').update(content).digest('hex');
    const envelope = artifactEnvelope(body, sha);
    const response = await handleProductionOperationsRolloutVerifierRequest(new Request('https://rollout-verifier.internal/verify/artifact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, actualSha256: 'f'.repeat(64), artifactContent: { kind: 'utf8', content } }),
    }), VERIFIER);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'production-rollout-artifact-digest-invalid' });
  });

  it('rejects malformed UTF-8 artifact JSON after digest verification', async () => {
    const { body } = await capture();
    const bytes = malformedArtifactBytes(body);
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
    const response = await verifyArtifactBytes(body, bytes);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'production-rollout-artifact-json-invalid' });
  });

  it('preserves UTF-8 BOM compatibility for artifact JSON', async () => {
    const { body } = await capture();
    const response = await verifyArtifactBytes(body, bomArtifactBytes(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass' });
  });

  it('rejects action receipt binding drift', async () => {
    const { body } = await capture();
    body.actionReceipts[0].idempotencyKey = 'wrong-key';
    const response = await handleProductionOperationsRolloutVerifierRequest(new Request('https://rollout-verifier.internal/verify/capture', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), VERIFIER);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'production-rollout-action-receipt-invalid:provider-health' });
  });
});
