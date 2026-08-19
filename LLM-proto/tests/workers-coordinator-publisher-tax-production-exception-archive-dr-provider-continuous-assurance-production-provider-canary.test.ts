import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import {
  CONTINUOUS_ASSURANCE_ENGINE_SERVICE,
  CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE,
  CONTINUOUS_ASSURANCE_RUNTIME_SERVICE,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
  type ContinuousAssuranceDeploymentServiceRole,
  type ContinuousAssuranceProductionDeploymentCanaryPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';
import {
  CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE,
  CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate,
  type ProductionProviderCanaryPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';

const BASE = Date.parse('2026-08-20T04:00:00.000Z');
const DEPLOY_ARTIFACT = 'deployment artifact';
const PROVIDER_ARTIFACT = 'provider canary artifact';
const DEPLOY_SHA = createHash('sha256').update(DEPLOY_ARTIFACT).digest('hex');
const PROVIDER_SHA = createHash('sha256').update(PROVIDER_ARTIFACT).digest('hex');
const COMMIT = 'a'.repeat(40);
const MANIFEST = 'b'.repeat(64);
const VERIFIER = 'unzen-independent-evidence-verifier';
const ROLES: readonly [ContinuousAssuranceDeploymentServiceRole, string][] = [
  ['controller', CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE],
  ['runtime', CONTINUOUS_ASSURANCE_RUNTIME_SERVICE],
  ['engine', CONTINUOUS_ASSURANCE_ENGINE_SERVICE],
  ['provider', CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE],
  ['evidence', CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE],
  ['pager', CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE],
  ['verifier', CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE],
];
const fingerprints = Object.fromEntries(ROLES.map(([role], i) => [role, String(i + 1).repeat(64).slice(0, 64)])) as Record<ContinuousAssuranceDeploymentServiceRole, string>;

function deploymentEvidence(): EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload> {
  const scheduledTimeMs = BASE - 60_000;
  const completedAtMs = scheduledTimeMs + 2;
  const payload: ContinuousAssuranceProductionDeploymentCanaryPayload = {
    scope: 'publisher-tax-exception-archive-dr',
    cron: 'deployment-canary-idle',
    scheduledTimeMs,
    triggerKey: `publisher-tax-exception-archive-dr:deployment-canary-idle:${scheduledTimeMs}`,
    canaryRunId: `production-deployment-canary:${scheduledTimeMs}`,
    startedAtMs: scheduledTimeMs,
    completedAtMs,
    deployCommitSha: COMMIT,
    deploymentManifestSha256: MANIFEST,
    deployments: ROLES.map(([role, service], i) => ({
      role,
      service,
      versionId: `version-${role}-${i}-12345678`,
      versionTag: `tag-${i}`,
      versionTimestamp: new Date(scheduledTimeMs - 1_000).toISOString(),
      configFingerprintSha256: fingerprints[role],
    })),
    runtimeResult: {
      status: 'idle',
      triggerKey: `publisher-tax-exception-archive-dr:deployment-canary-idle:${scheduledTimeMs}`,
      cycleId: 'schedule-1:next',
      failureReason: null,
      actionIdempotencyKeys: [],
      latestCycleRunId: null,
      latestAggregateRunId: null,
      runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false },
    },
    artifactLocator: 'r2://continuous-assurance-evidence/deployment.json',
    artifactSha256: DEPLOY_SHA,
    verificationId: 'deploy-verification',
    verifier: VERIFIER,
    verifierVersion: '1.0.0',
    negativeChecks: {
      badDispatchSecretRejected: true,
      duplicateCompletedDispatchSuppressed: true,
      versionOrConfigMismatchRejected: true,
      digestMismatchRejected: true,
      untrustedVerifierRejected: true,
    },
    capturedAtMs: completedAtMs,
  };
  return {
    schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified', readinessStatus: 'production-candidate',
    producer: { name: CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE, version: '1.0.0', commitSha: COMMIT },
    runId: payload.canaryRunId, capturedAt: new Date(completedAtMs).toISOString(),
    environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'deployment-canary', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: 'deployment-canary', scenario: payload.canaryRunId, expectedResult: 'pass' },
    artifact: { locator: payload.artifactLocator, sha256: DEPLOY_SHA, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(completedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'deployment-v1' }, payload,
  };
}

function providerPayload(overrides: Partial<ProductionProviderCanaryPayload> = {}): ProductionProviderCanaryPayload {
  const deploy = deploymentEvidence();
  const versions = Object.fromEntries(deploy.payload.deployments.map((d) => [d.role, d.versionId])) as Record<ContinuousAssuranceDeploymentServiceRole, string>;
  const auth = {
    authorizationId: 'auth-provider-canary-1', changeTicketId: 'CHG-149', authorizedAtMs: BASE - 10_000,
    startsAtMs: BASE, expiresAtMs: BASE + 60_000, approvers: ['operator-a', 'operator-b'],
    providerName: 'provider-prod', accountId: 'acct-prod', primaryStorageId: 'storage-primary',
    backupStorageId: 'storage-backup', archiveId: 'archive-1', archiveContentDigest: 'c'.repeat(64),
    allowedActions: ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'] as const,
    deploymentVersionIds: versions, deploymentConfigFingerprints: fingerprints,
  };
  const receipt = (action: any, offset: number, extra: Record<string, unknown> = {}) => ({
    action, idempotencyKey: `provider-canary-1:${action}`, operationId: `op-${action}-${offset}`,
    observedAtMs: BASE + offset, status: 'success' as const, providerName: 'provider-prod', accountId: 'acct-prod', ...extra,
  });
  return {
    canaryRunId: 'production-provider-canary-1', startedAtMs: BASE, completedAtMs: BASE + 10_000,
    deploymentCanaryInputEvidence: deploy, authorization: auth,
    receipts: [
      receipt('provider-health', 1_000),
      receipt('provider-audit', 2_000),
      receipt('primary-archive-retrieval', 3_000, { storageId: 'storage-primary', archiveId: 'archive-1', observedContentDigest: 'c'.repeat(64), integrityStatus: 'pass' }),
      receipt('backup-archive-retrieval', 4_000, { storageId: 'storage-backup', archiveId: 'archive-1', observedContentDigest: 'c'.repeat(64), integrityStatus: 'pass' }),
      receipt('pager-canary', 5_000, { providerName: undefined, accountId: undefined, pagerDeliveryId: 'page-1' }),
      { ...receipt('pager-canary', 6_000, { providerName: undefined, accountId: undefined }), status: 'deduplicated' as const, idempotencyKey: 'provider-canary-1:pager-canary' },
    ],
    artifactLocator: 'r2://continuous-assurance-evidence/provider-canary.json', artifactSha256: PROVIDER_SHA,
    verifier: VERIFIER, verifierVersion: '1.0.0', verificationId: 'provider-verification-1',
    negativeChecks: { unauthorizedActionRejected: true, expiredAuthorizationRejected: true, identityDriftRejected: true, digestMismatchRejected: true, pagerDuplicateSuppressed: true, selfReportedEvidenceRejected: true },
    ...overrides,
  };
}

function providerEnvelope(payload = providerPayload()): EvidenceEnvelope<ProductionProviderCanaryPayload> {
  return {
    schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified', readinessStatus: 'production-candidate', producer: { name: 'provider-canary-controller', version: '1.0.0', commitSha: COMMIT },
    runId: payload.canaryRunId, capturedAt: new Date(payload.completedAtMs).toISOString(),
    environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'provider-canary', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: 'provider-canary', scenario: payload.canaryRunId, expectedResult: 'bounded provider canary passes' },
    artifact: { locator: payload.artifactLocator, sha256: PROVIDER_SHA, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(payload.completedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'provider-canary-v1' }, payload,
  };
}

function validation(artifact: string, value: EvidenceEnvelope<any>): EvidenceValidationOptions {
  return { now: BASE + 30_000, trustedVerifiers: [{ name: VERIFIER, version: '1.0.0' }], loadArtifact: async () => artifact, verifyArtifact: async () => ({ ...value.verification! }) };
}

async function run(value = providerEnvelope()) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate({
    canaryEvidence: value, evidenceValidationOptions: validation(PROVIDER_ARTIFACT, value),
    deploymentEvidenceValidationOptions: validation(DEPLOY_ARTIFACT, value.payload.deploymentCanaryInputEvidence),
    expectedDeployCommitSha: COMMIT, expectedDeploymentManifestSha256: MANIFEST,
    expectedConfigFingerprints: fingerprints, expectedVerifierName: VERIFIER,
  });
}

describe('continuous assurance production provider canary gate', () => {
  it('promotes a bounded captured-and-verified provider canary', async () => {
    const report = await run();
    expect(report.status).toBe('pass');
    expect(report.bottlenecksToIssue).toEqual([PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK]);
  });
  it('rejects self-reported provider canary evidence', async () => {
    const value = providerEnvelope();
    const bad = { ...value, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', artifact: undefined, verification: undefined } as EvidenceEnvelope<ProductionProviderCanaryPayload>;
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate({ canaryEvidence: bad, expectedDeployCommitSha: COMMIT, expectedDeploymentManifestSha256: MANIFEST, expectedConfigFingerprints: fingerprints });
    expect(report.failureReason).toBe('production-provider-canary-evidence-not-production-candidate');
  });
  it('requires two distinct approvers', async () => {
    const base = providerPayload();
    const report = await run(providerEnvelope(providerPayload({ authorization: { ...base.authorization, approvers: ['operator-a', 'operator-a'] } })));
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-provider-canary-two-person-approval-required');
  });
  it('rejects an incomplete action allowlist', async () => {
    const base = providerPayload();
    const report = await run(providerEnvelope(providerPayload({ authorization: { ...base.authorization, allowedActions: ['provider-health'] } })));
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-provider-canary-action-allowlist-invalid');
  });
  it('rejects execution outside authorization window', async () => {
    const base = providerPayload();
    const report = await run(providerEnvelope(providerPayload({ completedAtMs: BASE + 70_000, authorization: { ...base.authorization, expiresAtMs: BASE + 60_000 } })));
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-provider-canary-timeline-invalid');
  });
  it('rejects deployment version drift from the verified wiring canary', async () => {
    const base = providerPayload();
    const report = await run(providerEnvelope(providerPayload({ authorization: { ...base.authorization, deploymentVersionIds: { ...base.authorization.deploymentVersionIds, provider: 'different-version' } } })));
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-provider-canary-deployment-binding-mismatch:provider');
  });
  it('rejects archive digest drift', async () => {
    const base = providerPayload();
    const receipts = base.receipts.map((r) => r.action === 'backup-archive-retrieval' ? { ...r, observedContentDigest: 'd'.repeat(64) } : r);
    const report = await run(providerEnvelope(providerPayload({ receipts })));
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-provider-canary-archive-integrity-mismatch:backup-archive-retrieval');
  });
  it('requires the pager duplicate to use the same idempotency key and deduplicate', async () => {
    const base = providerPayload();
    const receipts = base.receipts.map((r, i) => i === 5 ? { ...r, idempotencyKey: 'different-key', status: 'success' as const } : r);
    const report = await run(providerEnvelope(providerPayload({ receipts })));
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-provider-canary-pager-dedupe-invalid');
  });
});
