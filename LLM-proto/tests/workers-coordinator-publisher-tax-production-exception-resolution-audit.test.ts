import { describe, expect, it } from 'vitest';
import type { WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport } from '../src/workers-coordinator-publisher-tax-production-exception-operations.js';
import {
  createWorkersCoordinatorPublisherTaxProductionExceptionIdentityFingerprint,
  runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate,
  type WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence,
} from '../src/workers-coordinator-publisher-tax-production-exception-resolution-audit.js';

const WINDOW_ID = 'tax-production-filing-window:publisher-rewards:2026:001';
const ROLLBACK_ID = 'rollback-plan:publisher-tax-production-cutover:2026:001';
const HOLD_ID = 'emergency-hold:publisher-tax-production-cutover:2026:001';
const DECISION_ID = 'exception-decision:publisher-tax-production:2026:001';
const SUPPRESSION_ID = 'duplicate-filing-suppression:publisher-rewards:2026:001';
const CAPTURED_AT = 1_783_312_500_000;

const ACTIONS = {
  rejected: 'runbook-action:rejected:001',
  corrected: 'runbook-action:corrected:001',
  duplicate: 'runbook-action:duplicate:001',
  replay: 'runbook-action:replay:001',
} as const;

const SUPPORT = {
  rejected: 'support-escalation:rejected:001',
  corrected: 'support-escalation:corrected:001',
  duplicate: 'support-escalation:duplicate:001',
  replay: 'support-escalation:replay:001',
} as const;

const ORIGINAL_STATUS = {
  rejected: 'publisher-status:rejected:001',
  corrected: 'publisher-status:corrected:001',
  duplicate: 'publisher-status:duplicate:001',
  replay: 'publisher-status:replay:001',
} as const;

function createExceptionOperationsReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport> = {},
): WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport {
  const base = {
    runtime: 'publisher-tax-filing-production-exception-operations-runbook-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    operatorRunbookActions: [
      {
        actionId: ACTIONS.rejected,
        eventType: 'filing.rejected',
        callbackId: 'production-callback:rejected:001',
        monitoringRecordIds: ['monitoring:rejected:001'],
        monitoringAlertIds: ['alert:rejected:001'],
        providerFilingIds: ['provider-filing:001'],
        productionWindowId: WINDOW_ID,
        action: 'investigate-rejection',
        status: 'acknowledged',
        createdAtMs: 1_783_311_100_000,
      },
      {
        actionId: ACTIONS.corrected,
        eventType: 'filing.corrected',
        callbackId: 'production-callback:corrected:001',
        monitoringRecordIds: ['monitoring:corrected:001'],
        monitoringAlertIds: [],
        providerFilingIds: ['provider-filing:003'],
        productionWindowId: WINDOW_ID,
        action: 'prepare-correction',
        status: 'acknowledged',
        createdAtMs: 1_783_311_110_000,
      },
      {
        actionId: ACTIONS.duplicate,
        eventType: 'filing.duplicate_suppressed',
        callbackId: 'production-callback:duplicate:001',
        monitoringRecordIds: ['monitoring:duplicate:001'],
        monitoringAlertIds: ['alert:duplicate:001'],
        providerFilingIds: ['provider-filing:001'],
        productionWindowId: WINDOW_ID,
        action: 'confirm-duplicate-suppression',
        status: 'resolved',
        createdAtMs: 1_783_311_120_000,
      },
      {
        actionId: ACTIONS.replay,
        eventType: 'monitoring.replay_detected',
        replayId: 'monitoring-replay:001',
        monitoringRecordIds: ['monitoring:rejected:001', 'monitoring:corrected:001'],
        monitoringAlertIds: ['alert:rejected:001'],
        providerFilingIds: ['provider-filing:001', 'provider-filing:003'],
        productionWindowId: WINDOW_ID,
        action: 'review-replay',
        status: 'open',
        createdAtMs: 1_783_311_130_000,
      },
    ],
    supportEscalations: [
      { supportEscalationId: SUPPORT.rejected, actionId: ACTIONS.rejected },
      { supportEscalationId: SUPPORT.corrected, actionId: ACTIONS.corrected },
      { supportEscalationId: SUPPORT.duplicate, actionId: ACTIONS.duplicate },
      { supportEscalationId: SUPPORT.replay, actionId: ACTIONS.replay },
    ],
    publisherStatusUpdates: [
      {
        statusUpdateId: ORIGINAL_STATUS.rejected,
        providerFilingId: 'provider-filing:001',
        productionWindowId: WINDOW_ID,
        actionIds: [ACTIONS.rejected],
        publishedAtMs: 1_783_311_200_000,
      },
      {
        statusUpdateId: ORIGINAL_STATUS.corrected,
        providerFilingId: 'provider-filing:003',
        productionWindowId: WINDOW_ID,
        actionIds: [ACTIONS.corrected],
        publishedAtMs: 1_783_311_210_000,
      },
      {
        statusUpdateId: ORIGINAL_STATUS.duplicate,
        providerFilingId: 'provider-filing:001',
        productionWindowId: WINDOW_ID,
        actionIds: [ACTIONS.duplicate],
        publishedAtMs: 1_783_311_220_000,
      },
      {
        statusUpdateId: ORIGINAL_STATUS.replay,
        providerFilingId: 'provider-filing:001',
        productionWindowId: WINDOW_ID,
        actionIds: [ACTIONS.replay],
        publishedAtMs: 1_783_311_230_000,
      },
      {
        statusUpdateId: 'publisher-status:replay:002',
        providerFilingId: 'provider-filing:003',
        productionWindowId: WINDOW_ID,
        actionIds: [ACTIONS.replay],
        publishedAtMs: 1_783_311_231_000,
      },
    ],
    duplicateFilingSuppressionState: {
      requiredDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
      preservedDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
    },
    rollbackEmergencyDecisionEvidence: {
      decisionId: DECISION_ID,
      rollbackPlanId: ROLLBACK_ID,
      emergencyHoldSwitchId: HOLD_ID,
      decision: 'continue-monitoring',
      reason: 'exceptions remain bounded',
      decidedAtMs: 1_783_311_300_000,
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-exception-resolution-audit'],
  } as unknown as WorkersCoordinatorPublisherTaxProductionExceptionOperationsReport;
  return { ...base, ...overrides };
}

function auditIdentity(actionId: string, supportId: string, publisherIds: readonly string[]) {
  return {
    auditRecordId: `identity-audit:${actionId}`,
    actionId,
    supportEscalationIds: [supportId],
    originalPublisherStatusUpdateIds: publisherIds,
    identityFingerprint: createWorkersCoordinatorPublisherTaxProductionExceptionIdentityFingerprint(
      actionId,
      [supportId],
      publisherIds,
    ),
    recordedAtMs: 1_783_312_400_000,
  };
}

function createResolutionEvidence(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence> = {},
): WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence {
  const base: WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditEvidence = {
    source: 'publisher-tax-filing-production-exception-resolution-audit',
    capturedAtMs: CAPTURED_AT,
    actionResolutions: [
      { resolutionId: 'resolution:rejected:001', actionId: ACTIONS.rejected, outcome: 'resolved', resolvedAtMs: 1_783_312_100_000 },
      { resolutionId: 'resolution:corrected:001', actionId: ACTIONS.corrected, outcome: 'resolved', resolvedAtMs: 1_783_312_110_000 },
      { resolutionId: 'resolution:duplicate:001', actionId: ACTIONS.duplicate, outcome: 'resolved', resolvedAtMs: 1_783_312_120_000 },
      {
        resolutionId: 'resolution:replay:001',
        actionId: ACTIONS.replay,
        outcome: 'carried-forward',
        carryForward: {
          ownerId: 'operator:tax-ops-lead',
          reason: 'waiting for replay investigation window to close',
          nextReviewAtMs: CAPTURED_AT + 86_400_000,
        },
      },
    ],
    providerCorrectionOutcomes: [
      {
        correctionOutcomeId: 'provider-correction-outcome:001',
        actionId: ACTIONS.corrected,
        providerFilingId: 'provider-filing:003',
        productionWindowId: WINDOW_ID,
        providerSubmissionId: 'provider-correction-submission:001',
        providerStatus: 'accepted',
        observedAtMs: 1_783_312_105_000,
      },
    ],
    supportResolutions: [
      { supportEscalationId: SUPPORT.rejected, actionId: ACTIONS.rejected, state: 'closed', closedAtMs: 1_783_312_130_000 },
      { supportEscalationId: SUPPORT.corrected, actionId: ACTIONS.corrected, state: 'closed', closedAtMs: 1_783_312_140_000 },
      { supportEscalationId: SUPPORT.duplicate, actionId: ACTIONS.duplicate, state: 'closed', closedAtMs: 1_783_312_150_000 },
      { supportEscalationId: SUPPORT.replay, actionId: ACTIONS.replay, state: 'carried-forward', nextReviewAtMs: CAPTURED_AT + 86_400_000 },
    ],
    terminalPublisherStatuses: [
      { terminalStatusUpdateId: 'terminal-status:rejected:001', providerFilingId: 'provider-filing:001', productionWindowId: WINDOW_ID, actionIds: [ACTIONS.rejected], status: 'resolved', publishedAtMs: 1_783_312_160_000 },
      { terminalStatusUpdateId: 'terminal-status:corrected:001', providerFilingId: 'provider-filing:003', productionWindowId: WINDOW_ID, actionIds: [ACTIONS.corrected], status: 'corrected-accepted', publishedAtMs: 1_783_312_170_000 },
      { terminalStatusUpdateId: 'terminal-status:duplicate:001', providerFilingId: 'provider-filing:001', productionWindowId: WINDOW_ID, actionIds: [ACTIONS.duplicate], status: 'duplicate-confirmed', publishedAtMs: 1_783_312_180_000 },
      { terminalStatusUpdateId: 'terminal-status:replay:001', providerFilingId: 'provider-filing:001', productionWindowId: WINDOW_ID, actionIds: [ACTIONS.replay], status: 'carried-forward', publishedAtMs: 1_783_312_190_000 },
      { terminalStatusUpdateId: 'terminal-status:replay:002', providerFilingId: 'provider-filing:003', productionWindowId: WINDOW_ID, actionIds: [ACTIONS.replay], status: 'carried-forward', publishedAtMs: 1_783_312_191_000 },
    ],
    immutableIdentityAudits: [
      auditIdentity(ACTIONS.rejected, SUPPORT.rejected, [ORIGINAL_STATUS.rejected]),
      auditIdentity(ACTIONS.corrected, SUPPORT.corrected, [ORIGINAL_STATUS.corrected]),
      auditIdentity(ACTIONS.duplicate, SUPPORT.duplicate, [ORIGINAL_STATUS.duplicate]),
      auditIdentity(ACTIONS.replay, SUPPORT.replay, [ORIGINAL_STATUS.replay, 'publisher-status:replay:002']),
    ],
    preservedDuplicateFilingSuppressionIds: [SUPPRESSION_ID],
    rollbackEmergencyDecisionIdentity: {
      decisionId: DECISION_ID,
      rollbackPlanId: ROLLBACK_ID,
      emergencyHoldSwitchId: HOLD_ID,
    },
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      { url: 'https://coordinator.unzen.dev/payouts/tax-exception-resolution', initiator: 'dedicated-worker', blocked: false },
      { url: 'https://collector.example.test/tax-exception-resolution', initiator: 'dedicated-worker', blocked: true, reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin' },
    ],
  };
  return { ...base, ...overrides };
}

describe('publisher tax production exception resolution audit gate', () => {
  it('promotes when each action is resolved or explicitly carried forward with immutable traceability', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence(),
    });
    expect(report.status).toBe('pass');
    expect(report.resolutionSummary).toEqual({
      upstreamActionCount: 4,
      resolvedActionCount: 3,
      carriedForwardActionCount: 1,
      correctionOutcomeCount: 1,
      closedSupportEscalationCount: 3,
      carriedForwardSupportEscalationCount: 1,
      terminalPublisherStatusCount: 5,
    });
    expect(report.failureReason).toBeUndefined();
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-exception-audit-archive-retention']);
  });

  it('holds when upstream exception operations failed', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport({ status: 'fail', failureReason: 'runbook-invalid' }),
      resolutionAuditEvidence: createResolutionEvidence(),
    });
    expect(report.failureReason).toBe('publisher-tax-production-exception-operations-gate-not-clean: runbook-invalid');
  });

  it('holds when an upstream action has no resolution record', () => {
    const evidence = createResolutionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        actionResolutions: evidence.actionResolutions.filter((entry) => entry.actionId !== ACTIONS.duplicate),
      }),
    });
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-resolution-action-coverage-invalid');
  });

  it('holds when a carry-forward record has no future review', () => {
    const evidence = createResolutionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        actionResolutions: evidence.actionResolutions.map((entry) => entry.actionId === ACTIONS.replay
          ? { ...entry, carryForward: { ownerId: 'operator:tax-ops-lead', reason: 'pending', nextReviewAtMs: CAPTURED_AT } }
          : entry),
      }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain(`publisher-tax-production-exception-resolution-carry-forward-invalid: ${ACTIONS.replay}`);
  });

  it('holds when corrected filing outcome evidence is missing', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({ providerCorrectionOutcomes: [] }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain(`publisher-tax-production-exception-resolution-correction-outcome-invalid: ${ACTIONS.corrected}`);
  });

  it('holds when support resolution state conflicts with action resolution', () => {
    const evidence = createResolutionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        supportResolutions: evidence.supportResolutions.map((entry) => entry.actionId === ACTIONS.rejected
          ? { ...entry, state: 'carried-forward' as const, closedAtMs: undefined, nextReviewAtMs: CAPTURED_AT + 1 }
          : entry),
      }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain(`publisher-tax-production-exception-resolution-support-state-invalid: ${ACTIONS.rejected}`);
  });

  it('holds when a carried-forward action is presented as terminal to the publisher', () => {
    const evidence = createResolutionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        terminalPublisherStatuses: evidence.terminalPublisherStatuses.map((entry) => entry.actionIds.includes(ACTIONS.replay)
          ? { ...entry, status: 'resolved' as const }
          : entry),
      }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain(`publisher-tax-production-exception-resolution-publisher-status-not-carried-forward: ${ACTIONS.replay}`);
  });

  it('holds when immutable identity fingerprint rewrites upstream identity', () => {
    const evidence = createResolutionEvidence();
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        immutableIdentityAudits: evidence.immutableIdentityAudits.map((entry) => entry.actionId === ACTIONS.rejected
          ? { ...entry, identityFingerprint: 'rewritten' }
          : entry),
      }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain(`publisher-tax-production-exception-resolution-immutable-identity-invalid: ${ACTIONS.rejected}`);
  });

  it('holds when duplicate suppression or rollback controls change', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        preservedDuplicateFilingSuppressionIds: [],
        rollbackEmergencyDecisionIdentity: {
          decisionId: DECISION_ID,
          rollbackPlanId: 'changed',
          emergencyHoldSwitchId: HOLD_ID,
        },
      }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-resolution-duplicate-suppression-changed');
    expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-resolution-rollback-hold-identity-changed');
  });

  it('holds when resolution audit leaks to a non-Coordinator/CDN origin', () => {
    const report = runWorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditGate({
      exceptionOperationsReport: createExceptionOperationsReport(),
      resolutionAuditEvidence: createResolutionEvidence({
        networkAttempts: [
          { url: 'https://coordinator.unzen.dev/payouts/tax-exception-resolution', initiator: 'dedicated-worker', blocked: false },
          { url: 'https://collector.example.test/tax-exception-resolution', initiator: 'dedicated-worker', blocked: false },
        ],
      }),
    });
    expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-resolution-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test');
  });
});
