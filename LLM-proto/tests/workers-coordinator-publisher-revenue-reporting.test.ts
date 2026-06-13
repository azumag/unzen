import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherRecurringPayoutOperationsReport,
} from '../src/workers-coordinator-publisher-recurring-payout-operations.js';
import {
  runWorkersCoordinatorPublisherRevenueReportingGate,
  type WorkersCoordinatorPublisherRevenueReportingEvidence,
} from '../src/workers-coordinator-publisher-revenue-reporting.js';

function createRecurringPayoutReport(
  overrides: Partial<WorkersCoordinatorPublisherRecurringPayoutOperationsReport> = {},
): WorkersCoordinatorPublisherRecurringPayoutOperationsReport {
  const base: WorkersCoordinatorPublisherRecurringPayoutOperationsReport = {
    runtime: 'publisher-reward-recurring-payout-operations-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    scheduledPayoutWindowIdempotency: [
      {
        windowId: 'payout-window:weekly:2026-06-12:001',
        scheduleId: 'payout-schedule:publisher-rewards:weekly',
        batchId: 'payout-batch:weekly:2026-06-12:001',
        providerBatchId: 'stripe-batch:weekly:2026-06-12:001',
        ledgerEntryIds: [
          'ledger:publisher:newsroom-a:segment-03:001',
          'ledger:publisher:docs-b:segment-04:001',
        ],
        opensAtMs: 1_780_444_800_000,
        closesAtMs: 1_780_448_400_000,
        idempotencyKey: 'idempotency:publisher-rewards:weekly:2026-06-12:001',
        submissionCount: 1,
        duplicateProviderSubmissionBlocked: true,
      },
    ],
    providerRetryBackoffLedgers: [
      {
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        ledgerEntryIds: [
          'ledger:publisher:newsroom-a:segment-03:001',
          'ledger:publisher:docs-b:segment-04:001',
        ],
        status: 'settled',
        retryCount: 0,
        nextRetryAtMs: null,
        backoffPolicy: 'none',
        lastFailureReason: null,
      },
    ],
    publisherSupportDisputeRouting: [
      {
        disputeId: 'dispute:publisher:newsroom-a:payout:001',
        publisherId: 'publisher:newsroom-a',
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        receiptIds: ['receipt:publisher:newsroom-a:payout-live:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        routedTo: 'publisher-support',
        status: 'triaged',
        createdAtMs: 1_780_445_500_000,
      },
      {
        disputeId: 'dispute:publisher:docs-b:payout:001',
        publisherId: 'publisher:docs-b',
        ledgerEntryIds: ['ledger:publisher:docs-b:segment-04:001'],
        receiptIds: ['receipt:publisher:docs-b:payout-live:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        routedTo: 'payout-ops',
        status: 'resolved',
        createdAtMs: 1_780_445_510_000,
      },
    ],
    accountingExportReconciliation: [
      {
        exportId: 'accounting-export:publisher-rewards:weekly:2026-06-12:001',
        generatedAtMs: 1_780_445_600_000,
        currency: 'USD',
        accountingPayoutTotalUsd: 8,
        providerSettlementTotalUsd: 8,
        ledgerPayoutTotalUsd: 8,
        accountingCoordinatorRelaySpendUsd: 2.2,
        providerCoordinatorRelaySpendUsd: 2.2,
        unmatchedLedgerEntryIds: [],
      },
    ],
    postPilotSloErrorBudgetDashboards: [
      {
        dashboardId: 'slo:publisher-rewards:payout-ops:weekly',
        measuredWindowIds: ['payout-window:weekly:2026-06-12:001'],
        callbackP95LatencyMs: 12_000,
        failedPayoutRate: 0.005,
        duplicateSubmissionRate: 0,
        supportDisputeRate: 0.02,
        errorBudgetRemainingPercent: 86,
      },
    ],
    emergencyHoldRollbackControls: [
      {
        controlId: 'emergency-control:publisher-rewards:payout-ops:weekly',
        scheduleId: 'payout-schedule:publisher-rewards:weekly',
        emergencyHoldSwitchId: 'emergency-hold:publisher-payout:weekly',
        rollbackPlanId: 'rollback-plan:publisher-payout:weekly',
        controlledBy: 'operator:payout-incident-commander',
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      },
    ],
    recurringPayoutReconciliation: {
      currency: 'USD',
      providerSettlementTotalUsd: 8,
      accountingPayoutTotalUsd: 8,
      ledgerPayoutTotalUsd: 8,
      providerCoordinatorRelaySpendUsd: 2.2,
      accountingCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher live-money payout pilot gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringRecurringOperations: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-recurring-ops',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-payout-ops-revenue-reporting'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createRevenueReportingEvidence(
  overrides: Partial<WorkersCoordinatorPublisherRevenueReportingEvidence> = {},
): WorkersCoordinatorPublisherRevenueReportingEvidence {
  const base: WorkersCoordinatorPublisherRevenueReportingEvidence = {
    source: 'publisher-reward-payout-ops-revenue-reporting',
    capturedAtMs: 1_780_531_830_000,
    publisherMonthlyStatements: [
      {
        statementId: 'statement:publisher:newsroom-a:2026-06',
        publisherId: 'publisher:newsroom-a',
        period: '2026-06',
        currency: 'USD',
        recurringPayoutWindowIds: ['payout-window:weekly:2026-06-12:001'],
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        receiptIds: ['receipt:publisher:newsroom-a:payout-live:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        grossRewardUsd: 5,
        platformFeeUsd: 0.75,
        coordinatorRelaySpendUsd: 1.25,
        netPublisherPayoutUsd: 3,
        supportDisputeIds: ['dispute:publisher:newsroom-a:payout:001'],
        immutableLedgerHistoryPreserved: true,
      },
      {
        statementId: 'statement:publisher:docs-b:2026-06',
        publisherId: 'publisher:docs-b',
        period: '2026-06',
        currency: 'USD',
        recurringPayoutWindowIds: ['payout-window:weekly:2026-06-12:001'],
        ledgerEntryIds: ['ledger:publisher:docs-b:segment-04:001'],
        receiptIds: ['receipt:publisher:docs-b:payout-live:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        grossRewardUsd: 5,
        platformFeeUsd: 0.85,
        coordinatorRelaySpendUsd: 0.35,
        netPublisherPayoutUsd: 3.8,
        supportDisputeIds: ['dispute:publisher:docs-b:payout:001'],
        immutableLedgerHistoryPreserved: true,
      },
    ],
    platformFeeMarginReconciliations: [
      {
        reconciliationId: 'revenue-reconciliation:publisher-rewards:2026-06',
        accountingExportId: 'accounting-export:publisher-rewards:weekly:2026-06-12:001',
        providerSettlementTotalUsd: 8,
        accountingPayoutTotalUsd: 8,
        ledgerPayoutTotalUsd: 8,
        platformFeeRevenueUsd: 1.6,
        coordinatorRelaySpendUsd: 1.6,
        grossRewardUsd: 10,
        netPublisherPayoutUsd: 6.8,
        marginUsd: 0,
      },
    ],
    refundReversalClawbackAdjustments: [
      {
        adjustmentId: 'adjustment:refund:publisher:newsroom-a:2026-06:001',
        type: 'refund',
        publisherId: 'publisher:newsroom-a',
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        amountUsd: 0.2,
        reason: 'customer refund applied after payout settlement',
        adjustmentLedgerEntryId: 'ledger-adjustment:refund:publisher:newsroom-a:2026-06:001',
        originalLedgerEntryIdsPreserved: true,
        appliedAtMs: 1_780_531_840_000,
      },
      {
        adjustmentId: 'adjustment:reversal:publisher:docs-b:2026-06:001',
        type: 'reversal',
        publisherId: 'publisher:docs-b',
        ledgerEntryIds: ['ledger:publisher:docs-b:segment-04:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        amountUsd: 0.1,
        reason: 'provider reversal notice attached to statement',
        adjustmentLedgerEntryId: 'ledger-adjustment:reversal:publisher:docs-b:2026-06:001',
        originalLedgerEntryIdsPreserved: true,
        appliedAtMs: 1_780_531_850_000,
      },
      {
        adjustmentId: 'adjustment:clawback:publisher:newsroom-a:2026-06:001',
        type: 'clawback',
        publisherId: 'publisher:newsroom-a',
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        amountUsd: 0.05,
        reason: 'post-settlement abuse review clawback',
        adjustmentLedgerEntryId: 'ledger-adjustment:clawback:publisher:newsroom-a:2026-06:001',
        originalLedgerEntryIdsPreserved: true,
        appliedAtMs: 1_780_531_860_000,
      },
    ],
    auditReadyExports: [
      {
        exportId: 'audit-export:finance:publisher-rewards:2026-06',
        generatedAtMs: 1_780_531_900_000,
        audience: 'finance',
        statementIds: [
          'statement:publisher:newsroom-a:2026-06',
          'statement:publisher:docs-b:2026-06',
        ],
        reconciliationIds: ['revenue-reconciliation:publisher-rewards:2026-06'],
        adjustmentIds: [
          'adjustment:refund:publisher:newsroom-a:2026-06:001',
          'adjustment:reversal:publisher:docs-b:2026-06:001',
          'adjustment:clawback:publisher:newsroom-a:2026-06:001',
        ],
        includesProviderSettlementIds: true,
        includesAccountingExportIds: true,
        includesEmergencyControlIds: true,
      },
      {
        exportId: 'audit-export:operator-review:publisher-rewards:2026-06',
        generatedAtMs: 1_780_531_910_000,
        audience: 'operator-review',
        statementIds: [
          'statement:publisher:newsroom-a:2026-06',
          'statement:publisher:docs-b:2026-06',
        ],
        reconciliationIds: ['revenue-reconciliation:publisher-rewards:2026-06'],
        adjustmentIds: [
          'adjustment:refund:publisher:newsroom-a:2026-06:001',
          'adjustment:reversal:publisher:docs-b:2026-06:001',
          'adjustment:clawback:publisher:newsroom-a:2026-06:001',
        ],
        includesProviderSettlementIds: true,
        includesAccountingExportIds: true,
        includesEmergencyControlIds: true,
      },
    ],
    emergencyControls: [
      {
        controlId: 'emergency-control:publisher-rewards:payout-ops:weekly',
        scheduleId: 'payout-schedule:publisher-rewards:weekly',
        emergencyHoldSwitchId: 'emergency-hold:publisher-payout:weekly',
        rollbackPlanId: 'rollback-plan:publisher-payout:weekly',
        controlledBy: 'operator:payout-incident-commander',
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      },
    ],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/revenue-reporting',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-revenue-reporting',
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

describe('Workers Coordinator publisher reward payout operations revenue reporting gate', () => {
  it('promotes revenue reporting when statements, margin reconciliation, adjustments, exports, controls, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherRevenueReportingGate({
      recurringPayoutReport: createRecurringPayoutReport(),
      revenueReportingEvidence: createRevenueReportingEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-payout-ops-revenue-reporting-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.publisherMonthlyStatements).toEqual([
      expect.objectContaining({
        statementId: 'statement:publisher:newsroom-a:2026-06',
        recurringPayoutWindowIds: ['payout-window:weekly:2026-06-12:001'],
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        receiptIds: ['receipt:publisher:newsroom-a:payout-live:001'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        immutableLedgerHistoryPreserved: true,
      }),
      expect.objectContaining({
        statementId: 'statement:publisher:docs-b:2026-06',
        netPublisherPayoutUsd: 3.8,
      }),
    ]);
    expect(report.platformFeeRelaySpendMarginReconciliation).toEqual([
      expect.objectContaining({
        providerSettlementTotalUsd: 8,
        accountingPayoutTotalUsd: 8,
        ledgerPayoutTotalUsd: 8,
        platformFeeRevenueUsd: 1.6,
        coordinatorRelaySpendUsd: 1.6,
        marginUsd: 0,
      }),
    ]);
    expect(report.refundReversalClawbackAdjustments.map((adjustment) => adjustment.type)).toEqual([
      'refund',
      'reversal',
      'clawback',
    ]);
    expect(report.auditReadyPayoutOperationsExports.map((auditExport) => auditExport.audience)).toEqual([
      'finance',
      'operator-review',
    ]);
    expect(report.revenueReportingSummary).toMatchObject({
      currency: 'USD',
      grossRewardUsd: 10,
      platformFeeRevenueUsd: 1.6,
      coordinatorRelaySpendUsd: 1.6,
      netPublisherPayoutUsd: 6.8,
      adjustmentTotalUsd: 0.35,
      marginUsd: -0.35,
    });
    expect(report.emergencyHoldRollbackControls).toEqual([
      expect.objectContaining({
        emergencyHoldSwitchId: 'emergency-hold:publisher-payout:weekly',
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      }),
    ]);
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringRevenueReporting).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringRevenueReporting.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-revenue-reporting',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-tax-reporting-and-1099-k-export']);
  });

  it('holds when the upstream recurring payout operations gate has not passed', () => {
    const report = runWorkersCoordinatorPublisherRevenueReportingGate({
      recurringPayoutReport: createRecurringPayoutReport({
        status: 'fail',
        failureReason: 'publisher-recurring-payout-accounting-export-reconciliation-invalid: accounting-export:broken',
      }),
      revenueReportingEvidence: createRevenueReportingEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-recurring-payout-operations-gate-not-clean: publisher-recurring-payout-accounting-export-reconciliation-invalid: accounting-export:broken',
    );
  });

  it('holds when a publisher monthly statement mutates payout ledger history', () => {
    const report = runWorkersCoordinatorPublisherRevenueReportingGate({
      recurringPayoutReport: createRecurringPayoutReport(),
      revenueReportingEvidence: createRevenueReportingEvidence({
        publisherMonthlyStatements: [
          {
            statementId: 'statement:publisher:newsroom-a:2026-06',
            publisherId: 'publisher:newsroom-a',
            period: '2026-06',
            currency: 'USD',
            recurringPayoutWindowIds: ['payout-window:weekly:2026-06-12:001'],
            ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
            receiptIds: ['receipt:publisher:newsroom-a:payout-live:001'],
            providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
            grossRewardUsd: 5,
            platformFeeUsd: 0.75,
            coordinatorRelaySpendUsd: 1.25,
            netPublisherPayoutUsd: 3,
            supportDisputeIds: ['dispute:publisher:newsroom-a:payout:001'],
            immutableLedgerHistoryPreserved: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-revenue-reporting-monthly-statement-invalid: statement:publisher:newsroom-a:2026-06',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-revenue-reporting-monthly-statement-hardening']);
  });

  it('holds when platform fee margin does not reconcile to Coordinator relay spend', () => {
    const report = runWorkersCoordinatorPublisherRevenueReportingGate({
      recurringPayoutReport: createRecurringPayoutReport(),
      revenueReportingEvidence: createRevenueReportingEvidence({
        platformFeeMarginReconciliations: [
          {
            reconciliationId: 'revenue-reconciliation:publisher-rewards:2026-06',
            accountingExportId: 'accounting-export:publisher-rewards:weekly:2026-06-12:001',
            providerSettlementTotalUsd: 8,
            accountingPayoutTotalUsd: 8,
            ledgerPayoutTotalUsd: 8,
            platformFeeRevenueUsd: 1.6,
            coordinatorRelaySpendUsd: 1.1,
            grossRewardUsd: 10,
            netPublisherPayoutUsd: 6.8,
            marginUsd: 0,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-revenue-reporting-platform-fee-margin-reconciliation-invalid: revenue-reconciliation:publisher-rewards:2026-06',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-revenue-reporting-margin-reconciliation-hardening']);
  });

  it('holds when refund, reversal, and clawback coverage is incomplete', () => {
    const evidence = createRevenueReportingEvidence();
    const report = runWorkersCoordinatorPublisherRevenueReportingGate({
      recurringPayoutReport: createRecurringPayoutReport(),
      revenueReportingEvidence: createRevenueReportingEvidence({
        refundReversalClawbackAdjustments: evidence.refundReversalClawbackAdjustments.filter((adjustment) =>
          adjustment.type !== 'clawback',
        ),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('publisher-revenue-reporting-adjustment-type-missing: clawback');
    expect(report.bottlenecksToIssue).toEqual(['publisher-revenue-reporting-refund-reversal-clawback-workflow']);
  });

  it('holds when revenue reporting leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherRevenueReportingGate({
      recurringPayoutReport: createRecurringPayoutReport(),
      revenueReportingEvidence: createRevenueReportingEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/revenue-reporting',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-revenue-reporting',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-revenue-reporting-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-revenue-reporting-security-boundary-hardening']);
  });
});
