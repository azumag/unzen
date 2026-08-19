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
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
  type ProductionProviderCanaryPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionOperationsRolloutGate,
  type ProductionOperationsRolloutAuthorization,
  type ProductionOperationsRolloutPhase,
  type ProductionOperationsRolloutPhasePayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.js';

const BASE = Date.parse('2026-08-20T05:00:00.000Z');
const COMMIT = 'a'.repeat(40);
const MANIFEST = 'b'.repeat(64);
const ARCHIVE_DIGEST = 'c'.repeat(64);
const VERIFIER = 'unzen-independent-evidence-verifier';
const PHASE_VERIFIER = 'unzen-production-rollout-verifier';
const DEPLOY_ARTIFACT = 'deployment artifact';
const PROVIDER_ARTIFACT = 'provider canary artifact';
const DEPLOY_SHA = createHash('sha256').update(DEPLOY_ARTIFACT).digest('hex');
const PROVIDER_SHA = createHash('sha256').update(PROVIDER_ARTIFACT).digest('hex');
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
  const scheduledTimeMs = BASE - 120_000;
  const completedAtMs = scheduledTimeMs + 2;
  const deployments = ROLES.map(([role, service], i) => ({
    role, service, versionId: `version-${role}-${i}-12345678`, versionTag: `tag-${i}`,
    versionTimestamp: new Date(scheduledTimeMs - 1_000).toISOString(), configFingerprintSha256: fingerprints[role],
  }));
  const payload: ContinuousAssuranceProductionDeploymentCanaryPayload = {
    scope: 'publisher-tax-exception-archive-dr', cron: 'deployment-canary-idle', scheduledTimeMs,
    triggerKey: `publisher-tax-exception-archive-dr:deployment-canary-idle:${scheduledTimeMs}`,
    canaryRunId: `production-deployment-canary:${scheduledTimeMs}`, startedAtMs: scheduledTimeMs, completedAtMs,
    deployCommitSha: COMMIT, deploymentManifestSha256: MANIFEST, deployments,
    runtimeResult: { status: 'idle', triggerKey: `publisher-tax-exception-archive-dr:deployment-canary-idle:${scheduledTimeMs}`,
      cycleId: 'schedule-1:next', failureReason: null, actionIdempotencyKeys: [], latestCycleRunId: null,
      latestAggregateRunId: null, runtimeDelivery: { durableState: 'completed', replayCount: 0, replayed: false } },
    artifactLocator: 'r2://evidence/deployment.json', artifactSha256: DEPLOY_SHA, verificationId: 'deploy-verification',
    verifier: VERIFIER, verifierVersion: '1.0.0', negativeChecks: { badDispatchSecretRejected: true,
      duplicateCompletedDispatchSuppressed: true, versionOrConfigMismatchRejected: true, digestMismatchRejected: true,
      untrustedVerifierRejected: true }, capturedAtMs: completedAtMs,
  };
  return { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified', readinessStatus: 'production-candidate', producer: { name: 'deployment-controller', version: '1.0.0', commitSha: COMMIT },
    runId: payload.canaryRunId, capturedAt: new Date(completedAtMs).toISOString(), environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'deployment-canary', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: 'deployment-canary', scenario: payload.canaryRunId, expectedResult: 'pass' }, artifact: { locator: payload.artifactLocator, sha256: DEPLOY_SHA, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(completedAtMs + 1_000).toISOString(), result: 'pass' }, redaction: { applied: true, policyVersion: 'v1' }, payload };
}

function providerEnvelope(): EvidenceEnvelope<ProductionProviderCanaryPayload> {
  const deploy = deploymentEvidence();
  const versions = Object.fromEntries(deploy.payload.deployments.map((item) => [item.role, item.versionId])) as Record<ContinuousAssuranceDeploymentServiceRole, string>;
  const startedAtMs = BASE - 30_000;
  const completedAtMs = BASE - 20_000;
  const authorization = { authorizationId: 'provider-auth', changeTicketId: 'CHG-149', authorizedAtMs: startedAtMs - 5_000,
    startsAtMs: startedAtMs, expiresAtMs: BASE - 10_000, approvers: ['operator-a', 'operator-b'], providerName: 'provider-prod', accountId: 'acct-prod',
    primaryStorageId: 'storage-primary', backupStorageId: 'storage-backup', archiveId: 'archive-1', archiveContentDigest: ARCHIVE_DIGEST,
    allowedActions: ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'] as const,
    deploymentVersionIds: versions, deploymentConfigFingerprints: fingerprints };
  const receipt = (action: any, offset: number, extra: Record<string, unknown> = {}) => ({ action, idempotencyKey: `provider-canary:${action}`,
    operationId: `op-${action}`, observedAtMs: startedAtMs + offset, status: 'success' as const, providerName: 'provider-prod', accountId: 'acct-prod', ...extra });
  const payload: ProductionProviderCanaryPayload = { canaryRunId: 'production-provider-canary-1', startedAtMs, completedAtMs,
    deploymentCanaryInputEvidence: deploy, authorization, receipts: [receipt('provider-health', 1_000), receipt('provider-audit', 2_000),
      receipt('primary-archive-retrieval', 3_000, { storageId: 'storage-primary', archiveId: 'archive-1', observedContentDigest: ARCHIVE_DIGEST, integrityStatus: 'pass' }),
      receipt('backup-archive-retrieval', 4_000, { storageId: 'storage-backup', archiveId: 'archive-1', observedContentDigest: ARCHIVE_DIGEST, integrityStatus: 'pass' }),
      receipt('pager-canary', 5_000, { providerName: undefined, accountId: undefined, pagerDeliveryId: 'page-1' }),
      { ...receipt('pager-canary', 6_000, { providerName: undefined, accountId: undefined }), status: 'deduplicated' as const }],
    artifactLocator: 'r2://evidence/provider.json', artifactSha256: PROVIDER_SHA, verifier: VERIFIER, verifierVersion: '1.0.0', verificationId: 'provider-verification',
    negativeChecks: { unauthorizedActionRejected: true, expiredAuthorizationRejected: true, identityDriftRejected: true, digestMismatchRejected: true, pagerDuplicateSuppressed: true, selfReportedEvidenceRejected: true } };
  return { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified', readinessStatus: 'production-candidate', producer: { name: 'provider-controller', version: '1.0.0', commitSha: COMMIT },
    runId: payload.canaryRunId, capturedAt: new Date(completedAtMs).toISOString(), environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'provider-canary', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: 'provider-canary', scenario: payload.canaryRunId, expectedResult: 'pass' }, artifact: { locator: payload.artifactLocator, sha256: PROVIDER_SHA, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(completedAtMs + 1_000).toISOString(), result: 'pass' }, redaction: { applied: true, policyVersion: 'v1' }, payload };
}

function authorization(provider = providerEnvelope()): ProductionOperationsRolloutAuthorization {
  const canaryAuth = provider.payload.authorization;
  return { rolloutId: 'rollout-152', authorizationId: 'rollout-auth-152', changeTicketId: 'CHG-152', authorizedAtMs: BASE - 1_000,
    startsAtMs: BASE, expiresAtMs: BASE + 400_000, approvers: ['operator-a', 'operator-b'], providerName: canaryAuth.providerName,
    accountId: canaryAuth.accountId, primaryStorageId: canaryAuth.primaryStorageId, backupStorageId: canaryAuth.backupStorageId,
    archiveId: canaryAuth.archiveId, archiveContentDigest: canaryAuth.archiveContentDigest, deploymentVersionIds: canaryAuth.deploymentVersionIds,
    deploymentConfigFingerprints: canaryAuth.deploymentConfigFingerprints, rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1',
    phasePlan: [
      { phase: 'observe-only', sequence: 1, startsAtMs: BASE, expiresAtMs: BASE + 80_000, minimumObservationMs: 40_000, maximumActions: 10 },
      { phase: 'maintenance-enabled', sequence: 2, startsAtMs: BASE + 80_000, expiresAtMs: BASE + 170_000, minimumObservationMs: 40_000, maximumActions: 12 },
      { phase: 'dr-exercise-enabled', sequence: 3, startsAtMs: BASE + 170_000, expiresAtMs: BASE + 270_000, minimumObservationMs: 40_000, maximumActions: 12 },
      { phase: 'steady-state-enabled', sequence: 4, startsAtMs: BASE + 270_000, expiresAtMs: BASE + 380_000, minimumObservationMs: 40_000, maximumActions: 10 },
    ],
    maintenance: { required: true, authorizationId: 'rotation-auth', rotationDueAtMs: BASE + 140_000, previousCredentialSetId: 'cred-old', previousSigningKeyId: 'sign-old', previousEncryptionKeyId: 'enc-old' },
    drExercise: { authorizationId: 'dr-auth', changeWindowStartMs: BASE + 190_000, changeWindowEndMs: BASE + 250_000 } };
}

function phasePayload(phase: ProductionOperationsRolloutPhase, index: number, auth: ProductionOperationsRolloutAuthorization, provider: EvidenceEnvelope<ProductionProviderCanaryPayload>): ProductionOperationsRolloutPhasePayload {
  const plan = auth.phasePlan[index];
  const startedAtMs = plan.startsAtMs + 5_000;
  const completedAtMs = startedAtMs + 45_000;
  const payload: ProductionOperationsRolloutPhasePayload = { rolloutId: auth.rolloutId, authorizationId: auth.authorizationId, phase, sequence: index + 1,
    providerCanaryRunId: provider.runId, providerCanaryArtifactSha256: provider.artifact!.sha256, startedAtMs, completedAtMs, actionBudget: 8, observedActionCount: 3,
    replayCount: 0, actionIdempotencyKeys: [`${phase}:1`, `${phase}:2`, `${phase}:3`], identity: { providerName: auth.providerName, accountId: auth.accountId,
      primaryStorageId: auth.primaryStorageId, backupStorageId: auth.backupStorageId, archiveId: auth.archiveId, archiveContentDigest: auth.archiveContentDigest,
      deploymentVersionIds: auth.deploymentVersionIds, deploymentConfigFingerprints: auth.deploymentConfigFingerprints },
    slo: { operationCount: 20, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0,
      providerAvailabilityPct: 100, minimumProviderAvailabilityPct: 99, allowedFailureBudget: 3, remainingFailureBudget: 3 }, alerts: [], incidents: [], controlInvocations: [], capturedAtMs: completedAtMs };
  if (phase === 'maintenance-enabled') payload.rotationTransition = { authorizationId: 'rotation-auth', rotatedAtMs: BASE + 120_000,
    previousCredentialSetId: 'cred-old', previousSigningKeyId: 'sign-old', previousEncryptionKeyId: 'enc-old', newCredentialSetId: 'cred-new', newSigningKeyId: 'sign-new', newEncryptionKeyId: 'enc-new' };
  if (phase === 'dr-exercise-enabled') payload.drExercise = { authorizationId: 'dr-auth', exerciseId: 'dr-exercise-1', sourceStorageId: auth.backupStorageId,
    startedAtMs: BASE + 200_000, completedAtMs: BASE + 220_000, observedContentDigest: ARCHIVE_DIGEST, integrityStatus: 'pass' };
  if (phase === 'steady-state-enabled') payload.operationalObligations = { nextCycleDueAtMs: completedAtMs + 60_000, nextRotationDueAtMs: completedAtMs + 120_000,
    nextDrExerciseDueAtMs: completedAtMs + 180_000, evidenceRetentionUntilMs: completedAtMs + 86_400_000, onCallRoute: 'oncall-prod', escalationTarget: 'ops-lead',
    rollbackControlId: auth.rollbackControlId, emergencyHoldControlId: auth.emergencyHoldControlId };
  return payload;
}

function phaseEnvelope(payload: ProductionOperationsRolloutPhasePayload): EvidenceEnvelope<ProductionOperationsRolloutPhasePayload> {
  const artifact = `phase:${payload.phase}`;
  const sha = createHash('sha256').update(artifact).digest('hex');
  return { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified', readinessStatus: 'production-approved', producer: { name: 'rollout-controller', version: '1.0.0', commitSha: COMMIT },
    runId: `${payload.rolloutId}:${payload.sequence}:${payload.phase}`, capturedAt: new Date(payload.completedAtMs).toISOString(), environment: { runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'operations-rollout', os: { name: 'cloudflare-workers', version: 'managed' } },
    scenario: { feature: 'operations-rollout', scenario: payload.phase, expectedResult: 'phase clean' }, artifact: { locator: `r2://evidence/${payload.phase}.json`, sha256: sha, expiresAt: new Date(payload.completedAtMs + 86_400_000).toISOString() },
    verification: { verifier: PHASE_VERIFIER, version: '1.0.0', verifiedAt: new Date(payload.completedAtMs + 1_000).toISOString(), result: 'pass' }, redaction: { applied: true, policyVersion: 'rollout-v1' }, payload };
}

function validation(artifact: string, envelope: EvidenceEnvelope<any>, verifier = VERIFIER): EvidenceValidationOptions {
  return { now: BASE + 390_000, trustedVerifiers: [{ name: verifier, version: '1.0.0' }], loadArtifact: async () => artifact,
    verifyArtifact: async () => ({ ...envelope.verification! }) };
}

async function run(overrides: { auth?: ProductionOperationsRolloutAuthorization; phases?: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[]; provider?: EvidenceEnvelope<ProductionProviderCanaryPayload> } = {}) {
  const provider = overrides.provider ?? providerEnvelope();
  const auth = overrides.auth ?? authorization(provider);
  const phases = overrides.phases ?? (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionOperationsRolloutGate({ providerCanaryEvidence: provider,
    rolloutAuthorization: auth, phaseEvidences: phases, evidenceValidationOptions: validation(PROVIDER_ARTIFACT, provider),
    deploymentEvidenceValidationOptions: validation(DEPLOY_ARTIFACT, provider.payload.deploymentCanaryInputEvidence),
    phaseEvidenceValidationOptions: { now: BASE + 390_000, trustedVerifiers: [{ name: PHASE_VERIFIER, version: '1.0.0' }],
      loadArtifact: async (locator) => `phase:${locator.match(/([^/]+)\.json$/)?.[1] ?? ''}`, verifyArtifact: async (context) => ({ ...context.envelope.verification! }) },
    expectedDeployCommitSha: COMMIT, expectedDeploymentManifestSha256: MANIFEST, expectedConfigFingerprints: fingerprints,
    expectedVerifierName: VERIFIER, expectedDeploymentVerifierName: VERIFIER, expectedPhaseVerifierName: PHASE_VERIFIER });
}

describe('continuous assurance production operations rollout gate', () => {
  it('returns terminal steady-state-enabled with no next validator bottleneck', async () => {
    const report = await run();
    expect(report.status).toBe('pass');
    expect(report.decision).toBe('steady-state-enabled');
    expect(report.bottlenecksToIssue).toEqual([]);
    expect(report.operationalObligations?.nextCycleDueAtMs).toBeGreaterThan(BASE);
  });
  it('rejects a skipped phase', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = ['observe-only', 'dr-exercise-enabled', 'steady-state-enabled'].map((phase, index) => phaseEnvelope(phasePayload(phase as ProductionOperationsRolloutPhase, index, auth, provider)));
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-phase-count-invalid');
  });
  it('rejects overlapping or reordered phase plans', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const bad = { ...auth, phasePlan: auth.phasePlan.map((plan, index) => index === 1 ? { ...plan, startsAtMs: BASE + 10_000 } : plan) };
    const report = await run({ provider, auth: bad });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-phase-plan-invalid:maintenance-enabled');
  });
  it('rejects observe-only side effects', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[0] = phaseEnvelope({ ...phases[0].payload, rotationTransition: { authorizationId: 'bad', rotatedAtMs: BASE + 10_000, previousCredentialSetId: 'a', previousSigningKeyId: 'b', previousEncryptionKeyId: 'c', newCredentialSetId: 'd', newSigningKeyId: 'e', newEncryptionKeyId: 'f' } });
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-observe-only-side-effect-detected');
  });
  it('requires an authorized key transition when maintenance rotation is due', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[1] = phaseEnvelope({ ...phases[1].payload, rotationTransition: undefined });
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-maintenance-rotation-invalid');
  });
  it('requires the DR phase to exercise backup storage with the canonical digest', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[2] = phaseEnvelope({ ...phases[2].payload, drExercise: { ...phases[2].payload.drExercise!, sourceStorageId: 'wrong-storage' } });
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-dr-exercise-invalid');
  });
  it('holds on an unresolved critical alert', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[3] = phaseEnvelope({ ...phases[3].payload, alerts: [{ alertId: 'crit-1', severity: 'critical', status: 'open' }] });
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-critical-alert-unresolved:steady-state-enabled');
  });
  it('holds on exhausted rolling error budget', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[3] = phaseEnvelope({ ...phases[3].payload, slo: { ...phases[3].payload.slo, failureCount: 3, allowedFailureBudget: 3, remainingFailureBudget: 0 } });
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-slo-hold:steady-state-enabled');
  });
  it('rejects provider/deployment identity drift from the verified canary', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[1] = phaseEnvelope({ ...phases[1].payload, identity: { ...phases[1].payload.identity, accountId: 'different-account' } });
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-identity-drift:maintenance-enabled');
  });
  it('rejects self-reported rollout phase evidence', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider);
    const phases = (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).map((phase, index) => phaseEnvelope(phasePayload(phase, index, auth, provider)));
    phases[0] = { ...phases[0], evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', artifact: undefined, verification: undefined } as EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>;
    const report = await run({ provider, auth, phases });
    expect(report.promoteHoldThresholds.holdReasons).toContain('production-operations-rollout-phase-evidence-not-production-approved:observe-only');
  });
});
