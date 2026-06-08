import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherPilotLedgerReport,
} from '../src/workers-coordinator-publisher-ledger-payout-reconciliation.js';
import {
  runWorkersCoordinatorPublisherPayoutDryRunGate,
  type WorkersCoordinatorPublisherPayoutDryRunEvidence,
} from '../src/workers-coordinator-publisher-payout-dry-run.js';

function createLedgerReport(
  overrides: Partial<WorkersCoordinatorPublisherPilotLedgerReport> = {},
): WorkersCoordinatorPublisherPilotLedgerReport {
  const base: WorkersCoordinatorPublisherPilotLedgerReport = {
    runtime: 'publisher-reward-pilot-ledger-payout-reconciliation-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
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
    payoutBatchReconciliation: {
      currency: 'USD',
      accruedRewardUsd: 8,
      ledgerRewardUsd: 8,
      payoutBatchUsd: 8,
      heldRewardUsd: 0,
      coordinatorRelaySpendUsd: 2.2,
      settlementCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    },
    rewardAccrualTotals: [
      { publisherId: 'publisher:newsroom-a', rewardUsd: 4.25, payableUsd: 4.25, heldUsd: 0 },
      { publisherId: 'publisher:docs-b', rewardUsd: 3.75, payableUsd: 3.75, heldUsd: 0 },
    ],
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
    settlementHoldReasons: [],
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['payout batches exclude publisher-level holds and match payable ledger totals'],
      holdReasons: [],
    },
    securityBoundaryDuringLedgerReconciliation: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-ledger',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-real-money-payout-pilot'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createPayoutDryRunEvidence(
  overrides: Partial<WorkersCoordinatorPublisherPayoutDryRunEvidence> = {},
): WorkersCoordinatorPublisherPayoutDryRunEvidence {
  const base: WorkersCoordinatorPublisherPayoutDryRunEvidence = {
    source: 'publisher-reward-real-money-payout-pilot-dry-run',
    capturedAtMs: 1_779_754_030_000,
    providerDryRuns: [
      {
        providerDryRunId: 'stripe-dry-run:payout-batch:pilot:2026-06-08:001',
        provider: 'stripe-connect',
        batchId: 'payout-batch:pilot:2026-06-08:001',
        ledgerEntryIds: [
          'ledger:publisher:newsroom-a:segment-03:001',
          'ledger:publisher:docs-b:segment-04:001',
        ],
        currency: 'USD',
        dryRunPayoutUsd: 8,
        dryRunCoordinatorRelaySpendUsd: 2.2,
        status: 'ready',
        liveMoneyMovementTriggered: false,
      },
    ],
    taxInvoiceMetadata: [
      {
        publisherId: 'publisher:newsroom-a',
        taxProfileId: 'tax-profile:newsroom-a:us-w9:2026',
        taxFormStatus: 'valid',
        invoiceId: 'invoice:publisher:newsroom-a:2026-06-08:001',
        invoiceStatus: 'ready-for-review',
        payoutCurrency: 'USD',
      },
      {
        publisherId: 'publisher:docs-b',
        taxProfileId: 'tax-profile:docs-b:us-w8ben:2026',
        taxFormStatus: 'valid',
        invoiceId: 'invoice:publisher:docs-b:2026-06-08:001',
        invoiceStatus: 'ready-for-review',
        payoutCurrency: 'USD',
      },
    ],
    operatorApprovals: [
      {
        batchId: 'payout-batch:pilot:2026-06-08:001',
        approvedBy: 'operator:payout-reviewer-01',
        approvedAtMs: 1_779_754_040_000,
        dryRunOnlyAttestation: true,
        blockerReasons: [],
      },
    ],
    publisherFacingExports: [
      {
        publisherId: 'publisher:newsroom-a',
        exportId: 'export:publisher:newsroom-a:payout-dry-run:001',
        generatedAtMs: 1_779_754_041_000,
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        includesProviderDryRunId: true,
        includesTaxInvoiceMetadata: true,
      },
      {
        publisherId: 'publisher:docs-b',
        exportId: 'export:publisher:docs-b:payout-dry-run:001',
        generatedAtMs: 1_779_754_042_000,
        ledgerEntryIds: ['ledger:publisher:docs-b:segment-04:001'],
        includesProviderDryRunId: true,
        includesTaxInvoiceMetadata: true,
      },
    ],
    publisherLevelHolds: [],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/provider-dry-run',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-provider-dry-run',
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

describe('Workers Coordinator publisher reward real-money payout pilot dry-run gate', () => {
  it('promotes payout dry-run when provider, tax, approval, export, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-real-money-payout-pilot-dry-run-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.payoutProviderDryRunEvidence).toEqual([
      expect.objectContaining({
        providerDryRunId: 'stripe-dry-run:payout-batch:pilot:2026-06-08:001',
        provider: 'stripe-connect',
        dryRunPayoutUsd: 8,
        liveMoneyMovementTriggered: false,
      }),
    ]);
    expect(report.payoutDryRunReconciliation).toMatchObject({
      currency: 'USD',
      ledgerPayoutBatchUsd: 8,
      providerDryRunPayoutUsd: 8,
      ledgerCoordinatorRelaySpendUsd: 2.2,
      providerDryRunCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    });
    expect(report.taxInvoiceMetadata).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        taxFormStatus: 'valid',
        invoiceStatus: 'ready-for-review',
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        taxFormStatus: 'valid',
        invoiceStatus: 'ready-for-review',
      }),
    ]);
    expect(report.operatorApprovalEvidence).toEqual([
      expect.objectContaining({
        approvedBy: 'operator:payout-reviewer-01',
        dryRunOnlyAttestation: true,
        blockerReasons: [],
      }),
    ]);
    expect(report.publisherFacingReconciliationExports).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        includesProviderDryRunId: true,
        includesTaxInvoiceMetadata: true,
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        includesProviderDryRunId: true,
        includesTaxInvoiceMetadata: true,
      }),
    ]);
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringPayoutDryRun).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringPayoutDryRun.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-provider-dry-run',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-live-money-payout-pilot']);
  });

  it('holds when the upstream ledger gate has not passed', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport({
        status: 'fail',
        failureReason: 'publisher-ledger-payout-batch-total-does-not-match-payable-ledger-total',
      }),
      payoutDryRunEvidence: createPayoutDryRunEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-ledger-gate-not-clean: publisher-ledger-payout-batch-total-does-not-match-payable-ledger-total',
    );
  });

  it('holds when provider dry-run evidence triggers live money movement', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence({
        providerDryRuns: [
          {
            providerDryRunId: 'stripe-dry-run:payout-batch:pilot:2026-06-08:001',
            provider: 'stripe-connect',
            batchId: 'payout-batch:pilot:2026-06-08:001',
            ledgerEntryIds: [
              'ledger:publisher:newsroom-a:segment-03:001',
              'ledger:publisher:docs-b:segment-04:001',
            ],
            currency: 'USD',
            dryRunPayoutUsd: 8,
            dryRunCoordinatorRelaySpendUsd: 2.2,
            status: 'ready',
            liveMoneyMovementTriggered: true,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-dry-run-triggered-live-money-movement: stripe-dry-run:payout-batch:pilot:2026-06-08:001',
    );
  });

  it('holds when provider dry-run totals do not reconcile to ledger payout batch totals', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence({
        providerDryRuns: [
          {
            providerDryRunId: 'stripe-dry-run:payout-batch:pilot:2026-06-08:001',
            provider: 'stripe-connect',
            batchId: 'payout-batch:pilot:2026-06-08:001',
            ledgerEntryIds: [
              'ledger:publisher:newsroom-a:segment-03:001',
              'ledger:publisher:docs-b:segment-04:001',
            ],
            currency: 'USD',
            dryRunPayoutUsd: 7.5,
            dryRunCoordinatorRelaySpendUsd: 2.2,
            status: 'ready',
            liveMoneyMovementTriggered: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-dry-run-total-does-not-match-ledger-payout-batch-total',
    );
  });

  it('holds when tax or invoice metadata is missing for a payable publisher', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence({
        taxInvoiceMetadata: [
          {
            publisherId: 'publisher:newsroom-a',
            taxProfileId: 'tax-profile:newsroom-a:us-w9:2026',
            taxFormStatus: 'valid',
            invoiceId: 'invoice:publisher:newsroom-a:2026-06-08:001',
            invoiceStatus: 'ready-for-review',
            payoutCurrency: 'USD',
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-tax-invoice-metadata-missing-or-blocked: publisher:docs-b',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-invoice-review-workflow']);
  });

  it('holds when operator approval does not attest dry-run-only movement', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence({
        operatorApprovals: [
          {
            batchId: 'payout-batch:pilot:2026-06-08:001',
            approvedBy: 'operator:payout-reviewer-01',
            approvedAtMs: 1_779_754_040_000,
            dryRunOnlyAttestation: false,
            blockerReasons: ['provider-console-state-unverified'],
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-operator-approval-missing-or-blocked: payout-batch:pilot:2026-06-08:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-payout-operator-approval-workflow']);
  });

  it('holds when publisher-facing reconciliation export omits provider dry-run evidence', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence({
        publisherFacingExports: [
          {
            publisherId: 'publisher:newsroom-a',
            exportId: 'export:publisher:newsroom-a:payout-dry-run:001',
            generatedAtMs: 1_779_754_041_000,
            ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
            includesProviderDryRunId: false,
            includesTaxInvoiceMetadata: true,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-reconciliation-export-missing-or-incomplete: publisher:newsroom-a',
    );
  });

  it('holds when payout dry-run leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherPayoutDryRunGate({
      ledgerReport: createLedgerReport(),
      payoutDryRunEvidence: createPayoutDryRunEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/provider-dry-run',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-provider-dry-run',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-dry-run-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-payout-security-boundary-hardening']);
  });
});
