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

async function capture(p: any, sha: string) {
  return handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/capture', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
      runId: p.canaryRunId, payload: p, requestedReadinessStatus: 'production-candidate', artifactLocator: 'r2://x', artifactSha256: sha,
    }),
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

  it('re-verifies the exact artifact bytes and envelope attestation', async () => {
    const p = payload(); const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const verifiedAt = new Date(p.completedAtMs + 1000).toISOString();
    const envelope = { evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, readinessStatus: 'production-candidate', runId: p.canaryRunId, artifact: { sha256: sha }, payload: p, verification: { verifier: VERIFIER.verifierName, version: VERIFIER.verifierVersion, verifiedAt, result: 'pass' } };
    const response = await handleProductionProviderCanaryVerifierRequest(new Request('https://verifier.internal/verify/artifact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope, actualSha256: sha, artifactContent: { kind: 'utf8', content: artifact } }),
    }), VERIFIER);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: 'pass' });
  });

  it('rejects artifact digest tampering', async () => {
    const p = payload(); const artifact = artifactRecord(p); const sha = createHash('sha256').update(artifact).digest('hex');
    p.artifactLocator = 'r2://x'; p.artifactSha256 = sha;
    const envelope = { evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, readinessStatus: 'production-candidate', runId: p.canaryRunId, artifact: { sha256: sha }, payload: p, verification: { verifier: VERIFIER.verifierName, version: VERIFIER.verifierVersion, verifiedAt: new Date(p.completedAtMs + 1000).toISOString(), result: 'pass' } };
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
