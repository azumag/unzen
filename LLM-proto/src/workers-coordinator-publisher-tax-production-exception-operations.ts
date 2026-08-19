import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport,
} from './workers-coordinator-publisher-tax-production-monitoring-reconciliation.js';

export type WorkersCoordinatorPublisherTaxProductionExceptionEventType =
  | 'filing.rejected'
  | 'filing.corrected'
  | 'filing.duplicate_suppressed'
  | 'monitoring.replay_detected';

export type WorkersCoordinatorPublisherTaxProductionRunbookActionKind =
  | 'investigate-rejection'
  | 'prepare-correction'
  | 'confirm-duplicate-suppression'
  | 'review-replay';

export interface WorkersCoordinatorPublisherTaxProductionRunbookActionRecord {
  readonly actionId: string;
  readonly eventType: WorkersCoordinatorPublisherTaxProductionExceptionEventType;
  readonly callbackId?: string;
  readonly replayId?: string;
  readonly monitoringRecordIds: readonly string[];
  readonly monitoringAlertIds: readonly string[];
  readonly providerFilingIds: readonly string[];
  readonly productionWindowId: string;
  readonly action: WorkersCoordinatorPublisherTaxProductionRunbookActionKind;
  readonly status: 'open' | 'acknowledged' | 'resolved';
  readonly createdAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionSupportEscalationRecord {
  readonly supportEscalationId: string;
  readonly actionId: string;
  readonly monitoringAlertIds: readonly string[];
  readonly productionCallbackIds: readonly string[];
  readonly providerFilingIds: readonly string[];
  readonly productionWindowId: string;
  readonly openedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionPublisherStatusUpdate {
  readonly statusUpdateId: string;
  readonly providerFilingId: string;
  readonly productionWindowId: string;
  readonly actionIds: readonly string[];
  readonly supportEscalationIds: readonly string[];
  readonly status: 'exception-open' | 'correction-in-progress' | 'duplicate-suppressed' | 'under-review';
  readonly publishedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionRollbackEmergencyDecision {
  readonly decisionId: string;
  readonly rollbackPlanId: string;
  readonly emergencyHoldSwitchId: string;
  readonly decision: 'continue-monitoring' | 'hold' | 'rollback';
  readonly reason: string;
  readonly decidedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence {
  readonly source: 'publisher-tax-filing-production-exception-operations';
  readonly capturedAtMs: number;
  readonly operatorRunbookActions: readonly WorkersCoordinatorPublisherTaxProductionRunbookActionRecord[];
  readonly supportEscalations: readonly WorkersCoordinatorPublisherTaxProductionSupportEscalationRecord[];
  readonly publisherStatusUpdates: readonly WorkersCoordinatorPublisherTaxProductionPublisherStatusUpdate[];
  readonly preservedDuplicateFilingSuppressionIds: readonly string[];
  readonly rollbackEmergencyDecision: WorkersCoordinatorPublisherTaxProductionRollbackEmergencyDecision;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionOperationsOptions {
  readonly productionMonitoringReconciliationReport: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport;
  readonly exceptionOperationsEvidence: WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport {
  readonly runtime: 'publisher-tax-filing-production-exception-operations-runbook-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly productionMonitoringReconciliationEvidence: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport;
  readonly operatorRunbookActions: readonly WorkersCoordinatorPublisherTaxProductionRunbookActionRecord[];
  readonly supportEscalations: readonly WorkersCoordinatorPublisherTaxProductionSupportEscalationRecord[];
  readonly publisherStatusUpdates: readonly WorkersCoordinatorPublisherTaxProductionPublisherStatusUpdate[];
  readonly exceptionOperationsSummary: {
    readonly requiredActionCount: number;
    readonly runbookActionCount: number;
    readonly supportEscalationCount: number;
    readonly affectedProviderFilingCount: number;
    readonly publisherStatusUpdateCount: number;
  };
  readonly approvedWindowReconciliation: {
    readonly approvedProductionWindowId: string;
    readonly affectedProviderFilingIds: readonly string[];
    readonly statusUpdatedProviderFilingIds: readonly string[];
    readonly missingStatusUpdateProviderFilingIds: readonly string[];
  };
  readonly duplicateFilingSuppressionState: {
    readonly requiredDuplicateFilingSuppressionIds: readonly string[];
    readonly preservedDuplicateFilingSuppressionIds: readonly string[];
  };
  readonly rollbackEmergencyDecisionEvidence: WorkersCoordinatorPublisherTaxProductionRollbackEmergencyDecision;
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringExceptionOperations: {
    readonly cspConnectSrc: readonly string[];
    readonly sandboxFlags: readonly string[];
    readonly coop: string | null;
    readonly coep: string | null;
    readonly allowedOrigins: readonly string[];
    readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  };
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

interface ExceptionActionRequirement {
  readonly key: string;
  readonly eventType: WorkersCoordinatorPublisherTaxProductionExceptionEventType;
  readonly callbackIds: readonly string[];
  readonly callbackId?: string;
  readonly replayId?: string;
  readonly monitoringRecordIds: readonly string[];
  readonly monitoringAlertIds: readonly string[];
  readonly providerFilingIds: readonly string[];
  readonly productionWindowId: string;
  readonly expectedAction: WorkersCoordinatorPublisherTaxProductionRunbookActionKind;
}

export function runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate(
  options: WorkersCoordinatorPublisherTaxProductionExceptionOperationsOptions,
): WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport {
  const requirements = deriveExceptionActionRequirements(options.productionMonitoringReconciliationReport);
  const affectedProviderFilingIds = unique(requirements.flatMap((requirement) => requirement.providerFilingIds));
  const approvedWindowReconciliation = reconcileApprovedWindow(
    options.productionMonitoringReconciliationReport,
    options.exceptionOperationsEvidence,
    affectedProviderFilingIds,
  );
  const duplicateFilingSuppressionState = {
    requiredDuplicateFilingSuppressionIds:
      options.productionMonitoringReconciliationReport.duplicateFilingSuppressionReplay.requiredDuplicateFilingSuppressionIds,
    preservedDuplicateFilingSuppressionIds:
      options.exceptionOperationsEvidence.preservedDuplicateFilingSuppressionIds,
  };
  const blockedNonCoordinatorCdnNetworkAttempt = selectBlockedNonCoordinatorCdnNetworkAttempt(
    options.exceptionOperationsEvidence,
  );
  const holdReasons = selectHoldReasons({
    ...options,
    requirements,
    affectedProviderFilingIds,
    approvedWindowReconciliation,
    duplicateFilingSuppressionState,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-exception-operations-runbook-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.productionMonitoringReconciliationReport.previewRunnerUrl,
    productionMonitoringReconciliationEvidence: options.productionMonitoringReconciliationReport,
    operatorRunbookActions: options.exceptionOperationsEvidence.operatorRunbookActions,
    supportEscalations: options.exceptionOperationsEvidence.supportEscalations,
    publisherStatusUpdates: options.exceptionOperationsEvidence.publisherStatusUpdates,
    exceptionOperationsSummary: {
      requiredActionCount: requirements.length,
      runbookActionCount: options.exceptionOperationsEvidence.operatorRunbookActions.length,
      supportEscalationCount: options.exceptionOperationsEvidence.supportEscalations.length,
      affectedProviderFilingCount: affectedProviderFilingIds.length,
      publisherStatusUpdateCount: options.exceptionOperationsEvidence.publisherStatusUpdates.length,
    },
    approvedWindowReconciliation,
    duplicateFilingSuppressionState,
    rollbackEmergencyDecisionEvidence: options.exceptionOperationsEvidence.rollbackEmergencyDecision,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher tax production monitoring reconciliation gate has already passed',
        'rejected, corrected, duplicate-suppressed, and replay-detected events each map to one traceable operator runbook action',
        'support escalations preserve monitoring alert, callback, provider filing, and approved production window linkage',
        'every affected provider filing has a publisher-facing status update linked to its runbook actions and support escalations',
        'duplicate-filing suppression state remains preserved during exception operations',
        'rollback and emergency hold decision evidence remains linked to the approved cutover controls',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during exception operations',
      ],
      holdReasons,
    },
    securityBoundaryDuringExceptionOperations: {
      cspConnectSrc: options.exceptionOperationsEvidence.cspConnectSrc,
      sandboxFlags: options.exceptionOperationsEvidence.sandboxFlags,
      coop: options.exceptionOperationsEvidence.coop,
      coep: options.exceptionOperationsEvidence.coep,
      allowedOrigins: options.exceptionOperationsEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function deriveExceptionActionRequirements(
  report: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport,
): readonly ExceptionActionRequirement[] {
  const requirements: ExceptionActionRequirement[] = [];
  const exceptionCallbacks = report.productionProviderCallbacks.filter((callback) =>
    callback.eventType === 'filing.rejected' ||
    callback.eventType === 'filing.corrected' ||
    callback.eventType === 'filing.duplicate_suppressed',
  );

  for (const callback of exceptionCallbacks) {
    requirements.push({
      key: `callback:${callback.callbackId}`,
      eventType: callback.eventType,
      callbackIds: [callback.callbackId],
      callbackId: callback.callbackId,
      monitoringRecordIds: report.operatorMonitoringRecords
        .filter((record) => record.callbackId === callback.callbackId)
        .map((record) => record.monitoringRecordId),
      monitoringAlertIds: report.monitoringAlerts
        .filter((alert) => alert.callbackId === callback.callbackId)
        .map((alert) => alert.alertId),
      providerFilingIds: [callback.providerFilingId],
      productionWindowId: callback.productionWindowId,
      expectedAction: actionForEventType(callback.eventType),
    });
  }

  for (const replay of report.productionMonitoringReconciliationEvidence?.replayAudits ?? []) {
    const callbacks = report.productionProviderCallbacks.filter((callback) =>
      replay.sourceCallbackIds.includes(callback.callbackId),
    );
    requirements.push({
      key: `replay:${replay.replayId}`,
      eventType: 'monitoring.replay_detected',
      callbackIds: replay.sourceCallbackIds,
      replayId: replay.replayId,
      monitoringRecordIds: report.operatorMonitoringRecords
        .filter((record) => replay.sourceCallbackIds.includes(record.callbackId))
        .map((record) => record.monitoringRecordId),
      monitoringAlertIds: report.monitoringAlerts
        .filter((alert) => replay.sourceCallbackIds.includes(alert.callbackId))
        .map((alert) => alert.alertId),
      providerFilingIds: unique(callbacks.map((callback) => callback.providerFilingId)),
      productionWindowId: report.approvedWindowReconciliation.approvedProductionWindowId,
      expectedAction: 'review-replay',
    });
  }

  return requirements;
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxProductionExceptionOperationsOptions & {
  readonly requirements: readonly ExceptionActionRequirement[];
  readonly affectedProviderFilingIds: readonly string[];
  readonly approvedWindowReconciliation: WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport['approvedWindowReconciliation'];
  readonly duplicateFilingSuppressionState: WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport['duplicateFilingSuppressionState'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.productionMonitoringReconciliationReport.status === 'fail') {
    return [`publisher-tax-production-monitoring-reconciliation-gate-not-clean: ${input.productionMonitoringReconciliationReport.failureReason ?? 'unknown'}`];
  }
  if (input.exceptionOperationsEvidence.source !== 'publisher-tax-filing-production-exception-operations') {
    return ['publisher-tax-production-exception-operations-must-use-runbook-evidence'];
  }

  const holdReasons: string[] = [];
  const latestUpstreamAtMs = Math.max(
    ...input.productionMonitoringReconciliationReport.operatorMonitoringRecords.map((record) => record.observedAtMs),
    ...(input.productionMonitoringReconciliationReport.productionMonitoringReconciliationEvidence?.replayAudits ?? [])
      .map((replay) => replay.replayedAtMs),
    0,
  );
  if (input.exceptionOperationsEvidence.capturedAtMs < latestUpstreamAtMs) {
    holdReasons.push('publisher-tax-production-exception-operations-captured-before-monitoring-complete');
  }

  for (const requirement of input.requirements) {
    const matchingActions = input.exceptionOperationsEvidence.operatorRunbookActions.filter((action) =>
      action.eventType === requirement.eventType &&
      action.callbackId === requirement.callbackId &&
      action.replayId === requirement.replayId,
    );
    if (matchingActions.length !== 1) {
      holdReasons.push(`publisher-tax-production-exception-runbook-action-missing-or-duplicate: ${requirement.key}`);
      continue;
    }
    const action = matchingActions[0]!;
    if (
      action.actionId.length === 0 ||
      action.productionWindowId !== requirement.productionWindowId ||
      action.action !== requirement.expectedAction ||
      !isPositiveFinite(action.createdAtMs) ||
      !containsAll(action.monitoringRecordIds, requirement.monitoringRecordIds) ||
      !containsAll(action.monitoringAlertIds, requirement.monitoringAlertIds) ||
      !containsAll(action.providerFilingIds, requirement.providerFilingIds)
    ) {
      holdReasons.push(`publisher-tax-production-exception-runbook-action-invalid: ${requirement.key}`);
      continue;
    }

    const escalation = input.exceptionOperationsEvidence.supportEscalations.find((entry) =>
      entry.actionId === action.actionId,
    );
    if (
      !escalation ||
      escalation.supportEscalationId.length === 0 ||
      escalation.productionWindowId !== requirement.productionWindowId ||
      !isPositiveFinite(escalation.openedAtMs) ||
      !containsAll(escalation.monitoringAlertIds, requirement.monitoringAlertIds) ||
      !containsAll(escalation.productionCallbackIds, requirement.callbackIds) ||
      !containsAll(escalation.providerFilingIds, requirement.providerFilingIds)
    ) {
      holdReasons.push(`publisher-tax-production-exception-support-escalation-not-traceable: ${requirement.key}`);
    }
  }

  if (input.approvedWindowReconciliation.missingStatusUpdateProviderFilingIds.length > 0) {
    holdReasons.push(`publisher-tax-production-exception-publisher-status-update-missing: ${input.approvedWindowReconciliation.missingStatusUpdateProviderFilingIds[0]}`);
  }

  for (const providerFilingId of input.affectedProviderFilingIds) {
    const relevantActions = input.exceptionOperationsEvidence.operatorRunbookActions.filter((action) =>
      action.providerFilingIds.includes(providerFilingId),
    );
    const relevantEscalationIds = input.exceptionOperationsEvidence.supportEscalations
      .filter((escalation) => relevantActions.some((action) => action.actionId === escalation.actionId))
      .map((escalation) => escalation.supportEscalationId);
    const update = input.exceptionOperationsEvidence.publisherStatusUpdates.find((entry) =>
      entry.providerFilingId === providerFilingId &&
      entry.productionWindowId === input.approvedWindowReconciliation.approvedProductionWindowId,
    );
    if (
      !update ||
      update.statusUpdateId.length === 0 ||
      !isPositiveFinite(update.publishedAtMs) ||
      !containsAll(update.actionIds, relevantActions.map((action) => action.actionId)) ||
      !containsAll(update.supportEscalationIds, relevantEscalationIds)
    ) {
      holdReasons.push(`publisher-tax-production-exception-publisher-status-update-invalid: ${providerFilingId}`);
    }
  }

  const missingSuppressionId = input.duplicateFilingSuppressionState.requiredDuplicateFilingSuppressionIds.find((id) =>
    !input.duplicateFilingSuppressionState.preservedDuplicateFilingSuppressionIds.includes(id),
  );
  if (missingSuppressionId) {
    holdReasons.push(`publisher-tax-production-exception-duplicate-suppression-not-preserved: ${missingSuppressionId}`);
  }

  const controls = input.productionMonitoringReconciliationReport.rollbackEmergencyControlsDuringReplay;
  const decision = input.exceptionOperationsEvidence.rollbackEmergencyDecision;
  if (
    decision.decisionId.length === 0 ||
    decision.rollbackPlanId !== controls.requiredRollbackPlanId ||
    decision.emergencyHoldSwitchId !== controls.requiredEmergencyHoldSwitchId ||
    decision.reason.length === 0 ||
    !isPositiveFinite(decision.decidedAtMs)
  ) {
    holdReasons.push('publisher-tax-production-exception-rollback-hold-decision-not-linked');
  }

  const leakedNetworkAttempt = input.exceptionOperationsEvidence.networkAttempts.find((attempt) =>
    !input.exceptionOperationsEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-production-exception-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-exception-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.exceptionOperationsEvidence.allowedOrigins.every((origin) =>
    input.exceptionOperationsEvidence.cspConnectSrc.includes(origin),
  )) {
    holdReasons.push('publisher-tax-production-exception-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(
    input.exceptionOperationsEvidence.sandboxFlags.length === 1 &&
    input.exceptionOperationsEvidence.sandboxFlags[0] === 'allow-scripts'
  )) {
    holdReasons.push('publisher-tax-production-exception-sandbox-must-remain-allow-scripts-only');
  }
  if (
    input.exceptionOperationsEvidence.coop !== 'same-origin' ||
    input.exceptionOperationsEvidence.coep !== 'require-corp'
  ) {
    holdReasons.push('publisher-tax-production-exception-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function reconcileApprovedWindow(
  report: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport,
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence,
  affectedProviderFilingIds: readonly string[],
): WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport['approvedWindowReconciliation'] {
  const approvedProductionWindowId = report.approvedWindowReconciliation.approvedProductionWindowId;
  const statusUpdatedProviderFilingIds = affectedProviderFilingIds.filter((providerFilingId) =>
    evidence.publisherStatusUpdates.some((update) =>
      update.providerFilingId === providerFilingId &&
      update.productionWindowId === approvedProductionWindowId,
    ),
  );
  return {
    approvedProductionWindowId,
    affectedProviderFilingIds,
    statusUpdatedProviderFilingIds,
    missingStatusUpdateProviderFilingIds: affectedProviderFilingIds.filter((providerFilingId) =>
      !statusUpdatedProviderFilingIds.includes(providerFilingId),
    ),
  };
}

function actionForEventType(
  eventType: 'filing.rejected' | 'filing.corrected' | 'filing.duplicate_suppressed',
): WorkersCoordinatorPublisherTaxProductionRunbookActionKind {
  if (eventType === 'filing.rejected') return 'investigate-rejection';
  if (eventType === 'filing.corrected') return 'prepare-correction';
  return 'confirm-duplicate-suppression';
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('runbook-action')) {
    return ['publisher-tax-production-exception-runbook-action-hardening'];
  }
  if (failureReason?.includes('support-escalation')) {
    return ['publisher-tax-production-exception-support-escalation-hardening'];
  }
  if (failureReason?.includes('publisher-status-update')) {
    return ['publisher-tax-production-exception-publisher-status-hardening'];
  }
  if (failureReason?.includes('duplicate-suppression')) {
    return ['publisher-tax-production-exception-duplicate-suppression-hardening'];
  }
  if (failureReason?.includes('rollback-hold')) {
    return ['publisher-tax-production-exception-control-decision-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-production-exception-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-production-exception-operations-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-exception-resolution-audit'];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function containsAll(values: readonly string[], required: readonly string[]): boolean {
  return required.every((value) => values.includes(value));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
