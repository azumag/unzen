import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport,
  WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-production-readiness' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_RECURRING_RUN_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-recurring-run' as const;

export interface ProviderRecurringRunPayload {
  providerName: string; accountId: string; primaryStorageId: string; backupStorageId: string;
  replicaSiteId: string; replicaRegion: string; archiveId: string; archiveContentDigest: string;
  restoreWindowId: string; primaryRetrievalOperationId: string; backupRetrievalOperationId: string;
  restoreExecutionId: string; restoreSourceStorageId: string; recoveryStartedAtMs: number;
  recoveryCompletedAtMs: number; recoveryPointAtMs: number; primarySnapshotAtMs: number;
  backupSnapshotAtMs: number; replicationLagMs: number; postRestoreIntegrityCheckId: string;
  observedContentDigest: string; integrityStatus: 'pass' | 'fail';
}
export interface ProductionRestoreWindow {
  windowId: string; startsAtMs: number; endsAtMs: number; changeTicketId: string;
  scope: string; approverIds: readonly string[];
}
export interface ProductionApproval { approvalId: string; approverId: string; role: string; approvedAtMs: number; }
export interface ProductionMonitoring {
  evaluatedFromMs: number; evaluatedToMs: number; verifiedRunCount: number; failureCount: number;
  rtoBreachCount: number; rpoBreachCount: number; integrityFailureCount: number;
  allowedFailureBudget: number; remainingFailureBudget: number;
}
export interface CredentialRotation {
  credentialSetId: string; signingKeyId: string; encryptionKeyId: string; secretStoreBoundary: string;
  managedSecretStore: boolean; lastRotatedAtMs: number; nextRotationDueAtMs: number; rotationEvidenceId: string;
}
export interface FailoverPolicy {
  policyId: string; version: string; failoverTrigger: string; primaryStorageId: string; backupStorageId: string;
  lastExercisedRunId: string; recoveryObjective: string;
}
export interface ProductionControls { rollbackControlId: string; emergencyHoldControlId: string; holdCriteria: readonly string[]; }

export interface ProviderProductionReadinessPayload {
  providerName: string; accountId: string; primaryStorageId: string; backupStorageId: string;
  replicaSiteId: string; replicaRegion: string; archiveId: string; archiveContentDigest: string;
  recurringRunIds: readonly string[]; restoreWindowIds: readonly string[];
  productionRestoreWindow: ProductionRestoreWindow; operatorApprovals: readonly ProductionApproval[];
  monitoring: ProductionMonitoring; credentialRotation: CredentialRotation; failoverPolicy: FailoverPolicy;
  controls: ProductionControls; recoveryOwnerId: string; onCallRoute: string; escalationTarget: string;
  incidentIds: readonly string[];
  retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport['retentionPolicySnapshot'];
  allowedOrigins: readonly string[]; cspConnectSrc: readonly string[]; sandboxFlags: readonly string[];
  coop: string | null; coep: string | null; networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
  capturedAtMs: number;
}

export interface ProviderProductionReadinessOptions {
  providerPilotReport: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport;
  providerPilotEvidence: EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>;
  recurringProviderRunEvidence: readonly EvidenceEnvelope<ProviderRecurringRunPayload>[];
  productionReadinessEvidence: EvidenceEnvelope<ProviderProductionReadinessPayload>;
  evidenceValidationOptions?: EvidenceValidationOptions;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate(options: ProviderProductionReadinessOptions) {
  const pilotValidation = await validateEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>(options.providerPilotEvidence, options.evidenceValidationOptions);
  const readinessValidation = await validateEvidenceEnvelope<ProviderProductionReadinessPayload>(options.productionReadinessEvidence, options.evidenceValidationOptions);
  const recurringValidations = await Promise.all(options.recurringProviderRunEvidence.map((e) => validateEvidenceEnvelope<ProviderRecurringRunPayload>(e, options.evidenceValidationOptions)));
  const payload = readinessValidation.envelope?.payload;
  const blockedAttempt = payload?.networkAttempts.find((a) => !payload.allowedOrigins.includes(originOf(a.url)) && a.blocked) ?? null;
  const reasons: string[] = [];
  const upstream = options.providerPilotReport;
  const pilotPayload = pilotValidation.envelope?.payload;

  if (upstream.status !== 'pass') reasons.push('provider-pilot-not-clean');
  if (!evidenceSupportsReadiness(pilotValidation, 'verified-pilot')) reasons.push('upstream-pilot-not-verified');
  if (options.providerPilotEvidence.runId !== upstream.providerEvidenceSummary.runId) reasons.push('upstream-pilot-run-mismatch');
  if (!evidenceSupportsReadiness(readinessValidation, 'production-candidate')) reasons.push('requires-production-candidate-evidence');
  if (options.productionReadinessEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND) reasons.push('readiness-evidence-kind-invalid');
  if (!payload || !pilotPayload) reasons.push('readiness-or-pilot-payload-missing');

  const runIds = options.recurringProviderRunEvidence.map((e) => e.runId);
  const recurringPayloads = recurringValidations.map((v) => v.envelope?.payload).filter((v): v is ProviderRecurringRunPayload => Boolean(v));
  const windowIds = recurringPayloads.map((r) => r.restoreWindowId);
  if (runIds.length < 3 || new Set(runIds).size < 3) reasons.push('requires-three-distinct-verified-runs');
  if (new Set(windowIds).size < 2) reasons.push('requires-two-restore-windows');
  options.recurringProviderRunEvidence.forEach((e, i) => {
    if (e.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_RECURRING_RUN_EVIDENCE_KIND) reasons.push(`recurring-run-kind-invalid:${e.runId}`);
    if (!evidenceSupportsReadiness(recurringValidations[i], 'verified-pilot')) reasons.push(`recurring-run-not-verified:${e.runId}`);
  });

  if (payload && pilotPayload) {
    if (!sameIdentity(payload, pilotPayload)) reasons.push('provider-identity-mismatch');
    recurringPayloads.forEach((run) => {
      if (!sameIdentity(run, pilotPayload)) reasons.push(`recurring-provider-identity-mismatch:${run.restoreExecutionId}`);
      validateRun(run, upstream, reasons);
    });
    if (!sameSet(payload.recurringRunIds, runIds)) reasons.push('recurring-run-set-mismatch');
    if (!sameSet(payload.restoreWindowIds, windowIds)) reasons.push('restore-window-set-mismatch');
    validateWindow(payload.productionRestoreWindow, payload.capturedAtMs, reasons);
    validateApprovals(payload.productionRestoreWindow, payload.operatorApprovals, reasons);
    validateMonitoring(payload.monitoring, new Set(runIds).size, reasons);
    validateRotation(payload.credentialRotation, payload.capturedAtMs, reasons);
    validateFailover(payload.failoverPolicy, pilotPayload, new Set(runIds), reasons);
    if (!payload.controls.rollbackControlId || !payload.controls.emergencyHoldControlId || payload.controls.holdCriteria.length === 0) reasons.push('controls-invalid');

    const dr = upstream.disasterRecoveryEvidence;
    if (payload.recoveryOwnerId !== dr.ownership.recoveryOwnerId || payload.onCallRoute !== dr.ownership.onCallRoute || payload.escalationTarget !== dr.ownership.escalationTarget || !sameSet(payload.incidentIds, dr.incidents.map((i) => i.incidentId))) reasons.push('operations-identity-mismatch');
    if (JSON.stringify(payload.retentionPolicySnapshot) !== JSON.stringify(upstream.retentionPolicySnapshot)) reasons.push('retention-state-changed');
    const leaked = payload.networkAttempts.find((a) => !payload.allowedOrigins.includes(originOf(a.url)) && !a.blocked);
    if (leaked) reasons.push(`network-leak:${originOf(leaked.url)}`);
    if (!blockedAttempt) reasons.push('missing-blocked-network-attempt');
    if (!payload.allowedOrigins.every((o) => payload.cspConnectSrc.includes(o))) reasons.push('csp-invalid');
    if (!(payload.sandboxFlags.length === 1 && payload.sandboxFlags[0] === 'allow-scripts')) reasons.push('sandbox-invalid');
    if (payload.coop !== 'same-origin' || payload.coep !== 'require-corp') reasons.push('cross-origin-isolation-lost');
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-production-readiness-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    previewRunnerUrl: upstream.previewRunnerUrl,
    providerPilotEvidence: upstream,
    readinessEvidenceSummary: {
      validationStatus: readinessValidation.status,
      effectiveEvidenceLevel: readinessValidation.effectiveEvidenceLevel,
      effectiveReadinessStatus: readinessValidation.effectiveReadinessStatus,
      evidenceKind: options.productionReadinessEvidence.evidenceKind,
      runId: options.productionReadinessEvidence.runId,
    },
    recurringRunSummary: { totalRuns: runIds.length, distinctRunIds: new Set(runIds).size, distinctRestoreWindows: new Set(windowIds).size, validatedRuns: recurringValidations.filter((v) => evidenceSupportsReadiness(v, 'verified-pilot')).length },
    productionRestoreWindow: payload?.productionRestoreWindow ?? null,
    operatorApprovals: payload?.operatorApprovals ?? [], monitoring: payload?.monitoring ?? null,
    credentialRotation: payload?.credentialRotation ?? null, failoverPolicy: payload?.failoverPolicy ?? null,
    controls: payload?.controls ?? null, retentionPolicySnapshot: payload?.retentionPolicySnapshot ?? upstream.retentionPolicySnapshot,
    securityBoundaryDuringProductionReadiness: { allowedOrigins: payload?.allowedOrigins ?? [], cspConnectSrc: payload?.cspConnectSrc ?? [], sandboxFlags: payload?.sandboxFlags ?? [], coop: payload?.coop ?? null, coep: payload?.coep ?? null, blockedNonCoordinatorCdnNetworkAttempt: blockedAttempt },
    promoteHoldThresholds: { decision: failureReason ? 'hold' as const : 'promote' as const, holdReasons: reasons },
    failureReason,
    bottlenecksToIssue: failureReason ? [] : ['publisher-tax-filing-production-exception-archive-dr-provider-production-cutover'],
  };
}

function sameIdentity(a: Pick<ProviderProductionReadinessPayload, 'providerName'|'accountId'|'primaryStorageId'|'backupStorageId'|'replicaSiteId'|'replicaRegion'|'archiveId'|'archiveContentDigest'>, b: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload): boolean {
  return a.providerName === b.providerName && a.accountId === b.accountId && a.primaryStorageId === b.primaryStorageId && a.backupStorageId === b.backupStorageId && a.replicaSiteId === b.replicaSiteId && a.replicaRegion === b.replicaRegion && a.archiveId === b.archiveId && a.archiveContentDigest === b.archiveContentDigest;
}
function validateRun(run: ProviderRecurringRunPayload, upstream: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport, reasons: string[]): void {
  const o = upstream.disasterRecoveryEvidence.objectives;
  if (!run.primaryRetrievalOperationId || !run.backupRetrievalOperationId || !run.restoreExecutionId || !run.postRestoreIntegrityCheckId || run.integrityStatus !== 'pass' || run.observedContentDigest !== run.archiveContentDigest) reasons.push(`recurring-run-integrity-invalid:${run.restoreExecutionId}`);
  const duration = run.recoveryCompletedAtMs - run.recoveryStartedAtMs;
  const rpoAge = run.recoveryStartedAtMs - run.recoveryPointAtMs;
  const backupAge = run.recoveryStartedAtMs - run.backupSnapshotAtMs;
  if (duration < 0 || duration > o.rtoMs || rpoAge < 0 || rpoAge > o.rpoMs || backupAge < 0 || backupAge > o.maxBackupAgeMs || run.replicationLagMs !== Math.max(0, run.primarySnapshotAtMs - run.backupSnapshotAtMs) || run.replicationLagMs > o.maxReplicationLagMs) reasons.push(`recurring-run-objectives-breached:${run.restoreExecutionId}`);
}
function validateWindow(w: ProductionRestoreWindow, capturedAtMs: number, reasons: string[]): void { if (!w.windowId || !w.changeTicketId || !w.scope || w.endsAtMs <= w.startsAtMs || w.startsAtMs < capturedAtMs) reasons.push('production-restore-window-invalid'); }
function validateApprovals(w: ProductionRestoreWindow, approvals: readonly ProductionApproval[], reasons: string[]): void { const ids = new Set(approvals.map((a) => a.approverId)); if (approvals.length < 2 || ids.size < 2 || !approvals.every((a) => a.approvalId && a.role && a.approvedAtMs > 0 && w.approverIds.includes(a.approverId))) reasons.push('two-person-approval-invalid'); }
function validateMonitoring(m: ProductionMonitoring, verifiedRuns: number, reasons: string[]): void { if (m.evaluatedToMs <= m.evaluatedFromMs || m.verifiedRunCount !== verifiedRuns || m.failureCount < 0 || m.rtoBreachCount !== 0 || m.rpoBreachCount !== 0 || m.integrityFailureCount !== 0 || m.allowedFailureBudget < 0 || m.remainingFailureBudget <= 0 || m.remainingFailureBudget !== m.allowedFailureBudget - m.failureCount) reasons.push('monitoring-error-budget-invalid'); }
function validateRotation(r: CredentialRotation, capturedAtMs: number, reasons: string[]): void { if (!r.credentialSetId || !r.signingKeyId || !r.encryptionKeyId || !r.secretStoreBoundary || !r.managedSecretStore || !r.rotationEvidenceId || r.lastRotatedAtMs <= 0 || r.nextRotationDueAtMs <= capturedAtMs || r.nextRotationDueAtMs <= r.lastRotatedAtMs) reasons.push('credential-key-rotation-invalid'); }
function validateFailover(f: FailoverPolicy, pilot: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload, runIds: Set<string>, reasons: string[]): void { if (!f.policyId || !f.version || !f.failoverTrigger || !f.recoveryObjective || f.primaryStorageId !== pilot.primaryStorageId || f.backupStorageId !== pilot.backupStorageId || !runIds.has(f.lastExercisedRunId)) reasons.push('failover-policy-invalid'); }
function sameSet(a: readonly string[], b: readonly string[]): boolean { return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort()); }
function originOf(url: string): string { try { return new URL(url).origin; } catch { return url; } }
