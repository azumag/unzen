import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport,
} from '../src/workers-coordinator-publisher-tax-production-callbacks-readiness.js';
import {
  runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate,
  type WorkersCoordinatorPublisherTaxProductionMonitoringEvidence,
} from '../src/workers-coordinator-publisher-tax-production-monitoring-reconciliation.js';

function createProductionCallbacksReadinessReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport> = {},
): WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport {
  const base: WorkersCoordinatorPublisherTaxProductionCallbacksReadinessReport = {
    runtime: 'publisher-tax-filing-production-callbacks-readiness-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    cutoverApprovalEvidence: {
      approvalId: 'tax-production-cutover-approval:publisher-rewards:2026:001',
      operatorId: 'operator:tax-ops-lead',
      approvedAtMs: 1_783_310_010_000,
      productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      approvedSandboxProviderFilingIds: [
        'irs-fire-filing:publisher-rewards:2026:001',
        'irs-fire-filing:publisher-rewards:2026:002',
        'irs-fire-filing:publisher-rewards:2026:003',
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
        callbackId: 'production-callback:publisher-rewards:2026:rejected:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        providerTraceId: 'irs-fire-production-callback-trace:2026:rejected:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        receivedAtMs: 1_783_310_710_000,
        signatureVerified: true,
        eventType: 'filing.rejected',
        duplicateFilingSuppressed: true,
      },
      {
        callbackId: 'production-callback:publisher-rewards:2026:corrected:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:003',
        providerTraceId: 'irs-fire-production-callback-trace:2026:corrected:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        receivedAtMs: 1_783_310_720_000,
        signatureVerified: true,
        eventType: 'filing.corrected',
        duplicateFilingSuppressed: true,
      },
      {
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        providerTraceId: 'irs-fire-production-callback-trace:2026:duplicate:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        receivedAtMs: 1_783_310_730_000,
        signatureVerified: true,
        eventType: 'filing.duplicate_suppressed',
        duplicateFilingSuppressed: true,
      },
    ],
    productionCallbacksSummary: {
      callbackCount: 4,
      signedCallbackCount: 4,
      approvedWindowCallbackCount: 4,
      duplicateFilingSuppressionCount: 1,
      rollbackControlCount: 2,
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['publisher tax production cutover readiness gate has already passed'],
      holdReasons: [],
    },
    securityBoundaryDuringProductionCallbacks: {
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-tax-production-callbacks',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-monitoring-reconciliation'],
  };

  return {
    ...base,
    ...overrides,
  };
}

function createProductionMonitoringEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionMonitoringEvidence> = {},
): WorkersCoordinatorPublisherTaxProductionMonitoringEvidence {
  const base: WorkersCoordinatorPublisherTaxProductionMonitoringEvidence = {
    source: 'publisher-tax-filing-production-monitoring-reconciliation',
    capturedAtMs: 1_783_310_800_000,
    operatorMonitoringRecords: [
      {
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:accepted:001',
        callbackId: 'production-callback:publisher-rewards:2026:accepted:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        observedAtMs: 1_783_310_701_000,
        eventType: 'filing.accepted',
        duplicateFilingSuppressed: true,
      },
      {
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:rejected:001',
        callbackId: 'production-callback:publisher-rewards:2026:rejected:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        observedAtMs: 1_783_310_711_000,
        eventType: 'filing.rejected',
        duplicateFilingSuppressed: true,
      },
      {
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:corrected:001',
        callbackId: 'production-callback:publisher-rewards:2026:corrected:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:003',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        observedAtMs: 1_783_310_721_000,
        eventType: 'filing.corrected',
        duplicateFilingSuppressed: true,
      },
      {
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:duplicate:001',
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        observedAtMs: 1_783_310_731_000,
        eventType: 'filing.duplicate_suppressed',
        duplicateFilingSuppressed: true,
      },
    ],
    publisherMonitoringExports: [
      {
        exportId: 'publisher-monitoring-export:newsroom-a:tax-production:2026:001',
        publisherId: 'publisher:newsroom-a',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:002',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        monitoringRecordIds: ['tax-production-monitoring:publisher-rewards:2026:accepted:001'],
        deliveredAtMs: 1_783_310_900_000,
      },
      {
        exportId: 'publisher-monitoring-export:docs-b:tax-production:2026:001',
        publisherId: 'publisher:docs-b',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        monitoringRecordIds: [
          'tax-production-monitoring:publisher-rewards:2026:rejected:001',
          'tax-production-monitoring:publisher-rewards:2026:duplicate:001',
        ],
        deliveredAtMs: 1_783_310_910_000,
      },
      {
        exportId: 'publisher-monitoring-export:studio-c:tax-production:2026:001',
        publisherId: 'publisher:studio-c',
        providerFilingId: 'irs-fire-filing:publisher-rewards:2026:003',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        monitoringRecordIds: ['tax-production-monitoring:publisher-rewards:2026:corrected:001'],
        deliveredAtMs: 1_783_310_920_000,
      },
    ],
    monitoringAlerts: [
      {
        alertId: 'tax-production-monitoring-alert:publisher-rewards:2026:rejected:001',
        callbackId: 'production-callback:publisher-rewards:2026:rejected:001',
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:rejected:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        severity: 'warning',
        triggeredAtMs: 1_783_310_712_000,
      },
      {
        alertId: 'tax-production-monitoring-alert:publisher-rewards:2026:duplicate:001',
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:duplicate:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
        severity: 'info',
        triggeredAtMs: 1_783_310_732_000,
      },
    ],
    replayAudits: [
      {
        replayId: 'tax-production-monitoring-replay:publisher-rewards:2026:001',
        sourceCallbackIds: [
          'production-callback:publisher-rewards:2026:accepted:001',
          'production-callback:publisher-rewards:2026:rejected:001',
          'production-callback:publisher-rewards:2026:corrected:001',
          'production-callback:publisher-rewards:2026:duplicate:001',
        ],
        duplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
        rollbackPlanIds: ['rollback-plan:publisher-tax-production-cutover:2026:001'],
        emergencyHoldSwitchIds: ['emergency-hold:publisher-tax-production-cutover:2026:001'],
        replayedAtMs: 1_783_311_000_000,
      },
    ],
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/tax-production-monitoring',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-production-monitoring',
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

describe('Workers Coordinator publisher tax filing production monitoring reconciliation gate', () => {
  it('promotes when production callbacks reconcile to monitoring, publisher exports, alerts, and replay controls', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence(),
    });

    expect(report.runtime).toBe('publisher-tax-filing-production-monitoring-reconciliation-gate');
    expect(report.status).toBe('pass');
    expect(report.cutoverApprovalEvidence).toMatchObject({
      approvalId: 'tax-production-cutover-approval:publisher-rewards:2026:001',
      productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
    });
    expect(report.productionProviderCallbacks.map((callback) => callback.eventType)).toEqual([
      'filing.accepted',
      'filing.rejected',
      'filing.corrected',
      'filing.duplicate_suppressed',
    ]);
    expect(report.operatorMonitoringRecords).toEqual([
      expect.objectContaining({
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:accepted:001',
        callbackId: 'production-callback:publisher-rewards:2026:accepted:001',
      }),
      expect.objectContaining({
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:rejected:001',
        callbackId: 'production-callback:publisher-rewards:2026:rejected:001',
      }),
      expect.objectContaining({
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:corrected:001',
        callbackId: 'production-callback:publisher-rewards:2026:corrected:001',
      }),
      expect.objectContaining({
        monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:duplicate:001',
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
      }),
    ]);
    expect(report.publisherMonitoringExports.map((exportRecord) => exportRecord.exportId)).toEqual([
      'publisher-monitoring-export:newsroom-a:tax-production:2026:001',
      'publisher-monitoring-export:docs-b:tax-production:2026:001',
      'publisher-monitoring-export:studio-c:tax-production:2026:001',
    ]);
    expect(report.monitoringAlerts).toEqual([
      expect.objectContaining({
        alertId: 'tax-production-monitoring-alert:publisher-rewards:2026:rejected:001',
        callbackId: 'production-callback:publisher-rewards:2026:rejected:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      }),
      expect.objectContaining({
        alertId: 'tax-production-monitoring-alert:publisher-rewards:2026:duplicate:001',
        callbackId: 'production-callback:publisher-rewards:2026:duplicate:001',
        productionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      }),
    ]);
    expect(report.productionMonitoringSummary).toEqual({
      callbackCount: 4,
      monitoredCallbackCount: 4,
      publisherMonitoringExportCount: 3,
      alertTraceabilityCount: 2,
      replayAuditCount: 1,
    });
    expect(report.approvedWindowReconciliation).toEqual({
      approvedProductionWindowId: 'tax-production-filing-window:publisher-rewards:2026:001',
      reconciledProviderFilingIds: [
        'irs-fire-filing:publisher-rewards:2026:002',
        'irs-fire-filing:publisher-rewards:2026:001',
        'irs-fire-filing:publisher-rewards:2026:003',
      ],
      unreconciledProviderFilingIds: [],
    });
    expect(report.duplicateFilingSuppressionReplay).toEqual({
      requiredDuplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
      replayedDuplicateFilingSuppressionIds: ['duplicate-filing-suppression:publisher-rewards:2026:001'],
    });
    expect(report.rollbackEmergencyControlsDuringReplay).toEqual({
      requiredRollbackPlanId: 'rollback-plan:publisher-tax-production-cutover:2026:001',
      requiredEmergencyHoldSwitchId: 'emergency-hold:publisher-tax-production-cutover:2026:001',
      replayedRollbackPlanIds: ['rollback-plan:publisher-tax-production-cutover:2026:001'],
      replayedEmergencyHoldSwitchIds: ['emergency-hold:publisher-tax-production-cutover:2026:001'],
    });
    expect(report.securityBoundaryDuringProductionMonitoring).toMatchObject({
      cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    });
    expect(report.securityBoundaryDuringProductionMonitoring.blockedNonCoordinatorCdnNetworkAttempt).toMatchObject({
      url: 'https://collector.example.test/payout-tax-production-monitoring',
      blocked: true,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-exception-operations-runbook']);
  });

  it('holds when upstream production callbacks readiness has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport({
        status: 'fail',
        failureReason: 'publisher-tax-production-callbacks-invalid: missing',
      }),
      productionMonitoringEvidence: createProductionMonitoringEvidence(),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-callbacks-readiness-gate-not-clean: publisher-tax-production-callbacks-invalid: missing',
    );
  });

  it('holds when a callback is missing from operator monitoring records', () => {
    const evidence = createProductionMonitoringEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence({
        operatorMonitoringRecords: evidence.operatorMonitoringRecords.filter((record) =>
          record.callbackId !== 'production-callback:publisher-rewards:2026:corrected:001',
        ),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-callback-not-reconciled: production-callback:publisher-rewards:2026:corrected:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-monitoring-reconciliation-hardening']);
  });

  it('holds when a monitoring alert cannot be traced to the approved callback window', () => {
    const evidence = createProductionMonitoringEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence({
        monitoringAlerts: evidence.monitoringAlerts.map((alert, index) => index === 0
          ? {
              ...alert,
              callbackId: 'production-callback:publisher-rewards:2026:unknown',
            }
          : alert),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-alert-not-traceable: tax-production-monitoring-alert:publisher-rewards:2026:rejected:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-monitoring-alert-traceability-hardening']);
  });

  it('holds when a monitoring alert points at a record for a different callback', () => {
    const evidence = createProductionMonitoringEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence({
        monitoringAlerts: evidence.monitoringAlerts.map((alert, index) => index === 0
          ? {
              ...alert,
              monitoringRecordId: 'tax-production-monitoring:publisher-rewards:2026:accepted:001',
            }
          : alert),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-alert-not-traceable: tax-production-monitoring-alert:publisher-rewards:2026:rejected:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-monitoring-alert-traceability-hardening']);
  });

  it('holds when duplicate-filing suppression is not preserved during monitoring replay', () => {
    const evidence = createProductionMonitoringEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence({
        replayAudits: evidence.replayAudits.map((audit) => ({
          ...audit,
          duplicateFilingSuppressionIds: [],
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-duplicate-suppression-not-replayed: duplicate-filing-suppression:publisher-rewards:2026:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-monitoring-duplicate-suppression-replay-hardening']);
  });

  it('holds when monitoring replay does not include every production callback', () => {
    const evidence = createProductionMonitoringEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence({
        replayAudits: evidence.replayAudits.map((audit) => ({
          ...audit,
          sourceCallbackIds: audit.sourceCallbackIds.filter((callbackId) =>
            callbackId !== 'production-callback:publisher-rewards:2026:duplicate:001',
          ),
        })),
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-callback-not-replayed: production-callback:publisher-rewards:2026:duplicate:001',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-monitoring-reconciliation-hardening']);
  });

  it('holds when production monitoring leaks a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionMonitoringReconciliationGate({
      productionCallbacksReadinessReport: createProductionCallbacksReadinessReport(),
      productionMonitoringEvidence: createProductionMonitoringEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-production-monitoring',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-production-monitoring',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });

    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-production-monitoring-security-boundary-hardening']);
  });
});
