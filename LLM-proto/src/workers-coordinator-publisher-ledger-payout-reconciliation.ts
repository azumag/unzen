import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorPublisherRewardAccrualInput,
  WorkersCoordinatorPublisherSettlementAbuseDetection,
  WorkersCoordinatorPublisherRewardSettlementReport,
} from './workers-coordinator-publisher-reward-settlement.js';

export interface WorkersCoordinatorPublisherPilotLedgerEntry {
  readonly immutableLedgerId: string;
  readonly publisherId: string;
  readonly segmentId: string;
  readonly checkpointClaimId: string;
  readonly signedRunnerExecutionId: string;
  readonly rewardUsd: number;
  readonly decision: 'payable' | 'held';
  readonly decisionMetadata: {
    readonly decidedAtMs: number;
    readonly settlementRuntime: 'publisher-reward-abuse-resistant-settlement-gate';
    readonly reviewer: 'coordinator-payout-reconciliation';
    readonly holdReasons: readonly string[];
  };
}

export interface WorkersCoordinatorPublisherPayoutBatch {
  readonly batchId: string;
  readonly createdAtMs: number;
  readonly currency: 'USD';
  readonly ledgerEntryIds: readonly string[];
  readonly payoutUsd: number;
  readonly coordinatorRelaySpendUsd: number;
  readonly status: 'ready' | 'held';
}

export interface WorkersCoordinatorPublisherLevelHold {
  readonly publisherId: string;
  readonly reason: string;
  readonly ledgerEntryIds: readonly string[];
}

export interface WorkersCoordinatorPublisherPilotDisputeEvidence {
  readonly publisherId: string;
  readonly ledgerEntryId: string;
  readonly checkpointClaimId: string;
  readonly signedRunnerExecutionId: string;
  readonly settlementHoldReasons: readonly string[];
  readonly abuseDetections: WorkersCoordinatorPublisherSettlementAbuseDetection;
  readonly checkpointRelayLinked: boolean;
  readonly signedRunnerExecutionLinked: boolean;
}

export interface WorkersCoordinatorPublisherPilotLedgerEvidence {
  readonly source: 'publisher-reward-pilot-ledger';
  readonly capturedAtMs: number;
  readonly ledgerEntries: readonly WorkersCoordinatorPublisherPilotLedgerEntry[];
  readonly payoutBatches: readonly WorkersCoordinatorPublisherPayoutBatch[];
  readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  readonly disputeEvidence: readonly WorkersCoordinatorPublisherPilotDisputeEvidence[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherPilotLedgerOptions {
  readonly settlementReport: WorkersCoordinatorPublisherRewardSettlementReport;
  readonly ledgerEvidence: WorkersCoordinatorPublisherPilotLedgerEvidence;
}

export interface WorkersCoordinatorPublisherPilotLedgerReport {
  readonly runtime: 'publisher-reward-pilot-ledger-payout-reconciliation-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly ledgerEntries: readonly WorkersCoordinatorPublisherPilotLedgerEntry[];
  readonly payoutBatchReconciliation: {
    readonly currency: 'USD';
    readonly accruedRewardUsd: number;
    readonly ledgerRewardUsd: number;
    readonly payoutBatchUsd: number;
    readonly heldRewardUsd: number;
    readonly coordinatorRelaySpendUsd: number;
    readonly settlementCoordinatorRelaySpendUsd: number;
    readonly publisherLevelHolds: readonly WorkersCoordinatorPublisherLevelHold[];
  };
  readonly rewardAccrualTotals: readonly {
    readonly publisherId: string;
    readonly rewardUsd: number;
    readonly payableUsd: number;
    readonly heldUsd: number;
  }[];
  readonly disputeEvidence: readonly WorkersCoordinatorPublisherPilotDisputeEvidence[];
  readonly settlementHoldReasons: readonly string[];
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringLedgerReconciliation: {
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

export function runWorkersCoordinatorPublisherPilotLedgerGate(
  options: WorkersCoordinatorPublisherPilotLedgerOptions,
): WorkersCoordinatorPublisherPilotLedgerReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.ledgerEvidence);
  const payoutBatchReconciliation = reconcilePayoutBatches(options);
  const rewardAccrualTotals = summarizeRewardAccrualTotals(options.ledgerEvidence.ledgerEntries);
  const holdReasons = selectHoldReasons({
    ...options,
    payoutBatchReconciliation,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-pilot-ledger-payout-reconciliation-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.settlementReport.previewRunnerUrl,
    ledgerEntries: options.ledgerEvidence.ledgerEntries,
    payoutBatchReconciliation,
    rewardAccrualTotals,
    disputeEvidence: options.ledgerEvidence.disputeEvidence,
    settlementHoldReasons: [
      ...options.settlementReport.publisherSettlementHoldReasons,
      ...options.ledgerEvidence.publisherLevelHolds.map((hold) => `${hold.publisherId}: ${hold.reason}`),
    ],
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'publisher reward settlement gate has already passed',
        'each reward accrual input is persisted as one immutable pilot ledger entry',
        'ledger reward totals reconcile to settlement accrual totals',
        'payout batches exclude publisher-level holds and match payable ledger totals',
        'Coordinator relay spend reconciles to the settlement budget',
        'dispute evidence links ledger entries to checkpoint and signed runner evidence',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringLedgerReconciliation: {
      cspConnectSrc: options.ledgerEvidence.cspConnectSrc,
      sandboxFlags: options.ledgerEvidence.sandboxFlags,
      coop: options.ledgerEvidence.coop,
      coep: options.ledgerEvidence.coep,
      allowedOrigins: options.ledgerEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: WorkersCoordinatorPublisherPilotLedgerOptions & {
  readonly payoutBatchReconciliation: WorkersCoordinatorPublisherPilotLedgerReport['payoutBatchReconciliation'];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.settlementReport.status === 'fail') {
    return [`publisher-settlement-gate-not-clean: ${input.settlementReport.failureReason ?? 'unknown'}`];
  }
  if (input.ledgerEvidence.source !== 'publisher-reward-pilot-ledger') {
    return ['publisher-ledger-must-use-pilot-ledger-evidence'];
  }
  if (input.ledgerEvidence.ledgerEntries.length === 0) {
    return ['publisher-ledger-entries-missing'];
  }

  const holdReasons: string[] = [];
  const duplicateLedgerId = findDuplicate(input.ledgerEvidence.ledgerEntries.map((entry) => entry.immutableLedgerId));
  if (duplicateLedgerId) {
    holdReasons.push(`publisher-ledger-immutable-id-duplicated: ${duplicateLedgerId}`);
  }

  const missingLedgerEntry = input.settlementReport.rewardAccrualInputs.find((rewardInput) =>
    !input.ledgerEvidence.ledgerEntries.some((entry) => ledgerEntryMatchesRewardInput(entry, rewardInput)),
  );
  if (missingLedgerEntry) {
    holdReasons.push(`publisher-ledger-missing-reward-accrual: ${missingLedgerEntry.checkpointClaimId}`);
  }

  const invalidLedgerEntry = input.ledgerEvidence.ledgerEntries.find((entry) =>
    entry.immutableLedgerId.length === 0 ||
    entry.publisherId.length === 0 ||
    entry.segmentId.length === 0 ||
    entry.checkpointClaimId.length === 0 ||
    entry.signedRunnerExecutionId.length === 0 ||
    !isNonNegativeFinite(entry.rewardUsd) ||
    !isPositiveFinite(entry.decisionMetadata.decidedAtMs) ||
    entry.decisionMetadata.settlementRuntime !== input.settlementReport.runtime ||
    entry.decisionMetadata.reviewer !== 'coordinator-payout-reconciliation' ||
    (entry.decision === 'held' && entry.decisionMetadata.holdReasons.length === 0) ||
    (entry.decision === 'payable' && entry.decisionMetadata.holdReasons.length > 0)
  );
  if (invalidLedgerEntry) {
    holdReasons.push(`publisher-ledger-entry-invalid: ${invalidLedgerEntry.immutableLedgerId || 'unknown'}`);
  }

  if (!nearlyEqual(input.payoutBatchReconciliation.ledgerRewardUsd, input.settlementReport.settlementBudget.accruedRewardUsd)) {
    holdReasons.push('publisher-ledger-reward-total-does-not-match-settlement-accrual');
  }
  if (!nearlyEqual(
    input.payoutBatchReconciliation.coordinatorRelaySpendUsd,
    input.settlementReport.settlementBudget.coordinatorRelaySpendUsd,
  )) {
    holdReasons.push('publisher-ledger-relay-spend-does-not-match-settlement-budget');
  }

  const payableEntryIds = new Set(
    input.ledgerEvidence.ledgerEntries
      .filter((entry) => entry.decision === 'payable')
      .map((entry) => entry.immutableLedgerId),
  );
  const heldEntryIds = new Set(
    input.ledgerEvidence.ledgerEntries
      .filter((entry) => entry.decision === 'held')
      .map((entry) => entry.immutableLedgerId),
  );
  const batchedLedgerEntryIds = input.ledgerEvidence.payoutBatches.flatMap((batch) => batch.ledgerEntryIds);
  const duplicateBatchedEntryId = findDuplicate(batchedLedgerEntryIds);
  if (duplicateBatchedEntryId) {
    holdReasons.push(`publisher-ledger-entry-duplicated-across-payout-batches: ${duplicateBatchedEntryId}`);
  }
  const unknownBatchedEntryId = batchedLedgerEntryIds.find((entryId) =>
    !payableEntryIds.has(entryId) && !heldEntryIds.has(entryId),
  );
  if (unknownBatchedEntryId) {
    holdReasons.push(`publisher-ledger-payout-batch-references-unknown-entry: ${unknownBatchedEntryId}`);
  }
  const batchedHeldEntryId = batchedLedgerEntryIds.find((entryId) => heldEntryIds.has(entryId));
  if (batchedHeldEntryId) {
    holdReasons.push(`publisher-ledger-held-entry-in-payout-batch: ${batchedHeldEntryId}`);
  }
  const missingPayableEntryId = [...payableEntryIds].find((entryId) =>
    !input.ledgerEvidence.payoutBatches.some((batch) => batch.ledgerEntryIds.includes(entryId)),
  );
  if (missingPayableEntryId) {
    holdReasons.push(`publisher-ledger-payable-entry-missing-from-payout-batch: ${missingPayableEntryId}`);
  }

  const payableUsd = input.ledgerEvidence.ledgerEntries
    .filter((entry) => entry.decision === 'payable')
    .reduce((sum, entry) => sum + entry.rewardUsd, 0);
  if (!nearlyEqual(input.payoutBatchReconciliation.payoutBatchUsd, payableUsd)) {
    holdReasons.push('publisher-ledger-payout-batch-total-does-not-match-payable-ledger-total');
  }

  const invalidBatch = input.ledgerEvidence.payoutBatches.find((batch) =>
    batch.batchId.length === 0 ||
    batch.currency !== 'USD' ||
    !isPositiveFinite(batch.createdAtMs) ||
    !isNonNegativeFinite(batch.payoutUsd) ||
    !isNonNegativeFinite(batch.coordinatorRelaySpendUsd) ||
    (batch.status === 'ready' && batch.ledgerEntryIds.length === 0),
  );
  if (invalidBatch) {
    holdReasons.push(`publisher-ledger-payout-batch-invalid: ${invalidBatch.batchId || 'unknown'}`);
  }

  const missingDisputeEvidence = input.ledgerEvidence.ledgerEntries.find((entry) =>
    !input.ledgerEvidence.disputeEvidence.some((evidence) =>
      evidence.ledgerEntryId === entry.immutableLedgerId &&
      evidence.publisherId === entry.publisherId &&
      evidence.checkpointClaimId === entry.checkpointClaimId &&
      evidence.signedRunnerExecutionId === entry.signedRunnerExecutionId &&
      evidence.checkpointRelayLinked &&
      evidence.signedRunnerExecutionLinked,
    ),
  );
  if (missingDisputeEvidence) {
    holdReasons.push(`publisher-ledger-dispute-evidence-missing-linkage: ${missingDisputeEvidence.immutableLedgerId}`);
  }

  const leakedNetworkAttempt = input.ledgerEvidence.networkAttempts.find((attempt) =>
    !input.ledgerEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-ledger-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-ledger-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  if (!input.ledgerEvidence.allowedOrigins.every((origin) => input.ledgerEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-ledger-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.ledgerEvidence.sandboxFlags.length === 1 && input.ledgerEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-ledger-sandbox-must-remain-allow-scripts-only');
  }
  if (input.ledgerEvidence.coop !== 'same-origin' || input.ledgerEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-ledger-cross-origin-isolation-lost');
  }

  return holdReasons;
}

function reconcilePayoutBatches(
  options: WorkersCoordinatorPublisherPilotLedgerOptions,
): WorkersCoordinatorPublisherPilotLedgerReport['payoutBatchReconciliation'] {
  const ledgerRewardUsd = options.ledgerEvidence.ledgerEntries.reduce((sum, entry) => sum + entry.rewardUsd, 0);
  const payoutBatchUsd = options.ledgerEvidence.payoutBatches.reduce((sum, batch) => sum + batch.payoutUsd, 0);
  const coordinatorRelaySpendUsd = options.ledgerEvidence.payoutBatches
    .reduce((sum, batch) => sum + batch.coordinatorRelaySpendUsd, 0);
  const heldRewardUsd = options.ledgerEvidence.ledgerEntries
    .filter((entry) => entry.decision === 'held')
    .reduce((sum, entry) => sum + entry.rewardUsd, 0);

  return {
    currency: 'USD',
    accruedRewardUsd: options.settlementReport.settlementBudget.accruedRewardUsd,
    ledgerRewardUsd,
    payoutBatchUsd,
    heldRewardUsd,
    coordinatorRelaySpendUsd,
    settlementCoordinatorRelaySpendUsd: options.settlementReport.settlementBudget.coordinatorRelaySpendUsd,
    publisherLevelHolds: options.ledgerEvidence.publisherLevelHolds,
  };
}

function summarizeRewardAccrualTotals(
  ledgerEntries: readonly WorkersCoordinatorPublisherPilotLedgerEntry[],
): WorkersCoordinatorPublisherPilotLedgerReport['rewardAccrualTotals'] {
  const totals = new Map<string, { rewardUsd: number; payableUsd: number; heldUsd: number }>();
  for (const entry of ledgerEntries) {
    const current = totals.get(entry.publisherId) ?? { rewardUsd: 0, payableUsd: 0, heldUsd: 0 };
    current.rewardUsd += entry.rewardUsd;
    if (entry.decision === 'payable') {
      current.payableUsd += entry.rewardUsd;
    } else {
      current.heldUsd += entry.rewardUsd;
    }
    totals.set(entry.publisherId, current);
  }
  return [...totals.entries()].map(([publisherId, total]) => ({ publisherId, ...total }));
}

function ledgerEntryMatchesRewardInput(
  entry: WorkersCoordinatorPublisherPilotLedgerEntry,
  rewardInput: WorkersCoordinatorPublisherRewardAccrualInput,
): boolean {
  return entry.publisherId === rewardInput.publisherId &&
    entry.segmentId === rewardInput.segmentId &&
    entry.checkpointClaimId === rewardInput.checkpointClaimId &&
    entry.signedRunnerExecutionId === rewardInput.signedRunnerExecutionId &&
    nearlyEqual(entry.rewardUsd, rewardInput.rewardUsd);
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherPilotLedgerEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('payout-batch')) {
    return ['publisher-payout-batch-reconciliation-hardening'];
  }
  if (failureReason?.includes('dispute-evidence')) {
    return ['publisher-dispute-evidence-review-workflow'];
  }
  if (failureReason?.includes('network-attempt') || failureReason?.includes('cross-origin')) {
    return ['publisher-ledger-security-boundary-hardening'];
  }
  if (failureReason) {
    return [`publisher-reward-pilot-ledger-failure: ${failureReason}`];
  }
  return ['publisher-reward-real-money-payout-pilot'];
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
