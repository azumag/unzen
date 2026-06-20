import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport,
} from '../src/workers-coordinator-publisher-tax-production-cutover-readiness.js';
import {
  runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate,
  type WorkersCoordinatorPublisherTaxProductionCallbacksEvidence,
} from '../src/workers-coordinator-publisher-tax-production-callbacks-readiness.js';

function createProductionCutoverReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport> = {},
): WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport {
  const base: WorkersCoordinatorPublisherTaxProductionCutoverReadinessReport = {
    runtime: 'publisher-tax-filing-production-cutover-readiness-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
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
    productionCutoverSummary: {
      sandboxProviderFilingIdCount: 2,
      approvedSandboxProviderFilingIdCount: 2,
      liveProviderPreflightCount: 1,
      duplicateFilingSuppressionCount: 1,
      rollbackControlCount: 2,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher tax provider sandbox filing gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringProductionCutover: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-tax-production-cutover',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-callbacks-readiness'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createProductionCallbacksEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionCallbacksEvidence> = {},
): WorkersCoordinatorPublisherTaxProductionCallbacksEvidence {
  const base: WorkersCoordinatorPublisherTaxProductionCallbacksEvidence = {
    source: 'publisher-tax-filing-production-callbacks-readiness',
    capturedAtMs: 1_783_310_700_000,
    callbacksEnabledByApprovalId: 'tax-production-cutover-approval:publisher-rewards:2026:001',
    productionProviderCallbacks: [
      {
        callbackId: 'production-callback:publisher-rewards:2026:accepted:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
        providerTraceId: 'irs-fire-production-callback-trace:2026:accepted:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        receivedAtMs: 1_783_310_700_000,
        signatureVerified: true,
        eventType: 'filing.accepted',
        duplicateFilingSuppressed: true,
      },
      {
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        providerTraceId: 'irs-fire-production-callback-trace:2026:duplicate:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        receivedAtMs: 1_783_310_710_000,
        signatureVerified: true,
        eventType: 'filing.duplicate_suppressed',
        duplicateFilingSuppressed: true,
      },
    ],
    duplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
    rollbackPlanIds: ['rollback-plan:publisher-tax-production-cutover:2026:001'],
    emergencyHoldSwitchIds: ['emergency-hold:publisher-tax-production-cutover:2026:001'],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/tax-production-callbacks',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-production-callbacks',
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

describe('Workers Coordinator publisher tax filing production callbacks readiness gate', () => {
  it('promotes when signed callbacks reconcile to the approved window and controls remain linked', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate({
      productionCutoverReport: createProductionCutoverReport(),
      productionCallbacksEvidence: createProductionCallbacksEvidence(),
    });

    expect(report.runtime).toBe('publisher-tax-filing-production-callbacks-readiness-gate');
    expect(report.status).toBe('pass');
    expect(report.cutoverApprovalEvidence).toMatchObject({
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
      callbackEnableAtMs: 1_783_310_620_000,
      productionCallbacksEnabled: false,
    });
    expect(report.productionProviderCallbacks).toEqual([
      expect.objectContaining({
        callbackId: 'production-callback:publisher-rewards:2026:accepted:001',
        signatureVerified: true,
        eventType: 'filing.accepted',
        duplicateFilingSuppressed: true,
      }),
      expect.objectContaining({
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
        signatureVerified: true,
        eventType: 'filing.duplicate_suppressed',
        duplicateFilingSuppressed: true,
      }),
    ]);
    expect(report.productionCallbacksSummary).toEqual({
      callbackCount: 2,
      signedCallbackCount: 2,
      approvedWindowCallbackCount: 2,
      duplicateFilingSuppressionCount: 1,
      rollbackControlCount: 2,
    });
    expect(report.securityBoundaryDuringProductionCallbacks).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringProductionCallbacks.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-tax-production-callbacks',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-monitoring-reconciliation']);
  });

  it('holds when upstream production cutover readiness has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate({
      productionCutoverReport: createProductionCutoverReport({
        status: 'fail',
        failureReason: 'publisher-tax-production-cutover-window-invalid: missing-window',
      }),
      productionCallbacksEvidence: createProductionCallbacksEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-cutover-readiness-gate-not-clean: publisher-tax-production-cutover-window-invalid: missing-window',
    );
  });

  it('holds when a production callback is unsigned or outside the approved window', () => {
    const evidence = createProductionCallbacksEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate({
      productionCutoverReport: createProductionCutoverReport(),
      productionCallbacksEvidence: createProductionCallbacksEvidence({
        productionProviderCallbacks: evidence.productionProviderCallbacks.map((callback, index) => index === 0
          ? {
              ...callback,
              productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:wrong',
              signatureVerified: false,
            }
          : callback),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-callbacks-invalid: production-callback:publisher-rewards:2026:accepted:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-callbacks-signature-reconciliation-hardening']);
  });

  it('holds when duplicate-filing suppression is no longer linked', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate({
      productionCutoverReport: createProductionCutoverReport(),
      productionCallbacksEvidence: createProductionCallbacksEvidence({
        duplicateFilingSuppressionIds: [],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe('publisher-tax-production-callbacks-duplicate-filing-suppression-not-linked');
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-callbacks-duplicate-suppression-hardening']);
  });

  it('holds when production callback ingestion leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionCallbacksReadinessGate({
      productionCutoverReport: createProductionCutoverReport(),
      productionCallbacksEvidence: createProductionCallbacksEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-production-callbacks',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-production-callbacks',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-callbacks-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-callbacks-security-boundary-hardening']);
  });
});
