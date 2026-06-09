import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherPayoutDryRunReport,
} from '../src/workers-coordinator-publisher-payout-dry-run.js';
import {
  runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate,
  type WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence,
} from '../src/workers-coordinator-publisher-live-money-payout-pilot.js';

function createPayoutDryRunReport(
  overrides: Partial<WorkersCoordinatorPublisherPayoutDryRunReport> = {},
): WorkersCoordinatorPublisherPayoutDryRunReport {
  const base: WorkersCoordinatorPublisherPayoutDryRunReport = {
    runtime: 'publisher-reward-real-money-payout-pilot-dry-run-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    payoutProviderDryRunEvidence: [
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
    payoutDryRunReconciliation: {
      currency: 'USD',
      ledgerPayoutBatchUsd: 8,
      providerDryRunPayoutUsd: 8,
      ledgerCoordinatorRelaySpendUsd: 2.2,
      providerDryRunCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    },
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
    operatorApprovalEvidence: [
      {
        batchId: 'payout-batch:pilot:2026-06-08:001',
        approvedBy: 'operator:payout-reviewer-01',
        approvedAtMs: 1_779_754_040_000,
        dryRunOnlyAttestation: true,
        blockerReasons: [],
      },
    ],
    publisherFacingReconciliationExports: [
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
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['payout provider dry-run totals match ledger payout batch totals'],
      holdReasons: [],
    },
    securityBoundaryDuringPayoutDryRun: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-provider-dry-run',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-reward-live-money-payout-pilot'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createLivePayoutEvidence(
  overrides: Partial<WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence> = {},
): WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence {
  const base: WorkersCoordinatorPublisherLiveMoneyPayoutPilotEvidence = {
    source: 'publisher-reward-live-money-payout-pilot',
    capturedAtMs: 1_779_840_030_000,
    operatorReleaseSwitches: [
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
    publisherReceipts: [
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
    emergencyControls: [
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
    publisherLevelHolds: [],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/provider-settlement-callbacks',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-live-money',
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

describe('Workers Coordinator publisher reward live-money payout pilot gate', () => {
  it('promotes live payout pilot when release, settlement, receipt, controls, and security evidence pass', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport(),
      livePayoutEvidence: createLivePayoutEvidence(),
    });

    expect(report.runtime).toBe('publisher-reward-live-money-payout-pilot-gate');
    expect(report.status).toBe('pass');
    expect(report.previewRunnerUrl).toBe('https://preview.unzen-workers.example/runners/signed/runner.html');
    expect(report.operatorReleaseSwitchEvidence).toEqual([
      expect.objectContaining({
        releaseSwitchId: 'release-switch:publisher-payout:pilot:001',
        liveMoneyPilotAttestation: true,
        emergencyStopArmed: true,
        controlledOutsideSignedRunner: true,
      }),
    ]);
    expect(report.providerSettlementCallbacks).toEqual([
      expect.objectContaining({
        providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
        status: 'succeeded',
        settledPayoutUsd: 8,
      }),
    ]);
    expect(report.livePayoutReconciliation).toMatchObject({
      currency: 'USD',
      dryRunProviderPayoutUsd: 8,
      settledProviderPayoutUsd: 8,
      ledgerPayoutBatchUsd: 8,
      dryRunCoordinatorRelaySpendUsd: 2.2,
      settledCoordinatorRelaySpendUsd: 2.2,
      publisherLevelHolds: [],
    });
    expect(report.publisherReceiptEvidence).toEqual([
      expect.objectContaining({
        publisherId: 'publisher:newsroom-a',
        includesProviderSettlementCallback: true,
        includesTaxInvoiceMetadata: true,
      }),
      expect.objectContaining({
        publisherId: 'publisher:docs-b',
        includesProviderSettlementCallback: true,
        includesTaxInvoiceMetadata: true,
      }),
    ]);
    expect(report.payoutStatusTransitions).toEqual([
      expect.objectContaining({
        ledgerEntryId: 'ledger:publisher:newsroom-a:segment-03:001',
        to: 'settled',
      }),
      expect.objectContaining({
        ledgerEntryId: 'ledger:publisher:docs-b:segment-04:001',
        to: 'settled',
      }),
    ]);
    expect(report.emergencyHoldRollbackControls).toEqual([
      expect.objectContaining({
        rollbackPlanId: 'rollback-plan:publisher-payout:pilot:001',
        outsideSignedRunnerBoundary: true,
        activeHoldReasons: [],
      }),
    ]);
    expect(report.promoteHoldThresholds).toMatchObject({
      decision: 'promote',
      holdReasons: [],
    });
    expect(report.securityBoundaryDuringLivePayout).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringLivePayout.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-live-money',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-reward-recurring-payout-operations']);
  });

  it('holds when the upstream payout dry-run gate has not passed', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport({
        status: 'fail',
        failureReason: 'publisher-payout-dry-run-total-does-not-match-ledger-payout-batch-total',
      }),
      livePayoutEvidence: createLivePayoutEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-payout-dry-run-gate-not-clean: publisher-payout-dry-run-total-does-not-match-ledger-payout-batch-total',
    );
  });

  it('holds when operator release switch is not armed outside the signed runner boundary', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport(),
      livePayoutEvidence: createLivePayoutEvidence({
        operatorReleaseSwitches: [
          {
            batchId: 'payout-batch:pilot:2026-06-08:001',
            releaseSwitchId: 'release-switch:publisher-payout:pilot:001',
            enabledBy: 'operator:payout-reviewer-01',
            enabledAtMs: 1_779_840_040_000,
            liveMoneyPilotAttestation: false,
            maxPilotPayoutUsd: 10,
            emergencyStopArmed: false,
            controlledOutsideSignedRunner: false,
            blockerReasons: ['release-switch-state-not-verified'],
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-live-payout-operator-release-switch-invalid: payout-batch:pilot:2026-06-08:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-live-payout-operator-release-switch-workflow']);
  });

  it('holds when provider settlement callback does not reconcile to the dry-run batch total', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport(),
      livePayoutEvidence: createLivePayoutEvidence({
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
            settledPayoutUsd: 7.5,
            settledCoordinatorRelaySpendUsd: 2.2,
            status: 'succeeded',
            receivedAtMs: 1_779_840_050_000,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-live-payout-settlement-total-does-not-match-provider-dry-run-total',
    );
  });

  it('holds when publisher receipt evidence is incomplete', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport(),
      livePayoutEvidence: createLivePayoutEvidence({
        publisherReceipts: [
          {
            publisherId: 'publisher:newsroom-a',
            receiptId: 'receipt:publisher:newsroom-a:payout-live:001',
            providerPayoutId: 'stripe-payout:payout-batch:pilot:2026-06-08:001',
            deliveredAtMs: 1_779_840_060_000,
            ledgerEntryIds: ['ledger:publisher:newsroom-a:segment-03:001'],
            includesProviderSettlementCallback: true,
            includesTaxInvoiceMetadata: true,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-live-payout-publisher-receipt-missing-or-incomplete: publisher:docs-b',
    );
  });

  it('holds when emergency hold and rollback controls are active or inside signed runner control', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport(),
      livePayoutEvidence: createLivePayoutEvidence({
        emergencyControls: [
          {
            batchId: 'payout-batch:pilot:2026-06-08:001',
            emergencyHoldSwitchId: 'emergency-hold:publisher-payout:pilot:001',
            rollbackPlanId: 'rollback-plan:publisher-payout:pilot:001',
            controlledBy: 'operator:payout-incident-commander',
            armedAtMs: 1_779_840_039_000,
            outsideSignedRunnerBoundary: false,
            activeHoldReasons: ['provider-callback-latency-spike'],
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-live-payout-emergency-hold-rollback-controls-missing-or-active: payout-batch:pilot:2026-06-08:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-live-payout-emergency-control-workflow']);
  });

  it('holds when live payout leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherLiveMoneyPayoutPilotGate({
      payoutDryRunReport: createPayoutDryRunReport(),
      livePayoutEvidence: createLivePayoutEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/provider-settlement-callbacks',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-live-money',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-live-payout-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-live-payout-security-boundary-hardening']);
  });
});
