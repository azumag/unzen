import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate,
  type ContinuousAssuranceProductionProviderCanaryPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
  type ContinuousAssuranceProductionDeploymentCanaryPayload,
  type ContinuousAssuranceWorkerDeploymentIdentity,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
  type ProviderSteadyStateOperationsPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';

const BASE = Date.parse('2026-08-20T04:00:00.000Z');
const VERIFIER = 'unzen-independent-evidence-verifier';
const NORMAL_ROUTE = 'prod-on-call';
const NORMAL_TARGET = 'prod-escalation';
const CANARY_ROUTE = 'provider-canary-route';
const CANARY_TARGET = 'provider-canary-target';
const ARCHIVE_DIGEST = 'a'.repeat(64);

function deployment(role: ContinuousAssuranceWorkerDeploymentIdentity['role'], service: string, index: number) {
  return {
    role,
    service,
    versionId: `version-${role}-${index}`,
    versionTag: `tag-${index}`,
    versionTimestamp: new Date(BASE - index * 1_000).toISOString(),
    configFingerprintSha256: String((index % 9) + 1).repeat(64),
  } satisfies ContinuousAssuranceWorkerDeploymentIdentity;
}

const deployments: ContinuousAssuranceWorkerDeploymentIdentity[] = [
  deployment('controller', 'unzen-llm-continuous-assurance-production-canary', 1),
  deployment('runtime', 'unzen-llm-continuous-assurance', 2),
  deployment('engine', 'unzen-llm-continuous-assurance-engine', 3),
  deployment('provider', 'unzen-llm-continuous-assurance-provider-adapter', 4),
  deployment('evidence', 'unzen-llm-continuous-assurance-evidence-adapter', 5),
  deployment('pager', 'unzen-llm-continuous-assurance-pager-adapter', 6),
  deployment('verifier', 'unzen-llm-continuous-assurance-independent-verifier', 7),
];

function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

const artifacts = new Map<string, string>();

function captured<T>(args: {
  kind: string;
  runId: string;
  readiness: 'production-candidate' | 'production-approved';
  payload: T;
  artifactText: string;
  capturedAtMs: number;
}): EvidenceEnvelope<T> {
  const locator = `fixture://${args.runId}/${sha(args.artifactText)}`;
  artifacts.set(locator, args.artifactText);
  return {
    schemaVersion: '1.0.0',
    evidenceKind: args.kind,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: args.readiness,
    producer: { name: 'fixture-producer', version: '1.0.0', commitSha: '1'.repeat(40) },
    runId: args.runId,
    capturedAt: new Date(args.capturedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'fixture',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: { feature: args.kind, scenario: args.runId, expectedResult: 'pass' },
    artifact: { locator, sha256: sha(args.artifactText), expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(args.capturedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'fixture-v1' },
    payload: args.payload,
  };
}

const validationOptions: EvidenceValidationOptions = {
  now: BASE + 60_000,
  trustedVerifiers: [{ name: VERIFIER, version: '1.0.0' }],
  loadArtifact: async (locator) => {
    const value = artifacts.get(locator);
    if (value === undefined) throw new Error('missing fixture artifact');
    return value;
  },
  verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

function deploymentPayload(): ContinuousAssuranceProductionDeploymentCanaryPayload {
  return {
    scope: 'publisher-tax-exception-archive-dr',
    cron: 'deployment-canary-idle',
    scheduledTimeMs: BASE - 20_000,
    triggerKey: `publisher-tax-exception-archive-dr:deployment-canary-idle:${BASE - 20_000}`,
    canaryRunId: `production-deployment-canary:${BASE - 20_000}`,
    startedAtMs: BASE - 20_000,
    completedAtMs: BASE - 19_998,
    deployCommitSha: '2'.repeat(40),
    deploymentManifestSha256: 'b'.repeat(64),
    deployments,
    runtimeResult: {
      status: 'idle', triggerKey: `publisher-tax-exception-archive-dr:deployment-canary-idle:${BASE - 20_000}`,
      cycleId: 'idle-cycle', failureReason: null, actionIdempotencyKeys: [], latestCycleRunId: null, latestAggregateRunId: null,
      runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false },
    },
    artifactLocator: 'r2://continuous-assurance-evidence/deployment.json',
    artifactSha256: 'c'.repeat(64),
    verificationId: 'deployment-verification', verifier: VERIFIER, verifierVersion: '1.0.0',
    negativeChecks: {
      badDispatchSecretRejected: true, duplicateCompletedDispatchSuppressed: true,
      versionOrConfigMismatchRejected: true, digestMismatchRejected: true, untrustedVerifierRejected: true,
    },
    capturedAtMs: BASE - 19_998,
  };
}

function steadyPayload(): ProviderSteadyStateOperationsPayload {
  return {
    providerName: 'provider-a', accountId: 'account-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
    replicaSiteId: 'replica-1', replicaRegion: 'region-1', archiveId: 'archive-1', archiveContentDigest: ARCHIVE_DIGEST,
    baselineReconciliationRunId: 'reconcile-1', cycleRunIds: ['cycle-1', 'cycle-2', 'cycle-3'],
    schedule: { scheduleId: 'schedule-1', cadenceMs: 60_000, graceMs: 5_000, lastSuccessfulCycleAtMs: BASE - 60_000, nextDueAtMs: BASE + 60_000 },
    rollingSlo: {
      policyId: 'slo-1', policyVersion: '1', requiredProviderAvailabilityPct: 99, minimumOperationCount: 3,
      totalOperationCount: 10, totalFailureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0,
      providerAvailabilityFloorPct: 100, allowedFailureBudget: 1, remainingFailureBudget: 1,
    },
    credentialRotation: {
      rotationCadenceMs: 86_400_000, lastRotatedAtMs: BASE - 1_000, nextRotationDueAtMs: BASE + 86_399_000,
      currentCredentialSetId: 'cred-1', currentSigningKeyId: 'sign-1', currentEncryptionKeyId: 'enc-1', rotationEvidenceIds: ['rotation-1'],
    },
    drPolicy: { policyId: 'dr-1', drillCadenceMs: 86_400_000, graceMs: 1_000, baselineLastExerciseAtMs: BASE - 10_000, lastExerciseAtMs: BASE - 10_000, nextExerciseDueAtMs: BASE + 86_390_000, requiredBackupSourceStorageId: 'backup-1' },
    evidenceRetention: { policyId: 'retention-1', minimumRetentionMs: 86_400_000 },
    rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', baselineIncidentIds: [],
    recoveryOwnerId: 'owner-1', onCallRoute: NORMAL_ROUTE, escalationTarget: NORMAL_TARGET,
    retentionPolicySnapshot: {} as any,
    allowedOrigins: ['https://provider.example'], cspConnectSrc: ['https://provider.example'], sandboxFlags: ['allow-scripts'],
    coop: 'same-origin', coep: 'require-corp', networkAttempts: [], capturedAtMs: BASE - 5_000,
  };
}

function providerPayload(overrides: Partial<ContinuousAssuranceProductionProviderCanaryPayload> = {}): ContinuousAssuranceProductionProviderCanaryPayload {
  const deploymentRunId = `production-deployment-canary:${BASE - 20_000}`;
  const steadyRunId = 'steady-aggregate-1';
  const canaryRunId = `production-provider-canary:${deploymentRunId}:${steadyRunId}`;
  const startedAtMs = BASE;
  const completedAtMs = BASE + 100;
  const keys = {
    providerAudit: `${canaryRunId}:provider-audit`, primaryRetrieval: `${canaryRunId}:primary`,
    backupRetrieval: `${canaryRunId}:backup`, providerHealth: `${canaryRunId}:health`, pager: `${canaryRunId}:pager`,
  };
  return {
    canaryRunId,
    deploymentCanaryRunId: deploymentRunId,
    deploymentCanaryArtifactSha256: 'd'.repeat(64),
    steadyStateRunId: steadyRunId,
    steadyStateArtifactSha256: 'e'.repeat(64),
    startedAtMs, completedAtMs, deployments,
    providerIdentity: {
      providerName: 'provider-a', accountId: 'account-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
      replicaSiteId: 'replica-1', replicaRegion: 'region-1', archiveId: 'archive-1', archiveContentDigest: ARCHIVE_DIGEST,
      credentialSetId: 'cred-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1',
    },
    providerAudit: { auditStreamId: 'stream-1', auditCursorStart: 'cursor-a', auditCursorEnd: 'cursor-b', providerAuditRecordIds: ['audit-1'], observedAtMs: BASE + 10 },
    primaryRetrieval: { retrievalOperationId: 'retrieve-primary', storageId: 'primary-1', archiveId: 'archive-1', requestedAtMs: BASE + 20, completedAtMs: BASE + 30, observedContentDigest: ARCHIVE_DIGEST, integrityCheckId: 'integrity-primary', integrityStatus: 'pass' },
    backupRetrieval: { retrievalOperationId: 'retrieve-backup', storageId: 'backup-1', archiveId: 'archive-1', requestedAtMs: BASE + 30, completedAtMs: BASE + 40, observedContentDigest: ARCHIVE_DIGEST, integrityCheckId: 'integrity-backup', integrityStatus: 'pass' },
    providerHealth: {
      observedAtMs: BASE + 50, operationCount: 4, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0,
      providerAvailabilityPct: 100, observedCredentialSetId: 'cred-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1',
      alertDispositions: [], incidentReviews: [], rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true,
      controlInvocations: [], allowedOrigins: [], cspConnectSrc: [], sandboxFlags: [], coop: null, coep: null, networkAttempts: [],
    },
    pager: { route: CANARY_ROUTE, target: CANARY_TARGET, firstStatus: 'accepted', duplicateStatus: 'deduplicated', deliveryId: 'delivery-1', attempts: 1, dedupeKey: keys.pager },
    actionIdempotencyKeys: keys,
    forbiddenActionAttempts: [],
    negativeChecks: {
      badIdempotencyRejected: true, unknownProviderActionRejected: true, duplicatePagerSuppressed: true,
      deploymentDriftRejected: true, digestMismatchRejected: true, untrustedVerifierRejected: true, forbiddenMutationPathUnavailable: true,
    },
    artifactLocator: 'r2://continuous-assurance-evidence/provider-canary.json', artifactSha256: 'f'.repeat(64),
    verifier: VERIFIER, verifierVersion: '1.0.0', verificationId: 'provider-verification', capturedAtMs: completedAtMs,
    ...overrides,
  };
}

function fixture() {
  const deployment = captured({
    kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
    runId: `production-deployment-canary:${BASE - 20_000}`,
    readiness: 'production-candidate', payload: deploymentPayload(), artifactText: 'deployment-artifact', capturedAtMs: BASE - 19_998,
  });
  const steady = captured({
    kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
    runId: 'steady-aggregate-1', readiness: 'production-approved', payload: steadyPayload(), artifactText: 'steady-artifact', capturedAtMs: BASE - 5_000,
  });
  const pp = providerPayload({ deploymentCanaryArtifactSha256: deployment.artifact!.sha256, steadyStateArtifactSha256: steady.artifact!.sha256 });
  const provider = captured({
    kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    runId: pp.canaryRunId, readiness: 'production-candidate', payload: pp, artifactText: 'provider-artifact', capturedAtMs: pp.capturedAtMs,
  });
  return {
    deployment,
    steady,
    provider,
    deploymentReport: { status: 'pass', evidenceSummary: { runId: deployment.runId }, canaryInputEvidence: deployment } as any,
  };
}

async function run(parts = fixture()) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate({
    deploymentCanaryReport: parts.deploymentReport,
    deploymentCanaryEvidence: parts.deployment,
    steadyStateOperationsEvidence: parts.steady,
    providerCanaryEvidence: parts.provider,
    evidenceValidationOptions: validationOptions,
    expectedPagerRoute: CANARY_ROUTE,
    expectedPagerTarget: CANARY_TARGET,
    expectedVerifierName: VERIFIER,
  });
}

describe('continuous assurance production provider canary gate', () => {
  it('promotes a bounded captured-and-verified provider canary', async () => {
    const report = await run();
    expect(report.status).toBe('pass');
    expect(report.bottlenecksToIssue).toEqual([
      PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK,
    ]);
  });

  it('rejects self-reported provider canary evidence', async () => {
    const parts = fixture();
    parts.provider = { ...parts.provider, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', artifact: undefined, verification: undefined } as any;
    expect((await run(parts)).failureReason).toBe('production-provider-canary-evidence-not-production-candidate');
  });

  it('rejects same-run deployment evidence substitution', async () => {
    const parts = fixture();
    const changed = captured({
      kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
      runId: parts.deployment.runId, readiness: 'production-candidate',
      payload: { ...deploymentPayload(), deployments: deployments.map((item) => item.role === 'provider' ? { ...item, versionId: 'version-provider-substitute' } : item) },
      artifactText: 'deployment-substitute', capturedAtMs: BASE - 19_998,
    });
    parts.deployment = changed;
    expect((await run(parts)).promoteHoldThresholds.holdReasons).toContain('production-deployment-input-mismatch');
  });

  it('rejects deployed Worker drift in provider evidence', async () => {
    const parts = fixture();
    const payload = { ...providerPayload(), deployments: deployments.map((item) => item.role === 'provider' ? { ...item, versionId: 'version-provider-drift' } : item), deploymentCanaryArtifactSha256: parts.deployment.artifact!.sha256, steadyStateArtifactSha256: parts.steady.artifact!.sha256 };
    parts.provider = captured({ kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, runId: payload.canaryRunId, readiness: 'production-candidate', payload, artifactText: 'provider-drift', capturedAtMs: payload.capturedAtMs });
    expect((await run(parts)).promoteHoldThresholds.holdReasons).toContain('production-provider-canary-deployment-drift');
  });

  it('rejects archive digest drift', async () => {
    const parts = fixture();
    const base = providerPayload({ deploymentCanaryArtifactSha256: parts.deployment.artifact!.sha256, steadyStateArtifactSha256: parts.steady.artifact!.sha256 });
    const payload = { ...base, backupRetrieval: { ...base.backupRetrieval, observedContentDigest: '0'.repeat(64) } };
    parts.provider = captured({ kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, runId: payload.canaryRunId, readiness: 'production-candidate', payload, artifactText: 'digest-drift', capturedAtMs: payload.capturedAtMs });
    expect((await run(parts)).promoteHoldThresholds.holdReasons).toContain('production-provider-canary-backup-retrieval-invalid');
  });

  it('rejects the normal production pager route', async () => {
    const parts = fixture();
    const base = providerPayload({ deploymentCanaryArtifactSha256: parts.deployment.artifact!.sha256, steadyStateArtifactSha256: parts.steady.artifact!.sha256 });
    const payload = { ...base, pager: { ...base.pager, route: NORMAL_ROUTE } };
    parts.provider = captured({ kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, runId: payload.canaryRunId, readiness: 'production-candidate', payload, artifactText: 'pager-route', capturedAtMs: payload.capturedAtMs });
    expect((await run(parts)).promoteHoldThresholds.holdReasons).toContain('production-provider-canary-pager-invalid');
  });

  it('rejects forbidden mutation attempts', async () => {
    const parts = fixture();
    const base = providerPayload({ deploymentCanaryArtifactSha256: parts.deployment.artifact!.sha256, steadyStateArtifactSha256: parts.steady.artifact!.sha256 });
    const payload = { ...base, forbiddenActionAttempts: ['/provider/keys/rotate'] };
    parts.provider = captured({ kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, runId: payload.canaryRunId, readiness: 'production-candidate', payload, artifactText: 'forbidden-action', capturedAtMs: payload.capturedAtMs });
    expect((await run(parts)).promoteHoldThresholds.holdReasons).toContain('production-provider-canary-forbidden-action-attempted');
  });

  it('rejects unhealthy provider control state', async () => {
    const parts = fixture();
    const base = providerPayload({ deploymentCanaryArtifactSha256: parts.deployment.artifact!.sha256, steadyStateArtifactSha256: parts.steady.artifact!.sha256 });
    const payload = { ...base, providerHealth: { ...base.providerHealth, emergencyHoldArmed: false } };
    parts.provider = captured({ kind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND, runId: payload.canaryRunId, readiness: 'production-candidate', payload, artifactText: 'unhealthy', capturedAtMs: payload.capturedAtMs });
    expect((await run(parts)).promoteHoldThresholds.holdReasons).toContain('production-provider-canary-health-invalid');
  });
});
