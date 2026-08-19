import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type {
  ProviderPostCutoverReconciliationPayload,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-cycle' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_AUTOMATION_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation' as const;

type ProviderPostCutoverReconciliationReport = Awaited<ReturnType<
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate
>>;

export interface SteadyStateArchiveRetrieval {
  readonly retrievalOperationId: string;
  readonly storageId: string;
  readonly archiveId: string;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
  readonly observedContentDigest: string;
  readonly integrityCheckId: string;
  readonly integrityStatus: 'pass' | 'fail';
}

export interface SteadyStateAlertDisposition {
  readonly alertId: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly status: 'resolved' | 'acknowledged' | 'open';
  readonly dispositionId: string;
}

export interface SteadyStateIncidentReview {
  readonly incidentId: string;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
  readonly status: 'resolved' | 'monitoring' | 'active';
  readonly reconciliationId: string;
}

export interface SteadyStateControlInvocation {
  readonly invocationId: string;
  readonly controlId: string;
  readonly status: 'resolved' | 'active';
  readonly reconciliationId?: string;
}

export interface SteadyStateRotationEvent {
  readonly rotationEvidenceId: string;
  readonly rotatedAtMs: number;
  readonly previousCredentialSetId: string;
  readonly previousSigningKeyId: string;
  readonly previousEncryptionKeyId: string;
  readonly newCredentialSetId: string;
  readonly newSigningKeyId: string;
  readonly newEncryptionKeyId: string;
}

export interface SteadyStateDrExercise {
  readonly exerciseId: string;
  readonly sourceStorageId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly recoveryPointAtMs: number;
  readonly observedContentDigest: string;
  readonly integrityCheckId: string;
  readonly integrityStatus: 'pass' | 'fail';
}

export interface SteadyStateRetainedEvidence {
  readonly evidenceArchiveId: string;
  readonly evidenceContentDigest: string;
  readonly retentionUntilMs: number;
  readonly retrievalProofId: string;
}

export interface ProviderSteadyStateCyclePayload {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly cycleId: string;
  readonly scheduleId: string;
  readonly scheduledAtMs: number;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly auditStreamId: string;
  readonly auditCursorStart: string;
  readonly auditCursorEnd: string;
  readonly providerAuditRecordIds: readonly string[];
  readonly primaryRetrieval: SteadyStateArchiveRetrieval;
  readonly backupRetrieval: SteadyStateArchiveRetrieval;
  readonly operationCount: number;
  readonly failureCount: number;
  readonly rtoBreachCount: number;
  readonly rpoBreachCount: number;
  readonly integrityFailureCount: number;
  readonly providerAvailabilityPct: number;
  readonly observedCredentialSetId: string;
  readonly observedSigningKeyId: string;
  readonly observedEncryptionKeyId: string;
  readonly rotationEvent?: SteadyStateRotationEvent;
  readonly drExercise?: SteadyStateDrExercise;
  readonly alertDispositions: readonly SteadyStateAlertDisposition[];
  readonly incidentReviews: readonly SteadyStateIncidentReview[];
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
  readonly rollbackArmed: boolean;
  readonly emergencyHoldArmed: boolean;
  readonly controlInvocations: readonly SteadyStateControlInvocation[];
  readonly retainedEvidence: SteadyStateRetainedEvidence;
  readonly baselineIncidentIds: readonly string[];
  readonly recoveryOwnerId: string;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
  readonly retentionPolicySnapshot: ProviderPostCutoverReconciliationPayload['retentionPolicySnapshot'];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
  readonly capturedAtMs: number;
}

export interface SteadyStateSchedulePolicy {
  readonly scheduleId: string;
  readonly cadenceMs: number;
  readonly graceMs: number;
  readonly lastSuccessfulCycleAtMs: number;
  readonly nextDueAtMs: number;
}

export interface SteadyStateRollingSlo {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly requiredProviderAvailabilityPct: number;
  readonly minimumOperationCount: number;
  readonly totalOperationCount: number;
  readonly totalFailureCount: number;
  readonly rtoBreachCount: number;
  readonly rpoBreachCount: number;
  readonly integrityFailureCount: number;
  readonly providerAvailabilityFloorPct: number;
  readonly allowedFailureBudget: number;
  readonly remainingFailureBudget: number;
}

export interface SteadyStateCredentialRotationPolicy {
  readonly rotationCadenceMs: number;
  readonly lastRotatedAtMs: number;
  readonly nextRotationDueAtMs: number;
  readonly currentCredentialSetId: string;
  readonly currentSigningKeyId: string;
  readonly currentEncryptionKeyId: string;
  readonly rotationEvidenceIds: readonly string[];
}

export interface SteadyStateDrPolicy {
  readonly policyId: string;
  readonly drillCadenceMs: number;
  readonly graceMs: number;
  readonly baselineLastExerciseAtMs: number;
  readonly lastExerciseAtMs: number;
  readonly nextExerciseDueAtMs: number;
  readonly requiredBackupSourceStorageId: string;
}

export interface SteadyStateEvidenceRetentionPolicy {
  readonly policyId: string;
  readonly minimumRetentionMs: number;
}

export interface ProviderSteadyStateOperationsPayload {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly baselineReconciliationRunId: string;
  readonly cycleRunIds: readonly string[];
  readonly schedule: SteadyStateSchedulePolicy;
  readonly rollingSlo: SteadyStateRollingSlo;
  readonly credentialRotation: SteadyStateCredentialRotationPolicy;
  readonly drPolicy: SteadyStateDrPolicy;
  readonly evidenceRetention: SteadyStateEvidenceRetentionPolicy;
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
  readonly baselineIncidentIds: readonly string[];
  readonly recoveryOwnerId: string;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
  readonly retentionPolicySnapshot: ProviderPostCutoverReconciliationPayload['retentionPolicySnapshot'];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
  readonly capturedAtMs: number;
}

export interface ProviderSteadyStateOperationsOptions {
  readonly postCutoverReconciliationReport: ProviderPostCutoverReconciliationReport;
  readonly postCutoverReconciliationEvidence: EvidenceEnvelope<ProviderPostCutoverReconciliationPayload>;
  readonly steadyStateCycleEvidence: readonly EvidenceEnvelope<ProviderSteadyStateCyclePayload>[];
  readonly steadyStateOperationsEvidence: EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
}

interface VerifiedCycle {
  readonly runId: string;
  readonly payload: ProviderSteadyStateCyclePayload;
  readonly artifactSha256: string;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate(
  options: ProviderSteadyStateOperationsOptions,
) {
  const reconciliationValidation = await validateEvidenceEnvelope<ProviderPostCutoverReconciliationPayload>(
    options.postCutoverReconciliationEvidence,
    options.evidenceValidationOptions,
  );
  const operationsValidation = await validateEvidenceEnvelope<ProviderSteadyStateOperationsPayload>(
    options.steadyStateOperationsEvidence,
    options.evidenceValidationOptions,
  );
  const cycleValidations = await Promise.all(
    options.steadyStateCycleEvidence.map((evidence) =>
      validateEvidenceEnvelope<ProviderSteadyStateCyclePayload>(evidence, options.evidenceValidationOptions),
    ),
  );

  const upstream = options.postCutoverReconciliationReport;
  const baseline = reconciliationValidation.envelope?.payload;
  const payload = operationsValidation.envelope?.payload;
  const reasons: string[] = [];
  const verifiedCycles: VerifiedCycle[] = [];

  if (upstream.status !== 'pass') reasons.push('post-cutover-reconciliation-not-clean');
  if (!evidenceSupportsReadiness(reconciliationValidation, 'production-approved')) reasons.push('reconciliation-evidence-not-production-approved');
  if (options.postCutoverReconciliationEvidence.runId !== upstream.reconciliationEvidenceSummary.runId) reasons.push('reconciliation-run-mismatch');
  if (JSON.stringify(options.postCutoverReconciliationEvidence) !== JSON.stringify(upstream.reconciliationInputEvidence)) reasons.push('reconciliation-input-mismatch');
  if (!evidenceSupportsReadiness(operationsValidation, 'production-approved')) reasons.push('requires-production-approved-steady-state-evidence');
  if (options.steadyStateOperationsEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND) {
    reasons.push('steady-state-evidence-kind-invalid');
  }
  if (!payload || !baseline) reasons.push('steady-state-or-baseline-payload-missing');

  options.steadyStateCycleEvidence.forEach((evidence, index) => {
    const validation = cycleValidations[index];
    if (evidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND) {
      reasons.push(`steady-state-cycle-kind-invalid:${evidence.runId}`);
    }
    if (!evidenceSupportsReadiness(validation, 'production-approved')) {
      reasons.push(`steady-state-cycle-not-verified:${evidence.runId}`);
      return;
    }
    const cycle = validation.envelope?.payload;
    const artifactSha256 = validation.envelope?.artifact?.sha256;
    if (cycle && artifactSha256) verifiedCycles.push({ runId: evidence.runId, payload: cycle, artifactSha256 });
  });

  const distinctRunIds = new Set(verifiedCycles.map((cycle) => cycle.runId));
  if (verifiedCycles.length < 3 || distinctRunIds.size < 3) reasons.push('requires-three-distinct-steady-state-cycles');

  if (payload && baseline) {
    if (!sameIdentity(payload, baseline)) reasons.push('provider-identity-drift');
    if (payload.baselineReconciliationRunId !== options.postCutoverReconciliationEvidence.runId) reasons.push('baseline-reconciliation-run-mismatch');
    if (!sameSet(payload.cycleRunIds, verifiedCycles.map((cycle) => cycle.runId))) reasons.push('steady-state-cycle-set-mismatch');

    for (const cycle of verifiedCycles) {
      validateCycleIdentity(cycle, baseline, payload, reasons);
      validateCycleArchive(cycle, payload, reasons);
      validateCycleAlertsIncidentsControls(cycle, payload, reasons);
      validateCycleRetention(cycle, payload.evidenceRetention, reasons);
      validateCycleSecurity(cycle, baseline, reasons);
    }

    const ordered = [...verifiedCycles].sort((a, b) => a.payload.scheduledAtMs - b.payload.scheduledAtMs);
    validateSchedule(payload, baseline, ordered, reasons);
    validateAuditContinuity(ordered, reasons);
    validateRollingSlo(payload.rollingSlo, ordered, reasons);
    validateCredentialRotation(payload, upstream, ordered, reasons);
    validateDrPolicy(payload.drPolicy, ordered, payload.capturedAtMs, reasons);

    if (payload.rollbackControlId !== baseline.controlState.rollbackControlId ||
      payload.emergencyHoldControlId !== baseline.controlState.emergencyHoldControlId) reasons.push('control-identity-drift');
    if (!sameSet(payload.baselineIncidentIds, baseline.baselineIncidentIds)) reasons.push('baseline-incident-set-drift');
    if (payload.recoveryOwnerId !== baseline.recoveryOwnerId || payload.onCallRoute !== baseline.onCallRoute ||
      payload.escalationTarget !== baseline.escalationTarget) reasons.push('operations-identity-drift');
    if (JSON.stringify(payload.retentionPolicySnapshot) !== JSON.stringify(baseline.retentionPolicySnapshot)) reasons.push('retention-state-drift');
    if (!sameSet(payload.allowedOrigins, baseline.allowedOrigins) || !sameSet(payload.cspConnectSrc, baseline.cspConnectSrc) ||
      !sameSet(payload.sandboxFlags, baseline.sandboxFlags) || payload.coop !== baseline.coop || payload.coep !== baseline.coep) {
      reasons.push('steady-state-security-boundary-drift');
    }

    const blockedAttempt = payload.networkAttempts.find(
      (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
    );
    const leaked = payload.networkAttempts.find(
      (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
    );
    if (leaked) reasons.push(`network-leak:${originOf(leaked.url)}`);
    if (!blockedAttempt) reasons.push('missing-blocked-network-attempt');
    if (!payload.allowedOrigins.every((origin) => payload.cspConnectSrc.includes(origin))) reasons.push('csp-invalid');
    if (!(payload.sandboxFlags.length === 1 && payload.sandboxFlags[0] === 'allow-scripts')) reasons.push('sandbox-invalid');
    if (payload.coop !== 'same-origin' || payload.coep !== 'require-corp') reasons.push('cross-origin-isolation-lost');

    const envelopeCapturedAtMs = Date.parse(options.steadyStateOperationsEvidence.capturedAt);
    const lastCompletedAtMs = ordered.at(-1)?.payload.completedAtMs ?? 0;
    if (!Number.isFinite(envelopeCapturedAtMs) || envelopeCapturedAtMs !== payload.capturedAtMs || payload.capturedAtMs < lastCompletedAtMs) {
      reasons.push('steady-state-capture-timeline-invalid');
    }
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    previewRunnerUrl: upstream.previewRunnerUrl,
    postCutoverReconciliationEvidence: upstream,
    steadyStateInputEvidence: options.steadyStateOperationsEvidence,
    steadyStateEvidenceSummary: {
      validationStatus: operationsValidation.status,
      effectiveEvidenceLevel: operationsValidation.effectiveEvidenceLevel,
      effectiveReadinessStatus: operationsValidation.effectiveReadinessStatus,
      evidenceKind: options.steadyStateOperationsEvidence.evidenceKind,
      runId: options.steadyStateOperationsEvidence.runId,
    },
    cycleSummary: {
      totalCycles: options.steadyStateCycleEvidence.length,
      validatedCycles: verifiedCycles.length,
      distinctRunIds: distinctRunIds.size,
    },
    schedule: payload?.schedule ?? null,
    rollingSlo: payload?.rollingSlo ?? null,
    credentialRotation: payload?.credentialRotation ?? null,
    drPolicy: payload?.drPolicy ?? null,
    evidenceRetention: payload?.evidenceRetention ?? null,
    promoteHoldThresholds: {
      decision: failureReason ? 'hold' as const : 'promote' as const,
      holdReasons: reasons,
    },
    failureReason,
    bottlenecksToIssue: failureReason ? [] : [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_AUTOMATION_BOTTLENECK],
  };
}

function validateCycleIdentity(
  cycle: VerifiedCycle,
  baseline: ProviderPostCutoverReconciliationPayload,
  operations: ProviderSteadyStateOperationsPayload,
  reasons: string[],
): void {
  const p = cycle.payload;
  if (!p.cycleId || p.cycleId !== cycle.runId || p.scheduleId !== operations.schedule.scheduleId ||
    !sameIdentity(p, baseline) || p.rollbackControlId !== operations.rollbackControlId ||
    p.emergencyHoldControlId !== operations.emergencyHoldControlId ||
    !sameSet(p.baselineIncidentIds, operations.baselineIncidentIds) ||
    p.recoveryOwnerId !== operations.recoveryOwnerId || p.onCallRoute !== operations.onCallRoute ||
    p.escalationTarget !== operations.escalationTarget ||
    JSON.stringify(p.retentionPolicySnapshot) !== JSON.stringify(operations.retentionPolicySnapshot)) {
    reasons.push(`steady-state-cycle-identity-invalid:${cycle.runId}`);
  }
  if (p.completedAtMs < p.startedAtMs || p.capturedAtMs < p.completedAtMs) reasons.push(`steady-state-cycle-timeline-invalid:${cycle.runId}`);
}

function validateCycleArchive(cycle: VerifiedCycle, operations: ProviderSteadyStateOperationsPayload, reasons: string[]): void {
  const p = cycle.payload;
  for (const [label, retrieval, storageId] of [
    ['primary', p.primaryRetrieval, operations.primaryStorageId],
    ['backup', p.backupRetrieval, operations.backupStorageId],
  ] as const) {
    if (!retrieval.retrievalOperationId || !retrieval.integrityCheckId || retrieval.storageId !== storageId ||
      retrieval.archiveId !== operations.archiveId || retrieval.observedContentDigest !== operations.archiveContentDigest ||
      retrieval.integrityStatus !== 'pass' || retrieval.requestedAtMs < p.startedAtMs ||
      retrieval.completedAtMs > p.completedAtMs || retrieval.completedAtMs < retrieval.requestedAtMs) {
      reasons.push(`steady-state-${label}-archive-retrieval-invalid:${cycle.runId}`);
    }
  }
}

function validateCycleAlertsIncidentsControls(cycle: VerifiedCycle, operations: ProviderSteadyStateOperationsPayload, reasons: string[]): void {
  const p = cycle.payload;
  const alertIds = new Set<string>();
  for (const alert of p.alertDispositions) {
    if (!alert.alertId || !alert.dispositionId || alertIds.has(alert.alertId) ||
      (alert.severity === 'critical' && alert.status !== 'resolved')) reasons.push(`steady-state-alert-invalid:${cycle.runId}`);
    alertIds.add(alert.alertId);
  }
  for (const incident of p.incidentReviews) {
    if (!incident.incidentId || !incident.reconciliationId ||
      ((incident.severity === 'sev1' || incident.severity === 'sev2') && incident.status === 'active')) {
      reasons.push(`steady-state-incident-invalid:${cycle.runId}`);
    }
  }
  if (p.rollbackControlId !== operations.rollbackControlId || p.emergencyHoldControlId !== operations.emergencyHoldControlId ||
    !p.rollbackArmed || !p.emergencyHoldArmed) reasons.push(`steady-state-controls-not-armed:${cycle.runId}`);
  for (const invocation of p.controlInvocations) {
    if (!invocation.invocationId || !invocation.controlId ||
      ![operations.rollbackControlId, operations.emergencyHoldControlId].includes(invocation.controlId) ||
      invocation.status === 'active' || !invocation.reconciliationId) reasons.push(`steady-state-control-invocation-invalid:${cycle.runId}`);
  }
}

function validateCycleRetention(cycle: VerifiedCycle, policy: SteadyStateEvidenceRetentionPolicy, reasons: string[]): void {
  const retained = cycle.payload.retainedEvidence;
  if (!policy.policyId || policy.minimumRetentionMs <= 0 || !retained.evidenceArchiveId || !retained.retrievalProofId ||
    retained.evidenceContentDigest !== cycle.artifactSha256 ||
    retained.retentionUntilMs < cycle.payload.capturedAtMs + policy.minimumRetentionMs) {
    reasons.push(`steady-state-evidence-retention-invalid:${cycle.runId}`);
  }
}

function validateCycleSecurity(cycle: VerifiedCycle, baseline: ProviderPostCutoverReconciliationPayload, reasons: string[]): void {
  const p = cycle.payload;
  if (!sameSet(p.allowedOrigins, baseline.allowedOrigins) || !sameSet(p.cspConnectSrc, baseline.cspConnectSrc) ||
    !sameSet(p.sandboxFlags, baseline.sandboxFlags) || p.coop !== baseline.coop || p.coep !== baseline.coep) {
    reasons.push(`steady-state-cycle-security-drift:${cycle.runId}`);
  }
  const blocked = p.networkAttempts.find((attempt) => !p.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked);
  const leaked = p.networkAttempts.find((attempt) => !p.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked);
  if (!blocked) reasons.push(`steady-state-cycle-missing-blocked-network-attempt:${cycle.runId}`);
  if (leaked) reasons.push(`steady-state-cycle-network-leak:${cycle.runId}`);
}

function validateSchedule(
  operations: ProviderSteadyStateOperationsPayload,
  baseline: ProviderPostCutoverReconciliationPayload,
  cycles: readonly VerifiedCycle[],
  reasons: string[],
): void {
  const schedule = operations.schedule;
  if (!schedule.scheduleId || schedule.cadenceMs <= 0 || schedule.graceMs < 0 || cycles.length === 0) {
    reasons.push('steady-state-schedule-invalid');
    return;
  }
  const baselineEnd = baseline.observationWindow.endsAtMs;
  for (let i = 0; i < cycles.length; i += 1) {
    const cycle = cycles[i].payload;
    if (cycle.scheduledAtMs < baselineEnd || cycle.startedAtMs < cycle.scheduledAtMs - schedule.graceMs ||
      cycle.startedAtMs > cycle.scheduledAtMs + schedule.graceMs) reasons.push(`steady-state-cycle-schedule-miss:${cycles[i].runId}`);
    if (i > 0 && cycle.scheduledAtMs !== cycles[i - 1].payload.scheduledAtMs + schedule.cadenceMs) {
      reasons.push('steady-state-cycle-cadence-gap');
    }
  }
  const last = cycles.at(-1)!.payload;
  if (schedule.lastSuccessfulCycleAtMs !== last.completedAtMs || schedule.nextDueAtMs !== last.scheduledAtMs + schedule.cadenceMs ||
    operations.capturedAtMs > schedule.nextDueAtMs + schedule.graceMs) reasons.push('steady-state-schedule-overdue-or-inconsistent');
}

function validateAuditContinuity(cycles: readonly VerifiedCycle[], reasons: string[]): void {
  for (let i = 0; i < cycles.length; i += 1) {
    const p = cycles[i].payload;
    if (!p.auditStreamId || !p.auditCursorStart || !p.auditCursorEnd || p.auditCursorStart === p.auditCursorEnd ||
      p.providerAuditRecordIds.length < 2 || new Set(p.providerAuditRecordIds).size !== p.providerAuditRecordIds.length) {
      reasons.push(`steady-state-audit-invalid:${cycles[i].runId}`);
    }
    if (i > 0) {
      const previous = cycles[i - 1].payload;
      if (p.auditStreamId !== previous.auditStreamId || p.auditCursorStart !== previous.auditCursorEnd) {
        reasons.push('steady-state-audit-continuity-broken');
      }
    }
  }
}

function validateRollingSlo(slo: SteadyStateRollingSlo, cycles: readonly VerifiedCycle[], reasons: string[]): void {
  const totalOperations = cycles.reduce((sum, cycle) => sum + cycle.payload.operationCount, 0);
  const totalFailures = cycles.reduce((sum, cycle) => sum + cycle.payload.failureCount, 0);
  const rto = cycles.reduce((sum, cycle) => sum + cycle.payload.rtoBreachCount, 0);
  const rpo = cycles.reduce((sum, cycle) => sum + cycle.payload.rpoBreachCount, 0);
  const integrity = cycles.reduce((sum, cycle) => sum + cycle.payload.integrityFailureCount, 0);
  const floor = cycles.length ? Math.min(...cycles.map((cycle) => cycle.payload.providerAvailabilityPct)) : 0;
  if (!slo.policyId || !slo.policyVersion || slo.requiredProviderAvailabilityPct <= 0 || slo.requiredProviderAvailabilityPct > 100 ||
    slo.minimumOperationCount <= 0 || totalOperations < slo.minimumOperationCount ||
    slo.totalOperationCount !== totalOperations || slo.totalFailureCount !== totalFailures ||
    slo.rtoBreachCount !== rto || slo.rpoBreachCount !== rpo || slo.integrityFailureCount !== integrity ||
    slo.providerAvailabilityFloorPct !== floor || floor < slo.requiredProviderAvailabilityPct ||
    rto !== 0 || rpo !== 0 || integrity !== 0 || slo.allowedFailureBudget < 0 ||
    slo.remainingFailureBudget !== slo.allowedFailureBudget - totalFailures || slo.remainingFailureBudget <= 0) {
    reasons.push('steady-state-rolling-slo-invalid');
  }
}

function validateCredentialRotation(
  operations: ProviderSteadyStateOperationsPayload,
  upstream: ProviderPostCutoverReconciliationReport,
  cycles: readonly VerifiedCycle[],
  reasons: string[],
): void {
  const baselineRotation = upstream.productionCutoverEvidence.productionReadinessEvidence.readinessInputEvidence.payload.credentialRotation;
  const policy = operations.credentialRotation;
  if (policy.rotationCadenceMs <= 0 || policy.lastRotatedAtMs !== baselineRotation.lastRotatedAtMs ||
    policy.nextRotationDueAtMs !== baselineRotation.nextRotationDueAtMs) {
    reasons.push('steady-state-rotation-policy-invalid');
    return;
  }

  let currentCredential = baselineRotation.credentialSetId;
  let currentSigning = baselineRotation.signingKeyId;
  let currentEncryption = baselineRotation.encryptionKeyId;
  let lastRotatedAt = baselineRotation.lastRotatedAtMs;
  let nextDue = baselineRotation.nextRotationDueAtMs;
  const rotationIds: string[] = [];

  for (const cycle of cycles) {
    const p = cycle.payload;
    const rotation = p.rotationEvent;
    if (rotation) {
      if (!rotation.rotationEvidenceId || rotation.rotatedAtMs > nextDue || rotation.rotatedAtMs < lastRotatedAt ||
        rotation.previousCredentialSetId !== currentCredential || rotation.previousSigningKeyId !== currentSigning ||
        rotation.previousEncryptionKeyId !== currentEncryption || rotation.newCredentialSetId !== p.observedCredentialSetId ||
        rotation.newSigningKeyId !== p.observedSigningKeyId || rotation.newEncryptionKeyId !== p.observedEncryptionKeyId ||
        rotation.newCredentialSetId === currentCredential || rotation.newSigningKeyId === currentSigning ||
        rotation.newEncryptionKeyId === currentEncryption) {
        reasons.push(`steady-state-key-rotation-invalid:${cycle.runId}`);
      } else {
        currentCredential = rotation.newCredentialSetId;
        currentSigning = rotation.newSigningKeyId;
        currentEncryption = rotation.newEncryptionKeyId;
        lastRotatedAt = rotation.rotatedAtMs;
        nextDue = rotation.rotatedAtMs + policy.rotationCadenceMs;
        rotationIds.push(rotation.rotationEvidenceId);
      }
    } else if (p.completedAtMs >= nextDue || p.observedCredentialSetId !== currentCredential ||
      p.observedSigningKeyId !== currentSigning || p.observedEncryptionKeyId !== currentEncryption) {
      reasons.push(`steady-state-key-rotation-missing-or-drift:${cycle.runId}`);
    }
  }

  if (operations.capturedAtMs >= nextDue || policy.lastRotatedAtMs !== lastRotatedAt || policy.nextRotationDueAtMs !== nextDue ||
    policy.currentCredentialSetId !== currentCredential || policy.currentSigningKeyId !== currentSigning ||
    policy.currentEncryptionKeyId !== currentEncryption || !sameSet(policy.rotationEvidenceIds, rotationIds)) {
    reasons.push('steady-state-credential-posture-invalid');
  }
}

function validateDrPolicy(
  policy: SteadyStateDrPolicy,
  cycles: readonly VerifiedCycle[],
  capturedAtMs: number,
  reasons: string[],
): void {
  if (!policy.policyId || policy.drillCadenceMs <= 0 || policy.graceMs < 0 || !policy.requiredBackupSourceStorageId ||
    policy.baselineLastExerciseAtMs <= 0) {
    reasons.push('steady-state-dr-policy-invalid');
    return;
  }
  const exercises = cycles
    .filter((cycle) => cycle.payload.drExercise)
    .map((cycle) => ({ runId: cycle.runId, exercise: cycle.payload.drExercise! }))
    .sort((a, b) => a.exercise.completedAtMs - b.exercise.completedAtMs);
  if (exercises.length === 0 || !exercises.some((item) => item.exercise.sourceStorageId === policy.requiredBackupSourceStorageId)) {
    reasons.push('steady-state-backup-dr-exercise-missing');
    return;
  }
  let previousAt = policy.baselineLastExerciseAtMs;
  for (const { runId, exercise } of exercises) {
    if (!exercise.exerciseId || !exercise.integrityCheckId || exercise.integrityStatus !== 'pass' ||
      exercise.observedContentDigest !== cycles.find((cycle) => cycle.runId === runId)!.payload.archiveContentDigest ||
      exercise.completedAtMs < exercise.startedAtMs || exercise.recoveryPointAtMs > exercise.startedAtMs ||
      exercise.completedAtMs - previousAt > policy.drillCadenceMs + policy.graceMs) {
      reasons.push(`steady-state-dr-exercise-invalid:${runId}`);
    }
    previousAt = exercise.completedAtMs;
  }
  const lastExerciseAt = exercises.at(-1)!.exercise.completedAtMs;
  if (policy.lastExerciseAtMs !== lastExerciseAt || policy.nextExerciseDueAtMs !== lastExerciseAt + policy.drillCadenceMs ||
    capturedAtMs > policy.nextExerciseDueAtMs + policy.graceMs) reasons.push('steady-state-dr-schedule-overdue-or-inconsistent');
}

function sameIdentity(
  a: Pick<ProviderSteadyStateOperationsPayload, 'providerName' | 'accountId' | 'primaryStorageId' | 'backupStorageId' | 'replicaSiteId' | 'replicaRegion' | 'archiveId' | 'archiveContentDigest'>,
  b: Pick<ProviderPostCutoverReconciliationPayload, 'providerName' | 'accountId' | 'primaryStorageId' | 'backupStorageId' | 'replicaSiteId' | 'replicaRegion' | 'archiveId' | 'archiveContentDigest'>,
): boolean {
  return a.providerName === b.providerName && a.accountId === b.accountId &&
    a.primaryStorageId === b.primaryStorageId && a.backupStorageId === b.backupStorageId &&
    a.replicaSiteId === b.replicaSiteId && a.replicaRegion === b.replicaRegion &&
    a.archiveId === b.archiveId && a.archiveContentDigest === b.archiveContentDigest;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}
