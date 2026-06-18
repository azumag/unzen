import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherTaxFilingDeliveryReport,
} from '../src/workers-coordinator-publisher-tax-filing-delivery.js';
import {
  runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate,
  type WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence,
} from '../src/workers-coordinator-publisher-tax-provider-sandbox-filing.js';

function createTaxFilingDeliveryReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxFilingDeliveryReport> = {},
): WorkersCoordinatorPublisherTaxFilingDeliveryReport {
  const base: WorkersCoordinatorPublisherTaxFilingDeliveryReport = {
    runtime: 'publisher-reward-tax-filing-delivery-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
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
        publisherDeliveryId: 'tax-doc-delivery:publisher:newsroom-a:2026',
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
        ],
        reconciled: true,
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
    taxFilingDeliverySummary: {
      taxYear: 2026,
      packetCount: 1,
      acceptedFilingCount: 1,
      rejectedFilingCount: 1,
      deliveredDocumentCount: 2,
      correctedFormCount: 1,
      deadlineAlertCount: 1,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher tax reporting and 1099-K export gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringTaxFilingDelivery: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-tax-filing-delivery',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-tax-filing-real-provider-sandbox-run'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createSandboxFilingEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence> = {},
): WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence {
  const base: WorkersCoordinatorPublisherTaxProviderSandboxFilingEvidence = {
    source: 'publisher-tax-filing-real-provider-sandbox-run',
    capturedAtMs: 1_783_210_000_000,
    sandboxRuns: [
      {
        runId: 'tax-provider-sandbox-run:publisher-rewards:2026:001',
        provider: 'irs-fire',
        environment: 'sandbox',
        filingPacketId: 'tax-filing-packet:publisher-rewards:2026:001',
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
        ],
        retryEvidenceIds: ['filing-retry:publisher-rewards:2026:001'],
        submission: {
          submissionId: 'sandbox-submission:publisher-rewards:2026:001',
          providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
          providerTraceId: 'irs-fire-sandbox-trace:2026:001',
          idempotencyKey: 'tax-filing-sandbox-idempotency:publisher-rewards:2026:001',
          submittedAtMs: 1_783_210_010_000,
          completedAtMs: 1_783_210_080_000,
          status: 'rejected',
          rejectionReason: 'provider schema rejected corrected-form sequence number',
        },
        callbacks: [
          {
            callbackId: 'sandbox-callback:publisher-rewards:2026:rejected:001',
            providerTraceId: 'irs-fire-sandbox-trace:2026:001',
            receivedAtMs: 1_783_210_090_000,
            signatureVerified: true,
            eventType: 'filing.rejected',
          },
        ],
      },
      {
        runId: 'tax-provider-sandbox-run:publisher-rewards:2026:002',
        provider: 'irs-fire',
        environment: 'sandbox',
        filingPacketId: 'tax-filing-packet:publisher-rewards:2026:001',
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
          '1099-k-corrected:publisher:newsroom-a:2026:001',
        ],
        retryEvidenceIds: ['filing-retry:publisher-rewards:2026:001'],
        submission: {
          submissionId: 'sandbox-submission:publisher-rewards:2026:002',
          providerFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
          providerTraceId: 'irs-fire-sandbox-trace:2026:002',
          idempotencyKey: 'tax-filing-sandbox-idempotency:publisher-rewards:2026:002',
          submittedAtMs: 1_783_210_110_000,
          completedAtMs: 1_783_210_180_000,
          status: 'accepted',
          rejectionReason: null,
        },
        callbacks: [
          {
            callbackId: 'sandbox-callback:publisher-rewards:2026:accepted:001',
            providerTraceId: 'irs-fire-sandbox-trace:2026:002',
            receivedAtMs: 1_783_210_090_000,
            signatureVerified: true,
            eventType: 'filing.accepted',
          },
        ],
      },
    ],
    sandboxReconciliations: [
      {
        reconciliationId: 'sandbox-reconciliation:publisher-rewards:2026:001',
        sandboxRunIds: [
          'tax-provider-sandbox-run:publisher-rewards:2026:001',
          'tax-provider-sandbox-run:publisher-rewards:2026:002',
        ],
        providerFilingIds: ['irs-fire-filing:publisher-rewards:2026:002'],
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
          '1099-k-corrected:publisher:newsroom-a:2026:001',
        ],
        accountingExportIds: ['accounting-export:publisher-rewards:weekly:2026-06-12:001'],
        correctedFormWorkflowIds: ['tax-correction:publisher:newsroom-a:refund:2026:001'],
        publisherDeliveryIds: [
          'tax-doc-delivery:publisher:newsroom-a:2026',
          'tax-doc-delivery:publisher:docs-b:2026',
        ],
        postFilingAuditIds: ['post-filing-audit:publisher-rewards:2026'],
        emergencyControlIds: ['emergency-control:publisher-rewards:payout-ops:weekly'],
        reconciled: true,
      },
    ],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/tax-provider-sandbox-filing',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-provider-sandbox-filing',
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

describe('Workers Coordinator publisher tax filing real provider sandbox run gate', () => {
  it('promotes when sandbox provider submissions, callbacks, reconciliation, and security pass', () => {
    const report = runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate({
      taxFilingDeliveryReport: createTaxFilingDeliveryReport(),
      sandboxFilingEvidence: createSandboxFilingEvidence(),
    });

    expect(report.runtime).toBe('publisher-tax-filing-real-provider-sandbox-run-gate');
    expect(report.status).toBe('pass');
    expect(report.sandboxRuns).toEqual([
      expect.objectContaining({
        runId: 'tax-provider-sandbox-run:publisher-rewards:2026:001',
        provider: 'irs-fire',
        environment: 'sandbox',
        filingPacketId: 'tax-filing-packet:publisher-rewards:2026:001',
      }),
      expect.objectContaining({
        runId: 'tax-provider-sandbox-run:publisher-rewards:2026:002',
        provider: 'irs-fire',
        environment: 'sandbox',
        filingPacketId: 'tax-filing-packet:publisher-rewards:2026:001',
      }),
    ]);
    expect(report.sandboxRuns[0]?.submission).toMatchObject({
      providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
      providerTraceId: 'irs-fire-sandbox-trace:2026:001',
      idempotencyKey: 'tax-filing-sandbox-idempotency:publisher-rewards:2026:001',
      status: 'rejected',
      rejectionReason: 'provider schema rejected corrected-form sequence number',
    });
    expect(report.sandboxRuns[0]?.callbacks).toEqual([
      expect.objectContaining({
        providerTraceId: 'irs-fire-sandbox-trace:2026:001',
        signatureVerified: true,
        eventType: 'filing.rejected',
      }),
    ]);
    expect(report.sandboxReconciliations).toEqual([
      expect.objectContaining({
        providerFilingIds: ['irs-fire-filing:publisher-rewards:2026:002'],
        taxExportRecordIds: [
          '1099-k:publisher:newsroom-a:2026',
          '1099-k:publisher:docs-b:2026',
          '1099-k-corrected:publisher:newsroom-a:2026:001',
        ],
        accountingExportIds: ['accounting-export:publisher-rewards:weekly:2026-06-12:001'],
        correctedFormWorkflowIds: ['tax-correction:publisher:newsroom-a:refund:2026:001'],
        publisherDeliveryIds: [
          'tax-doc-delivery:publisher:newsroom-a:2026',
          'tax-doc-delivery:publisher:docs-b:2026',
        ],
        postFilingAuditIds: ['post-filing-audit:publisher-rewards:2026'],
        emergencyControlIds: ['emergency-control:publisher-rewards:payout-ops:weekly'],
        reconciled: true,
      }),
    ]);
    expect(report.sandboxFilingSummary).toEqual({
      runCount: 2,
      acceptedSubmissionCount: 1,
      rejectedSubmissionCount: 1,
      callbackCount: 2,
      reconciledRunCount: 2,
    });
    expect(report.securityBoundaryDuringProviderSandboxFiling).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringProviderSandboxFiling.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-tax-provider-sandbox-filing',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-cutover-readiness']);
  });

  it('holds when upstream tax filing delivery has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate({
      taxFilingDeliveryReport: createTaxFilingDeliveryReport({
        status: 'fail',
        failureReason: 'publisher-tax-filing-delivery-post-filing-audit-invalid: post-filing-audit:broken',
      }),
      sandboxFilingEvidence: createSandboxFilingEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-filing-delivery-gate-not-clean: publisher-tax-filing-delivery-post-filing-audit-invalid: post-filing-audit:broken',
    );
  });

  it('holds when provider callbacks are unsigned or missing for the sandbox submission', () => {
    const evidence = createSandboxFilingEvidence();
    const report = runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate({
      taxFilingDeliveryReport: createTaxFilingDeliveryReport(),
      sandboxFilingEvidence: createSandboxFilingEvidence({
        sandboxRuns: evidence.sandboxRuns.map((run) => ({
          ...run,
          callbacks: run.callbacks.map((callback) => ({
            ...callback,
            signatureVerified: false,
          })),
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-provider-sandbox-filing-run-invalid: tax-provider-sandbox-run:publisher-rewards:2026:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-provider-sandbox-run-hardening']);
  });

  it('holds when sandbox reconciliation does not link publisher deliveries and post-filing audit evidence', () => {
    const evidence = createSandboxFilingEvidence();
    const report = runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate({
      taxFilingDeliveryReport: createTaxFilingDeliveryReport(),
      sandboxFilingEvidence: createSandboxFilingEvidence({
        sandboxReconciliations: evidence.sandboxReconciliations.map((reconciliation) => ({
          ...reconciliation,
          publisherDeliveryIds: [],
          reconciled: false,
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-provider-sandbox-filing-reconciliation-invalid: sandbox-reconciliation:publisher-rewards:2026:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-provider-sandbox-reconciliation-hardening']);
  });

  it('holds when sandbox filing leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxProviderSandboxFilingGate({
      taxFilingDeliveryReport: createTaxFilingDeliveryReport(),
      sandboxFilingEvidence: createSandboxFilingEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-provider-sandbox-filing',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-provider-sandbox-filing',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-provider-sandbox-filing-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-provider-sandbox-security-boundary-hardening']);
  });
});
