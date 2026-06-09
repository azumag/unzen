import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherLevelHold,
} from './workers-coordinator-publisher-ledger-payout-reconciliation.js';
import type {
  WorkersCoordinatorPublisherPayoutDryRunReport,
} from './workers-coordinator-publisher-payout-dry-run.js';

export interface WorkersCoordinatorPublisherOperatorReleaseSwitchEvidence {
  readonly batchId: string;
  readonly releaseSwitchId: string;
  readonly enabledBy: string;
  readonly enabledAtMs: number;
  readonly liveMoneyPilotAttestation: boolean;
  readonly maxPilotPayoutUsd: number;
  readonly emergencyStopArmed: boolean;
  readonly controlledOutsideSignedRunner: boolean;
  readonly blockerReasons: readonly string[];
}

export interface WorkersCoordinatorPublisherProviderSettlementCallback {
  readonly providerPayoutId: string;
  readonly providerDryRunId: string;
  readonly batchId: string;
  readonly ledgerEntryIds: readonly string[];
  readonly currency: 'USD';
  readonly settledPayoutUsd: number;
  readonly settledCoordinatorRelaySpendUsd: number;
  readonly status: 'succeeded' | 'pending' | 'failed';
  readonly receivedAtMs: number;
}

export interface WorkersCoordinatorPublisherReceiptEvidence {
  readonly publisherId: string;
  readonly receiptId: string;
  readonly providerPayoutId: string;
  readonly deliveredAtMs: number;
  readonly ledgerEntryIds: readonly string[];
  readonly includesProviderSettlementCallback: boolean;
  readonly includesTaxInvoiceMetadata: boolean;
}

export interface WorkersCoordinatorPublisherPayoutStatusTransition {
  readonly ledgerEntryId: string;
  readonly from: 'dry-run-ready' | 'submitted' | 'held';
  readonly to: 'submitted' | 'settled' | 'held';
  readonly providerPayoutId: string;
  readonly transitionedAtMs: number;
  readonly reason: string;
}

export interface WorkersCoordinatorPublisherEmergencyControlEvidence {
  readonly batchId: string;
  readonly emergencyHoldSwitchId: string;
  readonly rollbackPlanId: string;
  readonly controlledBy: string;
  readonly armedAtMs: number;
  readonly outsideSignedRunnerBoundary: boolean;
  readonly activeHoldReasons: readonly string[];
}

export interface WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence {
  readonly source: 'publisher-reward-live-money-payout-pilot';
  readonly capturedAtMs: number;
  readonly operatorReleaseSwitches: readonly WorkersCoordinatorPublisherOperatorReleaseSwitchEvidence[];
  readonly providerSettlementCallbacks: readonly WorkersCoordinatorPublisherProviderSettlementCallback[];
  readonly publisherReceipts: readonly WorkersCoordinatorPublisherReceiptEvidence[];
  readonly payoutStatusTransitions: readonly WorkersCoordinatorPublisherPayoutStatusTransition[];
  readonly emergencyControls: readonly WorkersCoordinatorPublisherEmergencyControlEvidence[];
  readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherLiveMoneyPayoutPilotOptions {
  readonly payoutDryRunReport: WorkersCoordinatorPublisherPayoutDryRunReport;
  readonly livePayoutEvidence: WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence;
}

export interface WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport {
  readonly runtime: 'publisher-reward-live-money-payout-pilot-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly operatorReleaseSwitchEvidence: readonly WorkersCoordinatorPublisherOperatorReleaseSwitchEvidence[];
  readonly providerSettlementCallbacks: readonly WorkersCoordinatorPublisherProviderSettlementCallback[];
  readonly livePayoutReconciliation: {
    readonly currency: 'USD';
    readonly dryRunProviderPayoutUsd: number;
    readonly settledProviderPayoutUsd: number;
    readonly ledgerPayoutBatchUsd: number;
    readonly dryRunCoordinatorRelaySpendUsd: number;
    readonly settledCoordinatorRelaySpendUsd: number;
    readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  };
  readonly publisherReceiptEvidence: readonly WorkersCoordinatorPublisherReceiptEvidence[];
  readonly payoutStatusTransitions: readonly WorkersCoordinatorPublisherPayoutStatusTransition[];
  readonly emergencyHoldRollbackControls: readonly WorkersCoordinatorPublisherEmergencyControlEvidence[];
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringLivePayout: {
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

export function runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate(
  options: WorkersCoordinatorPublisherLiveMoneyPayoutPilotOptions,
): WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.livePayoutEvidence);
  const livePayoutReconciliation = reconcileLivePayout(options);
  const holdReasons = selectHoldReasons({
    ...options,
    livePayoutReconciliation,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-live-money-payout-pilot-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.payoutDryRunReport.previewRunnerUrl,
    operatorReleaseSwitchEvidence: options.livePayoutEvidence.operatorReleaseSwitches,
    providerSettlementCallbacks: options.livePayoutEvidence.providerSettlementCallbacks,
    livePayoutReconciliation,
    publisherReceiptEvidence: options.livePayoutEvidence.publisherReceipts,
    payoutStatusTransitions: options.livePayoutEvidence.payoutStatusTransitions,
    emergencyHoldRollbackControls: options.livePayoutEvidence.emergencyControls,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher payout dry-run gate has already passed',
        'operator release switch is armed outside the signed runner boundary',
        'provider settlement callbacks match dry-run provider batch and ledger payout totals',
        'publisher-level holds stay excluded from the live payout batch',
        'publisher receipts include provider settlement, tax, and invoice evidence',
        'each payable ledger entry reaches a settled payout status transition',
        'emergency hold and rollback controls remain outside signed runner control',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringLivePayout: {
      cspConnectSrc: options.livePayoutEvidence.cspConnectSrc,
      sandboxFlags: options.livePayoutEvidence.sandboxFlags,
      coop: options.livePayoutEvidence.coop,
      coep: options.livePayoutEvidence.coep,
      allowedOrigins: options.livePayoutEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherLiveMoneyPayoutPilotOptions & {
  readonly livePayoutReconciliation: WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport['livePayoutReconciliation'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.payoutDryRunReport.status === 'fail') {
    return [`publisher-payout-dry-run-gate-not-clean: ${input.payoutDryRunReport.failureReason ?? 'unknown'}`];
  }
  if (input.livePayoutEvidence.source !== 'publisher-reward-live-money-payout-pilot') {
    return ['publisher-live-payout-must-use-live-money-pilot-evidence'];
  }
  if (input.livePayoutEvidence.operatorReleaseSwitches.length === 0) {
    return ['publisher-live-payout-operator-release-switch-missing'];
  }
  if (input.livePayoutEvidence.providerSettlementCallbacks.length === 0) {
    return ['publisher-live-payout-provider-settlement-callback-missing'];
  }

  const holdReasons: string[] = [];
  const dryRunLedgerEntryIds = input.payoutDryRunReport.payoutProviderDryRunEvidence
    .flatMap((dryRun) => dryRun.ledgerEntryIds);
  const dryRunLedgerEntryIdSet = new Set(dryRunLedgerEntryIds);
  const dryRunProviderIds = new Set(
    input.payoutDryRunReport.payoutProviderDryRunEvidence.map((dryRun) => dryRun.providerDryRunId),
  );
  const dryRunBatchIds = new Set(
    input.payoutDryRunReport.payoutProviderDryRunEvidence.map((dryRun) => dryRun.batchId),
  );
  const settledLedgerEntryIds = input.livePayoutEvidence.providerSettlementCallbacks
    .flatMap((callback) => callback.ledgerEntryIds);

  const invalidReleaseSwitch = input.livePayoutEvidence.operatorReleaseSwitches.find((releaseSwitch) =>
    releaseSwitch.releaseSwitchId.length === 0 ||
    releaseSwitch.batchId.length === 0 ||
    !dryRunBatchIds.has(releaseSwitch.batchId) ||
    releaseSwitch.enabledBy.length === 0 ||
    !isPositiveFinite(releaseSwitch.enabledAtMs) ||
    !releaseSwitch.liveMoneyPilotAttestation ||
    !isPositiveFinite(releaseSwitch.maxPilotPayoutUsd) ||
    releaseSwitch.maxPilotPayoutUsd < input.payoutDryRunReport.payoutDryRunReconciliation.providerDryRunPayoutUsd ||
    !releaseSwitch.emergencyStopArmed ||
    !releaseSwitch.controlledOutsideSignedRunner ||
    releaseSwitch.blockerReasons.length > 0,
  );
  if (invalidReleaseSwitch) {
    holdReasons.push(`publisher-live-payout-operator-release-switch-invalid: ${invalidReleaseSwitch.batchId || 'unknown'}`);
  }

  const duplicateSettledLedgerEntryId = findDuplicate(settledLedgerEntryIds);
  if (duplicateSettledLedgerEntryId) {
    holdReasons.push(`publisher-live-payout-ledger-entry-duplicated: ${duplicateSettledLedgerEntryId}`);
  }
  const unknownSettledLedgerEntryId = settledLedgerEntryIds.find((entryId) => !dryRunLedgerEntryIdSet.has(entryId));
  if (unknownSettledLedgerEntryId) {
    holdReasons.push(`publisher-live-payout-references-unknown-ledger-entry: ${unknownSettledLedgerEntryId}`);
  }
  const missingSettledLedgerEntryId = dryRunLedgerEntryIds.find((entryId) => !settledLedgerEntryIds.includes(entryId));
  if (missingSettledLedgerEntryId) {
    holdReasons.push(`publisher-live-payout-missing-dry-run-ledger-entry: ${missingSettledLedgerEntryId}`);
  }

  const invalidSettlementCallback = input.livePayoutEvidence.providerSettlementCallbacks.find((callback) =>
    callback.providerPayoutId.length === 0 ||
    !dryRunProviderIds.has(callback.providerDryRunId) ||
    !dryRunBatchIds.has(callback.batchId) ||
    callback.currency !== 'USD' ||
    callback.ledgerEntryIds.length === 0 ||
    !isNonNegativeFinite(callback.settledPayoutUsd) ||
    !isNonNegativeFinite(callback.settledCoordinatorRelaySpendUsd) ||
    callback.status !== 'succeeded' ||
    !isPositiveFinite(callback.receivedAtMs),
  );
  if (invalidSettlementCallback) {
    holdReasons.push(`publisher-live-payout-provider-settlement-callback-invalid: ${invalidSettlementCallback.providerPayoutId || 'unknown'}`);
  }

  if (!nearlyEqual(
    input.livePayoutReconciliation.settledProviderPayoutUsd,
    input.livePayoutReconciliation.dryRunProviderPayoutUsd,
  )) {
    holdReasons.push('publisher-live-payout-settlement-total-does-not-match-provider-dry-run-total');
  }
  if (!nearlyEqual(
    input.livePayoutReconciliation.settledProviderPayoutUsd,
    input.livePayoutReconciliation.ledgerPayoutBatchUsd,
  )) {
    holdReasons.push('publisher-live-payout-settlement-total-does-not-match-ledger-payout-batch-total');
  }
  if (!nearlyEqual(
    input.livePayoutReconciliation.settledCoordinatorRelaySpendUsd,
    input.livePayoutReconciliation.dryRunCoordinatorRelaySpendUsd,
  )) {
    holdReasons.push('publisher-live-payout-relay-spend-does-not-match-provider-dry-run-total');
  }

  const heldPublisherId = input.livePayoutEvidence.publisherLevelHolds.find((hold) => hold.reason.length > 0)?.publisherId;
  if (heldPublisherId) {
    holdReasons.push(`publisher-live-payout-publisher-level-hold-active: ${heldPublisherId}`);
  }

  const missingSettledTransition = dryRunLedgerEntryIds.find((entryId) =>
    !input.livePayoutEvidence.payoutStatusTransitions.some((transition) =>
      transition.ledgerEntryId === entryId &&
      transition.from === 'submitted' &&
      transition.to === 'settled' &&
      transition.providerPayoutId.length > 0 &&
      isPositiveFinite(transition.transitionedAtMs) &&
      transition.reason.length > 0,
    ),
  );
  if (missingSettledTransition) {
    holdReasons.push(`publisher-live-payout-status-transition-missing-or-not-settled: ${missingSettledTransition}`);
  }

  const missingPublisherReceipt = input.payoutDryRunReport.taxInvoiceMetadata.find((metadata) => {
    const publisherLedgerEntryIds = input.payoutDryRunReport.payoutProviderDryRunEvidence
      .flatMap((dryRun) => dryRun.ledgerEntryIds)
      .filter((entryId) => input.payoutDryRunReport.publisherFacingReconciliationExports
        .some((publisherExport) =>
          publisherExport.publisherId === metadata.publisherId &&
          publisherExport.ledgerEntryIds.includes(entryId),
        ));
    return !input.livePayoutEvidence.publisherReceipts.some((receipt) =>
      receipt.publisherId === metadata.publisherId &&
      receipt.receiptId.length > 0 &&
      receipt.providerPayoutId.length > 0 &&
      isPositiveFinite(receipt.deliveredAtMs) &&
      receipt.includesProviderSettlementCallback &&
      receipt.includesTaxInvoiceMetadata &&
      publisherLedgerEntryIds.every((entryId) => receipt.ledgerEntryIds.includes(entryId)),
    );
  })?.publisherId;
  if (missingPublisherReceipt) {
    holdReasons.push(`publisher-live-payout-publisher-receipt-missing-or-incomplete: ${missingPublisherReceipt}`);
  }

  const missingEmergencyControls = [...dryRunBatchIds].find((batchId) =>
    !input.livePayoutEvidence.emergencyControls.some((control) =>
      control.batchId === batchId &&
      control.emergencyHoldSwitchId.length > 0 &&
      control.rollbackPlanId.length > 0 &&
      control.controlledBy.length > 0 &&
      isPositiveFinite(control.armedAtMs) &&
      control.outsideSignedRunnerBoundary &&
      control.activeHoldReasons.length === 0,
    ),
  );
  if (missingEmergencyControls) {
    holdReasons.push(`publisher-live-payout-emergency-hold-rollback-controls-missing-or-active: ${missingEmergencyControls}`);
  }

  const leakedNetworkAttempt = input.livePayoutEvidence.networkAttempts.find((attempt) =>
    !input.livePayoutEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-live-payout-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-live-payout-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.livePayoutEvidence.allowedOrigins.every((origin) => input.livePayoutEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-live-payout-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.livePayoutEvidence.sandboxFlags.length === 1 && input.livePayoutEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-live-payout-sandbox-must-remain-allow-scripts-only');
  }
  if (input.livePayoutEvidence.coop !== 'same-origin' || input.livePayoutEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-live-payout-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function reconcileLivePayout(
  options: WorkersCoordinatorPublisherLiveMoneyPayoutPilotOptions,
): WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport['livePayoutReconciliation'] {
  return {
    currency: 'USD',
    dryRunProviderPayoutUsd: options.payoutDryRunReport.payoutDryRunReconciliation.providerDryRunPayoutUsd,
    settledProviderPayoutUsd: options.livePayoutEvidence.providerSettlementCallbacks
      .reduce((sum, callback) => sum + callback.settledPayoutUsd, 0),
    ledgerPayoutBatchUsd: options.payoutDryRunReport.payoutDryRunReconciliation.ledgerPayoutBatchUsd,
    dryRunCoordinatorRelaySpendUsd: options.payoutDryRunReport.payoutDryRunReconciliation.providerDryRunCoordinatorRelaySpendUsd,
    settledCoordinatorRelaySpendUsd: options.livePayoutEvidence.providerSettlementCallbacks
      .reduce((sum, callback) => sum + callback.settledCoordinatorRelaySpendUsd, 0),
    publisherLevelHolds: options.livePayoutEvidence.publisherLevelHolds,
  };
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('release-switch')) {
    return ['publisher-live-payout-operator-release-switch-workflow'];
  }
  if (failureReason?.includes('settlement-callback')) {
    return ['publisher-live-payout-provider-callback-reconciliation'];
  }
  if (failureReason?.includes('emergency-hold') || failureReason?.includes('rollback')) {
    return ['publisher-live-payout-emergency-control-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-live-payout-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-live-payout-failure: ${failureReason}`];
  }
  return ['publisher-reward-recurring-payout-operations'];
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
