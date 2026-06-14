import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherRevenueReportingReport,
} from '../src/workers-coordinator-publisher-revenue-reporting.js';
import {
  runWorkersCoordinatorPublisherTaxReportingGate,
  type WorkersCoordinatorPublisherTaxReportingEvidence,
} from '../src/workers-coordinator-publisher-tax-reporting.js';

function createRevenueReportingReport(
  overrides: Partial<WorkersCoordinatorPublisherRevenueReportingReport> = {},
): WorkersCoordinatorPublisherRevenueReportingReport {
  const base: WorkersCoordinatorPublisherRevenueReportingReport = {
    runtime: 'publisher-reward-payout-ops-revenue-reporting-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
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
    platformFeeRelaySpendMarginReconciliation: [
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
    auditReadyPayoutOperationsExports: [
      {
        exportId: 'audit-export:finance:publisher-rewards:2026-06',
        generatedAtMs: 1_780_531_900_000,
        audience: 'finance',
        statementIds: ['statement:publisher:newsroom-a:2026-06', 'statement:publisher:docs-b:2026-06'],
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
    revenueReportingSummary: {
      currency: 'USD',
      grossRewardUsd: 10,
      platformFeeRevenueUsd: 1.6,
      coordinatorRelaySpendUsd: 1.6,
      netPublisherPayoutUsd: 6.8,
      adjustmentTotalUsd: 0.35,
      marginUsd: -0.35,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher recurring payout operations gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringRevenueReporting: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-revenue-reporting',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-tax-reporting-and-1099-k-export'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createTaxReportingEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxReportingEvidence> = {},
): WorkersCoordinatorPublisherTaxReportingEvidence {
  const base: WorkersCoordinatorPublisherTaxReportingEvidence = {
    source: 'publisher-reward-tax-reporting-1099-k',
    capturedAtMs: 1_783_037_700_000,
    publisherTaxProfiles: [
      {
        publisherId: 'publisher:newsroom-a',
        taxYear: 2026,
        country: 'US',
        taxClassification: 'business',
        taxpayerIdLast4: '1234',
        payoutProviderAccountId: 'acct_newsroom_a',
        addressValidated: true,
        w9SignedAtMs: 1_780_000_000_000,
        payable: true,
        withholdingHoldReason: null,
      },
      {
        publisherId: 'publisher:docs-b',
        taxYear: 2026,
        country: 'US',
        taxClassification: 'individual',
        taxpayerIdLast4: '9876',
        payoutProviderAccountId: 'acct_docs_b',
        addressValidated: true,
        w9SignedAtMs: 1_780_000_050_000,
        payable: true,
        withholdingHoldReason: null,
      },
    ],
    taxYearPublisherSummaries: [
      {
        summaryId: 'tax-summary:publisher:newsroom-a:2026',
        publisherId: 'publisher:newsroom-a',
        taxYear: 2026,
        statementIds: ['statement:publisher:newsroom-a:2026-06'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        payoutProviderAccountId: 'acct_newsroom_a',
        grossRewardUsd: 5,
        platformFeeRevenueUsd: 0.75,
        refundReversalClawbackAdjustmentUsd: 0.25,
        netPublisherPayoutUsd: 3,
      },
      {
        summaryId: 'tax-summary:publisher:docs-b:2026',
        publisherId: 'publisher:docs-b',
        taxYear: 2026,
        statementIds: ['statement:publisher:docs-b:2026-06'],
        providerPayoutIds: ['stripe-payout:payout-batch:pilot:2026-06-08:001'],
        payoutProviderAccountId: 'acct_docs_b',
        grossRewardUsd: 5,
        platformFeeRevenueUsd: 0.85,
        refundReversalClawbackAdjustmentUsd: 0.1,
        netPublisherPayoutUsd: 3.8,
      },
    ],
    tax1099KExportRecords: [
      {
        exportRecordId: '1099-k:publisher:newsroom-a:2026',
        publisherId: 'publisher:newsroom-a',
        taxYear: 2026,
        taxFormType: '1099-K',
        payoutProviderAccountId: 'acct_newsroom_a',
        grossReportableUsd: 5,
        adjustmentUsd: 0.25,
        netPayoutUsd: 3,
        generatedAtMs: 1_783_037_710_000,
        readyForFiling: true,
      },
      {
        exportRecordId: '1099-k:publisher:docs-b:2026',
        publisherId: 'publisher:docs-b',
        taxYear: 2026,
        taxFormType: '1099-K',
        payoutProviderAccountId: 'acct_docs_b',
        grossReportableUsd: 5,
        adjustmentUsd: 0.1,
        netPayoutUsd: 3.8,
        generatedAtMs: 1_783_037_720_000,
        readyForFiling: true,
      },
    ],
    taxExportReconciliations: [
      {
        reconciliationId: 'tax-reconciliation:publisher-rewards:2026',
        taxYear: 2026,
        accountingExportIds: ['accounting-export:publisher-rewards:weekly:2026-06-12:001'],
        revenueReportingGrossRewardUsd: 10,
        taxExportGrossReportableUsd: 10,
        revenueReportingNetPayoutUsd: 6.8,
        taxExportNetPayoutUsd: 6.8,
      },
    ],
    financeOperatorReviewExports: [
      {
        exportId: 'tax-review-export:finance:publisher-rewards:2026',
        generatedAtMs: 1_783_037_730_000,
        audience: 'finance',
        taxYear: 2026,
        taxProfilePublisherIds: ['publisher:newsroom-a', 'publisher:docs-b'],
        taxSummaryIds: ['tax-summary:publisher:newsroom-a:2026', 'tax-summary:publisher:docs-b:2026'],
        taxExportRecordIds: ['1099-k:publisher:newsroom-a:2026', '1099-k:publisher:docs-b:2026'],
        reconciliationIds: ['tax-reconciliation:publisher-rewards:2026'],
        includesAccountingExportIds: true,
        includesEmergencyControlIds: true,
      },
      {
        exportId: 'tax-review-export:operator:publisher-rewards:2026',
        generatedAtMs: 1_783_037_740_000,
        audience: 'operator-review',
        taxYear: 2026,
        taxProfilePublisherIds: ['publisher:newsroom-a', 'publisher:docs-b'],
        taxSummaryIds: ['tax-summary:publisher:newsroom-a:2026', 'tax-summary:publisher:docs-b:2026'],
        taxExportRecordIds: ['1099-k:publisher:newsroom-a:2026', '1099-k:publisher:docs-b:2026'],
        reconciliationIds: ['tax-reconciliation:publisher-rewards:2026'],
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
        url: 'https://coordinator.unzen.dev/payouts/tax-reporting',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-reporting',
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

describe('Workers Coordinator publisher reward tax reporting / 1099-K export gate', () => {
  it('promotes tax reporting when profiles, summaries, 1099-K records, reconciliation, exports, controls, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherTaxReportingGate({
      revenueReportingReport: createRevenueReportingReport(),
      taxReportingEvidence: createTaxReportingEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-tax-reporting-1099-k-gate');
    expect(report.status).toBe('pass');
    expect(report.publisherTaxProfiles).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        taxpayerIdLast4: '1234',
        payoutProviderAccountId: 'acct_newsroom_a',
        payable: true,
        withholdingHoldReason: null,
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        taxClassification: 'individual',
      }),
    ]);
    expect(report.taxYearPublisherSummaries).toEqual([
      expect.objectContaining({
        summaryId: 'tax-summary:publisher:newsroom-a:2026',
        statementIds: ['statement:publisher:newsroom-a:2026-06'],
        grossRewardUsd: 5,
        refundReversalClawbackAdjustmentUsd: 0.25,
      }),
      expect.objectContaining({
        summaryId: 'tax-summary:publisher:docs-b:2026',
        netPublisherPayoutUsd: 3.8,
      }),
    ]);
    expect(report.tax1099KExportRecords.map((record) => record.taxFormType)).toEqual(['1099-K', '1099-K']);
    expect(report.taxExportReconciliation).toEqual([
      expect.objectContaining({
        revenueReportingGrossRewardUsd: 10,
        taxExportGrossReportableUsd: 10,
        revenueReportingNetPayoutUsd: 6.8,
        taxExportNetPayoutUsd: 6.8,
      }),
    ]);
    expect(report.financeOperatorReviewExports.map((reviewExport) => reviewExport.audience)).toEqual([
      'finance',
      'operator-review',
    ]);
    expect(report.taxHolds).toEqual([]);
    expect(report.taxReportingSummary).toEqual({
      currency: 'USD',
      taxYear: 2026,
      publisherCount: 2,
      grossReportableUsd: 10,
      adjustmentUsd: 0.35,
      netPayoutUsd: 6.8,
    });
    expect(report.emergencyHoldRollbackControls).toEqual([
      expect.objectContaining({
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      }),
    ]);
    expect(report.securityBoundaryDuringTaxReporting).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringTaxReporting.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-tax-reporting',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-tax-filing-drill-and-publisher-delivery']);
  });

  it('holds when the upstream revenue reporting gate has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxReportingGate({
      revenueReportingReport: createRevenueReportingReport({
        status: 'fail',
        failureReason: 'publisher-revenue-reporting-audit-export-invalid: audit-export:broken',
      }),
      taxReportingEvidence: createTaxReportingEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-revenue-reporting-gate-not-clean: publisher-revenue-reporting-audit-export-invalid: audit-export:broken',
    );
  });

  it('holds when a payable publisher is missing valid tax identity evidence', () => {
    const evidence = createTaxReportingEvidence();
    const report = runWorkersCoordinatorPublisherTaxReportingGate({
      revenueReportingReport: createRevenueReportingReport(),
      taxReportingEvidence: createTaxReportingEvidence({
        publisherTaxProfiles: evidence.publisherTaxProfiles.map((profile) =>
          profile.publisherId === 'publisher:newsroom-a'
            ? { ...profile, taxpayerIdLast4: '', withholdingHoldReason: 'missing-taxpayer-id', payable: false }
            : profile,
        ),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.taxHolds).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        withholdingHoldReason: 'missing-taxpayer-id',
      }),
    ]);
    expect(report.failureReason).toBe('publisher-tax-reporting-tax-profile-invalid-or-held: publisher:newsroom-a');
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-reporting-tax-profile-remediation']);
  });

  it('holds when a tax-year summary no longer matches monthly statement totals', () => {
    const evidence = createTaxReportingEvidence();
    const report = runWorkersCoordinatorPublisherTaxReportingGate({
      revenueReportingReport: createRevenueReportingReport(),
      taxReportingEvidence: createTaxReportingEvidence({
        taxYearPublisherSummaries: evidence.taxYearPublisherSummaries.map((summary) =>
          summary.publisherId === 'publisher:docs-b'
            ? { ...summary, netPublisherPayoutUsd: 3.7 }
            : summary,
        ),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-reporting-tax-year-summary-invalid: tax-summary:publisher:docs-b:2026',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-reporting-tax-year-summary-hardening']);
  });

  it('holds when a 1099-K export record is not filing-ready', () => {
    const evidence = createTaxReportingEvidence();
    const report = runWorkersCoordinatorPublisherTaxReportingGate({
      revenueReportingReport: createRevenueReportingReport(),
      taxReportingEvidence: createTaxReportingEvidence({
        tax1099KExportRecords: evidence.tax1099KExportRecords.map((record) =>
          record.publisherId === 'publisher:newsroom-a'
            ? { ...record, readyForFiling: false }
            : record,
        ),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-reporting-1099-k-export-record-invalid: 1099-k:publisher:newsroom-a:2026',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-reporting-1099-k-export-hardening']);
  });

  it('holds when tax exports leak a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxReportingGate({
      revenueReportingReport: createRevenueReportingReport(),
      taxReportingEvidence: createTaxReportingEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-reporting',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-reporting',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-reporting-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-reporting-security-boundary-hardening']);
  });
});
