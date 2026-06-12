import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherLevelHold,
} from './workers-coordinator-publisher-ledger-payout-reconciliation.js';
import type {
  WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport,
} from './workers-coordinator-publisher-live-money-payout-pilot.js';

export interface WorkersCoordinatorPublisherScheduledPayoutWindow {
  readonly windowId: string;
  readonly scheduleId: string;
  readonly batchId: string;
  readonly providerBatchId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly opensAtMs: number;
  readonly closesAtMs: number;
  readonly idempotencyKey: string;
  readonly submissionCount: number;
  readonly duplicateProviderSubmissionBlocked: boolean;
}

export interface WorkersCoordinatorPublisherProviderRetryBackoffLedger {
  readonly providerPayoutId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly status: 'settled' | 'pending' | 'failed' | 'delayed';
  readonly retryCount: number;
  readonly nextRetryAtMs: number | null;
  readonly backoffPolicy: 'exponential' | 'manual-review' | 'none';
  readonly lastFailureReason: string | null;
}

export interface WorkersCoordinatorPublisherSupportDisputeRoute {
  readonly disputeId: string;
  readonly publisherId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly receiptIds: readonly string[];
  readonly providerPayoutIds: readonly string[];
  readonly routedTo: 'publisher-support' | 'payout-ops' | 'risk-review';
  readonly status: 'open' | 'triaged' | 'resolved';
  readonly createdAtMs: number;
}

export interface WorkersCoordinatorPublisherAccountingExportReconciliation {
  readonly exportId: string;
  readonly generatedAtMs: number;
  readonly currency: 'USD';
  readonly accountingPayoutTotalUsd: number;
  readonly providerSettlementTotalUsd: number;
  readonly ledgerPayoutTotalUsd: number;
  readonly accountingCoordinatorRelaySpendUsd: number;
  readonly providerCoordinatorRelaySpendUsd: number;
  readonly unmatchedLedgerEntryIds: readonly string[];
}

export interface WorkersCoordinatorPublisherRecurringPayoutSloDashboard {
  readonly dashboardId: string;
  readonly measuredWindowIds: readonly string[];
  readonly callbackP95LatencyMs: number;
  readonly failedPayoutRate: number;
  readonly duplicateSubmissionRate: number;
  readonly supportDisputeRate: number;
  readonly errorBudgetRemainingPercent: number;
}

export interface WorkersCoordinatorPublisherRecurringEmergencyControlEvidence {
  readonly controlId: string;
  readonly scheduleId: string;
  readonly emergencyHoldSwitchId: string;
  readonly rollbackPlanId: string;
  readonly controlledBy: string;
  readonly outsideSignedRunnerBoundary: boolean;
  readonly activeHoldReasons: readonly string[];
}

export interface WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence {
  readonly source: 'publisher-reward-recurring-payout-operations';
  readonly capturedAtMs: number;
  readonly scheduledPayoutWindows: readonly WorkersCoordinatorPublisherScheduledPayoutWindow[];
  readonly providerRetryBackoffLedgers: readonly WorkersCoordinatorPublisherProviderRetryBackoffLedger[];
  readonly supportDisputeRoutes: readonly WorkersCoordinatorPublisherSupportDisputeRoute[];
  readonly accountingExportReconciliations: readonly WorkersCoordinatorPublisherAccountingExportReconciliation[];
  readonly sloDashboards: readonly WorkersCoordinatorPublisherRecurringPayoutSloDashboard[];
  readonly emergencyControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherRecurringPayoutOperationsOptions {
  readonly livePayoutReport: WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport;
  readonly recurringPayoutEvidence: WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence;
}

export interface WorkersCoordinatorPublisherRecurringPayoutOperationsReport {
  readonly runtime: 'publisher-reward-recurring-payout-operations-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly scheduledPayoutWindowIdempotency: readonly WorkersCoordinatorPublisherScheduledPayoutWindow[];
  readonly providerRetryBackoffLedgers: readonly WorkersCoordinatorPublisherProviderRetryBackoffLedger[];
  readonly publisherSupportDisputeRouting: readonly WorkersCoordinatorPublisherSupportDisputeRoute[];
  readonly accountingExportReconciliation: readonly WorkersCoordinatorPublisherAccountingExportReconciliation[];
  readonly postPilotSloErrorBudgetDashboards: readonly WorkersCoordinatorPublisherRecurringPayoutSloDashboard[];
  readonly emergencyHoldRollbackControls: readonly WorkersCoordinatorPublisherRecurringEmergencyControlEvidence[];
  readonly recurringPayoutReconciliation: {
    readonly currency: 'USD';
    readonly providerSettlementTotalUsd: number;
    readonly accountingPayoutTotalUsd: number;
    readonly ledgerPayoutTotalUsd: number;
    readonly providerCoordinatorRelaySpendUsd: number;
    readonly accountingCoordinatorRelaySpendUsd: number;
    readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  };
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringRecurringOperations: {
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

export function runWorkersCoordinatorPublisherRecurringPayoutOperationsGate(
  options: WorkersCoordinatorPublisherRecurringPayoutOperationsOptions,
): WorkersCoordinatorPublisherRecurringPayoutOperationsReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.recurringPayoutEvidence);
  const recurringPayoutReconciliation = reconcileRecurringPayouts(options);
  const holdReasons = selectHoldReasons({
    ...options,
    recurringPayoutReconciliation,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-recurring-payout-operations-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.livePayoutReport.previewRunnerUrl,
    scheduledPayoutWindowIdempotency: options.recurringPayoutEvidence.scheduledPayoutWindows,
    providerRetryBackoffLedgers: options.recurringPayoutEvidence.providerRetryBackoffLedgers,
    publisherSupportDisputeRouting: options.recurringPayoutEvidence.supportDisputeRoutes,
    accountingExportReconciliation: options.recurringPayoutEvidence.accountingExportReconciliations,
    postPilotSloErrorBudgetDashboards: options.recurringPayoutEvidence.sloDashboards,
    emergencyHoldRollbackControls: options.recurringPayoutEvidence.emergencyControls,
    recurringPayoutReconciliation,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher live-money payout pilot gate has already passed',
        'scheduled payout windows use stable idempotency keys and block duplicate provider submissions',
        'provider retry and backoff ledgers cover settled, pending, failed, and delayed callbacks',
        'publisher support disputes link ledger entries, receipts, and provider payout IDs',
        'accounting exports reconcile to provider settlements, ledger payout totals, and Coordinator relay spend',
        'post-pilot SLO and error-budget dashboards remain inside operating thresholds',
        'emergency hold and rollback controls remain outside signed runner control',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringRecurringOperations: {
      cspConnectSrc: options.recurringPayoutEvidence.cspConnectSrc,
      sandboxFlags: options.recurringPayoutEvidence.sandboxFlags,
      coop: options.recurringPayoutEvidence.coop,
      coep: options.recurringPayoutEvidence.coep,
      allowedOrigins: options.recurringPayoutEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherRecurringPayoutOperationsOptions & {
  readonly recurringPayoutReconciliation: WorkersCoordinatorPublisherRecurringPayoutOperationsReport['recurringPayoutReconciliation'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.livePayoutReport.status === 'fail') {
    return [`publisher-live-money-payout-pilot-gate-not-clean: ${input.livePayoutReport.failureReason ?? 'unknown'}`];
  }
  if (input.recurringPayoutEvidence.source !== 'publisher-reward-recurring-payout-operations') {
    return ['publisher-recurring-payout-must-use-recurring-operations-evidence'];
  }
  if (input.recurringPayoutEvidence.scheduledPayoutWindows.length === 0) {
    return ['publisher-recurring-payout-scheduled-window-missing'];
  }
  if (input.recurringPayoutEvidence.providerRetryBackoffLedgers.length === 0) {
    return ['publisher-recurring-payout-provider-retry-backoff-ledger-missing'];
  }

  const holdReasons: string[] = [];
  const pilotLedgerEntryIds = input.livePayoutReport.providerSettlementCallbacks
    .flatMap((callback) => callback.ledgerEntryIds);
  const windowLedgerEntryIds = input.recurringPayoutEvidence.scheduledPayoutWindows
    .flatMap((window) => window.ledgerEntryIds);
  const windowLedgerEntryIdSet = new Set(windowLedgerEntryIds);
  const providerPayoutIds = new Set(
    input.livePayoutReport.providerSettlementCallbacks.map((callback) => callback.providerPayoutId),
  );
  const receiptIds = new Set(input.livePayoutReport.publisherReceiptEvidence.map((receipt) => receipt.receiptId));
  const scheduleIds = new Set(input.recurringPayoutEvidence.scheduledPayoutWindows.map((window) => window.scheduleId));

  const invalidWindow = input.recurringPayoutEvidence.scheduledPayoutWindows.find((window) =>
    window.windowId.length === 0 ||
    window.scheduleId.length === 0 ||
    window.batchId.length === 0 ||
    window.providerBatchId.length === 0 ||
    window.ledgerEntryIds.length === 0 ||
    window.ledgerEntryIds.some((entryId) => !pilotLedgerEntryIds.includes(entryId)) ||
    !isPositiveFinite(window.opensAtMs) ||
    !isPositiveFinite(window.closesAtMs) ||
    window.closesAtMs <= window.opensAtMs ||
    window.idempotencyKey.length === 0 ||
    window.submissionCount !== 1 ||
    !window.duplicateProviderSubmissionBlocked,
  );
  if (invalidWindow) {
    holdReasons.push(`publisher-recurring-payout-scheduled-window-idempotency-invalid: ${invalidWindow.windowId || 'unknown'}`);
  }

  const duplicateIdempotencyKey = findDuplicate(
    input.recurringPayoutEvidence.scheduledPayoutWindows.map((window) => window.idempotencyKey),
  );
  if (duplicateIdempotencyKey) {
    holdReasons.push(`publisher-recurring-payout-idempotency-key-duplicated: ${duplicateIdempotencyKey}`);
  }

  const missingPilotLedgerEntry = pilotLedgerEntryIds.find((entryId) => !windowLedgerEntryIdSet.has(entryId));
  if (missingPilotLedgerEntry) {
    holdReasons.push(`publisher-recurring-payout-window-missing-pilot-ledger-entry: ${missingPilotLedgerEntry}`);
  }

  const missingRetryStatuses = ['settled', 'pending', 'failed', 'delayed']
    .filter((status) => !input.recurringPayoutEvidence.providerRetryBackoffLedgers
      .some((ledger) => ledger.status === status));
  if (missingRetryStatuses.length > 0) {
    holdReasons.push(`publisher-recurring-payout-provider-retry-backoff-status-missing: ${missingRetryStatuses.join(',')}`);
  }

  const invalidRetryLedger = input.recurringPayoutEvidence.providerRetryBackoffLedgers.find((ledger) =>
    ledger.providerPayoutId.length === 0 ||
    ledger.ledgerEntryIds.length === 0 ||
    ledger.ledgerEntryIds.some((entryId) => !windowLedgerEntryIdSet.has(entryId)) ||
    !Number.isInteger(ledger.retryCount) ||
    ledger.retryCount < 0 ||
    (ledger.status === 'settled' && (ledger.retryCount !== 0 || ledger.nextRetryAtMs !== null || ledger.backoffPolicy !== 'none')) ||
    (ledger.status !== 'settled' && (!isPositiveFinite(ledger.nextRetryAtMs) || ledger.backoffPolicy === 'none')) ||
    ((ledger.status === 'failed' || ledger.status === 'delayed') && !ledger.lastFailureReason),
  );
  if (invalidRetryLedger) {
    holdReasons.push(`publisher-recurring-payout-provider-retry-backoff-ledger-invalid: ${invalidRetryLedger.providerPayoutId || 'unknown'}`);
  }

  const invalidDisputeRoute = input.recurringPayoutEvidence.supportDisputeRoutes.find((route) =>
    route.disputeId.length === 0 ||
    route.publisherId.length === 0 ||
    route.ledgerEntryIds.length === 0 ||
    route.ledgerEntryIds.some((entryId) => !windowLedgerEntryIdSet.has(entryId)) ||
    route.receiptIds.length === 0 ||
    route.receiptIds.some((receiptId) => !receiptIds.has(receiptId)) ||
    route.providerPayoutIds.length === 0 ||
    route.providerPayoutIds.some((providerPayoutId) => !providerPayoutIds.has(providerPayoutId)) ||
    route.status === 'open' ||
    !isPositiveFinite(route.createdAtMs),
  );
  if (invalidDisputeRoute) {
    holdReasons.push(`publisher-recurring-payout-support-dispute-route-invalid: ${invalidDisputeRoute.disputeId || 'unknown'}`);
  }

  const invalidAccountingExport = input.recurringPayoutEvidence.accountingExportReconciliations.find((exportReconciliation) =>
    exportReconciliation.exportId.length === 0 ||
    !isPositiveFinite(exportReconciliation.generatedAtMs) ||
    exportReconciliation.currency !== 'USD' ||
    exportReconciliation.unmatchedLedgerEntryIds.length > 0 ||
    !nearlyEqual(exportReconciliation.accountingPayoutTotalUsd, exportReconciliation.providerSettlementTotalUsd) ||
    !nearlyEqual(exportReconciliation.accountingPayoutTotalUsd, exportReconciliation.ledgerPayoutTotalUsd) ||
    !nearlyEqual(exportReconciliation.accountingCoordinatorRelaySpendUsd, exportReconciliation.providerCoordinatorRelaySpendUsd),
  );
  if (invalidAccountingExport) {
    holdReasons.push(`publisher-recurring-payout-accounting-export-reconciliation-invalid: ${invalidAccountingExport.exportId || 'unknown'}`);
  }

  if (!nearlyEqual(
    input.recurringPayoutReconciliation.providerSettlementTotalUsd,
    input.recurringPayoutReconciliation.accountingPayoutTotalUsd,
  )) {
    holdReasons.push('publisher-recurring-payout-provider-total-does-not-match-accounting-export-total');
  }
  if (!nearlyEqual(
    input.recurringPayoutReconciliation.providerSettlementTotalUsd,
    input.recurringPayoutReconciliation.ledgerPayoutTotalUsd,
  )) {
    holdReasons.push('publisher-recurring-payout-provider-total-does-not-match-ledger-total');
  }
  if (!nearlyEqual(
    input.recurringPayoutReconciliation.providerCoordinatorRelaySpendUsd,
    input.recurringPayoutReconciliation.accountingCoordinatorRelaySpendUsd,
  )) {
    holdReasons.push('publisher-recurring-payout-relay-spend-does-not-match-accounting-export');
  }

  const invalidDashboard = input.recurringPayoutEvidence.sloDashboards.find((dashboard) =>
    dashboard.dashboardId.length === 0 ||
    dashboard.measuredWindowIds.length === 0 ||
    dashboard.measuredWindowIds.some((windowId) =>
      !input.recurringPayoutEvidence.scheduledPayoutWindows.some((window) => window.windowId === windowId),
    ) ||
    !isNonNegativeFinite(dashboard.callbackP95LatencyMs) ||
    dashboard.callbackP95LatencyMs > 30_000 ||
    !isRateInRange(dashboard.failedPayoutRate) ||
    dashboard.failedPayoutRate > 0.01 ||
    !isRateInRange(dashboard.duplicateSubmissionRate) ||
    dashboard.duplicateSubmissionRate !== 0 ||
    !isRateInRange(dashboard.supportDisputeRate) ||
    dashboard.supportDisputeRate > 0.05 ||
    !isNonNegativeFinite(dashboard.errorBudgetRemainingPercent) ||
    dashboard.errorBudgetRemainingPercent < 50,
  );
  if (invalidDashboard) {
    holdReasons.push(`publisher-recurring-payout-slo-error-budget-dashboard-invalid: ${invalidDashboard.dashboardId || 'unknown'}`);
  }

  const missingEmergencyControl = [...scheduleIds].find((scheduleId) =>
    !input.recurringPayoutEvidence.emergencyControls.some((control) =>
      control.scheduleId === scheduleId &&
      control.controlId.length > 0 &&
      control.emergencyHoldSwitchId.length > 0 &&
      control.rollbackPlanId.length > 0 &&
      control.controlledBy.length > 0 &&
      control.outsideSignedRunnerBoundary &&
      control.activeHoldReasons.length === 0,
    ),
  );
  if (missingEmergencyControl) {
    holdReasons.push(`publisher-recurring-payout-emergency-hold-rollback-controls-missing-or-active: ${missingEmergencyControl}`);
  }

  const heldPublisherId = input.recurringPayoutEvidence.publisherLevelHolds
    .find((hold) => hold.reason.length > 0)?.publisherId;
  if (heldPublisherId) {
    holdReasons.push(`publisher-recurring-payout-publisher-level-hold-active: ${heldPublisherId}`);
  }

  const leakedNetworkAttempt = input.recurringPayoutEvidence.networkAttempts.find((attempt) =>
    !input.recurringPayoutEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-recurring-payout-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-recurring-payout-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.recurringPayoutEvidence.allowedOrigins.every((origin) => input.recurringPayoutEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-recurring-payout-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.recurringPayoutEvidence.sandboxFlags.length === 1 && input.recurringPayoutEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-recurring-payout-sandbox-must-remain-allow-scripts-only');
  }
  if (input.recurringPayoutEvidence.coop !== 'same-origin' || input.recurringPayoutEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-recurring-payout-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function reconcileRecurringPayouts(
  options: WorkersCoordinatorPublisherRecurringPayoutOperationsOptions,
): WorkersCoordinatorPublisherRecurringPayoutOperationsReport['recurringPayoutReconciliation'] {
  const accountingPayoutTotalUsd = options.recurringPayoutEvidence.accountingExportReconciliations
    .reduce((sum, exportReconciliation) => sum + exportReconciliation.accountingPayoutTotalUsd, 0);
  const ledgerPayoutTotalUsd = options.recurringPayoutEvidence.accountingExportReconciliations
    .reduce((sum, exportReconciliation) => sum + exportReconciliation.ledgerPayoutTotalUsd, 0);
  const accountingCoordinatorRelaySpendUsd = options.recurringPayoutEvidence.accountingExportReconciliations
    .reduce((sum, exportReconciliation) => sum + exportReconciliation.accountingCoordinatorRelaySpendUsd, 0);
  const providerCoordinatorRelaySpendUsd = options.recurringPayoutEvidence.accountingExportReconciliations
    .reduce((sum, exportReconciliation) => sum + exportReconciliation.providerCoordinatorRelaySpendUsd, 0);

  return {
    currency: 'USD',
    providerSettlementTotalUsd: options.recurringPayoutEvidence.accountingExportReconciliations
      .reduce((sum, exportReconciliation) => sum + exportReconciliation.providerSettlementTotalUsd, 0),
    accountingPayoutTotalUsd,
    ledgerPayoutTotalUsd,
    providerCoordinatorRelaySpendUsd,
    accountingCoordinatorRelaySpendUsd,
    publisherLevelHolds: options.recurringPayoutEvidence.publisherLevelHolds,
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('scheduled-window') || failureReason?.includes('idempotency')) {
    return ['publisher-recurring-payout-scheduler-idempotency-hardening'];
  }
  if (failureReason?.includes('retry-backoff')) {
    return ['publisher-recurring-payout-provider-retry-operations'];
  }
  if (failureReason?.includes('support-dispute')) {
    return ['publisher-recurring-payout-support-dispute-workflow'];
  }
  if (failureReason?.includes('accounting-export') || failureReason?.includes('ledger-total')) {
    return ['publisher-recurring-payout-accounting-reconciliation'];
  }
  if (failureReason?.includes('slo-error-budget')) {
    return ['publisher-recurring-payout-slo-dashboard-hardening'];
  }
  if (failureReason?.includes('emergency-hold') || failureReason?.includes('rollback')) {
    return ['publisher-recurring-payout-emergency-control-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-recurring-payout-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-recurring-payout-failure: ${failureReason}`];
  }
  return ['publisher-reward-payout-ops-revenue-reporting'];
}

function findDuplicate(items: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) {
      return item;
    }
    seen.add(item);
  }
  return null;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRateInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000_001;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
