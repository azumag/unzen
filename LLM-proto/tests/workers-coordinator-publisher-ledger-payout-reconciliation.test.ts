import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherRewardSettlementReport,
} from '../src/workers-coordinator-publisher-reward-settlement.js';
import {
  runWorkersCoordinatorPublisherPilotLedgerGate,
  type WorkersCoordinatorPublisherPilotLedgerEvidence,
} from '../src/workers-coordinator-publisher-ledger-payout-reconciliation.js';

function createSettlementReport(
  overrides: Partial<WorkersCoordinatorPublisherRewardSettlementReport> = {},
): WorkersCoordinatorPublisherRewardSettlementReport {
  const base: WorkersCoordinatorPublisherRewardSettlementReport = {
    runtime: 'publisher-reward-abuse-resistant-settlement-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    rewardAccrualInputs: [
      {
        publisherId: 'publisher:newsroom-a',
        optedInWorkerId: 'worker:attested-desktop-001',
        segmentId: 'segment-03',
        checkpointClaimId: 'claim:checkpoint:segment-03:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
        verifiedContributionMs: 8_900,
        rewardUsd: 4.25,
      },
      {
        publisherId: 'publisher:docs-b',
        optedInWorkerId: 'worker:attested-mobile-014',
        segmentId: 'segment-04',
        checkpointClaimId: 'claim:checkpoint:segment-04:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-04:001',
        verifiedContributionMs: 11_400,
        rewardUsd: 3.75,
      },
    ],
    checkpointRelayEvidence: [
      {
        claimId: 'claim:checkpoint:segment-03:001',
        checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-03',
        coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-03',
        relayOwner: 'coordinator-storage',
        replayNonce: 'nonce:segment-03:001',
        observedAtMs: 1_779_668_021_000,
      },
      {
        claimId: 'claim:checkpoint:segment-04:001',
        checkpointKey: 'checkpoint:signed-runner-webgpu-pilot:segment-04',
        coordinatorRelayUrl: 'https://coordinator.unzen.dev/checkpoints/settlement/segment-04',
        relayOwner: 'coordinator-storage',
        replayNonce: 'nonce:segment-04:001',
        observedAtMs: 1_779_668_023_000,
      },
    ],
    signedRunnerExecutionLinkage: [
      {
        executionId: 'exec:signed-runner:segment-03:001',
        runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
        segmentId: 'segment-03',
        signatureVerified: true,
        workerAttestationState: 'verified',
        topLevelDomAccessed: false,
        topLevelCookieAccessed: false,
        topLevelStorageAccessed: false,
      },
      {
        executionId: 'exec:signed-runner:segment-04:001',
        runnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
        segmentId: 'segment-04',
        signatureVerified: true,
        workerAttestationState: 'verified',
        topLevelDomAccessed: false,
        topLevelCookieAccessed: false,
        topLevelStorageAccessed: false,
      },
    ],
    abuseDetectionResults: {
      spoofedWorkerClaims: [],
      replayedCheckpointClaims: [],
      duplicateSegmentContributionClaims: [],
      costShiftingClaims: [],
    },
    publisherSettlementHoldReasons: [],
    settlementBudget: {
      currency: 'USD',
      accruedRewardUsd: 8,
      maxRewardUsd: 12,
      coordinatorRelaySpendUsd: 2.2,
      maxCoordinatorRelaySpendUsd: 5,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: [
        'each reward accrual input links to Coordinator-owned checkpoint relay evidence',
      ],
      holdReasons: [],
    },
    securityBoundaryDuringSettlement: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/settlement',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-pilot-ledger-and-payout-reconciliation'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createLedgerEvidence(
  overrides: Partial<WorkersCoordinatorPublisherPilotLedgerEvidence> = {},
): WorkersCoordinatorPublisherPilotLedgerEvidence {
  const base: WorkersCoordinatorPublisherPilotLedgerEvidence = {
    source: 'publisher-reward-pilot-ledger',
    capturedAtMs: 1_779_668_030_000,
    ledgerEntries: [
      {
        immutableLedgerId: 'ledger:publisher:newsroom-a:segment-03:001',
        publisherId: 'publisher:newsroom-a',
        segmentId: 'segment-03',
        checkpointClaimId: 'claim:checkpoint:segment-03:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
        rewardUsd: 4.25,
        decision: 'payable',
        decisionMetadata: {
          decidedAtMs: 1_779_668_031_000,
          settlementRuntime: 'publisher-reward-abuse-resistant-settlement-gate',
          reviewer: 'coordinator-payout-reconciliation',
          holdReasons: [],
        },
      },
      {
        immutableLedgerId: 'ledger:publisher:docs-b:segment-04:001',
        publisherId: 'publisher:docs-b',
        segmentId: 'segment-04',
        checkpointClaimId: 'claim:checkpoint:segment-04:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-04:001',
        rewardUsd: 3.75,
        decision: 'payable',
        decisionMetadata: {
          decidedAtMs: 1_779_668_032_000,
          settlementRuntime: 'publisher-reward-abuse-resistant-settlement-gate',
          reviewer: 'coordinator-payout-reconciliation',
          holdReasons: [],
        },
      },
    ],
    payoutBatches: [
      {
        batchId: 'payout-batch:pilot:2026-06-07:001',
        createdAtMs: 1_779_668_040_000,
        currency: 'USD',
        ledgerEntryIds: [
          'ledger:publisher:newsroom-a:segment-03:001',
          'ledger:publisher:docs-b:segment-04:001',
        ],
        payoutUsd: 8,
        coordinatorRelaySpendUsd: 2.2,
        status: 'ready',
      },
    ],
    publisherLevelHolds: [],
    disputeEvidence: [
      {
        publisherId: 'publisher:newsroom-a',
        ledgerEntryId: 'ledger:publisher:newsroom-a:segment-03:001',
        checkpointClaimId: 'claim:checkpoint:segment-03:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
        settlementHoldReasons: [],
        abuseDetections: {
          spoofedWorkerClaims: [],
          replayedCheckpointClaims: [],
          duplicateSegmentContributionClaims: [],
          costShiftingClaims: [],
        },
        checkpointRelayLinked: true,
        signedRunnerExecutionLinked: true,
      },
      {
        publisherId: 'publisher:docs-b',
        ledgerEntryId: 'ledger:publisher:docs-b:segment-04:001',
        checkpointClaimId: 'claim:checkpoint:segment-04:001',
        signedRunnerExecutionId: 'exec:signed-runner:segment-04:001',
        settlementHoldReasons: [],
        abuseDetections: {
          spoofedWorkerClaims: [],
          replayedCheckpointClaims: [],
          duplicateSegmentContributionClaims: [],
          costShiftingClaims: [],
        },
        checkpointRelayLinked: true,
        signedRunnerExecutionLinked: true,
      },
    ],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/pilot-ledger',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-ledger',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
  };

  return {
    ...base,
    ...overrides,
  };
}

describe('Workers Coordinator publisher reward pilot ledger payout reconciliation gate', () => {
  it('promotes pilot ledger payout reconciliation when ledger, payouts, disputes, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport(),
      ledgerEvidence: createLedgerEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-pilot-ledger-payout-reconciliation-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.ledgerEntries).toEqual([
      expect.objectContaining({
        immutableLedgerId: 'ledger:publisher:newsroom-a:segment-03:001',
        publisherId: 'publisher:newsroom-a',
        checkpointClaimId: 'claim:checkpoint:segment-03:001',
        rewardUsd: 4.25,
        decision: 'payable',
      }),
      expect.objectContaining({
        immutableLedgerId: 'ledger:publisher:docs-b:segment-04:001',
        publisherId: 'publisher:docs-b',
        signedRunnerExecutionId: 'exec:signed-runner:segment-04:001',
        rewardUsd: 3.75,
      }),
    ]);
    expect(report.payoutBatchReconciliation).toMatchObject({
      currency: 'USD',
      accruedRewardUsd: 8,
      ledgerRewardUsd: 8,
      payoutBatchUsd: 8,
      heldRewardUsd: 0,
      coordinatorRelaySpendUsd: 2.2,
      settlementCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    });
    expect(report.rewardAccrualTotals).toEqual([
      { publisherId: 'publisher:newsroom-a', rewardUsd: 4.25, payableUsd: 4.25, heldUsd: 0 },
      { publisherId: 'publisher:docs-b', rewardUsd: 3.75, payableUsd: 3.75, heldUsd: 0 },
    ]);
    expect(report.disputeEvidence).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        checkpointRelayLinked: true,
        signedRunnerExecutionLinked: true,
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        checkpointRelayLinked: true,
        signedRunnerExecutionLinked: true,
      }),
    ]);
    expect(report.settlementHoldReasons).toEqual([]);
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringLedgerReconciliation).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringLedgerReconciliation.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-ledger',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-real-money-payout-pilot']);
  });

  it('holds when settlement has not passed', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport({
        status: 'fail',
        failureReason: 'publisher-settlement-replayed-checkpoint-claims: claim:checkpoint:segment-03:001',
      }),
      ledgerEvidence: createLedgerEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-settlement-gate-not-clean: publisher-settlement-replayed-checkpoint-claims: claim:checkpoint:segment-03:001',
    );
  });

  it('holds when payout batch totals do not match payable ledger totals', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport(),
      ledgerEvidence: createLedgerEvidence({
        payoutBatches: [
          {
            batchId: 'payout-batch:pilot:2026-06-07:001',
            createdAtMs: 1_779_668_040_000,
            currency: 'USD',
            ledgerEntryIds: [
              'ledger:publisher:newsroom-a:segment-03:001',
              'ledger:publisher:docs-b:segment-04:001',
            ],
            payoutUsd: 7.5,
            coordinatorRelaySpendUsd: 2.2,
            status: 'ready',
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-ledger-payout-batch-total-does-not-match-payable-ledger-total',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-payout-batch-reconciliation-hardening']);
  });

  it('holds when payout batches reference unknown ledger entries', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport(),
      ledgerEvidence: createLedgerEvidence({
        payoutBatches: [
          {
            batchId: 'payout-batch:pilot:2026-06-07:001',
            createdAtMs: 1_779_668_040_000,
            currency: 'USD',
            ledgerEntryIds: [
              'ledger:publisher:newsroom-a:segment-03:001',
              'ledger:publisher:unknown:segment-99:001',
            ],
            payoutUsd: 8,
            coordinatorRelaySpendUsd: 2.2,
            status: 'ready',
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-ledger-payout-batch-references-unknown-entry: ledger:publisher:unknown:segment-99:001',
    );
    expect(report.promoteHoldThresholds.holdReasons).toContain(
      'publisher-ledger-payable-entry-missing-from-payout-batch: ledger:publisher:docs-b:segment-04:001',
    );
  });

  it('holds when held publisher entries are included in payout batches', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport(),
      ledgerEvidence: createLedgerEvidence({
        ledgerEntries: [
          {
            immutableLedgerId: 'ledger:publisher:newsroom-a:segment-03:001',
            publisherId: 'publisher:newsroom-a',
            segmentId: 'segment-03',
            checkpointClaimId: 'claim:checkpoint:segment-03:001',
            signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
            rewardUsd: 4.25,
            decision: 'held',
            decisionMetadata: {
              decidedAtMs: 1_779_668_031_000,
              settlementRuntime: 'publisher-reward-abuse-resistant-settlement-gate',
              reviewer: 'coordinator-payout-reconciliation',
              holdReasons: ['operator-review-requested'],
            },
          },
          {
            immutableLedgerId: 'ledger:publisher:docs-b:segment-04:001',
            publisherId: 'publisher:docs-b',
            segmentId: 'segment-04',
            checkpointClaimId: 'claim:checkpoint:segment-04:001',
            signedRunnerExecutionId: 'exec:signed-runner:segment-04:001',
            rewardUsd: 3.75,
            decision: 'payable',
            decisionMetadata: {
              decidedAtMs: 1_779_668_032_000,
              settlementRuntime: 'publisher-reward-abuse-resistant-settlement-gate',
              reviewer: 'coordinator-payout-reconciliation',
              holdReasons: [],
            },
          },
        ],
        publisherLevelHolds: [
          {
            publisherId: 'publisher:newsroom-a',
            reason: 'operator-review-requested',
            ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-ledger-held-entry-in-payout-batch: ledger:publisher:newsroom-a:segment-03:001',
    );
    expect(report.settlementHoldReasons).toContain('publisher:newsroom-a: operator-review-requested');
  });

  it('holds when dispute evidence does not link checkpoint and signed runner evidence', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport(),
      ledgerEvidence: createLedgerEvidence({
        disputeEvidence: [
          {
            publisherId: 'publisher:newsroom-a',
            ledgerEntryId: 'ledger:publisher:newsroom-a:segment-03:001',
            checkpointClaimId: 'claim:checkpoint:segment-03:001',
            signedRunnerExecutionId: 'exec:signed-runner:segment-03:001',
            settlementHoldReasons: [],
            abuseDetections: {
              spoofedWorkerClaims: [],
              replayedCheckpointClaims: [],
              duplicateSegmentContributionClaims: [],
              costShiftingClaims: [],
            },
            checkpointRelayLinked: true,
            signedRunnerExecutionLinked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-ledger-dispute-evidence-missing-linkage: ledger:publisher:newsroom-a:segment-03:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-dispute-evidence-review-workflow']);
  });

  it('holds when ledger reconciliation leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherPilotLedgerGate({
      settlementReport: createSettlementReport(),
      ledgerEvidence: createLedgerEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/pilot-ledger',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-ledger',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-ledger-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-ledger-security-boundary-hardening']);
  });
});
