import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorProductionWorkerFleetSloCostReport,
} from './workers-coordinator-production-worker-fleet-slo-cost.js';

export interface WorkersCoordinatorPublisherRewardAccrualInput {
  readonly publisherId: string;
  readonly optedInWorkerId: string;
  readonly segmentId: string;
  readonly checkpointClaimId: string;
  readonly signedRunnerExecutionId: string;
  readonly verifiedContributionMs: number;
  readonly rewardUsd: number;
}

export interface WorkersCoordinatorPublisherCheckpointSettlementClaim {
  readonly claimId: string;
  readonly checkpointKey: string;
  readonly coordinatorRelayUrl: string;
  readonly relayOwner: 'coordinator-storage' | 'worker-direct' | 'unknown';
  readonly replayNonce: string;
  readonly observedAtMs: number;
}

export interface WorkersCoordinatorPublisherSignedRunnerSettlementLink {
  readonly executionId: string;
  readonly runnerUrl: string;
  readonly segmentId: string;
  readonly signatureVerified: boolean;
  readonly workerAttestationState: 'verified' | 'spoofed' | 'missing';
  readonly topLevelDomAccessed: boolean;
  readonly topLevelCookieAccessed: boolean;
  readonly topLevelStorageAccessed: boolean;
}

export interface WorkersCoordinatorPublisherSettlementBudget {
  readonly currency: 'USD';
  readonly accruedRewardUsd: number;
  readonly maxRewardUsd: number;
  readonly coordinatorRelaySpendUsd: number;
  readonly maxCoordinatorRelaySpendUsd: number;
}

export interface WorkersCoordinatorPublisherSettlementAbuseDetection {
  readonly spoofedWorkerClaims: readonly string[];
  readonly replayedCheckpointClaims: readonly string[];
  readonly duplicateSegmentContributionClaims: readonly string[];
  readonly costShiftingClaims: readonly string[];
}

export interface WorkersCoordinatorPublisherSettlementEvidence {
  readonly source: 'publisher-reward-settlement-aggregation';
  readonly capturedAtMs: number;
  readonly rewardAccrualInputs: readonly WorkersCoordinatorPublisherRewardAccrualInput[];
  readonly checkpointClaims: readonly WorkersCoordinatorPublisherCheckpointSettlementClaim[];
  readonly signedRunnerExecutionLinks: readonly WorkersCoordinatorPublisherSignedRunnerSettlementLink[];
  readonly settlementBudget: WorkersCoordinatorPublisherSettlementBudget;
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorPublisherRewardSettlementOptions {
  readonly fleetSloCostReport: WorkersCoordinatorProductionWorkerFleetSloCostReport;
  readonly settlementEvidence: WorkersCoordinatorPublisherSettlementEvidence;
}

export interface WorkersCoordinatorPublisherRewardSettlementReport {
  readonly runtime: 'publisher-reward-abuse-resistant-settlement-gate';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly rewardAccrualInputs: readonly WorkersCoordinatorPublisherRewardAccrualInput[];
  readonly checkpointRelayEvidence: readonly WorkersCoordinatorPublisherCheckpointSettlementClaim[];
  readonly signedRunnerExecutionLinkage: readonly WorkersCoordinatorPublisherSignedRunnerSettlementLink[];
  readonly abuseDetectionResults: WorkersCoordinatorPublisherSettlementAbuseDetection;
  readonly publisherSettlementHoldReasons: readonly string[];
  readonly settlementBudget: WorkersCoordinatorPublisherSettlementBudget;
  readonly promoteHoldThresholds: {
    readonly decision: 'promote' | 'hold';
    readonly promoteWhen: readonly string[];
    readonly holdReasons: readonly string[];
  };
  readonly securityBoundaryDuringSettlement: {
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

export function runWorkersCoordinatorPublisherRewardSettlementGate(
  options: WorkersCoordinatorPublisherRewardSettlementOptions,
): WorkersCoordinatorPublisherRewardSettlementReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.settlementEvidence);
  const abuseDetectionResults = detectSettlementAbuse(options.settlementEvidence);
  const holdReasons = selectHoldReasons({
    fleetSloCostReport: options.fleetSloCostReport,
    settlementEvidence: options.settlementEvidence,
    abuseDetectionResults,
    blockedNonCoordinatorCdnNetworkAttempt,
  });
  const failureReason = holdReasons[0];

  return {
    runtime: 'publisher-reward-abuse-resistant-settlement-gate',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.fleetSloCostReport.previewRunnerUrl,
    rewardAccrualInputs: options.settlementEvidence.rewardAccrualInputs,
    checkpointRelayEvidence: options.settlementEvidence.checkpointClaims,
    signedRunnerExecutionLinkage: options.settlementEvidence.signedRunnerExecutionLinks,
    abuseDetectionResults,
    publisherSettlementHoldReasons: holdReasons,
    settlementBudget: options.settlementEvidence.settlementBudget,
    promoteHoldThresholds: {
      decision: holdReasons.length === 0 ? 'promote' : 'hold',
      promoteWhen: [
        'production worker fleet SLO and cost gate has already passed',
        'each reward accrual input links to Coordinator-owned checkpoint relay evidence',
        'each reward accrual input links to verified signed runner execution evidence',
        'spoofed workers, replayed checkpoint claims, duplicate segment claims, and cost shifting are absent',
        'settlement reward and Coordinator relay spend stay inside budget',
        'signed runner isolation and Coordinator/CDN network allowlist remain intact',
      ],
      holdReasons,
    },
    securityBoundaryDuringSettlement: {
      cspConnectSrc: options.settlementEvidence.cspConnectSrc,
      sandboxFlags: options.settlementEvidence.sandboxFlags,
      coop: options.settlementEvidence.coop,
      coep: options.settlementEvidence.coep,
      allowedOrigins: options.settlementEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectHoldReasons(input: {
  readonly fleetSloCostReport: WorkersCoordinatorProductionWorkerFleetSloCostReport;
  readonly settlementEvidence: WorkersCoordinatorPublisherSettlementEvidence;
  readonly abuseDetectionResults: WorkersCoordinatorPublisherSettlementAbuseDetection;
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): readonly string[] {
  if (input.fleetSloCostReport.status === 'fail') {
    return [`fleet-slo-cost-gate-not-clean: ${input.fleetSloCostReport.failureReason ?? 'unknown'}`];
  }
  if (input.settlementEvidence.source !== 'publisher-reward-settlement-aggregation') {
    return ['publisher-settlement-must-use-settlement-aggregation-evidence'];
  }
  if (input.settlementEvidence.rewardAccrualInputs.length === 0) {
    return ['publisher-reward-accrual-inputs-missing'];
  }

  const holdReasons: string[] = [];
  const invalidRewardInput = input.settlementEvidence.rewardAccrualInputs.find((rewardInput) =>
    rewardInput.publisherId.length === 0 ||
    rewardInput.optedInWorkerId.length === 0 ||
    rewardInput.segmentId.length === 0 ||
    rewardInput.checkpointClaimId.length === 0 ||
    rewardInput.signedRunnerExecutionId.length === 0 ||
    !isPositiveFinite(rewardInput.verifiedContributionMs) ||
    !isNonNegativeFinite(rewardInput.rewardUsd),
  );
  if (invalidRewardInput) {
    holdReasons.push(`publisher-reward-accrual-input-invalid: ${invalidRewardInput.publisherId || 'unknown'}`);
  }

  const missingCheckpointClaim = input.settlementEvidence.rewardAccrualInputs.find((rewardInput) =>
    !input.settlementEvidence.checkpointClaims.some((claim) =>
      claim.claimId === rewardInput.checkpointClaimId &&
      claim.relayOwner === 'coordinator-storage' &&
      originAllowed(input.settlementEvidence, claim.coordinatorRelayUrl),
    ),
  );
  if (missingCheckpointClaim) {
    holdReasons.push(`publisher-reward-missing-coordinator-checkpoint-relay: ${missingCheckpointClaim.checkpointClaimId}`);
  }

  const missingSignedRunnerExecution = input.settlementEvidence.rewardAccrualInputs.find((rewardInput) =>
    !input.settlementEvidence.signedRunnerExecutionLinks.some((link) =>
      link.executionId === rewardInput.signedRunnerExecutionId &&
      link.segmentId === rewardInput.segmentId &&
      link.signatureVerified &&
      link.workerAttestationState === 'verified' &&
      !link.topLevelDomAccessed &&
      !link.topLevelCookieAccessed &&
      !link.topLevelStorageAccessed,
    ),
  );
  if (missingSignedRunnerExecution) {
    holdReasons.push(`publisher-reward-missing-verified-signed-runner-execution: ${missingSignedRunnerExecution.signedRunnerExecutionId}`);
  }

  if (input.abuseDetectionResults.spoofedWorkerClaims.length > 0) {
    holdReasons.push(`publisher-settlement-spoofed-worker-claims: ${input.abuseDetectionResults.spoofedWorkerClaims.join(',')}`);
  }
  if (input.abuseDetectionResults.replayedCheckpointClaims.length > 0) {
    holdReasons.push(`publisher-settlement-replayed-checkpoint-claims: ${input.abuseDetectionResults.replayedCheckpointClaims.join(',')}`);
  }
  if (input.abuseDetectionResults.duplicateSegmentContributionClaims.length > 0) {
    holdReasons.push(
      `publisher-settlement-duplicate-segment-contribution-claims: ${input.abuseDetectionResults.duplicateSegmentContributionClaims.join(',')}`,
    );
  }
  if (input.abuseDetectionResults.costShiftingClaims.length > 0) {
    holdReasons.push(`publisher-settlement-cost-shifting-claims: ${input.abuseDetectionResults.costShiftingClaims.join(',')}`);
  }

  const rewardSumUsd = input.settlementEvidence.rewardAccrualInputs.reduce((sum, rewardInput) => sum + rewardInput.rewardUsd, 0);
  if (
    input.settlementEvidence.settlementBudget.currency !== 'USD' ||
    !isNonNegativeFinite(input.settlementEvidence.settlementBudget.accruedRewardUsd) ||
    !isNonNegativeFinite(input.settlementEvidence.settlementBudget.maxRewardUsd) ||
    !isNonNegativeFinite(input.settlementEvidence.settlementBudget.coordinatorRelaySpendUsd) ||
    !isNonNegativeFinite(input.settlementEvidence.settlementBudget.maxCoordinatorRelaySpendUsd) ||
    input.settlementEvidence.settlementBudget.accruedRewardUsd > input.settlementEvidence.settlementBudget.maxRewardUsd ||
    input.settlementEvidence.settlementBudget.coordinatorRelaySpendUsd >
      input.settlementEvidence.settlementBudget.maxCoordinatorRelaySpendUsd ||
    Math.abs(rewardSumUsd - input.settlementEvidence.settlementBudget.accruedRewardUsd) > 0.000_001
  ) {
    holdReasons.push('publisher-settlement-reward-or-relay-spend-over-budget');
  }

  if (!input.settlementEvidence.allowedOrigins.every((origin) => input.settlementEvidence.cspConnectSrc.includes(origin))) {
    holdReasons.push('publisher-settlement-csp-connect-src-missing-coordinator-or-cdn-origin');
  }
  if (!(input.settlementEvidence.sandboxFlags.length === 1 && input.settlementEvidence.sandboxFlags[0] === 'allow-scripts')) {
    holdReasons.push('publisher-settlement-sandbox-must-remain-allow-scripts-only');
  }
  if (input.settlementEvidence.coop !== 'same-origin' || input.settlementEvidence.coep !== 'require-corp') {
    holdReasons.push('publisher-settlement-cross-origin-isolation-lost');
  }
  const leakedNetworkAttempt = input.settlementEvidence.networkAttempts.find((attempt) =>
    !input.settlementEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    holdReasons.push(`publisher-settlement-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`);
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    holdReasons.push('publisher-settlement-missing-blocked-non-coordinator-cdn-network-attempt');
  }
  return holdReasons;
}

function detectSettlementAbuse(
  evidence: WorkersCoordinatorPublisherSettlementEvidence,
): WorkersCoordinatorPublisherSettlementAbuseDetection {
  const checkpointClaimsByNonce = groupDuplicateKeys(evidence.checkpointClaims, (claim) => claim.replayNonce);
  const rewardInputsByPublisherSegment = groupDuplicateKeys(
    evidence.rewardAccrualInputs,
    (rewardInput) => `${rewardInput.publisherId}:${rewardInput.segmentId}`,
  );
  const spoofedWorkerClaims = evidence.signedRunnerExecutionLinks
    .filter((link) => link.workerAttestationState !== 'verified' || !link.signatureVerified)
    .map((link) => link.executionId);
  const replayedCheckpointClaims = evidence.checkpointClaims
    .filter((claim) => checkpointClaimsByNonce.has(claim.replayNonce))
    .map((claim) => claim.claimId);
  const duplicateSegmentContributionClaims = evidence.rewardAccrualInputs
    .filter((rewardInput) => rewardInputsByPublisherSegment.has(`${rewardInput.publisherId}:${rewardInput.segmentId}`))
    .map((rewardInput) => rewardInput.checkpointClaimId);
  const costShiftingClaims = evidence.rewardAccrualInputs
    .filter((rewardInput) => {
      const claim = evidence.checkpointClaims.find((candidate) => candidate.claimId === rewardInput.checkpointClaimId);
      return !claim || claim.relayOwner !== 'coordinator-storage' || !originAllowed(evidence, claim.coordinatorRelayUrl);
    })
    .map((rewardInput) => rewardInput.checkpointClaimId);

  return {
    spoofedWorkerClaims,
    replayedCheckpointClaims,
    duplicateSegmentContributionClaims,
    costShiftingClaims,
  };
}

function groupDuplicateKeys<T>(items: readonly T[], keyOf: (item: T) => string): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      duplicates.add(key);
    }
    seen.add(key);
  }
  return duplicates;
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorPublisherSettlementEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.includes('spoofed-worker')) {
    return ['publisher-settlement-worker-attestation-hardening'];
  }
  if (failureReason?.includes('replayed-checkpoint')) {
    return ['publisher-settlement-checkpoint-replay-hardening'];
  }
  if (failureReason?.includes('duplicate-segment')) {
    return ['publisher-settlement-duplicate-contribution-hardening'];
  }
  if (failureReason?.includes('cost-shifting')) {
    return ['publisher-settlement-cost-shifting-hardening'];
  }
  if (failureReason) {
    return [`publisher-reward-settlement-failure: ${failureReason}`];
  }
  return ['publisher-reward-pilot-ledger-and-payout-reconciliation'];
}

function originAllowed(evidence: WorkersCoordinatorPublisherSettlementEvidence, url: string): boolean {
  return evidence.allowedOrigins.includes(originOf(url));
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
