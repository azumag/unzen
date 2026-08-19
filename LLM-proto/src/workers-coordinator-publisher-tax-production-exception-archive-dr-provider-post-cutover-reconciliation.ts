import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type {
  ProviderProductionCutoverPayload,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation' as const;

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-steady-state-operations' as const;

type ProviderProductionCutoverReport = Awaited<ReturnType<
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate
>>;

export interface PostCutoverObservationWindow {
  readonly windowId: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly minimumDurationMs: number;
}

export interface PostCutoverProviderAuditRecord {
  readonly auditRecordId: string;
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly cutoverRunId: string;
  readonly providerOperationId: string;
  readonly providerTraceId: string;
  readonly restoreExecutionId: string;
  readonly observedAtMs: number;
  readonly outcome: 'success' | 'warning' | 'failure';
  readonly alertId?: string;
}

export interface PostCutoverArchiveRetrieval {
  readonly retrievalOperationId: string;
  readonly storageId: string;
  readonly archiveId: string;
  readonly requestedAtMs: number;
  readonly completedAtMs: number;
  readonly observedContentDigest: string;
  readonly integrityCheckId: string;
  readonly integrityStatus: 'pass' | 'fail';
}

export interface PostCutoverAlertDisposition {
  readonly alertId: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly status: 'resolved' | 'acknowledged' | 'open';
  readonly dispositionId: string;
  readonly observedAtMs: number;
  readonly resolvedAtMs?: number;
  readonly incidentId?: string;
}

export interface PostCutoverIncidentReconciliation {
  readonly incidentId: string;
  readonly severity: 'sev1' | 'sev2' | 'sev3';
  readonly status: 'resolved' | 'monitoring' | 'active';
  readonly ownerId: string;
  readonly escalationTarget: string;
  readonly reconciliationId: string;
  readonly relatedAlertIds: readonly string[];
  readonly observedAtMs: number;
}

export interface PostCutoverControlInvocation {
  readonly invocationId: string;
  readonly controlId: string;
  readonly invokedAtMs: number;
  readonly status: 'resolved' | 'active';
  readonly reconciliationId?: string;
  readonly resolvedAtMs?: number;
}

export interface PostCutoverControlState {
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
  readonly rollbackArmed: boolean;
  readonly emergencyHoldArmed: boolean;
  readonly invocations: readonly PostCutoverControlInvocation[];
}

export interface PostCutoverSloEvidence {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly observedFromMs: number;
  readonly observedToMs: number;
  readonly operationCount: number;
  readonly failureCount: number;
  readonly rtoBreachCount: number;
  readonly rpoBreachCount: number;
  readonly integrityFailureCount: number;
  readonly providerAvailabilityPct: number;
  readonly requiredProviderAvailabilityPct: number;
  readonly allowedFailureBudget: number;
  readonly remainingFailureBudget: number;
}

export interface ProviderPostCutoverReconciliationPayload {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly cutoverRunId: string;
  readonly cutoverId: string;
  readonly productionWindowId: string;
  readonly changeTicketId: string;
  readonly providerOperationId: string;
  readonly providerTraceId: string;
  readonly restoreExecutionId: string;
  readonly observationWindow: PostCutoverObservationWindow;
  readonly providerAuditStreamId: string;
  readonly providerAuditCursor: string;
  readonly providerAuditRecords: readonly PostCutoverProviderAuditRecord[];
  readonly archiveRetrievals: readonly PostCutoverArchiveRetrieval[];
  readonly alertDispositions: readonly PostCutoverAlertDisposition[];
  readonly baselineIncidentIds: readonly string[];
  readonly incidentReconciliations: readonly PostCutoverIncidentReconciliation[];
  readonly controlState: PostCutoverControlState;
  readonly slo: PostCutoverSloEvidence;
  readonly observedCredentialSetId: string;
  readonly observedSigningKeyId: string;
  readonly observedEncryptionKeyId: string;
  readonly recoveryOwnerId: string;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
  readonly retentionPolicySnapshot: ProviderProductionCutoverPayload['retentionPolicySnapshot'];
  readonly reconciliationId: string;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
  readonly capturedAtMs: number;
}

export interface ProviderPostCutoverReconciliationOptions {
  readonly productionCutoverReport: ProviderProductionCutoverReport;
  readonly productionCutoverEvidence: EvidenceEnvelope<ProviderProductionCutoverPayload>;
  readonly postCutoverReconciliationEvidence: EvidenceEnvelope<ProviderPostCutoverReconciliationPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate(
  options: ProviderPostCutoverReconciliationOptions,
) {
  const cutoverValidation = await validateEvidenceEnvelope<ProviderProductionCutoverPayload>(
    options.productionCutoverEvidence,
    options.evidenceValidationOptions,
  );
  const reconciliationValidation = await validateEvidenceEnvelope<ProviderPostCutoverReconciliationPayload>(
    options.postCutoverReconciliationEvidence,
    options.evidenceValidationOptions,
  );
  const cutoverPayload = cutoverValidation.envelope?.payload;
  const payload = reconciliationValidation.envelope?.payload;
  const upstream = options.productionCutoverReport;
  const reasons: string[] = [];
  const blockedAttempt = payload?.networkAttempts.find(
    (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;

  if (upstream.status !== 'pass') reasons.push('production-cutover-not-clean');
  if (!evidenceSupportsReadiness(cutoverValidation, 'production-approved')) reasons.push('cutover-evidence-not-production-approved');
  if (options.productionCutoverEvidence.runId !== upstream.cutoverEvidenceSummary.runId) reasons.push('cutover-run-mismatch');
  if (JSON.stringify(options.productionCutoverEvidence) !== JSON.stringify(upstream.cutoverInputEvidence)) reasons.push('cutover-input-mismatch');
  if (!evidenceSupportsReadiness(reconciliationValidation, 'production-approved')) reasons.push('requires-production-approved-reconciliation-evidence');
  if (options.postCutoverReconciliationEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND) {
    reasons.push('reconciliation-evidence-kind-invalid');
  }
  if (!payload || !cutoverPayload) reasons.push('reconciliation-or-cutover-payload-missing');

  if (payload && cutoverPayload) {
    if (!sameIdentity(payload, cutoverPayload)) reasons.push('provider-identity-drift');
    validateCutoverLinkage(payload, cutoverPayload, options.productionCutoverEvidence.runId, reasons);
    validateObservationWindow(payload, cutoverPayload, reasons);
    validateAuditRecords(payload, cutoverPayload, reasons);
    validateArchiveRetrievals(payload, cutoverPayload, reasons);
    validateAlertsAndIncidents(payload, cutoverPayload, reasons);
    validateControlState(payload, cutoverPayload, reasons);
    validateSlo(payload, reasons);

    const readinessPayload = upstream.productionReadinessEvidence.readinessInputEvidence.payload;
    if (
      payload.observedCredentialSetId !== cutoverPayload.observedCredentialSetId ||
      payload.observedSigningKeyId !== cutoverPayload.observedSigningKeyId ||
      payload.observedEncryptionKeyId !== cutoverPayload.observedEncryptionKeyId ||
      payload.observationWindow.endsAtMs >= readinessPayload.credentialRotation.nextRotationDueAtMs
    ) reasons.push('credential-key-posture-invalid');

    if (
      payload.recoveryOwnerId !== cutoverPayload.recoveryOwnerId ||
      payload.onCallRoute !== cutoverPayload.onCallRoute ||
      payload.escalationTarget !== cutoverPayload.escalationTarget
    ) reasons.push('operations-identity-drift');
    if (!sameSet(payload.baselineIncidentIds, cutoverPayload.incidentIds)) reasons.push('baseline-incident-set-drift');
    if (JSON.stringify(payload.retentionPolicySnapshot) !== JSON.stringify(cutoverPayload.retentionPolicySnapshot)) reasons.push('retention-state-drift');
    if (!payload.reconciliationId) reasons.push('reconciliation-id-missing');

    const envelopeCapturedAtMs = Date.parse(options.postCutoverReconciliationEvidence.capturedAt);
    if (
      !Number.isFinite(envelopeCapturedAtMs) ||
      envelopeCapturedAtMs !== payload.capturedAtMs ||
      payload.capturedAtMs < payload.observationWindow.endsAtMs
    ) reasons.push('reconciliation-capture-timeline-invalid');

    if (!sameSet(payload.allowedOrigins, cutoverPayload.allowedOrigins) ||
      !sameSet(payload.cspConnectSrc, cutoverPayload.cspConnectSrc)) reasons.push('security-origin-boundary-drift');
    const leaked = payload.networkAttempts.find(
      (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
    );
    if (leaked) reasons.push(`network-leak:${originOf(leaked.url)}`);
    if (!blockedAttempt) reasons.push('missing-blocked-network-attempt');
    if (!payload.allowedOrigins.every((origin) => payload.cspConnectSrc.includes(origin))) reasons.push('csp-invalid');
    if (!(payload.sandboxFlags.length === 1 && payload.sandboxFlags[0] === 'allow-scripts') ||
      !sameSet(payload.sandboxFlags, cutoverPayload.sandboxFlags)) reasons.push('sandbox-invalid');
    if (payload.coop !== 'same-origin' || payload.coep !== 'require-corp' ||
      payload.coop !== cutoverPayload.coop || payload.coep !== cutoverPayload.coep) reasons.push('cross-origin-isolation-lost');
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    previewRunnerUrl: upstream.previewRunnerUrl,
    productionCutoverEvidence: upstream,
    reconciliationInputEvidence: options.postCutoverReconciliationEvidence,
    reconciliationEvidenceSummary: {
      validationStatus: reconciliationValidation.status,
      effectiveEvidenceLevel: reconciliationValidation.effectiveEvidenceLevel,
      effectiveReadinessStatus: reconciliationValidation.effectiveReadinessStatus,
      evidenceKind: options.postCutoverReconciliationEvidence.evidenceKind,
      runId: options.postCutoverReconciliationEvidence.runId,
    },
    observationWindow: payload?.observationWindow ?? null,
    auditSummary: {
      providerAuditRecordCount: payload?.providerAuditRecords.length ?? 0,
      archiveRetrievalCount: payload?.archiveRetrievals.length ?? 0,
      alertDispositionCount: payload?.alertDispositions.length ?? 0,
      incidentReconciliationCount: payload?.incidentReconciliations.length ?? 0,
      controlInvocationCount: payload?.controlState.invocations.length ?? 0,
    },
    slo: payload?.slo ?? null,
    controlState: payload?.controlState ?? null,
    reconciliationId: payload?.reconciliationId ?? null,
    retentionPolicySnapshot: payload?.retentionPolicySnapshot ?? upstream.retentionPolicySnapshot,
    securityBoundaryDuringPostCutoverReconciliation: {
      allowedOrigins: payload?.allowedOrigins ?? [],
      cspConnectSrc: payload?.cspConnectSrc ?? [],
      sandboxFlags: payload?.sandboxFlags ?? [],
      coop: payload?.coop ?? null,
      coep: payload?.coep ?? null,
      blockedNonCoordinatorCdnNetworkAttempt: blockedAttempt,
    },
    promoteHoldThresholds: {
      decision: failureReason ? 'hold' as const : 'promote' as const,
      holdReasons: reasons,
    },
    failureReason,
    bottlenecksToIssue: failureReason ? [] : [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_BOTTLENECK],
  };
}

function validateCutoverLinkage(
  payload: ProviderPostCutoverReconciliationPayload,
  cutover: ProviderProductionCutoverPayload,
  cutoverRunId: string,
  reasons: string[],
): void {
  if (
    payload.cutoverRunId !== cutoverRunId ||
    payload.cutoverId !== cutover.authorization.cutoverId ||
    payload.productionWindowId !== cutover.authorization.productionWindowId ||
    payload.changeTicketId !== cutover.authorization.changeTicketId ||
    payload.providerOperationId !== cutover.execution.providerOperationId ||
    payload.providerTraceId !== cutover.execution.providerTraceId ||
    payload.restoreExecutionId !== cutover.execution.restoreExecutionId
  ) reasons.push('cutover-linkage-drift');
}

function validateObservationWindow(
  payload: ProviderPostCutoverReconciliationPayload,
  cutover: ProviderProductionCutoverPayload,
  reasons: string[],
): void {
  const window = payload.observationWindow;
  if (
    !window.windowId ||
    window.minimumDurationMs <= 0 ||
    window.startsAtMs < cutover.execution.completedAtMs ||
    window.startsAtMs > cutover.monitoring.endedAtMs ||
    window.endsAtMs <= cutover.monitoring.endedAtMs ||
    window.endsAtMs <= window.startsAtMs ||
    window.endsAtMs - window.startsAtMs < window.minimumDurationMs
  ) reasons.push('post-cutover-observation-window-invalid');
}

function validateAuditRecords(
  payload: ProviderPostCutoverReconciliationPayload,
  cutover: ProviderProductionCutoverPayload,
  reasons: string[],
): void {
  const records = payload.providerAuditRecords;
  const alertIds = new Set(payload.alertDispositions.map((alert) => alert.alertId));
  if (!payload.providerAuditStreamId || !payload.providerAuditCursor || records.length < 2 ||
    new Set(records.map((record) => record.auditRecordId)).size !== records.length) {
    reasons.push('provider-audit-evidence-invalid');
    return;
  }
  let observedAfterImmediateMonitoring = false;
  for (const record of records) {
    if (!record.auditRecordId || !sameIdentity(record, cutover) ||
      record.cutoverRunId !== payload.cutoverRunId ||
      record.providerOperationId !== cutover.execution.providerOperationId ||
      record.providerTraceId !== cutover.execution.providerTraceId ||
      record.restoreExecutionId !== cutover.execution.restoreExecutionId ||
      record.observedAtMs < payload.observationWindow.startsAtMs ||
      record.observedAtMs > payload.observationWindow.endsAtMs ||
      record.outcome === 'failure' ||
      (record.outcome === 'warning' && (!record.alertId || !alertIds.has(record.alertId)))) {
      reasons.push(`provider-audit-record-invalid:${record.auditRecordId || 'unknown'}`);
    }
    if (record.observedAtMs > cutover.monitoring.endedAtMs) observedAfterImmediateMonitoring = true;
  }
  if (!observedAfterImmediateMonitoring) reasons.push('provider-audit-does-not-extend-beyond-immediate-monitoring');
}

function validateArchiveRetrievals(
  payload: ProviderPostCutoverReconciliationPayload,
  cutover: ProviderProductionCutoverPayload,
  reasons: string[],
): void {
  const retrievals = payload.archiveRetrievals;
  if (retrievals.length < 2 || new Set(retrievals.map((item) => item.retrievalOperationId)).size !== retrievals.length) {
    reasons.push('archive-reretrieval-evidence-invalid');
    return;
  }
  const storageIds = new Set(retrievals.map((item) => item.storageId));
  if (!storageIds.has(cutover.primaryStorageId) || !storageIds.has(cutover.backupStorageId)) {
    reasons.push('archive-reretrieval-must-cover-primary-and-backup');
  }
  for (const retrieval of retrievals) {
    if (!retrieval.retrievalOperationId || !retrieval.integrityCheckId ||
      ![cutover.primaryStorageId, cutover.backupStorageId].includes(retrieval.storageId) ||
      retrieval.archiveId !== cutover.archiveId ||
      retrieval.observedContentDigest !== cutover.archiveContentDigest ||
      retrieval.integrityStatus !== 'pass' ||
      retrieval.requestedAtMs < payload.observationWindow.startsAtMs ||
      retrieval.completedAtMs > payload.observationWindow.endsAtMs ||
      retrieval.completedAtMs < retrieval.requestedAtMs) {
      reasons.push(`archive-reretrieval-invalid:${retrieval.retrievalOperationId || 'unknown'}`);
    }
  }
}

function validateAlertsAndIncidents(
  payload: ProviderPostCutoverReconciliationPayload,
  cutover: ProviderProductionCutoverPayload,
  reasons: string[],
): void {
  const alerts = payload.alertDispositions;
  const alertIds = new Set(alerts.map((alert) => alert.alertId));
  if (alertIds.size !== alerts.length) reasons.push('duplicate-alert-disposition');
  for (const cutoverAlertId of cutover.monitoring.alertIds) {
    if (!alertIds.has(cutoverAlertId)) reasons.push(`cutover-alert-not-reconciled:${cutoverAlertId}`);
  }

  const incidents = payload.incidentReconciliations;
  const incidentIds = new Set(incidents.map((incident) => incident.incidentId));
  if (incidentIds.size !== incidents.length) reasons.push('duplicate-incident-reconciliation');
  for (const baselineIncidentId of cutover.incidentIds) {
    if (!incidentIds.has(baselineIncidentId)) reasons.push(`baseline-incident-not-reconciled:${baselineIncidentId}`);
  }

  for (const alert of alerts) {
    if (!alert.alertId || !alert.dispositionId ||
      alert.observedAtMs < cutover.monitoring.startedAtMs ||
      alert.observedAtMs > payload.observationWindow.endsAtMs ||
      (alert.status === 'resolved' && (!alert.resolvedAtMs || alert.resolvedAtMs < alert.observedAtMs || alert.resolvedAtMs > payload.observationWindow.endsAtMs))) {
      reasons.push(`alert-disposition-invalid:${alert.alertId || 'unknown'}`);
    }
    if (alert.severity === 'critical' && alert.status !== 'resolved') reasons.push(`unresolved-critical-alert:${alert.alertId}`);
    if (alert.incidentId && !incidentIds.has(alert.incidentId)) reasons.push(`alert-incident-not-reconciled:${alert.alertId}`);
  }

  for (const incident of incidents) {
    if (!incident.incidentId || !incident.ownerId || !incident.escalationTarget || !incident.reconciliationId ||
      incident.observedAtMs < cutover.execution.startedAtMs || incident.observedAtMs > payload.observationWindow.endsAtMs ||
      incident.relatedAlertIds.some((alertId) => !alertIds.has(alertId))) {
      reasons.push(`incident-reconciliation-invalid:${incident.incidentId || 'unknown'}`);
    }
    if ((incident.severity === 'sev1' || incident.severity === 'sev2') && incident.status === 'active') {
      reasons.push(`active-critical-incident:${incident.incidentId}`);
    }
  }
}

function validateControlState(
  payload: ProviderPostCutoverReconciliationPayload,
  cutover: ProviderProductionCutoverPayload,
  reasons: string[],
): void {
  const state = payload.controlState;
  if (state.rollbackControlId !== cutover.controls.rollbackControlId ||
    state.emergencyHoldControlId !== cutover.controls.emergencyHoldControlId ||
    !state.rollbackArmed || !state.emergencyHoldArmed) reasons.push('post-cutover-controls-invalid');
  if (new Set(state.invocations.map((item) => item.invocationId)).size !== state.invocations.length) reasons.push('duplicate-control-invocation');
  for (const invocation of state.invocations) {
    if (!invocation.invocationId ||
      ![state.rollbackControlId, state.emergencyHoldControlId].includes(invocation.controlId) ||
      invocation.invokedAtMs < payload.observationWindow.startsAtMs || invocation.invokedAtMs > payload.observationWindow.endsAtMs ||
      !invocation.reconciliationId ||
      (invocation.status === 'resolved' && (!invocation.resolvedAtMs || invocation.resolvedAtMs < invocation.invokedAtMs || invocation.resolvedAtMs > payload.observationWindow.endsAtMs))) {
      reasons.push(`control-invocation-invalid:${invocation.invocationId || 'unknown'}`);
    }
    if (invocation.status === 'active') reasons.push(`active-control-invocation:${invocation.invocationId}`);
  }
}

function validateSlo(payload: ProviderPostCutoverReconciliationPayload, reasons: string[]): void {
  const slo = payload.slo;
  if (!slo.policyId || !slo.policyVersion ||
    slo.observedFromMs !== payload.observationWindow.startsAtMs ||
    slo.observedToMs !== payload.observationWindow.endsAtMs ||
    slo.operationCount <= 0 || slo.failureCount < 0 || slo.failureCount > slo.operationCount ||
    slo.rtoBreachCount !== 0 || slo.rpoBreachCount !== 0 || slo.integrityFailureCount !== 0 ||
    slo.providerAvailabilityPct < 0 || slo.providerAvailabilityPct > 100 ||
    slo.requiredProviderAvailabilityPct <= 0 || slo.requiredProviderAvailabilityPct > 100 ||
    slo.providerAvailabilityPct < slo.requiredProviderAvailabilityPct ||
    slo.allowedFailureBudget <= 0 || slo.remainingFailureBudget <= 0 ||
    slo.remainingFailureBudget !== slo.allowedFailureBudget - slo.failureCount ||
    slo.operationCount < payload.providerAuditRecords.length) {
    reasons.push('post-cutover-slo-error-budget-invalid');
  }
}

type ProviderIdentity = Pick<ProviderProductionCutoverPayload,
  'providerName' | 'accountId' | 'primaryStorageId' | 'backupStorageId' | 'replicaSiteId' | 'replicaRegion' | 'archiveId' | 'archiveContentDigest'>;

function sameIdentity(a: ProviderIdentity, b: ProviderIdentity): boolean {
  return a.providerName === b.providerName &&
    a.accountId === b.accountId &&
    a.primaryStorageId === b.primaryStorageId &&
    a.backupStorageId === b.backupStorageId &&
    a.replicaSiteId === b.replicaSiteId &&
    a.replicaRegion === b.replicaRegion &&
    a.archiveId === b.archiveId &&
    a.archiveContentDigest === b.archiveContentDigest;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}
