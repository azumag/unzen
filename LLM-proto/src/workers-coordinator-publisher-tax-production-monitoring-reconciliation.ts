import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport,
  WorkersCoordinatorPublisherTaxProductionProviderCallback,
} from './workers-coordinator-publisher-tax-production-callbacks-readiness.js';

export interface WorkersCoordinatorPublisherTaxProductionMonitoringRecord {
  readonly monitoringRecordId: string;
  readonly callbackId: string;
  readonly providerFilingId: string;
  readonly productionWindowId: string;
  readonly observedAtMs: number;
  readonly eventType: WorkersCoordinatorPublisherTaxProductionProviderCallback['eventType'];
  readonly duplicateFilingSuppressed: boolean;
}

export interface WorkersCoordinatorPublisherTaxProductionPublisherMonitoringExport {
  readonly exportId: string;
  readonly publisherId: string;
  readonly providerFilingId: string;
  readonly productionWindowId: string;
  readonly monitoringRecordIds: readonly string[];
  readonly deliveredAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionMonitoringAlert {
  readonly alertId: string;
  readonly callbackId: string;
  readonly monitoringRecordId: string;
  readonly productionWindowId: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly triggeredAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionMonitoringReplayAudit {
  readonly replayId: string;
  readonly sourceCallbackIds: readonly string[];
  readonly duplicateFilingSuppressionIds: readonly string[];
  readonly rollbackPlanIds: readonly string[];
  readonly emergencyHoldSwitchIds: readonly string[];
  readonly replayedAtMs: number;
}

export interface WorkersCoordinatorPublisherTaxProductionMonitoringEvidence {
  readonly source: 'publisher-tax-filing-production-monitoring-reconciliation';
  readonly capturedAtMs: number;
  readonly operatorMonitoringRecords: readonly WorkersCoordinatorPublisherTaxProductionMonitoringRecord[];
  readonly publisherMonitoringExports: readonly WorkersCoordinatorPublisherTaxProductionPublisherMonitoringExport[];
  readonly monitoringAlerts: readonly WorkersCoordinatorPublisherTaxProductionMonitoringAlert[];
  readonly replayAudits: readonly WorkersCoordinatorPublisherTaxProductionMonitoringReplayAudit[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions {
  readonly productionCallbacksReadinessReport: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport;
  readonly productionMonitoringEvidence: WorkersCoordinatorPublisherTaxProductionMonitoringEvidence;
}

export interface WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport {
  readonly runtime: 'publisher-tax-filing-production-monitoring-reconciliation-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly cutoverApprovalEvidence: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport['cutoverApprovalEvidence'];
  readonly productionProviderCallbacks: readonly WorkersCoordinatorPublisherTaxProductionProviderCallback[];
  readonly operatorMonitoringRecords: readonly WorkersCoordinatorPublisherTaxProductionMonitoringRecord[];
  readonly publisherMonitoringExports: readonly WorkersCoordinatorPublisherTaxProductionPublisherMonitoringExport[];
  readonly monitoringAlerts: readonly WorkersCoordinatorPublisherTaxProductionMonitoringAlert[];
  readonly productionMonitoringSummary: {
    readonly callbackCount: number;
    readonly monitoredCallbackCount: number;
    readonly publisherMonitoringExportCount: number;
    readonly alertTraceabilityCount: number;
    readonly replayAuditCount: number;
  };
  readonly approvedWindowReconciliation: {
    readonly approvedProductionWindowId: string;
    readonly reconciledProviderFilingIds: readonly string[];
    readonly unreconciledProviderFilingIds: readonly string[];
  };
  readonly duplicateFilingSuppressionReplay: {
    readonly requiredDuplicateFilingSuppressionIds: readonly string[];
    readonly replayedDuplicateFilingSuppressionIds: readonly string[];
  };
  readonly rollbackEmergencyControlsDuringReplay: {
    readonly requiredRollbackPlanId: string;
    readonly requiredEmergencyHoldSwitchId: string;
    readonly replayedRollbackPlanIds: readonly string[];
    readonly replayedEmergencyHoldSwitchIds: readonly string[];
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringProductionMonitoring: {
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

export function runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate(
  options: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions,
): WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.productionMonitoringEvidence);
  const approvedWindowReconciliation = reconcileApprovedProductionWindow(options);
  const duplicateFilingSuppressionReplay = summarizeDuplicateFilingSuppressionReplay(options);
  const rollbackEmergencyControlsDuringReplay = summarizeRollbackEmergencyControlsDuringReplay(options);
  const productionMonitoringSummary = summarizeProductionMonitoring(options);
  const holdReasons = selectHoldReasons({
    ...options,
    approvedWindowReconciliation,
    duplicateFilingSuppressionReplay,
    rollbackEmergencyControlsDuringReplay,
    productionMonitoringSummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-tax-filing-production-monitoring-reconciliation-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.productionCallbacksReadinessReport.previewRunnerUrl,
    cutoverApprovalEvidence: options.productionCallbacksReadinessReport.cutoverApprovalEvidence,
    productionProviderCallbacks: options.productionCallbacksReadinessReport.productionProviderCallbacks,
    operatorMonitoringRecords: options.productionMonitoringEvidence.operatorMonitoringRecords,
    publisherMonitoringExports: options.productionMonitoringEvidence.publisherMonitoringExports,
    monitoringAlerts: options.productionMonitoringEvidence.monitoringAlerts,
    productionMonitoringSummary,
    approvedWindowReconciliation,
    duplicateFilingSuppressionReplay,
    rollbackEmergencyControlsDuringReplay,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher tax production callbacks readiness gate has already passed',
        'accepted, rejected, corrected, and duplicate-suppressed production callbacks reconcile into operator monitoring records',
        'publisher-facing monitoring exports reconcile to approved production filing window IDs and provider filing IDs',
        'alert IDs map back to production callback IDs and approved production filing window IDs',
        'duplicate-filing suppression state is preserved during monitoring replay',
        'rollback and emergency hold controls remain linked during monitoring replay',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact during production monitoring reconciliation',
      ],
      holdReasons,
    },
    securityBoundaryDuringProductionMonitoring: {
      cspConnectSrc: options.productionMonitoringEvidence.cspConnectSrc,
      sandboxFlags: options.productionMonitoringEvidence.sandboxFlags,
      coop: options.productionMonitoringEvidence.coop,
      coep: options.productionMonitoringEvidence.coep,
      allowedOrigins: options.productionMonitoringEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions & {
  readonly approvedWindowReconciliation: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['approvedWindowReconciliation'];
  readonly duplicateFilingSuppressionReplay: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['duplicateFilingSuppressionReplay'];
  readonly rollbackEmergencyControlsDuringReplay: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['rollbackEmergencyControlsDuringReplay'];
  readonly productionMonitoringSummary: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['productionMonitoringSummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.productionCallbacksReadinessReport.status === 'fail') {
    return [`publisher-tax-production-callbacks-readiness-gate-not-clean: ${input.productionCallbacksReadinessReport.failureReason ?? 'unknown'}`];
  }
  if (input.productionMonitoringEvidence.source !== 'publisher-tax-filing-production-monitoring-reconciliation') {
    return ['publisher-tax-production-monitoring-must-use-production-monitoring-evidence'];
  }

  const holdReasons: string[] = [];
  const callbacks = input.productionCallbacksReadinessReport.productionProviderCallbacks;
  const callbackIds = new Set(callbacks.map((callback) => callback.callbackId));
  const approvedWindowId = input.productionCallbacksReadinessReport.productionFilingWindow.windowId;

  if (input.productionMonitoringEvidence.capturedAtMs <
    Math.max(...callbacks.map((callback) => callback.receivedAtMs), 0)
  ) {
    holdReasons.push('publisher-tax-production-monitoring-captured-before-callback-stream-complete');
  }

  const missingMonitoredCallback = callbacks.find((callback) =>
    !input.productionMonitoringEvidence.operatorMonitoringRecords.some((record) =>
      record.callbackId === callback.callbackId &&
      record.providerFilingId === callback.providerFilingId &&
      record.productionWindowId === approvedWindowId &&
      record.eventType === callback.eventType &&
      record.duplicateFilingSuppressed === callback.duplicateFilingSuppressed &&
      isPositiveFinite(record.observedAtMs),
    ),
  );
  if (missingMonitoredCallback || callbacks.length === 0) {
    holdReasons.push(`publisher-tax-production-monitoring-callback-not-reconciled: ${missingMonitoredCallback?.callbackId ?? 'missing'}`);
  }

  if (input.approvedWindowReconciliation.unreconciledProviderFilingIds.length > 0) {
    holdReasons.push(`publisher-tax-production-monitoring-provider-filing-not-exported: ${input.approvedWindowReconciliation.unreconciledProviderFilingIds[0]}`);
  }

  const invalidPublisherExport = input.productionMonitoringEvidence.publisherMonitoringExports.find((exportRecord) =>
    exportRecord.exportId.length === 0 ||
    exportRecord.publisherId.length === 0 ||
    exportRecord.productionWindowId !== approvedWindowId ||
    !input.productionCallbacksReadinessReport.cutoverApprovalEvidence.approvedSandboxProviderFilingIds.includes(exportRecord.providerFilingId) ||
    exportRecord.monitoringRecordIds.length === 0 ||
    exportRecord.monitoringRecordIds.some((monitoringRecordId) =>
      !input.productionMonitoringEvidence.operatorMonitoringRecords.some((record) =>
        record.monitoringRecordId === monitoringRecordId &&
        record.providerFilingId === exportRecord.providerFilingId &&
        record.productionWindowId === exportRecord.productionWindowId,
      ),
    ) ||
    !isPositiveFinite(exportRecord.deliveredAtMs),
  );
  if (invalidPublisherExport) {
    holdReasons.push(`publisher-tax-production-monitoring-publisher-export-invalid: ${invalidPublisherExport.exportId || 'unknown'}`);
  }

  const invalidAlert = input.productionMonitoringEvidence.monitoringAlerts.find((alert) =>
    alert.alertId.length === 0 ||
    !callbackIds.has(alert.callbackId) ||
    !input.productionMonitoringEvidence.operatorMonitoringRecords.some((record) =>
      record.monitoringRecordId === alert.monitoringRecordId &&
      record.callbackId === alert.callbackId &&
      record.productionWindowId === alert.productionWindowId,
    ) ||
    alert.productionWindowId !== approvedWindowId ||
    !isPositiveFinite(alert.triggeredAtMs),
  );
  if (invalidAlert || input.productionMonitoringEvidence.monitoringAlerts.length === 0) {
    holdReasons.push(`publisher-tax-production-monitoring-alert-not-traceable: ${invalidAlert?.alertId ?? 'missing'}`);
  }

  const missingDuplicateSuppressionId = input.duplicateFilingSuppressionReplay.requiredDuplicateFilingSuppressionIds.find((suppressionId) =>
    !input.duplicateFilingSuppressionReplay.replayedDuplicateFilingSuppressionIds.includes(suppressionId),
  );
  if (missingDuplicateSuppressionId) {
    holdReasons.push(`publisher-tax-production-monitoring-duplicate-suppression-not-replayed: ${missingDuplicateSuppressionId}`);
  }

  const replayedCallbackIds = new Set(input.productionMonitoringEvidence.replayAudits.flatMap((audit) => audit.sourceCallbackIds));
  const missingReplayCallback = callbacks.find((callback) => !replayedCallbackIds.has(callback.callbackId));
  if (missingReplayCallback || input.productionMonitoringEvidence.replayAudits.length === 0) {
    holdReasons.push(`publisher-tax-production-monitoring-callback-not-replayed: ${missingReplayCallback?.callbackId ?? 'missing'}`);
  }

  if (!input.rollbackEmergencyControlsDuringReplay.replayedRollbackPlanIds.includes(input.rollbackEmergencyControlsDuringReplay.requiredRollbackPlanId) ||
    !input.rollbackEmergencyControlsDuringReplay.replayedEmergencyHoldSwitchIds.includes(input.rollbackEmergencyControlsDuringReplay.requiredEmergencyHoldSwitchId)
  ) {
    holdReasons.push('publisher-tax-production-monitoring-rollback-hold-controls-not-replayed');
  }

  const leakedNetworkAttempt = input.productionMonitoringEvidence.networkAttempts.find((attempt) =>
    !input.productionMonitoringEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-tax-production-monitoring-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-tax-production-monitoring-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.productionMonitoringEvidence.allowedOrigins.every((origin) => input.productionMonitoringEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-tax-production-monitoring-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.productionMonitoringEvidence.sandboxFlags.length === 1 && input.productionMonitoringEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-tax-production-monitoring-sandbox-must-remain-allow-scripts-only');
  }
  if (input.productionMonitoringEvidence.coop !== 'same-origin' || input.productionMonitoringEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-tax-production-monitoring-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeProductionMonitoring(
  options: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions,
): WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['productionMonitoringSummary'] {
  const callbackIds = new Set(options.productionCallbacksReadinessReport.productionProviderCallbacks.map((callback) => callback.callbackId));
  return {
    callbackCount: options.productionCallbacksReadinessReport.productionProviderCallbacks.length,
    monitoredCallbackCount: options.productionMonitoringEvidence.operatorMonitoringRecords.filter((record) =>
      callbackIds.has(record.callbackId),
    ).length,
    publisherMonitoringExportCount: options.productionMonitoringEvidence.publisherMonitoringExports.length,
    alertTraceabilityCount: options.productionMonitoringEvidence.monitoringAlerts.filter((alert) =>
      callbackIds.has(alert.callbackId),
    ).length,
    replayAuditCount: options.productionMonitoringEvidence.replayAudits.length,
  };
}

function reconcileApprovedProductionWindow(
  options: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions,
): WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['approvedWindowReconciliation'] {
  const approvedProviderFilingIds = [
    ...new Set(options.productionCallbacksReadinessReport.productionProviderCallbacks.map((callback) => callback.providerFilingId)),
  ];
  const exportedProviderFilingIds = new Set(options.productionMonitoringEvidence.publisherMonitoringExports
    .filter((exportRecord) =>
      exportRecord.productionWindowId === options.productionCallbacksReadinessReport.productionFilingWindow.windowId,
    )
    .map((exportRecord) => exportRecord.providerFilingId));

  return {
    approvedProductionWindowId: options.productionCallbacksReadinessReport.productionFilingWindow.windowId,
    reconciledProviderFilingIds: approvedProviderFilingIds.filter((providerFilingId) =>
      exportedProviderFilingIds.has(providerFilingId),
    ),
    unreconciledProviderFilingIds: approvedProviderFilingIds.filter((providerFilingId) =>
      !exportedProviderFilingIds.has(providerFilingId),
    ),
  };
}

function summarizeDuplicateFilingSuppressionReplay(
  options: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions,
): WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['duplicateFilingSuppressionReplay'] {
  const requiredDuplicateFilingSuppressionIds = options.productionCallbacksReadinessReport.productionFilingWindow.duplicateFilingSuppressionIds;
  const replayedDuplicateFilingSuppressionIds = [
    ...new Set(options.productionMonitoringEvidence.replayAudits.flatMap((audit) => audit.duplicateFilingSuppressionIds)),
  ];

  return {
    requiredDuplicateFilingSuppressionIds,
    replayedDuplicateFilingSuppressionIds,
  };
}

function summarizeRollbackEmergencyControlsDuringReplay(
  options: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationOptions,
): WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport['rollbackEmergencyControlsDuringReplay'] {
  return {
    requiredRollbackPlanId: options.productionCallbacksReadinessReport.cutoverApprovalEvidence.rollbackPlanId,
    requiredEmergencyHoldSwitchId: options.productionCallbacksReadinessReport.cutoverApprovalEvidence.emergencyHoldSwitchId,
    replayedRollbackPlanIds: [
      ...new Set(options.productionMonitoringEvidence.replayAudits.flatMap((audit) => audit.rollbackPlanIds)),
    ],
    replayedEmergencyHoldSwitchIds: [
      ...new Set(options.productionMonitoringEvidence.replayAudits.flatMap((audit) => audit.emergencyHoldSwitchIds)),
    ],
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherTaxProductionMonitoringEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('callbacks-readiness')) {
    return ['publisher-tax-production-monitoring-callbacks-readiness-hardening'];
  }
  if (failureReason?.includes('callback-not-reconciled') ||
    failureReason?.includes('callback-not-replayed') ||
    failureReason?.includes('provider-filing')) {
    return ['publisher-tax-production-monitoring-reconciliation-hardening'];
  }
  if (failureReason?.includes('publisher-export')) {
    return ['publisher-tax-production-monitoring-publisher-export-hardening'];
  }
  if (failureReason?.includes('alert')) {
    return ['publisher-tax-production-monitoring-alert-traceability-hardening'];
  }
  if (failureReason?.includes('duplicate')) {
    return ['publisher-tax-production-monitoring-duplicate-suppression-replay-hardening'];
  }
  if (failureReason?.includes('rollback') || failureReason?.includes('hold')) {
    return ['publisher-tax-production-monitoring-rollback-hold-replay-hardening'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-tax-production-monitoring-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-tax-production-monitoring-reconciliation-failure: ${failureReason}`];
  }
  return ['publisher-tax-filing-production-exception-operations-runbook'];
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
