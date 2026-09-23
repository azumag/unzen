import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleProductionProviderCanaryVerifierRequest } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-verifier.js';
import { PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';

const BASE = Date.parse('2026-08-20T04:45:00.000Z');
const VERIFIER = { verifierName: 'unzen-production-provider-canary-verifier', verifierVersion: '1.0.0' };

function payload() {
  const authorization = {
    authorizationId: 'auth-149', changeTicketId: 'CHG-149', authorizedAtMs: BASE - 1000, startsAtMs: BASE,
    expiresAtMs: BASE + 60_000, approvers: ['a', 'b'], providerName: 'provider-prod', accountId: 'acct-prod',
    primaryStorageId: 'primary', backupStorageId: 'backup', archiveId: 'archive-1', archiveContentDigest: 'c'.repeat(64),
    allowedActions: ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'],
    deploymentVersionIds: {}, deploymentConfigFingerprints: {},
  };
  const receipts = [
    { action: 'provider-health', idempotencyKey: 'k-health', operationId: 'health-1', observedAtMs: BASE + 1, status: 'success', providerName: 'provider-prod', accountId: 'acct-prod' },
    { action: 'provider-audit', idempotencyKey: 'k-audit', operationId: 'audit-1', observedAtMs: BASE + 2, status: 'success', providerName: 'provider-prod', accountId: 'acct-prod' },
    { action: 'primary-archive-retrieval', idempotencyKey: 'k-primary', operationId: 'primary-1', observedAtMs: BASE + 3, status: 'success', providerName: 'provider-prod', accountId: 'acct-prod', storageId: 'primary', archiveId: 'archive-1', observedContentDigest: 'c'.repeat(64), integrityStatus: 'pass' },
    { action: 'backup-archive-retrieval', idempotencyKey: 'k-backup', operationId: 'backup-1', observedAtMs: BASE + 4, status: 'success', providerName: 'provider-prod', accountId: 'acct-prod', storageId: 'backup', archiveId: 'archive-1', observedContentDigest: 'c'.repeat(64), integrityStatus: 'pass' },
    { action: 'pager-canary', idempotencyKey: 'k-page', operationId: 'page-1', observedAtMs: BASE + 5, status: 'success' },
    { action: 'pager-canary', idempotencyKey: 'k-page', operationId: 'page-1', observedAtMs: BASE + 6, status: 'deduplicated' },
  ];
  return {
    canaryRunId: 'provider-canary-1', startedAtMs: BASE, completedAtMs: BASE + 10,
    deploymentCanaryInputEvidence: { runId: 'deployment-canary-1' }, authorization, receipts,
    artifactLocator: '', artifactSha256: '', verifier: VERIFIER.verifierName, verifierVersion: VERIFIER.verifierVersion,
    verificationId: 'verify-1',
    negativeChecks: { unauthorizedActionRejected: true, expiredAuthorizationRejected: true, identityDriftRejected: true, digestMismatchRejected: true, pagerDuplicateSuppressed: true, selfReportedEvidenceRejected: true },
  } as any;
}

function artifactRecord(p: any) {
  return JSON.stringify({
    schema: 'unzen-continuous-assurance-production-provider-canary-v1',
    canaryRunId: p.canaryRunId,
    deploymentCanaryRunId: p.deploymentCanaryInputEvidence.runId,
    authorization: p.authorization,
    receipts: p.receipts,
    negativeChecks: p.negativeChecks,
  });
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

function malformedArtifactBytes(p: any): Uint8Array {
  const base = artifactRecord(p);
  return concatBytes(
    new TextEncoder().encode(`${base.slice(0, -1)},"note":"`),
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

function bomArtifactBytes(p: any): Uint8Array {
  return concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), new TextEncoder().encode(artifactRecord(p)));
}

function artifactEnvelope(p: any, sha: string) {
  return {
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    readinessStatus: 'production-candidate', runId: p.canaryRunId, artifact: { sha256: sha }, payload: p,
    verification: { verifier: VERIFIER.verifierName, version: VERIFIER.verifierVersion, verifiedAt: new Date(p.completedAtMs + 1000).toISOString(), result: 'pass' },
  };
}

function captureBody(p: any, sha: string) {
  return {
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    runId: p.canaryRunId, payload: p, requestedReadinessStatus: 'production-candidate', artifactLocator: 'r2://x', artifactSha256: sha,
  };
}

async function verifyArtifactBytes(p: any, bytes: Uint8Array) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
  return handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/artifact', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      envelope: artifactEnvelope(p, sha), actualSha256: sha, artifactContent: { kind: 'bytes', bytes: Array.from(bytes) },
    }),
  }), VERIFIER);
}

async function capture(p: any, sha: string) {
  return handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(captureBody(p, sha)),
  }), VERIFIER);
}

describe('production provider canary independent verifier', () => {
  it('accepts a bounded provider canary capture', async () => {
    const p = payload(); const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const response = await capture(p, sha);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass', readinessStatus: 'production-candidate' });
  });

  it('rejects malformed UTF-8 request JSON before semantic verification', async () => {
    const bytes = malformedRequestBytes();
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
    const response = await handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/capture', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes,
    }), VERIFIER);
    expect(response.status).toBe(400);
    expect(await response.json()).not.toHaveProperty('reason');
  });

  it('preserves UTF-8 BOM compatibility for request JSON', async () => {
    const p = payload(); const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const bytes = concatBytes(Uint8Array.of(0xef, 0xbb, 0xbf), new TextEncoder().encode(JSON.stringify(captureBody(p, sha))));
    const response = await handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/capture', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes,
    }), VERIFIER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass' });
  });

  it('re-verifies the exact artifact bytes and envelope attestation', async () => {
    const p = payload(); const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const envelope = artifactEnvelope(p, sha);
    const response = await handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/artifact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, actualSha256: sha, artifactContent: { kind: 'utf8', content: artifact } }),
    }), VERIFIER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass' });
  });

  it('rejects malformed UTF-8 artifact JSON after digest verification', async () => {
    const p = payload();
    const bytes = malformedArtifactBytes(p);
    expect(() => JSON.parse(new TextDecoder().decode(bytes))).not.toThrow();
    const response = await verifyArtifactBytes(p, bytes);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'provider-canary-artifact-json-invalid' });
  });

  it('preserves UTF-8 BOM compatibility for artifact JSON', async () => {
    const p = payload();
    const response = await verifyArtifactBytes(p, bomArtifactBytes(p));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass' });
  });

  it('rejects artifact digest tampering', async () => {
    const p = payload(); const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const envelope = artifactEnvelope(p, sha);
    const response = await handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/artifact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, actualSha256: sha, artifactContent: { kind: 'utf8', content: `${artifact}tampered` } }),
    }), VERIFIER);
    expect(response.status).toBe(409);
  });

  it('rejects a destructive or incomplete action allowlist', async () => {
    const p = payload(); p.authorization.allowedActions = ['provider-health', 'provider-keys-rotate'];
    const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const response = await capture(p, sha);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'provider-canary-action-allowlist-invalid' });
  });
});
