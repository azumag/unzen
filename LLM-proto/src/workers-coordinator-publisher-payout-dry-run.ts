import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherPilotLedgerReport,
  WorkersCoordinatorPublisherLevelHold,
} from './workers-coordinator-publisher-ledger-payout-reconciliation.js';

export interface WorkersCoordinatorPublisherProviderDryRun {
  readonly providerDryRunId: string;
  readonly provider: 'stripe-connect' | 'wise-platform';
  readonly batchId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly currency: 'USD';
  readonly dryRunPayoutUsd: number;
  readonly dryRunCoordinatorRelaySpendUsd: number;
  readonly status: 'ready' | 'held';
  readonly liveMoneyMovementTriggered: boolean;
}

export interface WorkersCoordinatorPublisherTaxInvoiceMetadata {
  readonly publisherId: string;
  readonly taxProfileId: string;
  readonly taxFormStatus: 'valid' | 'missing' | 'expired';
  readonly invoiceId: string;
  readonly invoiceStatus: 'ready-for-review' | 'missing' | 'blocked';
  readonly payoutCurrency: 'USD';
}

export interface WorkersCoordinatorPublisherOperatorApprovalEvidence {
  readonly batchId: string;
  readonly approvedBy: string;
  readonly approvedAtMs: number;
  readonly dryRunOnlyAttestation: boolean;
  readonly blockerReasons: readonly string[];
}

export interface WorkersCoordinatorPublisherReconciliationExportEvidence {
  readonly publisherId: string;
  readonly exportId: string;
  readonly generatedAtMs: number;
  readonly ledgerEntryIds: readonly string[];
  readonly includesProviderDryRunId: boolean;
  readonly includesTaxInvoiceMetadata: boolean;
}

export interface WorkersCoordinatorPublisherPayoutDryRunEvidence {
  readonly source: 'publisher-reward-real-money-payout-pilot-dry-run';
  readonly capturedAtMs: number;
  readonly providerDryRuns: readonly WorkersCoordinatorPublisherProviderDryRun[];
  readonly taxInvoiceMetadata: readonly WorkersCoordinatorPublisherTaxInvoiceMetadata[];
  readonly operatorApprovals: readonly WorkersCoordinatorPublisherOperatorApprovalEvidence[];
  readonly publisherFacingExports: readonly WorkersCoordinatorPublisherReconciliationExportEvidence[];
  readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherPayoutDryRunOptions {
  readonly ledgerReport: WorkersCoordinatorPublisherPilotLedgerReport;
  readonly payoutDryRunEvidence: WorkersCoordinatorPublisherPayoutDryRunEvidence;
}

export interface WorkersCoordinatorPublisherPayoutDryRunReport {
  readonly runtime: 'publisher-reward-real-money-payout-pilot-dry-run-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly payoutProviderDryRunEvidence: readonly WorkersCoordinatorPublisherProviderDryRun[];
  readonly payoutDryRunReconciliation: {
    readonly currency: 'USD';
    readonly ledgerPayoutBatchUsd: number;
    readonly providerDryRunPayoutUsd: number;
    readonly ledgerCoordinatorRelaySpendUsd: number;
    readonly providerDryRunCoordinatorRelaySpendUsd: number;
    readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  };
  readonly taxInvoiceMetadata: readonly WorkersCoordinatorPublisherTaxInvoiceMetadata[];
  readonly operatorApprovalEvidence: readonly WorkersCoordinatorPublisherOperatorApprovalEvidence[];
  readonly publisherFacingReconciliationExports: readonly WorkersCoordinatorPublisherReconciliationExportEvidence[];
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringPayoutDryRun: {
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

export function runWorkersCoordinatorPublisherPayoutDryRunGate(
  options: WorkersCoordinatorPublisherPayoutDryRunOptions,
): WorkersCoordinatorPublisherPayoutDryRunReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.payoutDryRunEvidence);
  const payoutDryRunReconciliation = reconcilePayoutDryRun(options);
  const holdReasons = selectHoldReasons({
    ...options,
    payoutDryRunReconciliation,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-real-money-payout-pilot-dry-run-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.ledgerReport.previewRunnerUrl,
    payoutProviderDryRunEvidence: options.payoutDryRunEvidence.providerDryRuns,
    payoutDryRunReconciliation,
    taxInvoiceMetadata: options.payoutDryRunEvidence.taxInvoiceMetadata,
    operatorApprovalEvidence: options.payoutDryRunEvidence.operatorApprovals,
    publisherFacingReconciliationExports: options.payoutDryRunEvidence.publisherFacingExports,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher pilot ledger payout reconciliation gate has already passed',
        'payout provider dry-run totals match ledger payout batch totals',
        'dry-run evidence proves live money movement was not triggered',
        'tax and invoice metadata exists for each payable publisher',
        'operator approval attests the batch is dry-run only',
        'publisher-facing reconciliation exports include ledger, provider, tax, and invoice evidence',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringPayoutDryRun: {
      cspConnectSrc: options.payoutDryRunEvidence.cspConnectSrc,
      sandboxFlags: options.payoutDryRunEvidence.sandboxFlags,
      coop: options.payoutDryRunEvidence.coop,
      coep: options.payoutDryRunEvidence.coep,
      allowedOrigins: options.payoutDryRunEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherPayoutDryRunOptions & {
  readonly payoutDryRunReconciliation: WorkersCoordinatorPublisherPayoutDryRunReport['payoutDryRunReconciliation'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.ledgerReport.status === 'fail') {
    return [`publisher-ledger-gate-not-clean: ${input.ledgerReport.failureReason ?? 'unknown'}`];
  }
  if (input.payoutDryRunEvidence.source !== 'publisher-reward-real-money-payout-pilot-dry-run') {
    return ['publisher-payout-dry-run-must-use-provider-dry-run-evidence'];
  }
  if (input.payoutDryRunEvidence.providerDryRuns.length === 0) {
    return ['publisher-payout-provider-dry-run-evidence-missing'];
  }

  const holdReasons: string[] = [];
  const payableEntryIds = new Set(
    input.ledgerReport.ledgerEntries
      .filter((entry) => entry.decision === 'payable')
      .map((entry) => entry.immutableLedgerId),
  );
  const heldEntryIds = new Set(
    input.ledgerReport.ledgerEntries
      .filter((entry) => entry.decision === 'held')
      .map((entry) => entry.immutableLedgerId),
  );
  const dryRunLedgerEntryIds = input.payoutDryRunEvidence.providerDryRuns.flatMap((dryRun) => dryRun.ledgerEntryIds);

  const duplicateDryRunLedgerEntryId = findDuplicate(dryRunLedgerEntryIds);
  if (duplicateDryRunLedgerEntryId) {
    holdReasons.push(`publisher-payout-dry-run-ledger-entry-duplicated: ${duplicateDryRunLedgerEntryId}`);
  }
  const unknownDryRunLedgerEntryId = dryRunLedgerEntryIds.find((entryId) =>
    !payableEntryIds.has(entryId) && !heldEntryIds.has(entryId),
  );
  if (unknownDryRunLedgerEntryId) {
    holdReasons.push(`publisher-payout-dry-run-references-unknown-ledger-entry: ${unknownDryRunLedgerEntryId}`);
  }
  const heldDryRunLedgerEntryId = dryRunLedgerEntryIds.find((entryId) => heldEntryIds.has(entryId));
  if (heldDryRunLedgerEntryId) {
    holdReasons.push(`publisher-payout-dry-run-includes-held-ledger-entry: ${heldDryRunLedgerEntryId}`);
  }
  const missingPayableLedgerEntryId = [...payableEntryIds].find((entryId) => !dryRunLedgerEntryIds.includes(entryId));
  if (missingPayableLedgerEntryId) {
    holdReasons.push(`publisher-payout-dry-run-missing-payable-ledger-entry: ${missingPayableLedgerEntryId}`);
  }

  const invalidProviderDryRun = input.payoutDryRunEvidence.providerDryRuns.find((dryRun) =>
    dryRun.providerDryRunId.length === 0 ||
    dryRun.batchId.length === 0 ||
    dryRun.currency !== 'USD' ||
    dryRun.ledgerEntryIds.length === 0 ||
    !isNonNegativeFinite(dryRun.dryRunPayoutUsd) ||
    !isNonNegativeFinite(dryRun.dryRunCoordinatorRelaySpendUsd) ||
    dryRun.status !== 'ready',
  );
  if (invalidProviderDryRun) {
    holdReasons.push(`publisher-payout-provider-dry-run-invalid: ${invalidProviderDryRun.providerDryRunId || 'unknown'}`);
  }
  const liveMoneyMovement = input.payoutDryRunEvidence.providerDryRuns.find((dryRun) => dryRun.liveMoneyMovementTriggered);
  if (liveMoneyMovement) {
    holdReasons.push(`publisher-payout-dry-run-triggered-live-money-movement: ${liveMoneyMovement.providerDryRunId}`);
  }

  if (!nearlyEqual(
    input.payoutDryRunReconciliation.providerDryRunPayoutUsd,
    input.payoutDryRunReconciliation.ledgerPayoutBatchUsd,
  )) {
    holdReasons.push('publisher-payout-dry-run-total-does-not-match-ledger-payout-batch-total');
  }
  if (!nearlyEqual(
    input.payoutDryRunReconciliation.providerDryRunCoordinatorRelaySpendUsd,
    input.payoutDryRunReconciliation.ledgerCoordinatorRelaySpendUsd,
  )) {
    holdReasons.push('publisher-payout-dry-run-relay-spend-does-not-match-ledger-payout-batch-total');
  }

  const payablePublisherIds = new Set(
    input.ledgerReport.ledgerEntries
      .filter((entry) => entry.decision === 'payable')
      .map((entry) => entry.publisherId),
  );
  const missingTaxInvoicePublisherId = [...payablePublisherIds].find((publisherId) =>
    !input.payoutDryRunEvidence.taxInvoiceMetadata.some((metadata) =>
      metadata.publisherId === publisherId &&
      metadata.taxProfileId.length > 0 &&
      metadata.taxFormStatus === 'valid' &&
      metadata.invoiceId.length > 0 &&
      metadata.invoiceStatus === 'ready-for-review' &&
      metadata.payoutCurrency === 'USD',
    ),
  );
  if (missingTaxInvoicePublisherId) {
    holdReasons.push(`publisher-payout-tax-invoice-metadata-missing-or-blocked: ${missingTaxInvoicePublisherId}`);
  }

  const missingOperatorApproval = input.payoutDryRunEvidence.providerDryRuns.find((dryRun) =>
    !input.payoutDryRunEvidence.operatorApprovals.some((approval) =>
      approval.batchId === dryRun.batchId &&
      approval.approvedBy.length > 0 &&
      isPositiveFinite(approval.approvedAtMs) &&
      approval.dryRunOnlyAttestation &&
      approval.blockerReasons.length === 0,
    ),
  );
  if (missingOperatorApproval) {
    holdReasons.push(`publisher-payout-operator-approval-missing-or-blocked: ${missingOperatorApproval.batchId}`);
  }

  const missingPublisherExport = [...payablePublisherIds].find((publisherId) => {
    const payablePublisherLedgerIds = input.ledgerReport.ledgerEntries
      .filter((entry) => entry.publisherId === publisherId && entry.decision === 'payable')
      .map((entry) => entry.immutableLedgerId);
    return !input.payoutDryRunEvidence.publisherFacingExports.some((publisherExport) =>
      publisherExport.publisherId === publisherId &&
      publisherExport.exportId.length > 0 &&
      isPositiveFinite(publisherExport.generatedAtMs) &&
      publisherExport.includesProviderDryRunId &&
      publisherExport.includesTaxInvoiceMetadata &&
      payablePublisherLedgerIds.every((entryId) => publisherExport.ledgerEntryIds.includes(entryId)),
    );
  });
  if (missingPublisherExport) {
    holdReasons.push(`publisher-payout-reconciliation-export-missing-or-incomplete: ${missingPublisherExport}`);
  }

  const leakedNetworkAttempt = input.payoutDryRunEvidence.networkAttempts.find((attempt) =>
    !input.payoutDryRunEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-payout-dry-run-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-payout-dry-run-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.payoutDryRunEvidence.allowedOrigins.every((origin) => input.payoutDryRunEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-payout-dry-run-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.payoutDryRunEvidence.sandboxFlags.length === 1 && input.payoutDryRunEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-payout-dry-run-sandbox-must-remain-allow-scripts-only');
  }
  if (input.payoutDryRunEvidence.coop !== 'same-origin' || input.payoutDryRunEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-payout-dry-run-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function reconcilePayoutDryRun(
  options: WorkersCoordinatorPublisherPayoutDryRunOptions,
): WorkersCoordinatorPublisherPayoutDryRunReport['payoutDryRunReconciliation'] {
  return {
    currency: 'USD',
    ledgerPayoutBatchUsd: options.ledgerReport.payoutBatchReconciliation.payoutBatchUsd,
    providerDryRunPayoutUsd: options.payoutDryRunEvidence.providerDryRuns
      .reduce((sum, dryRun) => sum + dryRun.dryRunPayoutUsd, 0),
    ledgerCoordinatorRelaySpendUsd: options.ledgerReport.payoutBatchReconciliation.coordinatorRelaySpendUsd,
    providerDryRunCoordinatorRelaySpendUsd: options.payoutDryRunEvidence.providerDryRuns
      .reduce((sum, dryRun) => sum + dryRun.dryRunCoordinatorRelaySpendUsd, 0),
    publisherLevelHolds: options.payoutDryRunEvidence.publisherLevelHolds,
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherPayoutDryRunEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('tax-invoice')) {
    return ['publisher-tax-invoice-review-workflow'];
  }
  if (failureReason?.includes('operator-approval')) {
    return ['publisher-payout-operator-approval-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-payout-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-payout-dry-run-failure: ${failureReason}`];
  }
  return ['publisher-reward-live-money-payout-pilot'];
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

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000_001;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
