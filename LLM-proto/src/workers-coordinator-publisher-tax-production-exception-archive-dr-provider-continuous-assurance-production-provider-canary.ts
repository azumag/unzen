import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate,
  type ContinuousAssuranceProductionDeploymentCanaryPayload,
  type ContinuousAssuranceWorkerDeploymentIdentity,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
  type ProviderSteadyStateOperationsPayload,
  type SteadyStateArchiveRetrieval,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';
import type {
  ContinuousAssuranceHealthResult,
  ContinuousAssuranceProviderAuditResult,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout' as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type ProductionDeploymentCanaryReport = Awaited<ReturnType<
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate
>>;

export interface ContinuousAssuranceProductionProviderIdentity {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly credentialSetId: string;
  readonly signingKeyId: string;
  readonly encryptionKeyId: string;
}

export interface ContinuousAssuranceProductionProviderPagerReceipt {
  readonly route: string;
  readonly target: string;
  readonly firstStatus: 'accepted' | 'deduplicated';
  readonly duplicateStatus: 'deduplicated';
  readonly deliveryId: string | null;
  readonly attempts: number;
  readonly dedupeKey: string;
}

export interface ContinuousAssuranceProductionProviderNegativeChecks {
  readonly badIdempotencyRejected: boolean;
  readonly unknownProviderActionRejected: boolean;
  readonly duplicatePagerSuppressed: boolean;
  readonly deploymentDriftRejected: boolean;
  readonly digestMismatchRejected: boolean;
  readonly untrustedVerifierRejected: boolean;
  readonly forbiddenMutationPathUnavailable: boolean;
}

export interface ContinuousAssuranceProductionProviderCanaryPayload {
  readonly canaryRunId: string;
  readonly deploymentCanaryRunId: string;
  readonly deploymentCanaryArtifactSha256: string;
  readonly steadyStateRunId: string;
  readonly steadyStateArtifactSha256: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly deployments: readonly ContinuousAssuranceWorkerDeploymentIdentity[];
  readonly providerIdentity: ContinuousAssuranceProductionProviderIdentity;
  readonly providerAudit: ContinuousAssuranceProviderAuditResult;
  readonly primaryRetrieval: SteadyStateArchiveRetrieval;
  readonly backupRetrieval: SteadyStateArchiveRetrieval;
  readonly providerHealth: ContinuousAssuranceHealthResult;
  readonly pager: ContinuousAssuranceProductionProviderPagerReceipt;
  readonly actionIdempotencyKeys: Readonly<Record<
    'providerAudit' | 'primaryRetrieval' | 'backupRetrieval' | 'providerHealth' | 'pager',
    string
  >>;
  readonly forbiddenActionAttempts: readonly string[];
  readonly negativeChecks: ContinuousAssuranceProductionProviderNegativeChecks;
  readonly artifactLocator: string;
  readonly artifactSha256: string;
  readonly verifier: string;
  readonly verifierVersion: string;
  readonly verificationId: string;
  readonly capturedAtMs: number;
}

export interface ContinuousAssuranceProductionProviderCanaryGateOptions {
  readonly deploymentCanaryReport: ProductionDeploymentCanaryReport;
  readonly deploymentCanaryEvidence: EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>;
  readonly steadyStateOperationsEvidence: EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
  readonly providerCanaryEvidence: EvidenceEnvelope<ContinuousAssuranceProductionProviderCanaryPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
  readonly expectedPagerRoute: string;
  readonly expectedPagerTarget: string;
  readonly expectedVerifierName?: string;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate(
  options: ContinuousAssuranceProductionProviderCanaryGateOptions,
) {
  const reasons: string[] = [];
  const [deploymentValidation, steadyValidation, providerValidation] = await Promise.all([
    validateEvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>(
      options.deploymentCanaryEvidence,
      options.evidenceValidationOptions,
    ),
    validateEvidenceEnvelope<ProviderSteadyStateOperationsPayload>(
      options.steadyStateOperationsEvidence,
      options.evidenceValidationOptions,
    ),
    validateEvidenceEnvelope<ContinuousAssuranceProductionProviderCanaryPayload>(
      options.providerCanaryEvidence,
      options.evidenceValidationOptions,
    ),
  ]);
  const deployment = deploymentValidation.envelope?.payload;
  const steady = steadyValidation.envelope?.payload;
  const payload = providerValidation.envelope?.payload;

  if (options.deploymentCanaryReport.status !== 'pass') {
    reasons.push('production-deployment-canary-not-clean');
  }
  if (!evidenceSupportsReadiness(deploymentValidation, 'production-candidate')) {
    reasons.push('production-deployment-evidence-not-production-candidate');
  }
  if (options.deploymentCanaryEvidence.evidenceKind !==
    PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND) {
    reasons.push('production-deployment-evidence-kind-invalid');
  }
  if (options.deploymentCanaryEvidence.runId !== options.deploymentCanaryReport.evidenceSummary.runId) {
    reasons.push('production-deployment-run-mismatch');
  }
  if (JSON.stringify(options.deploymentCanaryEvidence) !== JSON.stringify(options.deploymentCanaryReport.canaryInputEvidence)) {
    reasons.push('production-deployment-input-mismatch');
  }
  if (!evidenceSupportsReadiness(steadyValidation, 'production-approved')) {
    reasons.push('steady-state-evidence-not-production-approved');
  }
  if (options.steadyStateOperationsEvidence.evidenceKind !==
    PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND) {
    reasons.push('steady-state-evidence-kind-invalid');
  }
  if (options.providerCanaryEvidence.evidenceKind !==
    PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND) {
    reasons.push('production-provider-canary-evidence-kind-invalid');
  }
  if (!evidenceSupportsReadiness(providerValidation, 'production-candidate')) {
    reasons.push('production-provider-canary-evidence-not-production-candidate');
  }
  if (!deployment) reasons.push('production-deployment-payload-missing');
  if (!steady) reasons.push('steady-state-payload-missing');
  if (!payload) reasons.push('production-provider-canary-payload-missing');

  if (deployment && steady && payload) {
    if (payload.canaryRunId !== options.providerCanaryEvidence.runId ||
      payload.deploymentCanaryRunId !== options.deploymentCanaryEvidence.runId ||
      payload.deploymentCanaryArtifactSha256 !== options.deploymentCanaryEvidence.artifact?.sha256 ||
      payload.steadyStateRunId !== options.steadyStateOperationsEvidence.runId ||
      payload.steadyStateArtifactSha256 !== options.steadyStateOperationsEvidence.artifact?.sha256) {
      reasons.push('production-provider-canary-upstream-identity-mismatch');
    }
    if (JSON.stringify(payload.deployments) !== JSON.stringify(deployment.deployments)) {
      reasons.push('production-provider-canary-deployment-drift');
    }
    validateProviderIdentity(payload.providerIdentity, steady, reasons);
    validateAudit(payload.providerAudit, payload.startedAtMs, payload.completedAtMs, reasons);
    validateRetrieval(
      payload.primaryRetrieval,
      'primary',
      steady.primaryStorageId,
      steady.archiveId,
      steady.archiveContentDigest,
      payload.startedAtMs,
      payload.completedAtMs,
      reasons,
    );
    validateRetrieval(
      payload.backupRetrieval,
      'backup',
      steady.backupStorageId,
      steady.archiveId,
      steady.archiveContentDigest,
      payload.startedAtMs,
      payload.completedAtMs,
      reasons,
    );
    validateHealth(payload.providerHealth, steady, payload.startedAtMs, payload.completedAtMs, reasons);
    validatePager(payload.pager, options, steady, reasons);
    validateActionKeys(payload, reasons);

    if (payload.forbiddenActionAttempts.length !== 0) {
      reasons.push('production-provider-canary-forbidden-action-attempted');
    }
    if (!Object.values(payload.negativeChecks).every(Boolean)) {
      reasons.push('production-provider-canary-negative-check-incomplete');
    }
    if (!payload.artifactLocator || !SHA256_PATTERN.test(payload.artifactSha256) ||
      !payload.verifier || !payload.verifierVersion || !payload.verificationId) {
      reasons.push('production-provider-canary-artifact-invalid');
    }
    if (options.expectedVerifierName && payload.verifier !== options.expectedVerifierName) {
      reasons.push('production-provider-canary-verifier-invalid');
    }
    if (payload.completedAtMs < payload.startedAtMs || payload.capturedAtMs !== payload.completedAtMs) {
      reasons.push('production-provider-canary-timeline-invalid');
    }
    const envelopeCapturedAtMs = Date.parse(options.providerCanaryEvidence.capturedAt);
    if (!Number.isFinite(envelopeCapturedAtMs) || envelopeCapturedAtMs !== payload.capturedAtMs) {
      reasons.push('production-provider-canary-envelope-timeline-invalid');
    }
    if (options.providerCanaryEvidence.artifact?.locator !== payload.artifactLocator ||
      options.providerCanaryEvidence.artifact?.sha256 !== payload.artifactSha256) {
      reasons.push('production-provider-canary-envelope-artifact-mismatch');
    }
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    deploymentCanaryInputEvidence: options.deploymentCanaryEvidence,
    steadyStateInputEvidence: options.steadyStateOperationsEvidence,
    providerCanaryInputEvidence: options.providerCanaryEvidence,
    evidenceSummary: {
      deployment: {
        status: deploymentValidation.status,
        effectiveEvidenceLevel: deploymentValidation.effectiveEvidenceLevel,
        effectiveReadinessStatus: deploymentValidation.effectiveReadinessStatus,
        runId: options.deploymentCanaryEvidence.runId,
      },
      steadyState: {
        status: steadyValidation.status,
        effectiveEvidenceLevel: steadyValidation.effectiveEvidenceLevel,
        effectiveReadinessStatus: steadyValidation.effectiveReadinessStatus,
        runId: options.steadyStateOperationsEvidence.runId,
      },
      providerCanary: {
        status: providerValidation.status,
        effectiveEvidenceLevel: providerValidation.effectiveEvidenceLevel,
        effectiveReadinessStatus: providerValidation.effectiveReadinessStatus,
        runId: options.providerCanaryEvidence.runId,
      },
    },
    providerIdentity: payload?.providerIdentity ?? null,
    pager: payload?.pager ?? null,
    negativeChecks: payload?.negativeChecks ?? null,
    promoteHoldThresholds: {
      decision: failureReason ? 'hold' as const : 'promote' as const,
      holdReasons: reasons,
    },
    failureReason,
    bottlenecksToIssue: failureReason
      ? []
      : [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK],
  };
}

function validateProviderIdentity(
  identity: ContinuousAssuranceProductionProviderIdentity,
  steady: ProviderSteadyStateOperationsPayload,
  reasons: string[],
): void {
  if (identity.providerName !== steady.providerName ||
    identity.accountId !== steady.accountId ||
    identity.primaryStorageId !== steady.primaryStorageId ||
    identity.backupStorageId !== steady.backupStorageId ||
    identity.replicaSiteId !== steady.replicaSiteId ||
    identity.replicaRegion !== steady.replicaRegion ||
    identity.archiveId !== steady.archiveId ||
    identity.archiveContentDigest !== steady.archiveContentDigest ||
    identity.credentialSetId !== steady.credentialRotation.currentCredentialSetId ||
    identity.signingKeyId !== steady.credentialRotation.currentSigningKeyId ||
    identity.encryptionKeyId !== steady.credentialRotation.currentEncryptionKeyId) {
    reasons.push('production-provider-canary-provider-identity-mismatch');
  }
}

function validateAudit(
  audit: ContinuousAssuranceProviderAuditResult,
  startedAtMs: number,
  completedAtMs: number,
  reasons: string[],
): void {
  if (!audit.auditStreamId || !audit.auditCursorStart || !audit.auditCursorEnd ||
    audit.providerAuditRecordIds.length === 0 ||
    new Set(audit.providerAuditRecordIds).size !== audit.providerAuditRecordIds.length ||
    !Number.isFinite(audit.observedAtMs) || audit.observedAtMs < startedAtMs || audit.observedAtMs > completedAtMs) {
    reasons.push('production-provider-canary-audit-invalid');
  }
}

function validateRetrieval(
  retrieval: SteadyStateArchiveRetrieval,
  role: 'primary' | 'backup',
  expectedStorageId: string,
  expectedArchiveId: string,
  expectedDigest: string,
  startedAtMs: number,
  completedAtMs: number,
  reasons: string[],
): void {
  if (!retrieval.retrievalOperationId || retrieval.storageId !== expectedStorageId ||
    retrieval.archiveId !== expectedArchiveId || retrieval.observedContentDigest !== expectedDigest ||
    retrieval.integrityStatus !== 'pass' || !retrieval.integrityCheckId ||
    retrieval.requestedAtMs < startedAtMs || retrieval.completedAtMs < retrieval.requestedAtMs ||
    retrieval.completedAtMs > completedAtMs) {
    reasons.push(`production-provider-canary-${role}-retrieval-invalid`);
  }
}

function validateHealth(
  health: ContinuousAssuranceHealthResult,
  steady: ProviderSteadyStateOperationsPayload,
  startedAtMs: number,
  completedAtMs: number,
  reasons: string[],
): void {
  if (!Number.isFinite(health.observedAtMs) || health.observedAtMs < startedAtMs || health.observedAtMs > completedAtMs ||
    health.failureCount !== 0 || health.rtoBreachCount !== 0 || health.rpoBreachCount !== 0 ||
    health.integrityFailureCount !== 0 ||
    health.providerAvailabilityPct < steady.rollingSlo.requiredProviderAvailabilityPct ||
    health.observedCredentialSetId !== steady.credentialRotation.currentCredentialSetId ||
    health.observedSigningKeyId !== steady.credentialRotation.currentSigningKeyId ||
    health.observedEncryptionKeyId !== steady.credentialRotation.currentEncryptionKeyId ||
    health.rollbackControlId !== steady.rollbackControlId || !health.rollbackArmed ||
    health.emergencyHoldControlId !== steady.emergencyHoldControlId || !health.emergencyHoldArmed ||
    health.alertDispositions.some((alert) => alert.severity === 'critical' && alert.status === 'open') ||
    health.incidentReviews.some((incident) => incident.status === 'active') ||
    health.controlInvocations.some((invocation) => invocation.status === 'active')) {
    reasons.push('production-provider-canary-health-invalid');
  }
}

function validatePager(
  pager: ContinuousAssuranceProductionProviderPagerReceipt,
  options: ContinuousAssuranceProductionProviderCanaryGateOptions,
  steady: ProviderSteadyStateOperationsPayload,
  reasons: string[],
): void {
  if (!options.expectedPagerRoute || !options.expectedPagerTarget ||
    pager.route !== options.expectedPagerRoute || pager.target !== options.expectedPagerTarget ||
    pager.route === steady.onCallRoute || pager.target === steady.escalationTarget ||
    !pager.dedupeKey || pager.duplicateStatus !== 'deduplicated' ||
    (pager.firstStatus !== 'accepted' && pager.firstStatus !== 'deduplicated') ||
    !Number.isInteger(pager.attempts) || pager.attempts < 1 || pager.attempts > 3) {
    reasons.push('production-provider-canary-pager-invalid');
  }
}

function validateActionKeys(
  payload: ContinuousAssuranceProductionProviderCanaryPayload,
  reasons: string[],
): void {
  const values = Object.values(payload.actionIdempotencyKeys);
  if (values.some((value) => !value || value.length > 512) || new Set(values).size !== values.length ||
    payload.pager.dedupeKey !== payload.actionIdempotencyKeys.pager) {
    reasons.push('production-provider-canary-idempotency-invalid');
  }
}
