import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherTaxProviderSandboxFilingReport,
} from '../src/workers-coordinator-publisher-tax-provider-sandbox-filing.js';
import {
  runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate,
  type WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence,
} from '../src/workers-coordinator-publisher-tax-production-cutover-readiness.js';

function createSandboxFilingReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProviderSandboxFilingReport> = {},
): WorkersCoordinatorPublisherTaxProviderSandboxFilingReport {
  const base: WorkersCoordinatorPublisherTaxProviderSandboxFilingReport = {
    runtime: 'publisher-tax-filing-real-provider-sandbox-run-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
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
            receivedAtMs: 1_783_210_190_000,
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
    sandboxFilingSummary: {
      runCount: 2,
      acceptedSubmissionCount: 1,
      rejectedSubmissionCount: 1,
      callbackCount: 2,
      reconciledRunCount: 2,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['real provider sandbox run submits known provider filing packets with idempotency keys'],
      holdReasons: [],
    },
    securityBoundaryDuringProviderSandboxFiling: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-tax-provider-sandbox-filing',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-cutover-readiness'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createProductionCutoverEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence> = {},
): WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence {
  const base: WorkersCoordinatorPublisherTaxProductionCutoverReadinessEvidence = {
    source: 'publisher-tax-filing-production-cutover-readiness',
    capturedAtMs: 1_783_310_000_000,
    sandboxProviderFilingIds: [
      'irs-fire-filing:publisher-rewards:2026:001',
      'irs-fire-filing:publisher-rewards:2026:002',
    ],
    operatorApprovalEvidence: {
      approvalId: 'tax-production-cutover-approval:publisher-rewards:2026:001',
      operatorId: 'operator:tax-ops-lead',
      approvedAtMs: 1_783_310_010_000,
      productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      approvedSandboxProviderFilingIds: [
        'irs-fire-filing:publisher-rewards:2026:001',
        'irs-fire-filing:publisher-rewards:2026:002',
      ],
      duplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
      rollbackPlanId: 'rollback-plan:publisher-tax-production-cutover:2026:001',
      emergencyHoldSwitchId: 'emergency-hold:publisher-tax-production-cutover:2026:001',
    },
    productionFilingWindow: {
      windowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      provider: 'irs-fire',
      environment: 'production',
      opensAtMs: 1_783_310_020_000,
      closesAtMs: 1_783_310_320_000,
      callbackEnableAtMs: 1_783_310_620_000,
      filingMode: 'preflight-only',
      duplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
      liveMoneyMovementSuppressed: true,
      productionCallbacksEnabled: false,
    },
    liveProviderPreflightEvidence: [
      {
        preflightId: 'live-provider-preflight:publisher-rewards:2026:001',
        provider: 'irs-fire',
        endpointMode: 'production-preflight',
        providerAccountId: 'irs-fire-production-account:publisher-rewards',
        checkedAtMs: 1_783_310_120_000,
        dryRun: true,
        wouldSubmitFiling: false,
        duplicateFilingSuppressed: true,
        providerTraceId: 'irs-fire-production-preflight-trace:2026:001',
      },
    ],
    preservedSandboxEvidence: {
      acceptedProviderFilingIds: ['irs-fire-filing:publisher-rewards:2026:002'],
      rejectedProviderFilingIds: ['irs-fire-filing:publisher-rewards:2026:001'],
      retryEvidenceIds: ['filing-retry:publisher-rewards:2026:001'],
      publisherDeliveryIds: [
        'tax-doc-delivery:publisher:newsroom-a:2026',
        'tax-doc-delivery:publisher:docs-b:2026',
      ],
      correctedFormWorkflowIds: ['tax-correction:publisher:newsroom-a:refund:2026:001'],
      postFilingAuditIds: ['post-filing-audit:publisher-rewards:2026'],
    },
    emergencyReadiness: {
      emergencyControlIds: ['emergency-control:publisher-rewards:payout-ops:weekly'],
      rollbackPlanIds: ['rollback-plan:publisher-tax-production-cutover:2026:001'],
      emergencyHoldSwitchIds: ['emergency-hold:publisher-tax-production-cutover:2026:001'],
      verifiedAtMs: 1_783_310_200_000,
      productionCallbacksEnabledAfterVerification: false,
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/tax-production-cutover',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-production-cutover',
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

describe('Workers Coordinator publisher tax filing production cutover readiness gate', () => {
  it('promotes when sandbox IDs, production preflight, rollback controls, and security pass', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate({
      sandboxFilingReport: createSandboxFilingReport(),
      productionCutoverEvidence: createProductionCutoverEvidence(),
    });

    expect(report.runtime).toBe('publisher-tax-filing-production-cutover-readiness-gate');
    expect(report.status).toBe('pass');
    expect(report.sandboxProviderFilingIds).toEqual([
      'irs-fire-filing:publisher-rewards:2026:001',
      'irs-fire-filing:publisher-rewards:2026:002',
    ]);
    expect(report.operatorApprovalEvidence).toMatchObject({
      approvalId: 'tax-production-cutover-approval:publisher-rewards:2026:001',
      productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      approvedSandboxProviderFilingIds: [
        'irs-fire-filing:publisher-rewards:2026:001',
        'irs-fire-filing:publisher-rewards:2026:002',
      ],
    });
    expect(report.productionFilingWindow).toMatchObject({
      environment: 'production',
      filingMode: 'preflight-only',
      liveMoneyMovementSuppressed: true,
      productionCallbacksEnabled: false,
      duplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
    });
    expect(report.liveProviderPreflightEvidence).toEqual([
      expect.objectContaining({
        endpointMode: 'production-preflight',
        dryRun: true,
        wouldSubmitFiling: false,
        duplicateFilingSuppressed: true,
      }),
    ]);
    expect(report.preservedSandboxEvidence).toEqual({
      acceptedProviderFilingIds: ['irs-fire-filing:publisher-rewards:2026:002'],
      rejectedProviderFilingIds: ['irs-fire-filing:publisher-rewards:2026:001'],
      retryEvidenceIds: ['filing-retry:publisher-rewards:2026:001'],
      publisherDeliveryIds: [
        'tax-doc-delivery:publisher:newsroom-a:2026',
        'tax-doc-delivery:publisher:docs-b:2026',
      ],
      correctedFormWorkflowIds: ['tax-correction:publisher:newsroom-a:refund:2026:001'],
      postFilingAuditIds: ['post-filing-audit:publisher-rewards:2026'],
    });
    expect(report.productionCutoverSummary).toEqual({
      sandboxProviderFilingIdCount: 2,
      approvedSandboxProviderFilingIdCount: 2,
      liveProviderPreflightCount: 1,
      duplicateFilingSuppressionCount: 1,
      rollbackControlCount: 2,
    });
    expect(report.securityBoundaryDuringProductionCutover).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringProductionCutover.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-tax-production-cutover',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-callbacks-readiness']);
  });

  it('holds when upstream provider sandbox filing has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate({
      sandboxFilingReport: createSandboxFilingReport({
        status: 'fail',
        failureReason: 'publisher-tax-provider-sandbox-filing-reconciliation-invalid: sandbox-reconciliation:broken',
      }),
      productionCutoverEvidence: createProductionCutoverEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-provider-sandbox-filing-gate-not-clean: publisher-tax-provider-sandbox-filing-reconciliation-invalid: sandbox-reconciliation:broken',
    );
  });

  it('holds when live-provider preflight would submit a filing instead of suppressing duplicates', () => {
    const evidence = createProductionCutoverEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate({
      sandboxFilingReport: createSandboxFilingReport(),
      productionCutoverEvidence: createProductionCutoverEvidence({
        liveProviderPreflightEvidence: evidence.liveProviderPreflightEvidence.map((preflight) => ({
          ...preflight,
          dryRun: false,
          wouldSubmitFiling: true,
          duplicateFilingSuppressed: false,
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-cutover-live-provider-preflight-invalid: live-provider-preflight:publisher-rewards:2026:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-cutover-live-provider-preflight-hardening']);
  });

  it('holds when rollback and emergency hold controls are not verified before callbacks', () => {
    const evidence = createProductionCutoverEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate({
      sandboxFilingReport: createSandboxFilingReport(),
      productionCutoverEvidence: createProductionCutoverEvidence({
        emergencyReadiness: {
          ...evidence.emergencyReadiness,
          rollbackPlanIds: [],
          productionCallbacksEnabledAfterVerification: true,
        },
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('publisher-tax-production-cutover-emergency-readiness-invalid');
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-cutover-rollback-hold-hardening']);
  });

  it('holds when production cutover leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCutoverReadinessGate({
      sandboxFilingReport: createSandboxFilingReport(),
      productionCutoverEvidence: createProductionCutoverEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-production-cutover',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-production-cutover',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-cutover-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-cutover-security-boundary-hardening']);
  });
});
