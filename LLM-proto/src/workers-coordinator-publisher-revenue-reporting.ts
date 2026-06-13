import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherRecurringEmergencyControlEvidence,
  WorkersCoordinatorPublisherRecurringPayoutOperationsReport,
} from './workers-coordinator-publisher-recurring-payout-operations.js';

export interface WorkersCoordinatorPublisherMonthlyStatement {
  readonly statementId: string;
  readonly publisherId: string;
  readonly period: string;
  readonly currency: 'USD';
  readonly recurringPayoutWindowIds: readonly string[];
  readonly ledgerEntryIds: readonly string[];
  readonly receiptIds: readonly string[];
  readonly providerPayoutIds: readonly string[];
  readonly grossRewardUsd: number;
  readonly platformFeeUsd: number;
  readonly coordinatorRelaySpendUsd: number;
  readonly netPublisherPayoutUsd: number;
  readonly supportDisputeIds: readonly string[];
  readonly immutableLedgerHistoryPreserved: boolean;
}

export interface WorkersCoordinatorPublisherRevenueMarginReconciliation {
  readonly reconciliationId: string;
  readonly accountingExportId: string;
  readonly providerSettlementTotalUsd: number;
  readonly accountingPayoutTotalUsd: number;
  readonly ledgerPayoutTotalUsd: number;
  readonly platformFeeRevenueUsd: number;
  readonly coordinatorRelaySpendUsd: number;
  readonly grossRewardUsd: number;
  readonly netPublisherPayoutUsd: number;
  readonly marginUsd: number;
}

export interface WorkersCoordinatorPublisherRevenueAdjustment {
  readonly adjustmentId: string;
  readonly type: 'refund' | 'reversal' | 'clawback';
  readonly publisherId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly providerPayoutIds: readonly string[];
  readonly amountUsd: number;
  readonly reason: string;
  readonly adjustmentLedgerEntryId: string;
  readonly originalLedgerEntryIdsPreserved: boolean;
  readonly appliedAtMs: number;
}

export interface WorkersCoordinatorPublisherRevenueAuditExport {
  readonly exportId: string;
  readonly generatedAtMs: number;
  readonly audience: 'finance' | 'operator-review';
  readonly statementIds: readonly string[];
  readonly reconciliationIds: readonly string[];
  readonly adjustmentIds: readonly string[];
  readonly includesProviderSettlementIds: boolean;
  readonly includesAccountingExportIds: boolean;
  readonly includesEmergencyControlIds: boolean;
}

export interface WorkersCoordinatorPublisherRevenueReportingEvidence {
  readonly source: 'publisher-reward-payout-ops-revenue-reporting';
  readonly capturedAtMs: number;
  readonly publisherMonthlyStatements: readonly WorkersCoordinatorPublisherMonthlyStatement[];
  readonly platformFeeMarginReconciliations: readonly WorkersCoordinatorPublisherRevenueMarginReconciliation[];
  readonly refundReversalClawbackAdjustments: readonly WorkersCoordinatorPublisherRevenueAdjustment[];
  readonly auditReadyExports: readonly WorkersCoordinatorPublisherRevenueAuditExport[];
  readonly emergencyControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherRevenueReportingOptions {
  readonly recurringPayoutReport: WorkersCoordinatorPublisherRecurringPayoutOperationsReport;
  readonly revenueReportingEvidence: WorkersCoordinatorPublisherRevenueReportingEvidence;
}

export interface WorkersCoordinatorPublisherRevenueReportingReport {
  readonly runtime: 'publisher-reward-payout-ops-revenue-reporting-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly publisherMonthlyStatements: readonly WorkersCoordinatorPublisherMonthlyStatement[];
  readonly platformFeeRelaySpendMarginReconciliation: readonly WorkersCoordinatorPublisherRevenueMarginReconciliation[];
  readonly refundReversalClawbackAdjustments: readonly WorkersCoordinatorPublisherRevenueAdjustment[];
  readonly auditReadyPayoutOperationsExports: readonly WorkersCoordinatorPublisherRevenueAuditExport[];
  readonly emergencyHoldRollbackControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly revenueReportingSummary: {
    readonly currency: 'USD';
    readonly grossRewardUsd: number;
    readonly platformFeeRevenueUsd: number;
    readonly coordinatorRelaySpendUsd: number;
    readonly netPublisherPayoutUsd: number;
    readonly adjustmentTotalUsd: number;
    readonly marginUsd: number;
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringRevenueReporting: {
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

export function runWorkersCoordinatorPublisherRevenueReportingGate(
  options: WorkersCoordinatorPublisherRevenueReportingOptions,
): WorkersCoordinatorPublisherRevenueReportingReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.revenueReportingEvidence);
  const revenueReportingSummary = summarizeRevenueReporting(options.revenueReportingEvidence);
  const holdReasons = selectHoldReasons({
    ...options,
    revenueReportingSummary,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-payout-ops-revenue-reporting-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.recurringPayoutReport.previewRunnerUrl,
    publisherMonthlyStatements: options.revenueReportingEvidence.publisherMonthlyStatements,
    platformFeeRelaySpendMarginReconciliation: options.revenueReportingEvidence.platformFeeMarginReconciliations,
    refundReversalClawbackAdjustments: options.revenueReportingEvidence.refundReversalClawbackAdjustments,
    auditReadyPayoutOperationsExports: options.revenueReportingEvidence.auditReadyExports,
    emergencyHoldRollbackControls: options.revenueReportingEvidence.emergencyControls,
    revenueReportingSummary,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher recurring payout operations gate has already passed',
        'publisher monthly statements link recurring windows, ledger entries, receipts, provider payout IDs, and disputes',
        'platform fee revenue and Coordinator relay spend margin reconcile to accounting exports and provider settlements',
        'refund, reversal, and clawback adjustments append correction ledger entries without mutating immutable payout history',
        'finance and operator audit exports include statements, reconciliations, adjustments, settlements, and controls',
        'emergency hold and rollback controls remain outside signed runner control',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringRevenueReporting: {
      cspConnectSrc: options.revenueReportingEvidence.cspConnectSrc,
      sandboxFlags: options.revenueReportingEvidence.sandboxFlags,
      coop: options.revenueReportingEvidence.coop,
      coep: options.revenueReportingEvidence.coep,
      allowedOrigins: options.revenueReportingEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherRevenueReportingOptions & {
  readonly revenueReportingSummary: WorkersCoordinatorPublisherRevenueReportingReport['revenueReportingSummary'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.recurringPayoutReport.status === 'fail') {
    return [`publisher-recurring-payout-operations-gate-not-clean: ${input.recurringPayoutReport.failureReason ?? 'unknown'}`];
  }
  if (input.revenueReportingEvidence.source !== 'publisher-reward-payout-ops-revenue-reporting') {
    return ['publisher-revenue-reporting-must-use-revenue-reporting-evidence'];
  }
  if (input.revenueReportingEvidence.publisherMonthlyStatements.length === 0) {
    return ['publisher-revenue-reporting-monthly-statements-missing'];
  }
  if (input.revenueReportingEvidence.platformFeeMarginReconciliations.length === 0) {
    return ['publisher-revenue-reporting-platform-fee-margin-reconciliation-missing'];
  }

  const holdReasons: string[] = [];
  const recurringWindowIds = new Set(
    input.recurringPayoutReport.scheduledPayoutWindowIdempotency.map((window) => window.windowId),
  );
  const recurringLedgerEntryIds = new Set(
    input.recurringPayoutReport.scheduledPayoutWindowIdempotency.flatMap((window) => window.ledgerEntryIds),
  );
  const receiptIds = new Set(
    input.recurringPayoutReport.publisherSupportDisputeRouting.flatMap((route) => route.receiptIds),
  );
  const providerPayoutIds = new Set(
    input.recurringPayoutReport.publisherSupportDisputeRouting.flatMap((route) => route.providerPayoutIds),
  );
  const disputeIds = new Set(
    input.recurringPayoutReport.publisherSupportDisputeRouting.map((route) => route.disputeId),
  );
  const statementIds = new Set(input.revenueReportingEvidence.publisherMonthlyStatements.map((statement) => statement.statementId));
  const reconciliationIds = new Set(
    input.revenueReportingEvidence.platformFeeMarginReconciliations.map((reconciliation) => reconciliation.reconciliationId),
  );
  const adjustmentIds = new Set(
    input.revenueReportingEvidence.refundReversalClawbackAdjustments.map((adjustment) => adjustment.adjustmentId),
  );
  const emergencyControlIds = new Set(input.revenueReportingEvidence.emergencyControls.map((control) => control.controlId));
  const accountingExportIds = new Set(
    input.recurringPayoutReport.accountingExportReconciliation.map((exportReconciliation) => exportReconciliation.exportId),
  );

  const invalidStatement = input.revenueReportingEvidence.publisherMonthlyStatements.find((statement) =>
    statement.statementId.length === 0 ||
    statement.publisherId.length === 0 ||
    !/^\d{4}-\d{2}$/.test(statement.period) ||
    statement.currency !== 'USD' ||
    statement.recurringPayoutWindowIds.length === 0 ||
    statement.recurringPayoutWindowIds.some((windowId) => !recurringWindowIds.has(windowId)) ||
    statement.ledgerEntryIds.length === 0 ||
    statement.ledgerEntryIds.some((entryId) => !recurringLedgerEntryIds.has(entryId)) ||
    statement.receiptIds.length === 0 ||
    statement.receiptIds.some((receiptId) => !receiptIds.has(receiptId)) ||
    statement.providerPayoutIds.length === 0 ||
    statement.providerPayoutIds.some((providerPayoutId) => !providerPayoutIds.has(providerPayoutId)) ||
    statement.supportDisputeIds.some((disputeId) => !disputeIds.has(disputeId)) ||
    !isNonNegativeFinite(statement.grossRewardUsd) ||
    !isNonNegativeFinite(statement.platformFeeUsd) ||
    !isNonNegativeFinite(statement.coordinatorRelaySpendUsd) ||
    !isNonNegativeFinite(statement.netPublisherPayoutUsd) ||
    !nearlyEqual(
      statement.grossRewardUsd - statement.platformFeeUsd - statement.coordinatorRelaySpendUsd,
      statement.netPublisherPayoutUsd,
    ) ||
    !statement.immutableLedgerHistoryPreserved
  );
  if (invalidStatement) {
    holdReasons.push(`publisher-revenue-reporting-monthly-statement-invalid: ${invalidStatement.statementId || 'unknown'}`);
  }

  const invalidReconciliation = input.revenueReportingEvidence.platformFeeMarginReconciliations.find((reconciliation) =>
    reconciliation.reconciliationId.length === 0 ||
    !accountingExportIds.has(reconciliation.accountingExportId) ||
    !nearlyEqual(reconciliation.providerSettlementTotalUsd, reconciliation.accountingPayoutTotalUsd) ||
    !nearlyEqual(reconciliation.providerSettlementTotalUsd, reconciliation.ledgerPayoutTotalUsd) ||
    !isNonNegativeFinite(reconciliation.platformFeeRevenueUsd) ||
    !isNonNegativeFinite(reconciliation.coordinatorRelaySpendUsd) ||
    !isNonNegativeFinite(reconciliation.grossRewardUsd) ||
    !isNonNegativeFinite(reconciliation.netPublisherPayoutUsd) ||
    !nearlyEqual(
      reconciliation.grossRewardUsd - reconciliation.platformFeeRevenueUsd - reconciliation.coordinatorRelaySpendUsd,
      reconciliation.netPublisherPayoutUsd,
    ) ||
    !nearlyEqual(
      reconciliation.platformFeeRevenueUsd - reconciliation.coordinatorRelaySpendUsd,
      reconciliation.marginUsd,
    )
  );
  if (invalidReconciliation) {
    holdReasons.push(`publisher-revenue-reporting-platform-fee-margin-reconciliation-invalid: ${invalidReconciliation.reconciliationId || 'unknown'}`);
  }

  const invalidAdjustment = input.revenueReportingEvidence.refundReversalClawbackAdjustments.find((adjustment) =>
    adjustment.adjustmentId.length === 0 ||
    adjustment.publisherId.length === 0 ||
    adjustment.ledgerEntryIds.length === 0 ||
    adjustment.ledgerEntryIds.some((entryId) => !recurringLedgerEntryIds.has(entryId)) ||
    adjustment.providerPayoutIds.length === 0 ||
    adjustment.providerPayoutIds.some((providerPayoutId) => !providerPayoutIds.has(providerPayoutId)) ||
    !isPositiveFinite(adjustment.amountUsd) ||
    adjustment.reason.length === 0 ||
    adjustment.adjustmentLedgerEntryId.length === 0 ||
    recurringLedgerEntryIds.has(adjustment.adjustmentLedgerEntryId) ||
    !adjustment.originalLedgerEntryIdsPreserved ||
    !isPositiveFinite(adjustment.appliedAtMs)
  );
  if (invalidAdjustment) {
    holdReasons.push(`publisher-revenue-reporting-adjustment-invalid: ${invalidAdjustment.adjustmentId || 'unknown'}`);
  }

  const missingAdjustmentTypes = ['refund', 'reversal', 'clawback']
    .filter((type) => !input.revenueReportingEvidence.refundReversalClawbackAdjustments
      .some((adjustment) => adjustment.type === type));
  if (missingAdjustmentTypes.length > 0) {
    holdReasons.push(`publisher-revenue-reporting-adjustment-type-missing: ${missingAdjustmentTypes.join(',')}`);
  }

  const missingAuditAudience = ['finance', 'operator-review']
    .filter((audience) => !input.revenueReportingEvidence.auditReadyExports
      .some((auditExport) => auditExport.audience === audience));
  if (missingAuditAudience.length > 0) {
    holdReasons.push(`publisher-revenue-reporting-audit-export-audience-missing: ${missingAuditAudience.join(',')}`);
  }

  const invalidAuditExport = input.revenueReportingEvidence.auditReadyExports.find((auditExport) =>
    auditExport.exportId.length === 0 ||
    !isPositiveFinite(auditExport.generatedAtMs) ||
    auditExport.statementIds.length === 0 ||
    auditExport.statementIds.some((statementId) => !statementIds.has(statementId)) ||
    auditExport.reconciliationIds.length === 0 ||
    auditExport.reconciliationIds.some((reconciliationId) => !reconciliationIds.has(reconciliationId)) ||
    auditExport.adjustmentIds.some((adjustmentId) => !adjustmentIds.has(adjustmentId)) ||
    !auditExport.includesProviderSettlementIds ||
    !auditExport.includesAccountingExportIds ||
    !auditExport.includesEmergencyControlIds
  );
  if (invalidAuditExport) {
    holdReasons.push(`publisher-revenue-reporting-audit-export-invalid: ${invalidAuditExport.exportId || 'unknown'}`);
  }

  const missingEmergencyControl = input.recurringPayoutReport.scheduledPayoutWindowIdempotency.find((window) =>
    !input.revenueReportingEvidence.emergencyControls.some((control) =>
      control.scheduleId === window.scheduleId &&
      emergencyControlIds.has(control.controlId) &&
      control.outsideSignedRunnerBoundary &&
      control.activeHoldReasons.length === 0,
    ),
  );
  if (missingEmergencyControl) {
    holdReasons.push(`publisher-revenue-reporting-emergency-hold-rollback-controls-missing-or-active: ${missingEmergencyControl.scheduleId}`);
  }

  const statementGrossRewardUsd = input.revenueReportingEvidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.grossRewardUsd, 0);
  const statementPlatformFeeUsd = input.revenueReportingEvidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.platformFeeUsd, 0);
  const statementRelaySpendUsd = input.revenueReportingEvidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.coordinatorRelaySpendUsd, 0);
  const statementNetPayoutUsd = input.revenueReportingEvidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.netPublisherPayoutUsd, 0);

  if (!nearlyEqual(input.revenueReportingSummary.grossRewardUsd, statementGrossRewardUsd) ||
    !nearlyEqual(input.revenueReportingSummary.platformFeeRevenueUsd, statementPlatformFeeUsd) ||
    !nearlyEqual(input.revenueReportingSummary.coordinatorRelaySpendUsd, statementRelaySpendUsd) ||
    !nearlyEqual(input.revenueReportingSummary.netPublisherPayoutUsd, statementNetPayoutUsd)) {
    holdReasons.push('publisher-revenue-reporting-statement-summary-does-not-match-monthly-statements');
  }

  const leakedNetworkAttempt = input.revenueReportingEvidence.networkAttempts.find((attempt) =>
    !input.revenueReportingEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-revenue-reporting-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-revenue-reporting-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.revenueReportingEvidence.allowedOrigins.every((origin) => input.revenueReportingEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-revenue-reporting-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.revenueReportingEvidence.sandboxFlags.length === 1 && input.revenueReportingEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-revenue-reporting-sandbox-must-remain-allow-scripts-only');
  }
  if (input.revenueReportingEvidence.coop !== 'same-origin' || input.revenueReportingEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-revenue-reporting-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function summarizeRevenueReporting(
  evidence: WorkersCoordinatorPublisherRevenueReportingEvidence,
): WorkersCoordinatorPublisherRevenueReportingReport['revenueReportingSummary'] {
  const adjustmentTotalUsd = evidence.refundReversalClawbackAdjustments
    .reduce((sum, adjustment) => sum + adjustment.amountUsd, 0);
  const grossRewardUsd = evidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.grossRewardUsd, 0);
  const platformFeeRevenueUsd = evidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.platformFeeUsd, 0);
  const coordinatorRelaySpendUsd = evidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.coordinatorRelaySpendUsd, 0);
  const netPublisherPayoutUsd = evidence.publisherMonthlyStatements
    .reduce((sum, statement) => sum + statement.netPublisherPayoutUsd, 0);

  return {
    currency: 'USD',
    grossRewardUsd: roundUsd(grossRewardUsd),
    platformFeeRevenueUsd: roundUsd(platformFeeRevenueUsd),
    coordinatorRelaySpendUsd: roundUsd(coordinatorRelaySpendUsd),
    netPublisherPayoutUsd: roundUsd(netPublisherPayoutUsd),
    adjustmentTotalUsd: roundUsd(adjustmentTotalUsd),
    marginUsd: roundUsd(platformFeeRevenueUsd - coordinatorRelaySpendUsd - adjustmentTotalUsd),
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherRevenueReportingEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('monthly-statement')) {
    return ['publisher-revenue-reporting-monthly-statement-hardening'];
  }
  if (failureReason?.includes('platform-fee-margin')) {
    return ['publisher-revenue-reporting-margin-reconciliation-hardening'];
  }
  if (failureReason?.includes('adjustment')) {
    return ['publisher-revenue-reporting-refund-reversal-clawback-workflow'];
  }
  if (failureReason?.includes('audit-export')) {
    return ['publisher-revenue-reporting-audit-export-hardening'];
  }
  if (failureReason?.includes('emergency-hold') || failureReason?.includes('rollback')) {
    return ['publisher-revenue-reporting-emergency-control-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-revenue-reporting-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-revenue-reporting-failure: ${failureReason}`];
  }
  return ['publisher-reward-tax-reporting-and-1099-k-export'];
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000_001;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
