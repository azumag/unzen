import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import {
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate,
  type ProductionProviderCanaryPayload,
  type ProductionProviderCanaryGateOptions,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';
import type { ContinuousAssuranceDeploymentServiceRole } from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-phase' as const;

const SHA256 = /^[a-f0-9]{64}$/;
const PHASES = ['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const;
export type ProductionOperationsRolloutPhase = typeof PHASES[number];

export interface ProductionOperationsRolloutPhasePlan {
  readonly phase: ProductionOperationsRolloutPhase;
  readonly sequence: number;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly minimumObservationMs: number;
  readonly maximumActions: number;
}

export interface ProductionOperationsMaintenanceAuthorization {
  readonly required: boolean;
  readonly authorizationId: string | null;
  readonly rotationDueAtMs: number | null;
  readonly previousCredentialSetId: string | null;
  readonly previousSigningKeyId: string | null;
  readonly previousEncryptionKeyId: string | null;
}

export interface ProductionOperationsDrAuthorization {
  readonly authorizationId: string;
  readonly changeWindowStartMs: number;
  readonly changeWindowEndMs: number;
}

export interface ProductionOperationsRolloutAuthorization {
  readonly rolloutId: string;
  readonly authorizationId: string;
  readonly changeTicketId: string;
  readonly authorizedAtMs: number;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly approvers: readonly string[];
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly deploymentVersionIds: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
  readonly deploymentConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
  readonly phasePlan: readonly ProductionOperationsRolloutPhasePlan[];
  readonly maintenance: ProductionOperationsMaintenanceAuthorization;
  readonly drExercise: ProductionOperationsDrAuthorization;
}

export interface ProductionOperationsIdentitySnapshot {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly deploymentVersionIds: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
  readonly deploymentConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
}

export interface ProductionOperationsSloSnapshot {
  readonly operationCount: number;
  readonly failureCount: number;
  readonly rtoBreachCount: number;
  readonly rpoBreachCount: number;
  readonly integrityFailureCount: number;
  readonly providerAvailabilityPct: number;
  readonly minimumProviderAvailabilityPct: number;
  readonly allowedFailureBudget: number;
  readonly remainingFailureBudget: number;
}

export interface ProductionOperationsAlertReview {
  readonly alertId: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly status: 'resolved' | 'acknowledged' | 'open';
}

export interface ProductionOperationsIncidentReview {
  readonly incidentId: string;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
  readonly status: 'resolved' | 'monitoring' | 'active';
}

export interface ProductionOperationsControlInvocation {
  readonly invocationId: string;
  readonly controlId: string;
  readonly status: 'resolved' | 'active';
}

export interface ProductionOperationsRotationTransition {
  readonly authorizationId: string;
  readonly rotatedAtMs: number;
  readonly previousCredentialSetId: string;
  readonly previousSigningKeyId: string;
  readonly previousEncryptionKeyId: string;
  readonly newCredentialSetId: string;
  readonly newSigningKeyId: string;
  readonly newEncryptionKeyId: string;
}

export interface ProductionOperationsDrExercise {
  readonly authorizationId: string;
  readonly exerciseId: string;
  readonly sourceStorageId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly observedContentDigest: string;
  readonly integrityStatus: 'pass' | 'fail';
}

export interface ProductionOperationsOperationalObligations {
  readonly nextCycleDueAtMs: number;
  readonly nextRotationDueAtMs: number;
  readonly nextDrExerciseDueAtMs: number;
  readonly evidenceRetentionUntilMs: number;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
}

export interface ProductionOperationsRolloutPhasePayload {
  readonly rolloutId: string;
  readonly authorizationId: string;
  readonly phase: ProductionOperationsRolloutPhase;
  readonly sequence: number;
  readonly providerCanaryRunId: string;
  readonly providerCanaryArtifactSha256: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly actionBudget: number;
  readonly observedActionCount: number;
  readonly replayCount: number;
  readonly actionIdempotencyKeys: readonly string[];
  readonly identity: ProductionOperationsIdentitySnapshot;
  readonly slo: ProductionOperationsSloSnapshot;
  readonly alerts: readonly ProductionOperationsAlertReview[];
  readonly incidents: readonly ProductionOperationsIncidentReview[];
  readonly controlInvocations: readonly ProductionOperationsControlInvocation[];
  readonly rotationTransition?: ProductionOperationsRotationTransition;
  readonly drExercise?: ProductionOperationsDrExercise;
  readonly operationalObligations?: ProductionOperationsOperationalObligations;
  readonly capturedAtMs: number;
}

export interface ProductionOperationsRolloutGateOptions extends Omit<ProductionProviderCanaryGateOptions, 'canaryEvidence'> {
  readonly providerCanaryEvidence: EvidenceEnvelope<ProductionProviderCanaryPayload>;
  readonly rolloutAuthorization: ProductionOperationsRolloutAuthorization;
  readonly phaseEvidences: readonly EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[];
  readonly phaseEvidenceValidationOptions?: EvidenceValidationOptions;
  readonly expectedPhaseVerifierName?: string;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionOperationsRolloutGate(
  options: ProductionOperationsRolloutGateOptions,
) {
  const reasons: string[] = [];
  const upstream = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate({
    canaryEvidence: options.providerCanaryEvidence,
    evidenceValidationOptions: options.evidenceValidationOptions,
    deploymentEvidenceValidationOptions: options.deploymentEvidenceValidationOptions,
    expectedDeployCommitSha: options.expectedDeployCommitSha,
    expectedDeploymentManifestSha256: options.expectedDeploymentManifestSha256,
    expectedConfigFingerprints: options.expectedConfigFingerprints,
    expectedVerifierName: options.expectedVerifierName,
    expectedDeploymentVerifierName: options.expectedDeploymentVerifierName,
  });
  if (upstream.status !== 'pass') reasons.push('production-operations-rollout-upstream-provider-canary-invalid');

  const canary = options.providerCanaryEvidence.payload;
  validateAuthorization(options.rolloutAuthorization, canary, reasons);
  if (options.phaseEvidences.length !== PHASES.length) reasons.push('production-operations-rollout-phase-count-invalid');

  let previousCompletedAtMs = options.rolloutAuthorization.startsAtMs;
  const phaseSummaries: Array<{
    phase: ProductionOperationsRolloutPhase;
    runId: string | null;
    effectiveEvidenceLevel: string | null;
    effectiveReadinessStatus: string | null;
  }> = [];

  for (let index = 0; index < PHASES.length; index += 1) {
    const phase = PHASES[index];
    const evidence = options.phaseEvidences[index];
    const plan = options.rolloutAuthorization.phasePlan[index];
    if (!evidence || !plan) {
      reasons.push(`production-operations-rollout-phase-missing:${phase}`);
      phaseSummaries.push({ phase, runId: null, effectiveEvidenceLevel: null, effectiveReadinessStatus: null });
      continue;
    }
    const validation = await validateEvidenceEnvelope<ProductionOperationsRolloutPhasePayload>(evidence, options.phaseEvidenceValidationOptions);
    phaseSummaries.push({
      phase,
      runId: evidence.runId,
      effectiveEvidenceLevel: validation.effectiveEvidenceLevel ?? null,
      effectiveReadinessStatus: validation.effectiveReadinessStatus ?? null,
    });
    if (evidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND) {
      reasons.push(`production-operations-rollout-phase-evidence-kind-invalid:${phase}`);
    }
    if (!evidenceSupportsReadiness(validation, 'production-approved')) {
      reasons.push(`production-operations-rollout-phase-evidence-not-production-approved:${phase}`);
    }
    const payload = validation.envelope?.payload;
    if (!payload) {
      reasons.push(`production-operations-rollout-phase-payload-missing:${phase}`);
      continue;
    }
    validatePhase({ payload, evidence, phase, index, plan, previousCompletedAtMs, options, canary, reasons });
    previousCompletedAtMs = Math.max(previousCompletedAtMs, payload.completedAtMs);
  }

  const finalPayload = options.phaseEvidences[PHASES.length - 1]?.payload;
  const obligations = finalPayload?.operationalObligations ?? null;
  if (!reasons.length && !obligations) reasons.push('production-operations-rollout-operational-obligations-missing');
  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    decision: failureReason ? 'hold' as const : 'steady-state-enabled' as const,
    providerCanaryInputEvidence: options.providerCanaryEvidence,
    rolloutAuthorizationId: options.rolloutAuthorization.authorizationId,
    rolloutId: options.rolloutAuthorization.rolloutId,
    phaseSummaries,
    operationalObligations: failureReason ? null : obligations,
    promoteHoldThresholds: { decision: failureReason ? 'hold' as const : 'steady-state-enabled' as const, holdReasons: reasons },
    failureReason,
    bottlenecksToIssue: [] as const,
  };
}

function validateAuthorization(auth: ProductionOperationsRolloutAuthorization, canary: ProductionProviderCanaryPayload, reasons: string[]): void {
  if (!auth.rolloutId || !auth.authorizationId || !auth.changeTicketId || !auth.rollbackControlId || !auth.emergencyHoldControlId) {
    reasons.push('production-operations-rollout-authorization-identity-invalid');
  }
  if (!Number.isFinite(auth.authorizedAtMs) || !Number.isFinite(auth.startsAtMs) || !Number.isFinite(auth.expiresAtMs) ||
    auth.authorizedAtMs > auth.startsAtMs || auth.expiresAtMs <= auth.startsAtMs) {
    reasons.push('production-operations-rollout-authorization-window-invalid');
  }
  if (new Set(auth.approvers.filter(Boolean)).size < 2) reasons.push('production-operations-rollout-two-person-approval-required');
  const source = canary.authorization;
  if (auth.providerName !== source.providerName || auth.accountId !== source.accountId || auth.primaryStorageId !== source.primaryStorageId ||
    auth.backupStorageId !== source.backupStorageId || auth.archiveId !== source.archiveId || auth.archiveContentDigest !== source.archiveContentDigest ||
    stable(auth.deploymentVersionIds) !== stable(source.deploymentVersionIds) || stable(auth.deploymentConfigFingerprints) !== stable(source.deploymentConfigFingerprints)) {
    reasons.push('production-operations-rollout-provider-canary-identity-mismatch');
  }
  if (!SHA256.test(auth.archiveContentDigest)) reasons.push('production-operations-rollout-archive-digest-invalid');
  if (auth.phasePlan.length !== PHASES.length) reasons.push('production-operations-rollout-phase-plan-invalid');
  else {
    let previousEnd = auth.startsAtMs;
    for (let index = 0; index < PHASES.length; index += 1) {
      const plan = auth.phasePlan[index];
      if (plan.phase !== PHASES[index] || plan.sequence !== index + 1 || !Number.isFinite(plan.startsAtMs) || !Number.isFinite(plan.expiresAtMs) ||
        !Number.isFinite(plan.minimumObservationMs) || plan.minimumObservationMs <= 0 || !Number.isInteger(plan.maximumActions) || plan.maximumActions <= 0 ||
        plan.startsAtMs < previousEnd || plan.expiresAtMs <= plan.startsAtMs || plan.startsAtMs < auth.startsAtMs || plan.expiresAtMs > auth.expiresAtMs) {
        reasons.push(`production-operations-rollout-phase-plan-invalid:${PHASES[index]}`);
      }
      previousEnd = plan.expiresAtMs;
    }
  }
  if (auth.maintenance.required && (!auth.maintenance.authorizationId || !Number.isFinite(auth.maintenance.rotationDueAtMs) ||
    !auth.maintenance.previousCredentialSetId || !auth.maintenance.previousSigningKeyId || !auth.maintenance.previousEncryptionKeyId)) {
    reasons.push('production-operations-rollout-maintenance-authorization-invalid');
  }
  if (!auth.drExercise.authorizationId || !Number.isFinite(auth.drExercise.changeWindowStartMs) || !Number.isFinite(auth.drExercise.changeWindowEndMs) ||
    auth.drExercise.changeWindowEndMs <= auth.drExercise.changeWindowStartMs) reasons.push('production-operations-rollout-dr-authorization-invalid');
}

function validatePhase(input: {
  payload: ProductionOperationsRolloutPhasePayload;
  evidence: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>;
  phase: ProductionOperationsRolloutPhase;
  index: number;
  plan: ProductionOperationsRolloutPhasePlan;
  previousCompletedAtMs: number;
  options: ProductionOperationsRolloutGateOptions;
  canary: ProductionProviderCanaryPayload;
  reasons: string[];
}): void {
  const { payload, evidence, phase, index, plan, previousCompletedAtMs, options, canary, reasons } = input;
  if (payload.rolloutId !== options.rolloutAuthorization.rolloutId || payload.authorizationId !== options.rolloutAuthorization.authorizationId ||
    payload.phase !== phase || payload.sequence !== index + 1 || payload.providerCanaryRunId !== options.providerCanaryEvidence.runId ||
    payload.providerCanaryArtifactSha256 !== options.providerCanaryEvidence.artifact?.sha256) reasons.push(`production-operations-rollout-phase-identity-invalid:${phase}`);
  if (evidence.runId !== `${options.rolloutAuthorization.rolloutId}:${index + 1}:${phase}` || Date.parse(evidence.capturedAt) !== payload.capturedAtMs ||
    payload.capturedAtMs !== payload.completedAtMs) reasons.push(`production-operations-rollout-phase-envelope-binding-invalid:${phase}`);
  if (options.expectedPhaseVerifierName && evidence.verification?.verifier !== options.expectedPhaseVerifierName) reasons.push(`production-operations-rollout-phase-verifier-invalid:${phase}`);
  if (payload.startedAtMs < plan.startsAtMs || payload.completedAtMs > plan.expiresAtMs || payload.completedAtMs < payload.startedAtMs ||
    payload.startedAtMs < previousCompletedAtMs || payload.completedAtMs - payload.startedAtMs < plan.minimumObservationMs) reasons.push(`production-operations-rollout-phase-timeline-invalid:${phase}`);
  if (!Number.isInteger(payload.actionBudget) || payload.actionBudget <= 0 || payload.actionBudget > plan.maximumActions || !Number.isInteger(payload.observedActionCount) ||
    payload.observedActionCount <= 0 || payload.observedActionCount > payload.actionBudget || !Number.isInteger(payload.replayCount) || payload.replayCount < 0 ||
    payload.actionIdempotencyKeys.length !== payload.observedActionCount || new Set(payload.actionIdempotencyKeys).size !== payload.actionIdempotencyKeys.length) {
    reasons.push(`production-operations-rollout-phase-action-budget-invalid:${phase}`);
  }
  validateIdentity(payload.identity, options.rolloutAuthorization, phase, reasons);
  validateSlo(payload.slo, phase, reasons);
  if (payload.alerts.some((alert) => alert.severity === 'critical' && alert.status !== 'resolved')) reasons.push(`production-operations-rollout-critical-alert-unresolved:${phase}`);
  if (payload.incidents.some((incident) => (incident.severity === 'sev1' || incident.severity === 'sev2') && incident.status === 'active')) reasons.push(`production-operations-rollout-active-major-incident:${phase}`);
  for (const invocation of payload.controlInvocations) {
    if ((invocation.controlId !== options.rolloutAuthorization.rollbackControlId && invocation.controlId !== options.rolloutAuthorization.emergencyHoldControlId) || invocation.status === 'active') {
      reasons.push(`production-operations-rollout-control-invocation-hold:${phase}`);
    }
  }
  validatePhaseSideEffects(payload, phase, plan, options.rolloutAuthorization, reasons);
  if (phase === 'steady-state-enabled') validateObligations(payload.operationalObligations, payload.completedAtMs, options.rolloutAuthorization, reasons);
  else if (payload.operationalObligations) reasons.push(`production-operations-rollout-premature-obligations:${phase}`);
  if (canary.artifactSha256 !== options.providerCanaryEvidence.artifact?.sha256) reasons.push('production-operations-rollout-provider-canary-artifact-mismatch');
}

function validateIdentity(identity: ProductionOperationsIdentitySnapshot, auth: ProductionOperationsRolloutAuthorization, phase: ProductionOperationsRolloutPhase, reasons: string[]): void {
  if (identity.providerName !== auth.providerName || identity.accountId !== auth.accountId || identity.primaryStorageId !== auth.primaryStorageId ||
    identity.backupStorageId !== auth.backupStorageId || identity.archiveId !== auth.archiveId || identity.archiveContentDigest !== auth.archiveContentDigest ||
    stable(identity.deploymentVersionIds) !== stable(auth.deploymentVersionIds) || stable(identity.deploymentConfigFingerprints) !== stable(auth.deploymentConfigFingerprints)) {
    reasons.push(`production-operations-rollout-identity-drift:${phase}`);
  }
}

function validateSlo(slo: ProductionOperationsSloSnapshot, phase: ProductionOperationsRolloutPhase, reasons: string[]): void {
  if (!Number.isInteger(slo.operationCount) || slo.operationCount <= 0 || !Number.isInteger(slo.failureCount) || slo.failureCount < 0 || slo.failureCount > slo.operationCount ||
    slo.rtoBreachCount !== 0 || slo.rpoBreachCount !== 0 || slo.integrityFailureCount !== 0 || !Number.isFinite(slo.providerAvailabilityPct) ||
    !Number.isFinite(slo.minimumProviderAvailabilityPct) || slo.providerAvailabilityPct < slo.minimumProviderAvailabilityPct || slo.minimumProviderAvailabilityPct < 0 ||
    slo.providerAvailabilityPct > 100 || !Number.isInteger(slo.allowedFailureBudget) || slo.allowedFailureBudget <= 0 ||
    slo.remainingFailureBudget !== slo.allowedFailureBudget - slo.failureCount || slo.remainingFailureBudget <= 0) reasons.push(`production-operations-rollout-slo-hold:${phase}`);
}

function validatePhaseSideEffects(payload: ProductionOperationsRolloutPhasePayload, phase: ProductionOperationsRolloutPhase, plan: ProductionOperationsRolloutPhasePlan, auth: ProductionOperationsRolloutAuthorization, reasons: string[]): void {
  if (phase === 'observe-only') {
    if (payload.rotationTransition || payload.drExercise) reasons.push('production-operations-rollout-observe-only-side-effect-detected');
    return;
  }
  if (phase === 'maintenance-enabled') {
    if (payload.drExercise) reasons.push('production-operations-rollout-maintenance-dr-side-effect-detected');
    if (auth.maintenance.required) {
      const rotation = payload.rotationTransition;
      if (!rotation || rotation.authorizationId !== auth.maintenance.authorizationId || rotation.rotatedAtMs < plan.startsAtMs || rotation.rotatedAtMs > plan.expiresAtMs ||
        rotation.rotatedAtMs > (auth.maintenance.rotationDueAtMs ?? -Infinity) || rotation.previousCredentialSetId !== auth.maintenance.previousCredentialSetId ||
        rotation.previousSigningKeyId !== auth.maintenance.previousSigningKeyId || rotation.previousEncryptionKeyId !== auth.maintenance.previousEncryptionKeyId ||
        !rotation.newCredentialSetId || !rotation.newSigningKeyId || !rotation.newEncryptionKeyId || rotation.newCredentialSetId === rotation.previousCredentialSetId ||
        rotation.newSigningKeyId === rotation.previousSigningKeyId || rotation.newEncryptionKeyId === rotation.previousEncryptionKeyId) reasons.push('production-operations-rollout-maintenance-rotation-invalid');
    } else if (payload.rotationTransition) reasons.push('production-operations-rollout-unexpected-rotation');
    return;
  }
  if (phase === 'dr-exercise-enabled') {
    if (payload.rotationTransition) reasons.push('production-operations-rollout-dr-phase-unexpected-rotation');
    const exercise = payload.drExercise;
    if (!exercise || exercise.authorizationId !== auth.drExercise.authorizationId || !exercise.exerciseId || exercise.sourceStorageId !== auth.backupStorageId ||
      exercise.integrityStatus !== 'pass' || exercise.observedContentDigest !== auth.archiveContentDigest || exercise.completedAtMs < exercise.startedAtMs ||
      exercise.startedAtMs < auth.drExercise.changeWindowStartMs || exercise.completedAtMs > auth.drExercise.changeWindowEndMs ||
      exercise.startedAtMs < plan.startsAtMs || exercise.completedAtMs > plan.expiresAtMs) reasons.push('production-operations-rollout-dr-exercise-invalid');
    return;
  }
  if (payload.rotationTransition || payload.drExercise) reasons.push('production-operations-rollout-steady-state-promotion-side-effect-detected');
}

function validateObligations(obligations: ProductionOperationsOperationalObligations | undefined, completedAtMs: number, auth: ProductionOperationsRolloutAuthorization, reasons: string[]): void {
  if (!obligations || obligations.nextCycleDueAtMs <= completedAtMs || obligations.nextRotationDueAtMs <= completedAtMs || obligations.nextDrExerciseDueAtMs <= completedAtMs ||
    obligations.evidenceRetentionUntilMs <= completedAtMs || !obligations.onCallRoute || !obligations.escalationTarget ||
    obligations.rollbackControlId !== auth.rollbackControlId || obligations.emergencyHoldControlId !== auth.emergencyHoldControlId) reasons.push('production-operations-rollout-operational-obligations-invalid');
}

function stable(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]));
  return value;
}
