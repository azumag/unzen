import { describe, expect, it } from 'vitest';
import type { WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport } from '../src/workers-coordinator-publisher-tax-production-exception-resolution-audit.js';
import {
  createWorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
  runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate,
  type WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence,
} from '../src/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.js';

const CAPTURED_AT = 1_783_400_000_000;
const CREATED_AT = CAPTURED_AT - 10_000;
const EXPORTED_AT = CAPTURED_AT - 8_000;
const RETENTION_START = CREATED_AT - 1_000;
const DAY = 86_400_000;
const MIN_RETENTION = 30 * DAY;
const RETENTION_END = RETENTION_START + 180 * DAY;
const NEXT_REVIEW = CAPTURED_AT + 7 * DAY;
const ARCHIVE_ID = 'tax-exception-archive:2026:001';
const POLICY_ID = 'tax-exception-retention-policy:v1';

function createResolutionAuditReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport> = {},
): WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport {
  const base = {
    runtime: 'publisher-tax-filing-production-exception-resolution-audit-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    exceptionOperationsEvidence: {
      operatorRunbookActions: [
        {
          actionId: 'runbook-action:rejected:001',
          callbackId: 'production-callback:rejected:001',
          providerFilingIds: ['provider-filing:001'],
        },
        {
          actionId: 'runbook-action:corrected:001',
          callbackId: 'production-callback:corrected:001',
          providerFilingIds: ['provider-filing:003'],
        },
        {
          actionId: 'runbook-action:replay:001',
          replayId: 'monitoring-replay:001',
          providerFilingIds: ['provider-filing:001', 'provider-filing:003'],
        },
      ],
    },
    actionResolutions: [
      {
        resolutionId: 'resolution:rejected:001',
        actionId: 'runbook-action:rejected:001',
        outcome: 'resolved',
        resolvedAtMs: CAPTURED_AT - 100_000,
      },
      {
        resolutionId: 'resolution:corrected:001',
        actionId: 'runbook-action:corrected:001',
        outcome: 'resolved',
        resolvedAtMs: CAPTURED_AT - 90_000,
      },
      {
        resolutionId: 'resolution:replay:001',
        actionId: 'runbook-action:replay:001',
        outcome: 'carried-forward',
        carryForward: {
          ownerId: 'operator:tax-ops-lead',
          reason: 'waiting for replay review window',
          nextReviewAtMs: NEXT_REVIEW,
        },
      },
    ],
    providerCorrectionOutcomes: [
      {
        correctionOutcomeId: 'provider-correction-outcome:001',
        actionId: 'runbook-action:corrected:001',
        providerFilingId: 'provider-filing:003',
      },
    ],
    supportResolutions: [
      {
        supportEscalationId: 'support-escalation:rejected:001',
        actionId: 'runbook-action:rejected:001',
      },
      {
        supportEscalationId: 'support-escalation:corrected:001',
        actionId: 'runbook-action:corrected:001',
      },
      {
        supportEscalationId: 'support-escalation:replay:001',
        actionId: 'runbook-action:replay:001',
      },
    ],
    terminalPublisherStatuses: [
      { terminalStatusUpdateId: 'terminal-status:rejected:001' },
      { terminalStatusUpdateId: 'terminal-status:corrected:001' },
      { terminalStatusUpdateId: 'terminal-status:replay:001' },
    ],
    immutableIdentityAudits: [
      {
        auditRecordId: 'identity-audit:rejected:001',
        identityFingerprint: 'audit-fingerprint:rejected:001',
      },
      {
        auditRecordId: 'identity-audit:corrected:001',
        identityFingerprint: 'audit-fingerprint:corrected:001',
      },
      {
        auditRecordId: 'identity-audit:replay:001',
        identityFingerprint: 'audit-fingerprint:replay:001',
      },
    ],
    duplicateFilingSuppressionState: {
      requiredDuplicateFilingSuppressionIds: ['duplicate-filing-suppression:001'],
      preservedDuplicateFilingSuppressionIds: ['duplicate-filing-suppression:001'],
    },
    rollbackEmergencyDecisionIdentity: {
      decisionId: 'exception-decision:001',
      rollbackPlanId: 'rollback-plan:001',
      emergencyHoldSwitchId: 'emergency-hold:001',
    },
    bottlenecksToIssue: ['publisher-tax-filing-production-exception-audit-archive-retention'],
  } as unknown as WorkersCoordinatorPublisherTaxProductionExceptionResolutionAuditReport;
  return { ...base, ...overrides };
}

async function createArchiveEvidence(
  report = createResolutionAuditReport(),
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionEvidence> {
  const archivePackage = await createWorkersCoordinatorPublisherTaxProductionExceptionArchivePackage(
    report,
    { archiveId: ARCHIVE_ID, createdAtMs: CREATED_AT },
  );
  return {
    source: 'publisher-tax-filing-production-exception-audit-archive-retention',
    capturedAtMs: CAPTURED_AT,
    archivePackage,
    archiveExport: {
      archiveId: ARCHIVE_ID,
      archiveLocator: 'r2://tax-audit-archive/2026/001.json',
      storageClass: 'compliance-archive',
      retentionPolicyId: POLICY_ID,
      exportedAtMs: EXPORTED_AT,
      contentDigest: archivePackage.contentDigest,
    },
    retentionPolicy: {
      policyId: POLICY_ID,
      minimumRetentionMs: MIN_RETENTION,
      retentionStartsAtMs: RETENTION_START,
      retentionEndsAtMs: RETENTION_END,
      legalHold: false,
      operationalHold: false,
      deletionEligible: false,
      deletionReview: {
        reviewId: 'deletion-review:001',
        decision: 'retain',
        reason: 'carried-forward replay action remains under review',
        reviewedAtMs: CAPTURED_AT - 1_000,
        nextReviewAtMs: NEXT_REVIEW,
      },
    },
    retrievalProofs: [
      {
        retrievalProofId: 'retrieval:archive:001',
        archiveId: ARCHIVE_ID,
        lookupKind: 'archive-id',
        lookupValue: ARCHIVE_ID,
        retrievedAtMs: CAPTURED_AT - 5_000,
        contentDigest: archivePackage.contentDigest,
      },
      {
        retrievalProofId: 'retrieval:provider:001',
        archiveId: ARCHIVE_ID,
        lookupKind: 'provider-filing-id',
        lookupValue: 'provider-filing:001',
        retrievedAtMs: CAPTURED_AT - 4_000,
        contentDigest: archivePackage.contentDigest,
      },
      {
        retrievalProofId: 'retrieval:provider:003',
        archiveId: ARCHIVE_ID,
        lookupKind: 'provider-filing-id',
        lookupValue: 'provider-filing:003',
        retrievedAtMs: CAPTURED_AT - 3_000,
        contentDigest: archivePackage.contentDigest,
      },
    ],
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
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/tax-exception-archive/verify',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/tax-exception-archive',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
  };
}

describe('publisher tax production exception audit archive / retention gate', () => {
  it('promotes when archive identity, digest, retrieval, retention, and security evidence reconcile', async () => {
    const report = createResolutionAuditReport();
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: await createArchiveEvidence(report),
    });
    expect(result.status).toBe('pass');
    expect(result.archiveSummary).toEqual({
      affectedProviderFilingCount: 2,
      resolutionCount: 3,
      carriedForwardCount: 1,
      retrievalProofCount: 3,
      retentionDurationMs: 180 * DAY,
      deletionEligible: false,
    });
    expect(result.failureReason).toBeUndefined();
    expect(result.bottlenecksToIssue).toEqual([
      'publisher-tax-filing-production-exception-archive-restore-drill',
    ]);
  });

  it('holds when the upstream resolution audit failed', async () => {
    const report = createResolutionAuditReport({ status: 'fail', failureReason: 'resolution-invalid' });
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: await createArchiveEvidence(report),
    });
    expect(result.failureReason).toBe(
      'publisher-tax-production-exception-resolution-audit-gate-not-clean: resolution-invalid',
    );
  });

  it('holds when archive identity is silently rewritten', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        archivePackage: {
          ...evidence.archivePackage,
          identity: { ...evidence.archivePackage.identity, actionIds: ['rewritten-action'] },
        },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-identity-mismatch',
    );
  });

  it('holds when the archive digest does not match package content', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        archivePackage: { ...evidence.archivePackage, contentDigest: 'sha256:deadbeef' },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-digest-mismatch',
    );
  });

  it('holds when a provider filing cannot retrieve the archive', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        retrievalProofs: evidence.retrievalProofs.filter(
          (entry) => entry.lookupValue !== 'provider-filing:003',
        ),
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-provider-retrieval-proof-missing-or-duplicate: provider-filing:003',
    );
  });

  it('holds when retention expires before a carried-forward review obligation', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        retentionPolicy: {
          ...evidence.retentionPolicy,
          retentionEndsAtMs: NEXT_REVIEW,
          minimumRetentionMs: DAY,
        },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-retention-expires-before-carry-forward-review',
    );
  });

  it('holds when a legal hold still marks the archive deletion-eligible', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        retentionPolicy: {
          ...evidence.retentionPolicy,
          legalHold: true,
          deletionEligible: true,
          deletionReview: {
            ...evidence.retentionPolicy.deletionReview,
            decision: 'eligible-after-retention',
            nextReviewAtMs: undefined,
          },
        },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-retention-hold-allows-deletion',
    );
  });

  it('holds when deletion eligibility is granted before retention ends', async () => {
    const terminalReport = createResolutionAuditReport({
      actionResolutions: createResolutionAuditReport().actionResolutions.map((entry) =>
        entry.outcome === 'carried-forward'
          ? {
              resolutionId: entry.resolutionId,
              actionId: entry.actionId,
              outcome: 'resolved',
              resolvedAtMs: CAPTURED_AT - 50_000,
            }
          : entry,
      ),
    });
    const evidence = await createArchiveEvidence(terminalReport);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: terminalReport,
      archiveRetentionEvidence: {
        ...evidence,
        retentionPolicy: {
          ...evidence.retentionPolicy,
          deletionEligible: true,
          deletionReview: {
            reviewId: 'deletion-review:early',
            decision: 'eligible-after-retention',
            reason: 'incorrectly marked early',
            reviewedAtMs: CAPTURED_AT - 1_000,
          },
        },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-retention-deletion-eligibility-invalid',
    );
  });

  it('holds when export evidence points at a different digest', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        archiveExport: { ...evidence.archiveExport, contentDigest: 'sha256:wrong' },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-export-invalid',
    );
  });

  it('holds when retrieval proof IDs are duplicated', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        retrievalProofs: evidence.retrievalProofs.map((entry) => ({
          ...entry,
          retrievalProofId: 'retrieval:duplicate',
        })),
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-retrieval-proof-id-invalid',
    );
  });

  it('holds when archive verification leaks to a non-Coordinator/CDN origin', async () => {
    const report = createResolutionAuditReport();
    const evidence = await createArchiveEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionGate({
      resolutionAuditReport: report,
      archiveRetentionEvidence: {
        ...evidence,
        networkAttempts: [
          {
            url: 'https://collector.example.test/tax-exception-archive',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
  });
});
