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
  providerName: string;
  accountId: string;
  primaryStorageId: string;
  backupStorageId: string;
  replicaSiteId: string;
  replicaRegion: string;
  archiveId: string;
  archiveContentDigest: string;
  restoreWindowId: string;
  primaryRetrievalOperationId: string;
  backupRetrievalOperationId: string;
  restoreExecutionId: string;
  restoreSourceStorageId: string;
  recoveryStartedAtMs: number;
  recoveryCompletedAtMs: number;
  recoveryPointAtMs: number;
  primarySnapshotAtMs: number;
  backupSnapshotAtMs: number;
  replicationLagMs: number;
  postRestoreIntegrityCheckId: string;
  observedContentDigest: string;
  integrityStatus: 'pass' | 'fail';
}

export interface ProductionRestoreWindow {
  windowId: string;
  startsAtMs: number;
  endsAtMs: number;
  changeTicketId: string;
  scope: string;
  approverIds: readonly string[];
}

export interface ProductionApproval {
  approvalId: string;
  approverId: string;
  role: string;
  approvedAtMs: number;
}

export interface ProductionMonitoring {
  evaluatedFromMs: number;
  evaluatedToMs: number;
  verifiedRunCount: number;
  failureCount: number;
  rtoBreachCount: number;
  rpoBreachCount: number;
  integrityFailureCount: number;
  allowedFailureBudget: number;
  remainingFailureBudget: number;
}

export interface CredentialRotation {
  credentialSetId: string;
  signingKeyId: string;
  encryptionKeyId: string;
  secretStoreBoundary: string;
  managedSecretStore: boolean;
  lastRotatedAtMs: number;
  nextRotationDueAtMs: number;
  rotationEvidenceId: string;
}

export interface FailoverPolicy {
  policyId: string;
  version: string;
  failoverTrigger: string;
  primaryStorageId: string;
  backupStorageId: string;
  lastExercisedRunId: string;
  recoveryObjective: string;
}

export interface ProductionControls {
  rollbackControlId: string;
  emergencyHoldControlId: string;
  holdCriteria: readonly string[];
}

export interface ProviderProductionReadinessPayload {
  providerName: string;
  accountId: string;
  primaryStorageId: string;
  backupStorageId: string;
  replicaSiteId: string;
  replicaRegion: string;
  archiveId: string;
  archiveContentDigest: string;
  recurringRunIds: readonly string[];
  restoreWindowIds: readonly string[];
  productionRestoreWindow: ProductionRestoreWindow;
  operatorApprovals: readonly ProductionApproval[];
  monitoring: ProductionMonitoring;
  credentialRotation: CredentialRotation;
  failoverPolicy: FailoverPolicy;
  controls: ProductionControls;
  recoveryOwnerId: string;
  onCallRoute: string;
  escalationTarget: string;
  incidentIds: readonly string[];
  retentionPolicySnapshot: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport['retentionPolicySnapshot'];
  allowedOrigins: readonly string[];
  cspConnectSrc: readonly string[];
  sandboxFlags: readonly string[];
  coop: string | null;
  coep: string | null;
  networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
  capturedAtMs: number;
}

export interface ProviderProductionReadinessOptions {
  providerPilotReport: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport;
  providerPilotEvidence: EvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>;
  recurringProviderRunEvidence: readonly EvidenceEnvelope<ProviderRecurringRunPayload>[];
  productionReadinessEvidence: EvidenceEnvelope<ProviderProductionReadinessPayload>;
  evidenceValidationOptions?: EvidenceValidationOptions;
}

interface VerifiedRecurringRun {
  runId: string;
  payload: ProviderRecurringRunPayload;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate(
  options: ProviderProductionReadinessOptions,
) {
  const pilotValidation = await validateEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload>(
    options.providerPilotEvidence,
    options.evidenceValidationOptions,
  );
  const readinessValidation = await validateEvidenceEnvelope<ProviderProductionReadinessPayload>(
    options.productionReadinessEvidence,
    options.evidenceValidationOptions,
  );
  const recurringValidations = await Promise.all(
    options.recurringProviderRunEvidence.map((evidence) =>
      validateEvidenceEnvelope<ProviderRecurringRunPayload>(evidence, options.evidenceValidationOptions),
    ),
  );

  const payload = readinessValidation.envelope?.payload;
  const pilotPayload = pilotValidation.envelope?.payload;
  const blockedAttempt = payload?.networkAttempts.find(
    (attempt) => !payload.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
  const reasons: string[] = [];
  const upstream = options.providerPilotReport;

  if (upstream.status !== 'pass') reasons.push('provider-pilot-not-clean');
  if (!evidenceSupportsReadiness(pilotValidation, 'verified-pilot')) reasons.push('upstream-pilot-not-verified');
  if (options.providerPilotEvidence.runId !== upstream.providerEvidenceSummary.runId) reasons.push('upstream-pilot-run-mismatch');
  if (!evidenceSupportsReadiness(readinessValidation, 'production-candidate')) reasons.push('requires-production-candidate-evidence');
  if (options.productionReadinessEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND) reasons.push('readiness-evidence-kind-invalid');
  if (!payload || !pilotPayload) reasons.push('readiness-or-pilot-payload-missing');

  const runIds = options.recurringProviderRunEvidence.map((evidence) => evidence.runId);
  const verifiedRuns: VerifiedRecurringRun[] = [];
  options.recurringProviderRunEvidence.forEach((evidence, index) => {
    const validation = recurringValidations[index];
    if (evidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_RECURRING_RUN_EVIDENCE_KIND) {
      reasons.push(`recurring-run-kind-invalid:${evidence.runId}`);
    }
    if (!evidenceSupportsReadiness(validation, 'verified-pilot')) {
      reasons.push(`recurring-run-not-verified:${evidence.runId}`);
      return;
    }
    const verifiedPayload = validation.envelope?.payload;
    if (verifiedPayload) verifiedRuns.push({ runId: evidence.runId, payload: verifiedPayload });
  });

  const windowIds = verifiedRuns.map((run) => run.payload.restoreWindowId);
  if (runIds.length < 3 || new Set(runIds).size < 3) reasons.push('requires-three-distinct-verified-runs');
  if (new Set(windowIds).size < 2) reasons.push('requires-two-restore-windows');

  if (payload && pilotPayload) {
    if (!sameIdentity(payload, pilotPayload)) reasons.push('provider-identity-mismatch');
    for (const { runId, payload: run } of verifiedRuns) {
      if (!sameIdentity(run, pilotPayload)) reasons.push(`recurring-provider-identity-mismatch:${runId}`);
      validateRun(run, upstream, reasons);
    }
    if (!sameSet(payload.recurringRunIds, runIds)) reasons.push('recurring-run-set-mismatch');
    if (!sameSet(payload.restoreWindowIds, windowIds)) reasons.push('restore-window-set-mismatch');
    validateWindow(payload.productionRestoreWindow, payload.capturedAtMs, reasons);
    validateApprovals(payload.productionRestoreWindow, payload.operatorApprovals, reasons);
    validateMonitoring(payload.monitoring, new Set(runIds).size, reasons);
    validateRotation(payload.credentialRotation, payload.capturedAtMs, reasons);
    validateFailover(payload.failoverPolicy, pilotPayload, verifiedRuns, reasons);
    if (!payload.controls.rollbackControlId || !payload.controls.emergencyHoldControlId || payload.controls.holdCriteria.length === 0) reasons.push('controls-invalid');

    const dr = upstream.disasterRecoveryEvidence;
    if (
      payload.recoveryOwnerId !== dr.ownership.recoveryOwnerId ||
      payload.onCallRoute !== dr.ownership.onCallRoute ||
      payload.escalationTarget !== dr.ownership.escalationTarget ||
      !sameSet(payload.incidentIds, dr.incidents.map((incident) => incident.incidentId))
    ) reasons.push('operations-identity-mismatch');
    if (JSON.stringify(payload.retentionPolicySnapshot) !== JSON.stringify(upstream.retentionPolicySnapshot)) reasons.push('retention-state-changed');

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
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-production-readiness-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    previewRunnerUrl: upstream.previewRunnerUrl,
    providerPilotEvidence: upstream,
    readinessInputEvidence: options.productionReadinessEvidence,
    readinessEvidenceSummary: {
      validationStatus: readinessValidation.status,
      effectiveEvidenceLevel: readinessValidation.effectiveEvidenceLevel,
      effectiveReadinessStatus: readinessValidation.effectiveReadinessStatus,
      evidenceKind: options.productionReadinessEvidence.evidenceKind,
      runId: options.productionReadinessEvidence.runId,
    },
    recurringRunSummary: {
      totalRuns: runIds.length,
      distinctRunIds: new Set(runIds).size,
      distinctRestoreWindows: new Set(windowIds).size,
      validatedRuns: verifiedRuns.length,
    },
    productionRestoreWindow: payload?.productionRestoreWindow ?? null,
    operatorApprovals: payload?.operatorApprovals ?? [],
    monitoring: payload?.monitoring ?? null,
    credentialRotation: payload?.credentialRotation ?? null,
    failoverPolicy: payload?.failoverPolicy ?? null,
    controls: payload?.controls ?? null,
    retentionPolicySnapshot: payload?.retentionPolicySnapshot ?? upstream.retentionPolicySnapshot,
    securityBoundaryDuringProductionReadiness: {
      allowedOrigins: payload?.allowedOrigins ?? [],
      cspConnectSrc: payload?.cspConnectSrc ?? [],
      sandboxFlags: payload?.sandboxFlags ?? [],
      coop: payload?.coop ?? null,
      coep: payload?.coep ?? null,
      blockedNonCoordinatorCdnNetworkAttempt: blockedAttempt,
    },
    promoteHoldThresholds: { decision: failureReason ? 'hold' as const : 'promote' as const, holdReasons: reasons },
    failureReason,
    bottlenecksToIssue: failureReason ? [] : ['publisher-tax-filing-production-exception-archive-dr-provider-production-cutover'],
  };
}

function sameIdentity(
  candidate: Pick<ProviderProductionReadinessPayload, 'providerName' | 'accountId' | 'primaryStorageId' | 'backupStorageId' | 'replicaSiteId' | 'replicaRegion' | 'archiveId' | 'archiveContentDigest'>,
  pilot: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload,
): boolean {
  return candidate.providerName === pilot.providerName && candidate.accountId === pilot.accountId &&
    candidate.primaryStorageId === pilot.primaryStorageId && candidate.backupStorageId === pilot.backupStorageId &&
    candidate.replicaSiteId === pilot.replicaSiteId && candidate.replicaRegion === pilot.replicaRegion &&
    candidate.archiveId === pilot.archiveId && candidate.archiveContentDigest === pilot.archiveContentDigest;
}

function validateRun(
  run: ProviderRecurringRunPayload,
  upstream: WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport,
  reasons: string[],
): void {
  const objectives = upstream.disasterRecoveryEvidence.objectives;
  if (!run.primaryRetrievalOperationId || !run.backupRetrievalOperationId || !run.restoreExecutionId ||
    !run.postRestoreIntegrityCheckId || run.integrityStatus !== 'pass' || run.observedContentDigest !== run.archiveContentDigest) {
    reasons.push(`recurring-run-integrity-invalid:${run.restoreExecutionId}`);
  }
  const duration = run.recoveryCompletedAtMs - run.recoveryStartedAtMs;
  const rpoAge = run.recoveryStartedAtMs - run.recoveryPointAtMs;
  const backupAge = run.recoveryStartedAtMs - run.backupSnapshotAtMs;
  if (duration < 0 || duration > objectives.rtoMs || rpoAge < 0 || rpoAge > objectives.rpoMs ||
    backupAge < 0 || backupAge > objectives.maxBackupAgeMs ||
    run.replicationLagMs !== Math.max(0, run.primarySnapshotAtMs - run.backupSnapshotAtMs) ||
    run.replicationLagMs > objectives.maxReplicationLagMs) {
    reasons.push(`recurring-run-objectives-breached:${run.restoreExecutionId}`);
  }
}

function validateWindow(window: ProductionRestoreWindow, capturedAtMs: number, reasons: string[]): void {
  if (!window.windowId || !window.changeTicketId || !window.scope || window.endsAtMs <= window.startsAtMs || window.startsAtMs < capturedAtMs) reasons.push('production-restore-window-invalid');
}

function validateApprovals(window: ProductionRestoreWindow, approvals: readonly ProductionApproval[], reasons: string[]): void {
  const approverIds = new Set(approvals.map((approval) => approval.approverId));
  if (approvals.length < 2 || approverIds.size < 2 || !approvals.every((approval) =>
    approval.approvalId && approval.role && approval.approvedAtMs > 0 && window.approverIds.includes(approval.approverId))) {
    reasons.push('two-person-approval-invalid');
  }
}

function validateMonitoring(monitoring: ProductionMonitoring, verifiedRuns: number, reasons: string[]): void {
  if (monitoring.evaluatedToMs <= monitoring.evaluatedFromMs || monitoring.verifiedRunCount !== verifiedRuns ||
    monitoring.failureCount < 0 || monitoring.rtoBreachCount !== 0 || monitoring.rpoBreachCount !== 0 ||
    monitoring.integrityFailureCount !== 0 || monitoring.allowedFailureBudget < 0 || monitoring.remainingFailureBudget <= 0 ||
    monitoring.remainingFailureBudget !== monitoring.allowedFailureBudget - monitoring.failureCount) {
    reasons.push('monitoring-error-budget-invalid');
  }
}

function validateRotation(rotation: CredentialRotation, capturedAtMs: number, reasons: string[]): void {
  if (!rotation.credentialSetId || !rotation.signingKeyId || !rotation.encryptionKeyId || !rotation.secretStoreBoundary ||
    !rotation.managedSecretStore || !rotation.rotationEvidenceId || rotation.lastRotatedAtMs <= 0 ||
    rotation.nextRotationDueAtMs <= capturedAtMs || rotation.nextRotationDueAtMs <= rotation.lastRotatedAtMs) {
    reasons.push('credential-key-rotation-invalid');
  }
}

function validateFailover(
  failover: FailoverPolicy,
  pilot: WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload,
  verifiedRuns: readonly VerifiedRecurringRun[],
  reasons: string[],
): void {
  const exercised = verifiedRuns.find((run) => run.runId === failover.lastExercisedRunId);
  if (!failover.policyId || !failover.version || !failover.failoverTrigger || !failover.recoveryObjective ||
    failover.primaryStorageId !== pilot.primaryStorageId || failover.backupStorageId !== pilot.backupStorageId ||
    !exercised || exercised.payload.restoreSourceStorageId !== pilot.backupStorageId) {
    reasons.push('failover-policy-invalid');
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}
