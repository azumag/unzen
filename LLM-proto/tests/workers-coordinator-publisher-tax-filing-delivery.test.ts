import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherTaxReportingReport,
} from '../src/workers-coordinator-publisher-tax-reporting.js';
import {
  runWorkersCoordinatorPublisherTaxFilingDeliveryGate,
  type WorkersCoordinatorPublisherTaxFilingDeliveryEvidence,
} from '../src/workers-coordinator-publisher-tax-filing-delivery.js';

function createTaxReportingReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxReportingReport> = {},
): WorkersCoordinatorPublisherTaxReportingReport {
  const base: WorkersCoordinatorPublisherTaxReportingReport = {
    runtime: 'publisher-reward-tax-reporting-1099-k-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
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
      {
        exportRecordId: '1099-k-corrected:publisher:newsroom-a:2026:001',
        publisherId: 'publisher:newsroom-a',
        taxYear: 2026,
        taxFormType: '1099-K',
        payoutProviderAccountId: 'acct_newsroom_a',
        grossReportableUsd: 4.75,
        adjustmentUsd: 0.5,
        netPayoutUsd: 2.75,
        generatedAtMs: 1_783_124_110_000,
        readyForFiling: true,
      },
    ],
    taxExportReconciliation: [
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
    ],
    taxHolds: [],
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
    taxReportingSummary: {
      currency: 'USD',
      taxYear: 2026,
      publisherCount: 2,
      grossReportableUsd: 10,
      adjustmentUsd: 0.35,
      netPayoutUsd: 6.8,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher payout operations revenue reporting gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringTaxReporting: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-tax-reporting',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-tax-filing-drill-and-publisher-delivery'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createTaxFilingDeliveryEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxFilingDeliveryEvidence> = {},
): WorkersCoordinatorPublisherTaxFilingDeliveryEvidence {
  const base: WorkersCoordinatorPublisherTaxFilingDeliveryEvidence = {
    source: 'publisher-reward-tax-filing-drill-delivery',
    capturedAtMs: 1_783_124_200_000,
    providerFilingPackets: [
      {
        packetId: 'tax-filing-packet:publisher-rewards:2026:001',
        provider: 'irs-fire',
        taxYear: 2026,
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
          '1099-k-corrected:publisher:newsroom-a:2026:001',
        ],
        filingAttempts: [
          {
            filingId: 'irs-fire-filing:publisher-rewards:2026:001',
            submittedAtMs: 1_783_124_210_000,
            status: 'rejected',
            rejectionReason: 'provider schema rejected corrected-form sequence number',
          },
          {
            filingId: 'irs-fire-filing:publisher-rewards:2026:002',
            submittedAtMs: 1_783_124_260_000,
            status: 'accepted',
            rejectionReason: null,
          },
        ],
        retryEvidence: [
          {
            retryId: 'filing-retry:publisher-rewards:2026:001',
            previousRejectedFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
            retryFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
            attemptedAtMs: 1_783_124_255_000,
            resolved: true,
          },
        ],
      },
    ],
    publisherDocumentDeliveries: [
      {
        deliveryId: 'tax-doc-delivery:publisher:newsroom-a:2026',
        publisherId: 'publisher:newsroom-a',
        taxExportRecordId: '1099-k:publisher:newsroom-a:2026',
        portalDocumentId: 'portal-tax-doc:publisher:newsroom-a:2026',
        deliveredAtMs: 1_783_124_300_000,
        acknowledgedAtMs: 1_783_124_360_000,
        downloadEvidence: [
          {
            downloadId: 'tax-doc-download:publisher:newsroom-a:2026:001',
            downloadedAtMs: 1_783_124_340_000,
            requesterIpHash: 'sha256:newsroom-a-download-ip',
          },
        ],
      },
      {
        deliveryId: 'tax-doc-delivery:publisher:docs-b:2026',
        publisherId: 'publisher:docs-b',
        taxExportRecordId: '1099-k:publisher:docs-b:2026',
        portalDocumentId: 'portal-tax-doc:publisher:docs-b:2026',
        deliveredAtMs: 1_783_124_310_000,
        acknowledgedAtMs: 1_783_124_370_000,
        downloadEvidence: [
          {
            downloadId: 'tax-doc-download:publisher:docs-b:2026:001',
            downloadedAtMs: 1_783_124_350_000,
            requesterIpHash: 'sha256:docs-b-download-ip',
          },
        ],
      },
      {
        deliveryId: 'tax-doc-delivery:publisher:newsroom-a:2026:corrected:001',
        publisherId: 'publisher:newsroom-a',
        taxExportRecordId: '1099-k-corrected:publisher:newsroom-a:2026:001',
        portalDocumentId: 'portal-tax-doc:publisher:newsroom-a:2026:corrected:001',
        deliveredAtMs: 1_783_124_380_000,
        acknowledgedAtMs: 1_783_124_420_000,
        downloadEvidence: [
          {
            downloadId: 'tax-doc-download:publisher:newsroom-a:2026:corrected:001',
            downloadedAtMs: 1_783_124_400_000,
            requesterIpHash: 'sha256:newsroom-a-corrected-download-ip',
          },
        ],
      },
    ],
    correctedFormWorkflows: [
      {
        correctionId: 'tax-correction:publisher:newsroom-a:refund:2026:001',
        originalTaxExportRecordId: '1099-k:publisher:newsroom-a:2026',
        correctedTaxExportRecordId: '1099-k-corrected:publisher:newsroom-a:2026:001',
        adjustmentIds: ['adjustment:refund:publisher:newsroom-a:2026-06:001'],
        reason: 'refund',
        generatedAtMs: 1_783_124_230_000,
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
        publisherDeliveryId: 'tax-doc-delivery:publisher:newsroom-a:2026:corrected:001',
      },
    ],
    filingDeadlineAlerts: [
      {
        alertId: 'tax-deadline-alert:publisher-rewards:2026:001',
        taxYear: 2026,
        deadlineAtMs: 1_785_456_000_000,
        escalatedAtMs: 1_784_678_400_000,
        operatorId: 'operator:tax-ops-lead',
        acknowledgedAtMs: 1_784_678_460_000,
      },
    ],
    postFilingAuditEvidence: [
      {
        auditId: 'post-filing-audit:publisher-rewards:2026',
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
          '1099-k-corrected:publisher:newsroom-a:2026:001',
        ],
        accountingExportIds: ['accounting-export:publisher-rewards:weekly:2026-06-12:001'],
        emergencyControlIds: ['emergency-control:publisher-rewards:payout-ops:weekly'],
        providerFilingIds: ['irs-fire-filing:publisher-rewards:2026:002'],
        publisherDeliveryIds: [
          'tax-doc-delivery:publisher:newsroom-a:2026',
          'tax-doc-delivery:publisher:docs-b:2026',
          'tax-doc-delivery:publisher:newsroom-a:2026:corrected:001',
        ],
        reconciled: true,
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
        url: 'https://coordinator.unzen.dev/payouts/tax-filing-delivery',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-filing-delivery',
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

describe('Workers Coordinator publisher reward tax filing drill / publisher delivery gate', () => {
  it('promotes tax filing delivery when provider packets, portal delivery, corrections, alerts, audit, controls, and security pass', () => {
    const report = runWorkersCoordinatorPublisherTaxFilingDeliveryGate({
      taxReportingReport: createTaxReportingReport(),
      taxFilingDeliveryEvidence: createTaxFilingDeliveryEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-tax-filing-delivery-gate');
    expect(report.status).toBe('pass');
    expect(report.providerFilingPackets).toEqual([
      expect.objectContaining({
        packetId: 'tax-filing-packet:publisher-rewards:2026:001',
        provider: 'irs-fire',
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
          '1099-k-corrected:publisher:newsroom-a:2026:001',
        ],
      }),
    ]);
    expect(report.providerFilingPackets[0]?.filingAttempts.map((attempt) => attempt.status)).toEqual([
      'rejected',
      'accepted',
    ]);
    expect(report.providerFilingPackets[0]?.retryEvidence).toEqual([
      expect.objectContaining({
        previousRejectedFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        retryFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
        resolved: true,
      }),
    ]);
    expect(report.publisherDocumentDeliveries).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        portalDocumentId: 'portal-tax-doc:publisher:newsroom-a:2026',
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        downloadEvidence: [expect.objectContaining({ requesterIpHash: 'sha256:docs-b-download-ip' })],
      }),
      expect.objectContaining({
        taxExportRecordId: '1099-k-corrected:publisher:newsroom-a:2026:001',
      }),
    ]);
    expect(report.correctedFormWorkflows).toEqual([
      expect.objectContaining({
        correctionId: 'tax-correction:publisher:newsroom-a:refund:2026:001',
        adjustmentIds: ['adjustment:refund:publisher:newsroom-a:2026-06:001'],
      }),
    ]);
    expect(report.filingDeadlineAlerts).toEqual([
      expect.objectContaining({
        operatorId: 'operator:tax-ops-lead',
      }),
    ]);
    expect(report.postFilingAuditEvidence).toEqual([
      expect.objectContaining({
        accountingExportIds: ['accounting-export:publisher-rewards:weekly:2026-06-12:001'],
        emergencyControlIds: ['emergency-control:publisher-rewards:payout-ops:weekly'],
        reconciled: true,
      }),
    ]);
    expect(report.taxFilingDeliverySummary).toEqual({
      taxYear: 2026,
      packetCount: 1,
      acceptedFilingCount: 1,
      rejectedFilingCount: 1,
      deliveredDocumentCount: 3,
      correctedFormCount: 1,
      deadlineAlertCount: 1,
    });
    expect(report.emergencyHoldRollbackControls).toEqual([
      expect.objectContaining({
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      }),
    ]);
    expect(report.securityBoundaryDuringTaxFilingDelivery).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringTaxFilingDelivery.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-tax-filing-delivery',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-real-provider-sandbox-run']);
  });

  it('holds when upstream tax reporting has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxFilingDeliveryGate({
      taxReportingReport: createTaxReportingReport({
        status: 'fail',
        failureReason: 'publisher-tax-reporting-1099-k-export-record-invalid: 1099-k:broken',
      }),
      taxFilingDeliveryEvidence: createTaxFilingDeliveryEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-reporting-gate-not-clean: publisher-tax-reporting-1099-k-export-record-invalid: 1099-k:broken',
    );
  });

  it('holds when provider filing packets lack a rejected state and retry evidence', () => {
    const evidence = createTaxFilingDeliveryEvidence();
    const report = runWorkersCoordinatorPublisherTaxFilingDeliveryGate({
      taxReportingReport: createTaxReportingReport(),
      taxFilingDeliveryEvidence: createTaxFilingDeliveryEvidence({
        providerFilingPackets: evidence.providerFilingPackets.map((packet) => ({
          ...packet,
          filingAttempts: packet.filingAttempts.filter((attempt) => attempt.status === 'accepted'),
          retryEvidence: [],
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-filing-delivery-provider-filing-packet-invalid: tax-filing-packet:publisher-rewards:2026:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-provider-handoff-hardening']);
  });

  it('holds when a publisher delivery lacks download evidence', () => {
    const evidence = createTaxFilingDeliveryEvidence();
    const report = runWorkersCoordinatorPublisherTaxFilingDeliveryGate({
      taxReportingReport: createTaxReportingReport(),
      taxFilingDeliveryEvidence: createTaxFilingDeliveryEvidence({
        publisherDocumentDeliveries: evidence.publisherDocumentDeliveries.map((delivery) =>
          delivery.publisherId === 'publisher:docs-b'
            ? { ...delivery, downloadEvidence: [] }
            : delivery,
        ),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-filing-delivery-publisher-document-invalid: tax-doc-delivery:publisher:docs-b:2026',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-portal-delivery-hardening']);
  });

  it('holds when post-filing audit evidence does not reconcile accounting exports and emergency controls', () => {
    const evidence = createTaxFilingDeliveryEvidence();
    const report = runWorkersCoordinatorPublisherTaxFilingDeliveryGate({
      taxReportingReport: createTaxReportingReport(),
      taxFilingDeliveryEvidence: createTaxFilingDeliveryEvidence({
        postFilingAuditEvidence: evidence.postFilingAuditEvidence.map((audit) => ({
          ...audit,
          emergencyControlIds: [],
          reconciled: false,
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-filing-delivery-post-filing-audit-invalid: post-filing-audit:publisher-rewards:2026',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-post-filing-audit-hardening']);
  });

  it('holds when tax filing delivery leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxFilingDeliveryGate({
      taxReportingReport: createTaxReportingReport(),
      taxFilingDeliveryEvidence: createTaxFilingDeliveryEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-filing-delivery',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-filing-delivery',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-filing-delivery-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-security-boundary-hardening']);
  });
});
