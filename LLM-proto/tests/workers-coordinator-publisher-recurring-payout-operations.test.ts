import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport,
} from '../src/workers-coordinator-publisher-live-money-payout-pilot.js';
import {
  runWorkersCoordinatorPublisherRecurringPayoutOperationsGate,
  type WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence,
} from '../src/workers-coordinator-publisher-recurring-payout-operations.js';

function createLivePayoutReport(
  overrides: Partial<WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport> = {},
): WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport {
  const base: WorkersCoordinatorPublisherLiveMoneyPayoutPilotReport = {
    runtime: 'publisher-reward-live-money-payout-pilot-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    operatorReleaseSwitchEvidence: [
      {
        batchId: 'payout-batch:pilot:2026-06-08:001',
        releaseSwitchId: 'release-switch:publisher-payout:pilot:001',
        enabledBy: 'operator:payout-reviewer-01',
        enabledAtMs: 1_779_840_040_000,
        liveMoneyPilotAttestation: true,
        maxPilotPayoutUsd: 10,
        emergencyStopArmed: true,
        controlledOutsideSignedRunner: true,
        blockerReasons: [],
      },
    ],
    providerSettlementCallbacks: [
      {
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        providerDryRunId: 'stripe-dry-run:payout-batch:pilot:2026-06-08:001',
        batchId: 'payout-batch:pilot:2026-06-08:001',
        ledgerEntryIds: [
          'ledger:publisher:newsroom-a:segment-03:001',
          'ledger:publisher:docs-b:segment-04:001',
        ],
        currency: 'USD',
        settledPayoutUsd: 8,
        settledCoordinatorRelaySpendUsd: 2.2,
        status: 'succeeded',
        receivedAtMs: 1_779_840_050_000,
      },
    ],
    livePayoutReconciliation: {
      currency: 'USD',
      dryRunProviderPayoutUsd: 8,
      settledProviderPayoutUsd: 8,
      ledgerPayoutBatchUsd: 8,
      dryRunCoordinatorRelaySpendUsd: 2.2,
      settledCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    },
    publisherReceiptEvidence: [
      {
        publisherId: 'publisher:newsroom-a',
        receiptId: 'receipt:publisher:newsroom-a:payout-live:001',
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        deliveredAtMs: 1_779_840_060_000,
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        includesProviderSettlementCallback: true,
        includesTaxInvoiceMetadata: true,
      },
      {
        publisherId: 'publisher:docs-b',
        receiptId: 'receipt:publisher:docs-b:payout-live:001',
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        deliveredAtMs: 1_779_840_061_000,
        ledgerEntryIds: ['ledger:publisher:docs-b:segment-04:001'],
        includesProviderSettlementCallback: true,
        includesTaxInvoiceMetadata: true,
      },
    ],
    payoutStatusTransitions: [
      {
        ledgerEntryId: 'ledger:publisher:newsroom-a:segment-03:001',
        from: 'submitted',
        to: 'settled',
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        transitionedAtMs: 1_779_840_070_000,
        reason: 'provider settlement callback succeeded',
      },
      {
        ledgerEntryId: 'ledger:publisher:docs-b:segment-04:001',
        from: 'submitted',
        to: 'settled',
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        transitionedAtMs: 1_779_840_071_000,
        reason: 'provider settlement callback succeeded',
      },
    ],
    emergencyHoldRollbackControls: [
      {
        batchId: 'payout-batch:pilot:2026-06-08:001',
        emergencyHoldSwitchId: 'emergency-hold:publisher-payout:pilot:001',
        rollbackPlanId: 'rollback-plan:publisher-payout:pilot:001',
        controlledBy: 'operator:payout-incident-commander',
        armedAtMs: 1_779_840_039_000,
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      },
    ],
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher payout dry-run gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringLivePayout: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-live-money',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-recurring-payout-operations'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createRecurringPayoutEvidence(
  overrides: Partial<WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence> = {},
): WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence {
  const base: WorkersCoordinatorPublisherRecurringPayoutOperationsEvidence = {
    source: 'publisher-reward-recurring-payout-operations',
    capturedAtMs: 1_780_445_430_000,
    scheduledPayoutWindows: [
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
      {
        providerPayoutId: 'stripe-payout:payout-batch:weekly:2026-06-12:pending',
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        status: 'pending',
        retryCount: 1,
        nextRetryAtMs: 1_780_448_700_000,
        backoffPolicy: 'exponential',
        lastFailureReason: null,
      },
      {
        providerPayoutId: 'stripe-payout:payout-batch:weekly:2026-06-12:failed',
        ledgerEntryIds: ['ledger:publisher:docs-b:segment-04:001'],
        status: 'failed',
        retryCount: 2,
        nextRetryAtMs: 1_780_449_600_000,
        backoffPolicy: 'manual-review',
        lastFailureReason: 'provider-webhook-signature-mismatch',
      },
      {
        providerPayoutId: 'stripe-payout:payout-batch:weekly:2026-06-12:delayed',
        ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
        status: 'delayed',
        retryCount: 1,
        nextRetryAtMs: 1_780_450_200_000,
        backoffPolicy: 'exponential',
        lastFailureReason: 'provider-callback-latency-threshold',
      },
    ],
    supportDisputeRoutes: [
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
    ],
    accountingExportReconciliations: [
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
    sloDashboards: [
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
    publisherLevelHolds: [],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/recurring-windows',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-recurring-ops',
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

describe('Workers Coordinator publisher reward recurring payout operations gate', () => {
  it('promotes recurring payout operations when scheduling, retries, accounting, SLO, controls, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport(),
      recurringPayoutEvidence: createRecurringPayoutEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-recurring-payout-operations-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.scheduledPayoutWindowIdempotency).toEqual([
      expect.objectContaining({
        windowId: 'payout-window:weekly:2026-06-12:001',
        idempotencyKey: 'idempotency:publisher-rewards:weekly:2026-06-12:001',
        submissionCount: 1,
        duplicateProviderSubmissionBlocked: true,
      }),
    ]);
    expect(report.providerRetryBackoffLedgers.map((ledger) => ledger.status)).toEqual([
      'settled',
      'pending',
      'failed',
      'delayed',
    ]);
    expect(report.publisherSupportDisputeRouting).toEqual([
      expect.objectContaining({
        disputeId: 'dispute:publisher:newsroom-a:payout:001',
        routedTo: 'publisher-support',
        status: 'triaged',
      }),
    ]);
    expect(report.accountingExportReconciliation).toEqual([
      expect.objectContaining({
        accountingPayoutTotalUsd: 8,
        providerSettlementTotalUsd: 8,
        ledgerPayoutTotalUsd: 8,
        unmatchedLedgerEntryIds: [],
      }),
    ]);
    expect(report.postPilotSloErrorBudgetDashboards).toEqual([
      expect.objectContaining({
        dashboardId: 'slo:publisher-rewards:payout-ops:weekly',
        duplicateSubmissionRate: 0,
        errorBudgetRemainingPercent: 86,
      }),
    ]);
    expect(report.emergencyHoldRollbackControls).toEqual([
      expect.objectContaining({
        emergencyHoldSwitchId: 'emergency-hold:publisher-payout:weekly',
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      }),
    ]);
    expect(report.recurringPayoutReconciliation).toMatchObject({
      currency: 'USD',
      providerSettlementTotalUsd: 8,
      accountingPayoutTotalUsd: 8,
      ledgerPayoutTotalUsd: 8,
      providerCoordinatorRelaySpendUsd: 2.2,
      accountingCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    });
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringRecurringOperations).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringRecurringOperations.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-recurring-ops',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-payout-ops-revenue-reporting']);
  });

  it('holds when the upstream live-money payout pilot gate has not passed', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport({
        status: 'fail',
        failureReason: 'publisher-live-payout-provider-settlement-callback-invalid: stripe-payout:broken',
      }),
      recurringPayoutEvidence: createRecurringPayoutEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-live-money-payout-pilot-gate-not-clean: publisher-live-payout-provider-settlement-callback-invalid: stripe-payout:broken',
    );
  });

  it('holds when a scheduled payout window can double-submit a provider batch', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport(),
      recurringPayoutEvidence: createRecurringPayoutEvidence({
        scheduledPayoutWindows: [
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
            submissionCount: 2,
            duplicateProviderSubmissionBlocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-recurring-payout-scheduled-window-idempotency-invalid: payout-window:weekly:2026-06-12:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-recurring-payout-scheduler-idempotency-hardening']);
  });

  it('holds when provider retry and backoff ledgers omit a callback state', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport(),
      recurringPayoutEvidence: createRecurringPayoutEvidence({
        providerRetryBackoffLedgers: [
          {
            providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
            ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
            status: 'settled',
            retryCount: 0,
            nextRetryAtMs: null,
            backoffPolicy: 'none',
            lastFailureReason: null,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-recurring-payout-provider-retry-backoff-status-missing: pending,failed,delayed',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-recurring-payout-provider-retry-operations']);
  });

  it('holds when accounting export totals do not match provider settlements', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport(),
      recurringPayoutEvidence: createRecurringPayoutEvidence({
        accountingExportReconciliations: [
          {
            exportId: 'accounting-export:publisher-rewards:weekly:2026-06-12:001',
            generatedAtMs: 1_780_445_600_000,
            currency: 'USD',
            accountingPayoutTotalUsd: 8,
            providerSettlementTotalUsd: 7.5,
            ledgerPayoutTotalUsd: 8,
            accountingCoordinatorRelaySpendUsd: 2.2,
            providerCoordinatorRelaySpendUsd: 2.2,
            unmatchedLedgerEntryIds: [],
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-recurring-payout-accounting-export-reconciliation-invalid: accounting-export:publisher-rewards:weekly:2026-06-12:001',
    );
  });

  it('holds when post-pilot SLO and error budget dashboards exceed thresholds', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport(),
      recurringPayoutEvidence: createRecurringPayoutEvidence({
        sloDashboards: [
          {
            dashboardId: 'slo:publisher-rewards:payout-ops:weekly',
            measuredWindowIds: ['payout-window:weekly:2026-06-12:001'],
            callbackP95LatencyMs: 45_000,
            failedPayoutRate: 0.03,
            duplicateSubmissionRate: 0,
            supportDisputeRate: 0.02,
            errorBudgetRemainingPercent: 44,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-recurring-payout-slo-error-budget-dashboard-invalid: slo:publisher-rewards:payout-ops:weekly',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-recurring-payout-slo-dashboard-hardening']);
  });

  it('holds when recurring operations leak a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherRecurringPayoutOperationsGate({
      livePayoutReport: createLivePayoutReport(),
      recurringPayoutEvidence: createRecurringPayoutEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/recurring-windows',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-recurring-ops',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-recurring-payout-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-recurring-payout-security-boundary-hardening']);
  });
});
