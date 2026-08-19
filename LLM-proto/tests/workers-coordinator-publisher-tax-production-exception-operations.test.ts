import { describe, expect, it } from 'vitest';
import type {
  WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport,
} from '../src/workers-coordinator-publisher-tax-production-monitoring-reconciliation.js';
import {
  runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate,
  type WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence,
} from '../src/workers-coordinator-publisher-tax-production-exception-operations.js';

const WINDOW_ID = 'tax-production-filing-window:publisher-rewards:2026:001';
const SUPPRESSION_ID = 'duplicate-filing-suppression:publisher-rewards:2026:001';
const ROLLBACK_ID = 'rollback-plan:publisher-tax-production-cutover:2026:001';
const HOLD_ID = 'emergency-hold:publisher-tax-production-cutover:2026:001';

const CALLBACK_ACCEPTED = 'production-callback:publisher-rewards:2026:accepted:001';
const CALLBACK_REJECTED = 'production-callback:publisher-rewards:2026:rejected:001';
const CALLBACK_CORRECTED = 'production-callback:publisher-rewards:2026:corrected:001';
const CALLBACK_DUPLICATE = 'production-callback:publisher-rewards:2026:duplicate:001';

const FILING_001 = 'irs-fire-filing:publisher-rewards:2026:001';
const FILING_002 = 'irs-fire-filing:publisher-rewards:2026:002';
const FILING_003 = 'irs-fire-filing:publisher-rewards:2026:003';

const RECORD_ACCEPTED = 'tax-production-monitoring:publisher-rewards:2026:accepted:001';
const RECORD_REJECTED = 'tax-production-monitoring:publisher-rewards:2026:rejected:001';
const RECORD_CORRECTED = 'tax-production-monitoring:publisher-rewards:2026:corrected:001';
const RECORD_DUPLICATE = 'tax-production-monitoring:publisher-rewards:2026:duplicate:001';

const ALERT_REJECTED = 'tax-production-monitoring-alert:publisher-rewards:2026:rejected:001';
const ALERT_DUPLICATE = 'tax-production-monitoring-alert:publisher-rewards:2026:duplicate:001';
const REPLAY_ID = 'tax-production-monitoring-replay:publisher-rewards:2026:001';

const ACTION_REJECTED = 'tax-production-runbook-action:publisher-rewards:2026:rejected:001';
const ACTION_CORRECTED = 'tax-production-runbook-action:publisher-rewards:2026:corrected:001';
const ACTION_DUPLICATE = 'tax-production-runbook-action:publisher-rewards:2026:duplicate:001';
const ACTION_REPLAY = 'tax-production-runbook-action:publisher-rewards:2026:replay:001';

const ESCALATION_REJECTED = 'tax-production-support-escalation:publisher-rewards:2026:rejected:001';
const ESCALATION_CORRECTED = 'tax-production-support-escalation:publisher-rewards:2026:corrected:001';
const ESCALATION_DUPLICATE = 'tax-production-support-escalation:publisher-rewards:2026:duplicate:001';
const ESCALATION_REPLAY = 'tax-production-support-escalation:publisher-rewards:2026:replay:001';

function createMonitoringReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport> = {},
): WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport {
  const base: WorkersCoordinatorPublisherTaxProductionMonitoringReconciliationReport = {
    runtime: 'publisher-tax-filing-production-monitoring-reconciliation-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    cutoverApprovalEvidence: {
      approvalId: 'tax-production-cutover-approval:publisher-rewards:2026:001',
      operatorId: 'operator:tax-ops-lead',
      approvedAtMs: 1_783_310_010_000,
      productionWindowId: WINDOW_ID,
      approvedSandboxProviderFilingIds: [FILING_001, FILING_002, FILING_003],
      duplicateFilingSuppressionIds: [SUPPRESSION_ID],
      rollbackPlanId: ROLLBACK_ID,
      emergencyHoldSwitchId: HOLD_ID,
    },
    productionProviderCallbacks: [
      {
        callbackId: CALLBACK_ACCEPTED,
        providerFilingId: FILING_002,
        providerTraceId: 'trace:accepted:001',
        productionWindowId: WINDOW_ID,
        receivedAtMs: 1_783_310_700_000,
        signatureVerified: true,
        eventType: 'filing.accepted',
        duplicateFilingSuppressed: true,
      },
      {
        callbackId: CALLBACK_REJECTED,
        providerFilingId: FILING_001,
        providerTraceId: 'trace:rejected:001',
        productionWindowId: WINDOW_ID,
        receivedAtMs: 1_783_310_710_000,
        signatureVerified: true,
        eventType: 'filing.rejected',
        duplicateFilingSuppressed: true,
      },
      {
        callbackId: CALLBACK_CORRECTED,
        providerFilingId: FILING_003,
        providerTraceId: 'trace:corrected:001',
        productionWindowId: WINDOW_ID,
        receivedAtMs: 1_783_310_720_000,
        signatureVerified: true,
        eventType: 'filing.corrected',
        duplicateFilingSuppressed: true,
      },
      {
        callbackId: CALLBACK_DUPLICATE,
        providerFilingId: FILING_001,
        providerTraceId: 'trace:duplicate:001',
        productionWindowId: WINDOW_ID,
        receivedAtMs: 1_783_310_730_000,
        signatureVerified: true,
        eventType: 'filing.duplicate_suppressed',
        duplicateFilingSuppressed: true,
      },
    ],
    operatorMonitoringRecords: [
      {
        monitoringRecordId: RECORD_ACCEPTED,
        callbackId: CALLBACK_ACCEPTED,
        providerFilingId: FILING_002,
        productionWindowId: WINDOW_ID,
        observedAtMs: 1_783_310_701_000,
        eventType: 'filing.accepted',
        duplicateFilingSuppressed: true,
      },
      {
        monitoringRecordId: RECORD_REJECTED,
        callbackId: CALLBACK_REJECTED,
        providerFilingId: FILING_001,
        productionWindowId: WINDOW_ID,
        observedAtMs: 1_783_310_711_000,
        eventType: 'filing.rejected',
        duplicateFilingSuppressed: true,
      },
      {
        monitoringRecordId: RECORD_CORRECTED,
        callbackId: CALLBACK_CORRECTED,
        providerFilingId: FILING_003,
        productionWindowId: WINDOW_ID,
        observedAtMs: 1_783_310_721_000,
        eventType: 'filing.corrected',
        duplicateFilingSuppressed: true,
      },
      {
        monitoringRecordId: RECORD_DUPLICATE,
        callbackId: CALLBACK_DUPLICATE,
        providerFilingId: FILING_001,
        productionWindowId: WINDOW_ID,
        observedAtMs: 1_783_310_731_000,
        eventType: 'filing.duplicate_suppressed',
        duplicateFilingSuppressed: true,
      },
    ],
    publisherMonitoringExports: [
      {
        exportId: 'publisher-monitoring-export:newsroom-a:tax-production:2026:001',
        publisherId: 'publisher:newsroom-a',
        providerFilingId: FILING_002,
        productionWindowId: WINDOW_ID,
        monitoringRecordIds: [RECORD_ACCEPTED],
        deliveredAtMs: 1_783_310_800_000,
      },
      {
        exportId: 'publisher-monitoring-export:docs-b:tax-production:2026:001',
        publisherId: 'publisher:docs-b',
        providerFilingId: FILING_001,
        productionWindowId: WINDOW_ID,
        monitoringRecordIds: [RECORD_REJECTED, RECORD_DUPLICATE],
        deliveredAtMs: 1_783_310_810_000,
      },
      {
        exportId: 'publisher-monitoring-export:studio-c:tax-production:2026:001',
        publisherId: 'publisher:studio-c',
        providerFilingId: FILING_003,
        productionWindowId: WINDOW_ID,
        monitoringRecordIds: [RECORD_CORRECTED],
        deliveredAtMs: 1_783_310_820_000,
      },
    ],
    monitoringAlerts: [
      {
        alertId: ALERT_REJECTED,
        callbackId: CALLBACK_REJECTED,
        monitoringRecordId: RECORD_REJECTED,
        productionWindowId: WINDOW_ID,
        severity: 'warning',
        triggeredAtMs: 1_783_310_712_000,
      },
      {
        alertId: ALERT_DUPLICATE,
        callbackId: CALLBACK_DUPLICATE,
        monitoringRecordId: RECORD_DUPLICATE,
        productionWindowId: WINDOW_ID,
        severity: 'info',
        triggeredAtMs: 1_783_310_732_000,
      },
    ],
    productionMonitoringSummary: {
      callbackCount: 4,
      monitoredCallbackCount: 4,
      publisherMonitoringExportCount: 3,
      alertTraceabilityCount: 2,
      replayAuditCount: 1,
    },
    approvedWindowReconciliation: {
      approvedProductionWindowId: WINDOW_ID,
      reconciledProviderFilingIds: [FILING_002, FILING_001, FILING_003],
      unreconciledProviderFilingIds: [],
    },
    duplicateFilingSuppressionReplay: {
      requiredDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
      replayedDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
    },
    rollbackEmergencyControlsDuringReplay: {
      requiredRollbackPlanId: ROLLBACK_ID,
      requiredEmergencyHoldSwitchId: HOLD_ID,
      replayedRollbackPlanIds: [ROLLBACK_ID],
      replayedEmergencyHoldSwitchIds: [HOLD_ID],
    },
    promoteHoldThresholds: {
      decision: 'promote',
      promoteWhen: ['monitoring reconciled'],
      holdReasons: [],
    },
    securityBoundaryDuringProductionMonitoring: {
      cspConnectSrc: [
        'https://coordinator.unzen.dev',
        'wss://coordinator.unzen.dev',
        'https://cdn.unzen.dev',
      ],
      sandboxFlags: ['allow-scripts'],
      coop: 'same-origin',
      coep: 'require-corp',
      allowedOrigins: [
        'https://coordinator.unzen.dev',
        'wss://coordinator.unzen.dev',
        'https://cdn.unzen.dev',
      ],
      blockedNonCoordinatorCdnNetworkAttempt: {
        url: 'https://collector.example.test/payout-tax-production-monitoring',
        initiator: 'dedicated-worker',
        blocked: true,
      },
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-exception-operations-runbook'],
  };
  return { ...base, ...overrides };
}

function createExceptionEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence> = {},
): WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence {
  const base: WorkersCoordinatorPublisherTaxProductionExceptionOperationsEvidence = {
    source: 'publisher-tax-filing-production-exception-operations',
    capturedAtMs: 1_783_311_100_000,
    replayDetections: [
      {
        replayId: REPLAY_ID,
        sourceCallbackIds: [
          CALLBACK_ACCEPTED,
          CALLBACK_REJECTED,
          CALLBACK_CORRECTED,
          CALLBACK_DUPLICATE,
        ],
        detectedAtMs: 1_783_311_000_000,
      },
    ],
    operatorRunbookActions: [
      {
        actionId: ACTION_REJECTED,
        eventType: 'filing.rejected',
        callbackId: CALLBACK_REJECTED,
        monitoringRecordIds: [RECORD_REJECTED],
        monitoringAlertIds: [ALERT_REJECTED],
        providerFilingIds: [FILING_001],
        productionWindowId: WINDOW_ID,
        action: 'investigate-rejection',
        status: 'acknowledged',
        createdAtMs: 1_783_310_900_000,
      },
      {
        actionId: ACTION_CORRECTED,
        eventType: 'filing.corrected',
        callbackId: CALLBACK_CORRECTED,
        monitoringRecordIds: [RECORD_CORRECTED],
        monitoringAlertIds: [],
        providerFilingIds: [FILING_003],
        productionWindowId: WINDOW_ID,
        action: 'prepare-correction',
        status: 'open',
        createdAtMs: 1_783_310_910_000,
      },
      {
        actionId: ACTION_DUPLICATE,
        eventType: 'filing.duplicate_suppressed',
        callbackId: CALLBACK_DUPLICATE,
        monitoringRecordIds: [RECORD_DUPLICATE],
        monitoringAlertIds: [ALERT_DUPLICATE],
        providerFilingIds: [FILING_001],
        productionWindowId: WINDOW_ID,
        action: 'confirm-duplicate-suppression',
        status: 'resolved',
        createdAtMs: 1_783_310_920_000,
      },
      {
        actionId: ACTION_REPLAY,
        eventType: 'monitoring.replay_detected',
        replayId: REPLAY_ID,
        monitoringRecordIds: [
          RECORD_ACCEPTED,
          RECORD_REJECTED,
          RECORD_CORRECTED,
          RECORD_DUPLICATE,
        ],
        monitoringAlertIds: [ALERT_REJECTED, ALERT_DUPLICATE],
        providerFilingIds: [FILING_002, FILING_001, FILING_003],
        productionWindowId: WINDOW_ID,
        action: 'review-replay',
        status: 'acknowledged',
        createdAtMs: 1_783_311_010_000,
      },
    ],
    supportEscalations: [
      {
        supportEscalationId: ESCALATION_REJECTED,
        actionId: ACTION_REJECTED,
        monitoringAlertIds: [ALERT_REJECTED],
        productionCallbackIds: [CALLBACK_REJECTED],
        providerFilingIds: [FILING_001],
        productionWindowId: WINDOW_ID,
        openedAtMs: 1_783_310_930_000,
      },
      {
        supportEscalationId: ESCALATION_CORRECTED,
        actionId: ACTION_CORRECTED,
        monitoringAlertIds: [],
        productionCallbackIds: [CALLBACK_CORRECTED],
        providerFilingIds: [FILING_003],
        productionWindowId: WINDOW_ID,
        openedAtMs: 1_783_310_940_000,
      },
      {
        supportEscalationId: ESCALATION_DUPLICATE,
        actionId: ACTION_DUPLICATE,
        monitoringAlertIds: [ALERT_DUPLICATE],
        productionCallbackIds: [CALLBACK_DUPLICATE],
        providerFilingIds: [FILING_001],
        productionWindowId: WINDOW_ID,
        openedAtMs: 1_783_310_950_000,
      },
      {
        supportEscalationId: ESCALATION_REPLAY,
        actionId: ACTION_REPLAY,
        monitoringAlertIds: [ALERT_REJECTED, ALERT_DUPLICATE],
        productionCallbackIds: [
          CALLBACK_ACCEPTED,
          CALLBACK_REJECTED,
          CALLBACK_CORRECTED,
          CALLBACK_DUPLICATE,
        ],
        providerFilingIds: [FILING_002, FILING_001, FILING_003],
        productionWindowId: WINDOW_ID,
        openedAtMs: 1_783_311_020_000,
      },
    ],
    publisherStatusUpdates: [
      {
        statusUpdateId: 'publisher-status-update:tax-production:2026:filing-001',
        providerFilingId: FILING_001,
        productionWindowId: WINDOW_ID,
        actionIds: [ACTION_REJECTED, ACTION_DUPLICATE, ACTION_REPLAY],
        supportEscalationIds: [ESCALATION_REJECTED, ESCALATION_DUPLICATE, ESCALATION_REPLAY],
        status: 'exception-open',
        publishedAtMs: 1_783_311_030_000,
      },
      {
        statusUpdateId: 'publisher-status-update:tax-production:2026:filing-002',
        providerFilingId: FILING_002,
        productionWindowId: WINDOW_ID,
        actionIds: [ACTION_REPLAY],
        supportEscalationIds: [ESCALATION_REPLAY],
        status: 'under-review',
        publishedAtMs: 1_783_311_040_000,
      },
      {
        statusUpdateId: 'publisher-status-update:tax-production:2026:filing-003',
        providerFilingId: FILING_003,
        productionWindowId: WINDOW_ID,
        actionIds: [ACTION_CORRECTED, ACTION_REPLAY],
        supportEscalationIds: [ESCALATION_CORRECTED, ESCALATION_REPLAY],
        status: 'correction-in-progress',
        publishedAtMs: 1_783_311_050_000,
      },
    ],
    preservedDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
    rollbackEmergencyDecision: {
      decisionId: 'tax-production-exception-control-decision:2026:001',
      rollbackPlanId: ROLLBACK_ID,
      emergencyHoldSwitchId: HOLD_ID,
      decision: 'continue-monitoring',
      reason: 'exceptions are contained and duplicate filing suppression remains active',
      decidedAtMs: 1_783_311_060_000,
    },
    allowedOrigins: [
      'https://coordinator.unzen.dev',
      'wss://coordinator.unzen.dev',
      'https://cdn.unzen.dev',
    ],
    cspConnectSrc: [
      'https://coordinator.unzen.dev',
      'wss://coordinator.unzen.dev',
      'https://cdn.unzen.dev',
    ],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/payouts/tax-production-exceptions',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://cdn.unzen.dev/runners/signed/runner.html',
        initiator: 'iframe',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/payout-tax-production-exceptions',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('publisher tax production exception operations runbook gate', () => {
  it('promotes traceable exception actions, support escalations, publisher updates, and controls', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence(),
    });

    expect(report.runtime).toBe('publisher-tax-filing-production-exception-operations-runbook-gate');
    expect(report.status).toBe('pass');
    expect(report.productionMonitoringReconciliationEvidence.runtime).toBe(
      'publisher-tax-filing-production-monitoring-reconciliation-gate',
    );
    expect(report.replayDetections.map((entry) => entry.replayId)).toEqual([REPLAY_ID]);
    expect(report.operatorRunbookActions.map((entry) => entry.actionId)).toEqual([
      ACTION_REJECTED,
      ACTION_CORRECTED,
      ACTION_DUPLICATE,
      ACTION_REPLAY,
    ]);
    expect(report.supportEscalations.map((entry) => entry.supportEscalationId)).toEqual([
      ESCALATION_REJECTED,
      ESCALATION_CORRECTED,
      ESCALATION_DUPLICATE,
      ESCALATION_REPLAY,
    ]);
    expect(report.publisherStatusUpdates).toHaveLength(3);
    expect(report.exceptionOperationsSummary).toEqual({
      requiredActionCount: 4,
      runbookActionCount: 4,
      supportEscalationCount: 4,
      affectedProviderFilingCount: 3,
      publisherStatusUpdateCount: 3,
    });
    expect(report.approvedWindowReconciliation).toEqual({
      approvedProductionWindowId: WINDOW_ID,
      affectedProviderFilingIds: [FILING_001, FILING_003, FILING_002],
      statusUpdatedProviderFilingIds: [FILING_001, FILING_003, FILING_002],
      missingStatusUpdateProviderFilingIds: [],
    });
    expect(report.duplicateFilingSuppressionState).toEqual({
      requiredDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
      preservedDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
    });
    expect(report.rollbackEmergencyDecisionEvidence).toMatchObject({
      rollbackPlanId: ROLLBACK_ID,
      emergencyHoldSwitchId: HOLD_ID,
      decision: 'continue-monitoring',
    });
    expect(report.securityBoundaryDuringExceptionOperations.blockedNonCoordinatorCdnNetworkAttempt)
      .toMatchObject({
        url: 'https://collector.example.test/payout-tax-production-exceptions',
        blocked: true,
      });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual([
      'publisher-tax-filing-production-exception-resolution-audit',
    ]);
  });

  it('holds when upstream production monitoring reconciliation has not passed', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport({
        status: 'fail',
        failureReason: 'publisher-tax-production-monitoring-alert-not-traceable: missing',
      }),
      exceptionOperationsEvidence: createExceptionEvidence(),
    });
    expect(report.status).toBe('fail');
    expect(report.failureReason).toBe(
      'publisher-tax-production-monitoring-reconciliation-gate-not-clean: publisher-tax-production-monitoring-alert-not-traceable: missing',
    );
  });

  it('holds when a required callback action is missing', () => {
    const evidence = createExceptionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({
        operatorRunbookActions: evidence.operatorRunbookActions.filter(
          (action) => action.actionId !== ACTION_CORRECTED,
        ),
      }),
    });
    expect(report.failureReason).toBe(
      `publisher-tax-production-exception-runbook-action-missing-or-duplicate: callback:${CALLBACK_CORRECTED}`,
    );
  });

  it('holds when support escalation loses monitoring alert traceability', () => {
    const evidence = createExceptionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({
        supportEscalations: evidence.supportEscalations.map((entry) =>
          entry.actionId === ACTION_REJECTED ? { ...entry, monitoringAlertIds: [] } : entry,
        ),
      }),
    });
    expect(report.failureReason).toBe(
      `publisher-tax-production-exception-support-escalation-not-traceable: callback:${CALLBACK_REJECTED}`,
    );
  });

  it('holds when an affected provider filing has no publisher status update', () => {
    const evidence = createExceptionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({
        publisherStatusUpdates: evidence.publisherStatusUpdates.filter(
          (entry) => entry.providerFilingId !== FILING_003,
        ),
      }),
    });
    expect(report.failureReason).toBe(
      `publisher-tax-production-exception-publisher-status-update-missing: ${FILING_003}`,
    );
  });

  it('holds when duplicate filing suppression is not preserved', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({
        preservedDuplicateFilingSuppressionIds: [],
      }),
    });
    expect(report.failureReason).toBe(
      `publisher-tax-production-exception-duplicate-suppression-not-preserved: ${SUPPRESSION_ID}`,
    );
  });

  it('holds when rollback and emergency hold decision is not linked to cutover controls', () => {
    const evidence = createExceptionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({
        rollbackEmergencyDecision: {
          ...evidence.rollbackEmergencyDecision,
          rollbackPlanId: 'rollback-plan:wrong',
        },
      }),
    });
    expect(report.failureReason).toBe(
      'publisher-tax-production-exception-rollback-hold-decision-not-linked',
    );
  });

  it('holds when exception operations leak a non-Coordinator/CDN network attempt', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({
        networkAttempts: [
          {
            url: 'https://coordinator.unzen.dev/payouts/tax-production-exceptions',
            initiator: 'dedicated-worker',
            blocked: false,
          },
          {
            url: 'https://collector.example.test/payout-tax-production-exceptions',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      }),
    });
    expect(report.failureReason).toBe(
      'publisher-tax-production-exception-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
  });

  it('holds when captured replay detections do not match upstream replay count', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionOperationsRunbookGate({
      productionMonitoringReconciliationReport: createMonitoringReport(),
      exceptionOperationsEvidence: createExceptionEvidence({ replayDetections: [] }),
    });
    expect(report.failureReason).toBe(
      'publisher-tax-production-exception-replay-detection-count-mismatch',
    );
  });
});
