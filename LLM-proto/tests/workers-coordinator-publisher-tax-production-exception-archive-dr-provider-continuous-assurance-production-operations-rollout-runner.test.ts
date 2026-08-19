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
  type ProductionOperationsRolloutAuthorization,
  type ProductionOperationsRolloutPhase,
  type ProductionOperationsRolloutPhasePayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.js';
import {
  runProductionOperationsRolloutPhase,
  type ProductionOperationsRolloutExecutor,
  type ProductionOperationsRolloutPhaseCapture,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-runner.js';

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
const fingerprints = Object.fromEntries(
  ROLES.map(([role], index) => [role, String(index + 1).repeat(64).slice(0, 64)]),
) as Record<ContinuousAssuranceDeploymentServiceRole, string>;

function deploymentEvidence(): EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload> {
  const scheduledTimeMs = BASE - 120_000;
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
    deployments: ROLES.map(([role, service], index) => ({
      role,
      service,
      versionId: `version-${role}-${index}-12345678`,
      versionTag: `tag-${index}`,
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
    artifactLocator: 'r2://evidence/deployment.json',
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
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: 'deployment-controller', version: '1.0.0', commitSha: COMMIT },
    runId: payload.canaryRunId,
    capturedAt: new Date(completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'deployment-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: { feature: 'deployment-canary', scenario: payload.canaryRunId, expectedResult: 'pass' },
    artifact: { locator: payload.artifactLocator, sha256: DEPLOY_SHA, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(completedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'v1' },
    payload,
  };
}

function providerEnvelope(): EvidenceEnvelope<ProductionProviderCanaryPayload> {
  const deploy = deploymentEvidence();
  const versions = Object.fromEntries(
    deploy.payload.deployments.map((item) => [item.role, item.versionId]),
  ) as Record<ContinuousAssuranceDeploymentServiceRole, string>;
  const startedAtMs = BASE - 30_000;
  const completedAtMs = BASE - 20_000;
  const authorization = {
    authorizationId: 'provider-auth', changeTicketId: 'CHG-149', authorizedAtMs: startedAtMs - 5_000,
    startsAtMs: startedAtMs, expiresAtMs: BASE - 10_000, approvers: ['operator-a', 'operator-b'],
    providerName: 'provider-prod', accountId: 'acct-prod', primaryStorageId: 'storage-primary',
    backupStorageId: 'storage-backup', archiveId: 'archive-1', archiveContentDigest: ARCHIVE_DIGEST,
    allowedActions: ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'] as const,
    deploymentVersionIds: versions, deploymentConfigFingerprints: fingerprints,
  };
  const receipt = (action: any, offset: number, extra: Record<string, unknown> = {}) => ({
    action,
    idempotencyKey: `provider-canary:${action}`,
    operationId: `op-${action}`,
    observedAtMs: startedAtMs + offset,
    status: 'success' as const,
    providerName: 'provider-prod',
    accountId: 'acct-prod',
    ...extra,
  });
  const payload: ProductionProviderCanaryPayload = {
    canaryRunId: 'production-provider-canary-1',
    startedAtMs,
    completedAtMs,
    deploymentCanaryInputEvidence: deploy,
    authorization,
    receipts: [
      receipt('provider-health', 1_000),
      receipt('provider-audit', 2_000),
      receipt('primary-archive-retrieval', 3_000, {
        storageId: 'storage-primary', archiveId: 'archive-1', observedContentDigest: ARCHIVE_DIGEST, integrityStatus: 'pass',
      }),
      receipt('backup-archive-retrieval', 4_000, {
        storageId: 'storage-backup', archiveId: 'archive-1', observedContentDigest: ARCHIVE_DIGEST, integrityStatus: 'pass',
      }),
      receipt('pager-canary', 5_000, { providerName: undefined, accountId: undefined, pagerDeliveryId: 'page-1' }),
      { ...receipt('pager-canary', 6_000, { providerName: undefined, accountId: undefined }), status: 'deduplicated' as const },
    ],
    artifactLocator: 'r2://evidence/provider.json',
    artifactSha256: PROVIDER_SHA,
    verifier: VERIFIER,
    verifierVersion: '1.0.0',
    verificationId: 'provider-verification',
    negativeChecks: {
      unauthorizedActionRejected: true,
      expiredAuthorizationRejected: true,
      identityDriftRejected: true,
      digestMismatchRejected: true,
      pagerDuplicateSuppressed: true,
      selfReportedEvidenceRejected: true,
    },
  };
  return {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: 'provider-controller', version: '1.0.0', commitSha: COMMIT },
    runId: payload.canaryRunId,
    capturedAt: new Date(completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'provider-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: { feature: 'provider-canary', scenario: payload.canaryRunId, expectedResult: 'pass' },
    artifact: { locator: payload.artifactLocator, sha256: PROVIDER_SHA, expiresAt: new Date(BASE + 86_400_000).toISOString() },
    verification: { verifier: VERIFIER, version: '1.0.0', verifiedAt: new Date(completedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'v1' },
    payload,
  };
}

function authorization(provider = providerEnvelope()): ProductionOperationsRolloutAuthorization {
  const source = provider.payload.authorization;
  return {
    rolloutId: 'rollout-163', authorizationId: 'rollout-auth-163', changeTicketId: 'CHG-163',
    authorizedAtMs: BASE - 1_000, startsAtMs: BASE, expiresAtMs: BASE + 400_000,
    approvers: ['operator-a', 'operator-b'], providerName: source.providerName, accountId: source.accountId,
    primaryStorageId: source.primaryStorageId, backupStorageId: source.backupStorageId, archiveId: source.archiveId,
    archiveContentDigest: source.archiveContentDigest, deploymentVersionIds: source.deploymentVersionIds,
    deploymentConfigFingerprints: source.deploymentConfigFingerprints, rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1',
    phasePlan: [
      { phase: 'observe-only', sequence: 1, startsAtMs: BASE, expiresAtMs: BASE + 80_000, minimumObservationMs: 40_000, maximumActions: 10 },
      { phase: 'maintenance-enabled', sequence: 2, startsAtMs: BASE + 80_000, expiresAtMs: BASE + 170_000, minimumObservationMs: 40_000, maximumActions: 12 },
      { phase: 'dr-exercise-enabled', sequence: 3, startsAtMs: BASE + 170_000, expiresAtMs: BASE + 270_000, minimumObservationMs: 40_000, maximumActions: 12 },
      { phase: 'steady-state-enabled', sequence: 4, startsAtMs: BASE + 270_000, expiresAtMs: BASE + 380_000, minimumObservationMs: 40_000, maximumActions: 10 },
    ],
    maintenance: {
      required: true, authorizationId: 'rotation-auth', rotationDueAtMs: BASE + 140_000,
      previousCredentialSetId: 'cred-old', previousSigningKeyId: 'sign-old', previousEncryptionKeyId: 'enc-old',
    },
    drExercise: { authorizationId: 'dr-auth', changeWindowStartMs: BASE + 190_000, changeWindowEndMs: BASE + 250_000 },
  };
}

function validation(artifact: string, envelope: EvidenceEnvelope<any>, verifier = VERIFIER): EvidenceValidationOptions {
  return {
    now: BASE + 390_000,
    trustedVerifiers: [{ name: verifier, version: '1.0.0' }],
    loadArtifact: async () => artifact,
    verifyArtifact: async () => ({ ...envelope.verification! }),
  };
}

function phaseValidation(): EvidenceValidationOptions {
  return {
    now: BASE + 390_000,
    trustedVerifiers: [{ name: PHASE_VERIFIER, version: '1.0.0' }],
    loadArtifact: async (locator) => `phase:${decodeURIComponent(locator.split('/').pop() ?? '')}`,
    verifyArtifact: async (context) => ({ ...context.envelope.verification! }),
  };
}

function capture(): ProductionOperationsRolloutPhaseCapture {
  return {
    async capturePhaseEvidence(request) {
      const artifact = `phase:${request.expectedRunId}`;
      const sha = createHash('sha256').update(artifact).digest('hex');
      return {
        schemaVersion: '1.0.0',
        evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
        evidenceLevel: 'captured-and-verified',
        readinessStatus: 'production-approved',
        producer: { name: 'rollout-controller', version: '1.0.0', commitSha: COMMIT },
        runId: request.expectedRunId,
        capturedAt: new Date(request.payload.completedAtMs).toISOString(),
        environment: {
          runtime: 'cloudflare-workers', runtimeVersion: 'managed', executionSurface: 'rollout-runner-test',
          os: { name: 'cloudflare-workers', version: 'managed' },
        },
        scenario: { feature: 'rollout-runner', scenario: request.payload.phase, expectedResult: 'pass' },
        artifact: {
          locator: `r2://phase/${encodeURIComponent(request.expectedRunId)}`,
          sha256: sha,
          expiresAt: new Date(request.payload.completedAtMs + 86_400_000).toISOString(),
        },
        verification: {
          verifier: PHASE_VERIFIER, version: '1.0.0',
          verifiedAt: new Date(request.payload.completedAtMs + 1_000).toISOString(), result: 'pass',
        },
        redaction: { applied: true, policyVersion: 'test' },
        payload: request.payload,
      };
    },
  };
}

function executor(overrides: Partial<{ health: any; rotateCalls: number[]; drCalls: string[]; keys: string[] }> = {}): ProductionOperationsRolloutExecutor {
  const pageSeen = new Set<string>();
  return {
    async collectOperationalHealth(context) {
      overrides.keys?.push(context.idempotencyKey);
      return overrides.health ?? {
        providerHealthOperationId: 'health-op', observedAtMs: context.nowMs, operationCount: 20, failureCount: 0,
        rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 100,
        observedCredentialSetId: 'cred-old', observedSigningKeyId: 'sign-old', observedEncryptionKeyId: 'enc-old',
        alertDispositions: [], incidentReviews: [], rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1',
        rollbackArmed: true, emergencyHoldArmed: true, controlInvocations: [], allowedOrigins: [], cspConnectSrc: [],
        sandboxFlags: [], coop: null, coep: null, networkAttempts: [],
      } as any;
    },
    async collectProviderAudit(context) {
      overrides.keys?.push(context.idempotencyKey);
      return { auditStreamId: 'audit-stream', auditCursorStart: 'cursor-a', auditCursorEnd: 'cursor-b', providerAuditRecordIds: ['audit-1', 'audit-2'], observedAtMs: context.nowMs };
    },
    async retrieveArchive(role, storageId, archiveId, expectedDigest, context) {
      overrides.keys?.push(context.idempotencyKey);
      return { retrievalOperationId: `${role}-retrieval`, storageId, archiveId, requestedAtMs: context.nowMs - 1, completedAtMs: context.nowMs,
        observedContentDigest: expectedDigest, integrityCheckId: `${role}-integrity`, integrityStatus: 'pass' };
    },
    async pageCanary(request) {
      overrides.keys?.push(request.dedupeKey);
      if (pageSeen.has(request.dedupeKey)) return { status: 'deduplicated' as const, deliveryId: `page-${request.cycleId}` };
      pageSeen.add(request.dedupeKey);
      return { status: 'accepted' as const, deliveryId: `page-${request.cycleId}` };
    },
    async rotateCredentialKeys(current, context) {
      overrides.keys?.push(context.idempotencyKey);
      overrides.rotateCalls?.push(context.attempt);
      return { rotationEvidenceId: 'rotation-1', rotatedAtMs: context.nowMs, previousCredentialSetId: current.currentCredentialSetId,
        previousSigningKeyId: current.currentSigningKeyId, previousEncryptionKeyId: current.currentEncryptionKeyId,
        newCredentialSetId: 'cred-new', newSigningKeyId: 'sign-new', newEncryptionKeyId: 'enc-new' };
    },
    async runDrFailoverExercise(storageId, _archiveId, expectedDigest, context) {
      overrides.keys?.push(context.idempotencyKey);
      overrides.drCalls?.push(storageId);
      return { exerciseId: 'dr-exercise-1', sourceStorageId: storageId, startedAtMs: context.nowMs - 1_000,
        completedAtMs: context.nowMs, recoveryPointAtMs: context.nowMs - 500, observedContentDigest: expectedDigest,
        integrityCheckId: 'dr-integrity', integrityStatus: 'pass' };
    },
  };
}

function common(provider: EvidenceEnvelope<ProductionProviderCanaryPayload>, auth: ProductionOperationsRolloutAuthorization) {
  return {
    providerCanaryEvidence: provider,
    rolloutAuthorization: auth,
    minimumProviderAvailabilityPct: 99,
    allowedFailureBudget: 3,
    capture: capture(),
    evidenceValidationOptions: validation(PROVIDER_ARTIFACT, provider),
    deploymentEvidenceValidationOptions: validation(DEPLOY_ARTIFACT, provider.payload.deploymentCanaryInputEvidence),
    phaseEvidenceValidationOptions: phaseValidation(),
    expectedDeployCommitSha: COMMIT,
    expectedDeploymentManifestSha256: MANIFEST,
    expectedConfigFingerprints: fingerprints,
    expectedVerifierName: VERIFIER,
    expectedDeploymentVerifierName: VERIFIER,
    expectedPhaseVerifierName: PHASE_VERIFIER,
    onCallRoute: 'oncall-prod',
    escalationTarget: 'ops-lead',
  };
}

async function runPhase(
  phase: ProductionOperationsRolloutPhase,
  index: number,
  previous: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[],
  provider: EvidenceEnvelope<ProductionProviderCanaryPayload>,
  auth: ProductionOperationsRolloutAuthorization,
  exec: ProductionOperationsRolloutExecutor,
  replayCount = 0,
) {
  const plan = auth.phasePlan[index];
  return runProductionOperationsRolloutPhase({
    ...common(provider, auth),
    phase,
    previousPhaseEvidences: previous,
    phaseStartedAtMs: plan.startsAtMs + 5_000,
    nowMs: plan.startsAtMs + 45_000,
    replayCount,
    executor: exec,
    ...(phase === 'steady-state-enabled' ? {
      steadyStateObligations: {
        nextCycleDueAtMs: plan.startsAtMs + 100_000,
        nextRotationDueAtMs: plan.startsAtMs + 120_000,
        nextDrExerciseDueAtMs: plan.startsAtMs + 140_000,
        evidenceRetentionUntilMs: plan.startsAtMs + 86_400_000,
        onCallRoute: 'oncall-prod', escalationTarget: 'ops-lead', rollbackControlId: auth.rollbackControlId,
        emergencyHoldControlId: auth.emergencyHoldControlId,
      },
    } : {}),
  });
}

describe('production operations rollout phase runner', () => {
  it('executes all four phases and finishes through the real #152 terminal gate', async () => {
    const provider = providerEnvelope();
    const auth = authorization(provider);
    const previous: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[] = [];
    for (const [index, phase] of (['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const).entries()) {
      const result = await runPhase(phase, index, previous, provider, auth, executor());
      previous.push(result.phaseEvidence);
      if (phase === 'steady-state-enabled') {
        expect(result.status).toBe('steady-state-enabled');
        if (result.status === 'steady-state-enabled') {
          expect(result.terminal.decision).toBe('steady-state-enabled');
          expect(result.terminal.bottlenecksToIssue).toEqual([]);
        }
      }
    }
    expect(previous).toHaveLength(4);
  });

  it('rejects phase skipping before any provider action', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider); const keys: string[] = [];
    await expect(runProductionOperationsRolloutPhase({
      ...common(provider, auth), phase: 'maintenance-enabled', previousPhaseEvidences: [], phaseStartedAtMs: BASE + 85_000,
      nowMs: BASE + 125_000, replayCount: 0, executor: executor({ keys }),
    })).rejects.toThrow('production-rollout-phase-sequence-invalid:maintenance-enabled');
    expect(keys).toEqual([]);
  });

  it('holds on SLO failure before maintenance rotation side effects', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider); const previous: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[] = [];
    const observe = await runPhase('observe-only', 0, previous, provider, auth, executor()); previous.push(observe.phaseEvidence);
    const rotateCalls: number[] = [];
    await expect(runPhase('maintenance-enabled', 1, previous, provider, auth, executor({ rotateCalls, health: {
      providerHealthOperationId: 'health-op', observedAtMs: BASE + 125_000, operationCount: 20, failureCount: 0,
      rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 90,
      observedCredentialSetId: 'cred-old', observedSigningKeyId: 'sign-old', observedEncryptionKeyId: 'enc-old',
      alertDispositions: [], incidentReviews: [], rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1',
      rollbackArmed: true, emergencyHoldArmed: true, controlInvocations: [], allowedOrigins: [], cspConnectSrc: [],
      sandboxFlags: [], coop: null, coep: null, networkAttempts: [],
    } }))).rejects.toThrow('production-rollout-health-slo-hold');
    expect(rotateCalls).toEqual([]);
  });

  it('uses the exact backup storage in the DR phase', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider); const previous: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[] = [];
    for (const [index, phase] of (['observe-only', 'maintenance-enabled'] as const).entries()) {
      const result = await runPhase(phase, index, previous, provider, auth, executor()); previous.push(result.phaseEvidence);
    }
    const drCalls: string[] = [];
    const result = await runPhase('dr-exercise-enabled', 2, previous, provider, auth, executor({ drCalls }));
    expect(result.status).toBe('phase-completed');
    expect(drCalls).toEqual(['storage-backup']);
  });

  it('preserves deterministic phase/action idempotency keys across replay', async () => {
    const provider = providerEnvelope(); const auth = authorization(provider); const firstKeys: string[] = []; const retryKeys: string[] = [];
    await runPhase('observe-only', 0, [], provider, auth, executor({ keys: firstKeys }), 0);
    await runPhase('observe-only', 0, [], provider, auth, executor({ keys: retryKeys }), 1);
    expect(new Set(firstKeys)).toEqual(new Set(retryKeys));
    expect(firstKeys.some((key) => key.includes('rollout-163:1:observe-only:provider-health'))).toBe(true);
  });
});
