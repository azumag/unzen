import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type {
  ProviderProductionReadinessPayload,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-production-cutover' as const;

type ProviderProductionReadinessReport = Awaited<ReturnType<
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate
>>;

export interface ProviderProductionCutoverAuthorization {
  readonly cutoverId: string;
  readonly authorizationId: string;
  readonly readinessRunId: string;
  readonly productionWindowId: string;
  readonly changeTicketId: string;
  readonly approverIds: readonly string[];
  readonly credentialSetId: string;
  readonly signingKeyId: string;
  readonly encryptionKeyId: string;
  readonly authorizedAtMs: number;
  readonly expiresAtMs: number;
}

export interface ProviderProductionCutoverExecution {
  readonly providerOperationId: string;
  readonly providerTraceId: string;
  readonly restoreExecutionId: string;
  readonly sourceStorageId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly recoveryPointAtMs: number;
  readonly primarySnapshotAtMs: number;
  readonly backupSnapshotAtMs: number;
  readonly replicationLagMs: number;
  readonly archiveId: string;
  readonly observedContentDigest: string;
  readonly postCutoverIntegrityCheckId: string;
  readonly integrityStatus: 'pass' | 'fail';
}

export interface ProviderProductionCutoverMonitoring {
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly providerHealth: 'healthy' | 'degraded' | 'down';
  readonly integrityStatus: 'pass' | 'fail';
  readonly rtoBreachCount: number;
  readonly rpoBreachCount: number;
  readonly integrityFailureCount: number;
  readonly alertIds: readonly string[];
  readonly unresolvedCriticalAlertIds: readonly string[];
}

export interface ProviderProductionCutoverControls {
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
  readonly rollbackArmedBeforeExecution: boolean;
  readonly emergencyHoldArmedBeforeExecution: boolean;
  readonly rollbackArmedAfterExecution: boolean;
  readonly emergencyHoldArmedAfterExecution: boolean;
  readonly rollbackInvoked: boolean;
  readonly emergencyHoldInvoked: boolean;
  readonly invocationReconciliationId?: string;
}

export interface ProviderProductionCutoverPayload {
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly replicaSiteId: string;
  readonly replicaRegion: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly authorization: ProviderProductionCutoverAuthorization;
  readonly execution: ProviderProductionCutoverExecution;
  readonly monitoring: ProviderProductionCutoverMonitoring;
  readonly controls: ProviderProductionCutoverControls;
  readonly recoveryOwnerId: string;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
  readonly incidentIds: readonly string[];
  readonly retentionPolicySnapshot: ProviderProductionReadinessPayload['retentionPolicySnapshot'];
  readonly observedCredentialSetId: string;
  readonly observedSigningKeyId: string;
  readonly observedEncryptionKeyId: string;
  readonly reconciliationId: string;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
  readonly capturedAtMs: number;
}

export interface ProviderProductionCutoverOptions {
  readonly productionReadinessReport: ProviderProductionReadinessReport;
  readonly productionReadinessEvidence: EvidenceEnvelope<ProviderProductionReadinessPayload>;
  readonly productionCutoverEvidence: EvidenceEnvelope<ProviderProductionCutoverPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate(
  options: ProviderProductionCutoverOptions,
) {
  const readinessValidation = await validateEvidenceEnvelope<ProviderProductionReadinessPayload>(
    options.productionReadinessEvidence,
    options.evidenceValidationOptions,
  );
  const cutoverValidation = await validateEvidenceEnvelope<ProviderProductionCutoverPayload>(
    options.productionCutoverEvidence,
    options.evidenceValidationOptions,
  );
  const readinessPayload = readinessValidation.envelope?.payload;
  const payload = cutoverValidation.envelope?.payload;
  const upstream = options.productionReadinessReport;
  const reasons: string[] = [];
  const blockedAttempt = payload?.networkAttempts.find(
    (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;

  if (upstream.status !== 'pass') reasons.push('production-readiness-not-clean');
  if (!evidenceSupportsReadiness(readinessValidation, 'production-candidate')) reasons.push('readiness-evidence-not-production-candidate');
  if (options.productionReadinessEvidence.runId !== upstream.readinessEvidenceSummary.runId) reasons.push('readiness-run-mismatch');
  if (JSON.stringify(options.productionReadinessEvidence) !== JSON.stringify(upstream.readinessInputEvidence)) reasons.push('readiness-input-mismatch');
  if (!evidenceSupportsReadiness(cutoverValidation, 'production-approved')) reasons.push('requires-production-approved-cutover-evidence');
  if (options.productionCutoverEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND) reasons.push('cutover-evidence-kind-invalid');
  if (!payload || !readinessPayload) reasons.push('cutover-or-readiness-payload-missing');

  if (payload && readinessPayload) {
    if (!sameIdentity(payload, readinessPayload)) reasons.push('provider-identity-drift');
    validateAuthorization(payload, readinessPayload, upstream, reasons);
    validateExecution(payload, readinessPayload, upstream, reasons);
    validateMonitoring(payload, reasons);
    validateControls(payload, readinessPayload, reasons);

    const envelopeCapturedAtMs = Date.parse(options.productionCutoverEvidence.capturedAt);
    if (
      !Number.isFinite(envelopeCapturedAtMs) ||
      envelopeCapturedAtMs !== payload.capturedAtMs ||
      payload.capturedAtMs < payload.monitoring.endedAtMs
    ) reasons.push('cutover-capture-timeline-invalid');

    const dr = upstream.providerPilotEvidence.disasterRecoveryEvidence;
    if (
      payload.recoveryOwnerId !== dr.ownership.recoveryOwnerId ||
      payload.onCallRoute !== dr.ownership.onCallRoute ||
      payload.escalationTarget !== dr.ownership.escalationTarget ||
      !sameSet(payload.incidentIds, dr.incidents.map((incident) => incident.incidentId))
    ) reasons.push('operations-identity-drift');
    if (JSON.stringify(payload.retentionPolicySnapshot) !== JSON.stringify(upstream.retentionPolicySnapshot)) reasons.push('retention-state-drift');
    if (
      payload.observedCredentialSetId !== readinessPayload.credentialRotation.credentialSetId ||
      payload.observedSigningKeyId !== readinessPayload.credentialRotation.signingKeyId ||
      payload.observedEncryptionKeyId !== readinessPayload.credentialRotation.encryptionKeyId
    ) reasons.push('credential-key-identity-drift');
    if (!payload.reconciliationId) reasons.push('post-cutover-reconciliation-missing');

    const leaked = payload.networkAttempts.find(
      (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
    );
    if (leaked) reasons.push(`network-leak:${originOf(leaked.url)}`);
    if (!blockedAttempt) reasons.push('missing-blocked-network-attempt');
    if (!payload.allowedOrigins.every((origin) => payload.cspConnectSrc.includes(origin))) reasons.push('csp-invalid');
    if (!(payload.sandboxFlags.length === 1 && payload.sandboxFlags[0] === 'allow-scripts')) reasons.push('sandbox-invalid');
    if (payload.coop !== 'same-origin' || payload.coep !== 'require-corp') reasons.push('cross-origin-isolation-lost');
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-production-cutover-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    previewRunnerUrl: upstream.previewRunnerUrl,
    productionReadinessEvidence: upstream,
    cutoverInputEvidence: options.productionCutoverEvidence,
    cutoverEvidenceSummary: {
      validationStatus: cutoverValidation.status,
      effectiveEvidenceLevel: cutoverValidation.effectiveEvidenceLevel,
      effectiveReadinessStatus: cutoverValidation.effectiveReadinessStatus,
      evidenceKind: options.productionCutoverEvidence.evidenceKind,
      runId: options.productionCutoverEvidence.runId,
    },
    authorization: payload?.authorization ?? null,
    execution: payload?.execution ?? null,
    monitoring: payload?.monitoring ?? null,
    controls: payload?.controls ?? null,
    reconciliationId: payload?.reconciliationId ?? null,
    retentionPolicySnapshot: payload?.retentionPolicySnapshot ?? upstream.retentionPolicySnapshot,
    securityBoundaryDuringProductionCutover: {
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
    bottlenecksToIssue: failureReason
      ? []
      : ['publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation'],
  };
}

function validateAuthorization(
  payload: ProviderProductionCutoverPayload,
  readiness: ProviderProductionReadinessPayload,
  upstream: ProviderProductionReadinessReport,
  reasons: string[],
): void {
  const authorization = payload.authorization;
  const window = upstream.productionRestoreWindow;
  const approverIds = upstream.operatorApprovals.map((approval) => approval.approverId);
  if (!window ||
    !authorization.cutoverId ||
    !authorization.authorizationId ||
    authorization.readinessRunId !== upstream.readinessEvidenceSummary.runId ||
    authorization.productionWindowId !== window.windowId ||
    authorization.changeTicketId !== window.changeTicketId ||
    !sameSet(authorization.approverIds, approverIds) ||
    authorization.credentialSetId !== readiness.credentialRotation.credentialSetId ||
    authorization.signingKeyId !== readiness.credentialRotation.signingKeyId ||
    authorization.encryptionKeyId !== readiness.credentialRotation.encryptionKeyId ||
    authorization.authorizedAtMs < window.startsAtMs ||
    authorization.authorizedAtMs > window.endsAtMs ||
    authorization.expiresAtMs <= authorization.authorizedAtMs ||
    payload.execution.startedAtMs < authorization.authorizedAtMs ||
    payload.execution.startedAtMs >= authorization.expiresAtMs ||
    payload.execution.completedAtMs > authorization.expiresAtMs ||
    readiness.credentialRotation.nextRotationDueAtMs <= payload.execution.completedAtMs
  ) reasons.push('cutover-authorization-invalid');
}

function validateExecution(
  payload: ProviderProductionCutoverPayload,
  readiness: ProviderProductionReadinessPayload,
  upstream: ProviderProductionReadinessReport,
  reasons: string[],
): void {
  const execution = payload.execution;
  const window = upstream.productionRestoreWindow;
  const objectives = upstream.providerPilotEvidence.disasterRecoveryEvidence.objectives;
  const duration = execution.completedAtMs - execution.startedAtMs;
  const recoveryPointAge = execution.startedAtMs - execution.recoveryPointAtMs;
  const backupAge = execution.startedAtMs - execution.backupSnapshotAtMs;
  if (!window ||
    !execution.providerOperationId ||
    !execution.providerTraceId ||
    !execution.restoreExecutionId ||
    !execution.postCutoverIntegrityCheckId ||
    ![readiness.primaryStorageId, readiness.backupStorageId].includes(execution.sourceStorageId) ||
    execution.startedAtMs < window.startsAtMs ||
    execution.completedAtMs > window.endsAtMs ||
    execution.completedAtMs < execution.startedAtMs ||
    execution.archiveId !== readiness.archiveId ||
    execution.observedContentDigest !== readiness.archiveContentDigest ||
    execution.integrityStatus !== 'pass' ||
    duration > objectives.rtoMs ||
    recoveryPointAge < 0 || recoveryPointAge > objectives.rpoMs ||
    backupAge < 0 || backupAge > objectives.maxBackupAgeMs ||
    execution.replicationLagMs !== Math.max(0, execution.primarySnapshotAtMs - execution.backupSnapshotAtMs) ||
    execution.replicationLagMs > objectives.maxReplicationLagMs
  ) reasons.push('cutover-execution-invalid');
}

function validateMonitoring(payload: ProviderProductionCutoverPayload, reasons: string[]): void {
  const monitoring = payload.monitoring;
  if (
    monitoring.startedAtMs > payload.execution.startedAtMs ||
    monitoring.endedAtMs < payload.execution.completedAtMs ||
    monitoring.endedAtMs < monitoring.startedAtMs ||
    monitoring.providerHealth !== 'healthy' ||
    monitoring.integrityStatus !== 'pass' ||
    monitoring.rtoBreachCount !== 0 ||
    monitoring.rpoBreachCount !== 0 ||
    monitoring.integrityFailureCount !== 0 ||
    monitoring.unresolvedCriticalAlertIds.length !== 0
  ) reasons.push('post-cutover-monitoring-invalid');
}

function validateControls(
  payload: ProviderProductionCutoverPayload,
  readiness: ProviderProductionReadinessPayload,
  reasons: string[],
): void {
  const controls = payload.controls;
  if (
    controls.rollbackControlId !== readiness.controls.rollbackControlId ||
    controls.emergencyHoldControlId !== readiness.controls.emergencyHoldControlId ||
    !controls.rollbackArmedBeforeExecution ||
    !controls.emergencyHoldArmedBeforeExecution ||
    !controls.rollbackArmedAfterExecution ||
    !controls.emergencyHoldArmedAfterExecution
  ) reasons.push('cutover-controls-not-armed');
  if ((controls.rollbackInvoked || controls.emergencyHoldInvoked) && !controls.invocationReconciliationId) {
    reasons.push('invoked-control-reconciliation-missing');
  }
  if (controls.rollbackInvoked || controls.emergencyHoldInvoked) reasons.push('cutover-control-invoked');
}

function sameIdentity(a: ProviderProductionCutoverPayload, b: ProviderProductionReadinessPayload): boolean {
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
