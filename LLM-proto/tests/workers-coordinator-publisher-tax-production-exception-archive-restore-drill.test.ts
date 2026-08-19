import { describe, expect, it } from 'vitest';
import {
  computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest,
  type WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage,
  type WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport,
  type WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence,
} from '../src/workers-coordinator-publisher-tax-production-exception-audit-archive-retention.js';
import {
  runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate,
  type WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-restore-drill.js';

const ARCHIVE_ID = 'tax-exception-archive:2026:001';
const DIGESTED_AT = 1_787_162_000_000;
const EXPORTED_AT = 1_787_162_100_000;
const CAPTURED_AT = 1_787_162_900_000;

const IDENTITY = {
  actionResolutionIds: ['resolution:001'],
  actionIds: ['runbook-action:001'],
  providerCorrectionOutcomeIds: ['provider-correction-outcome:001'],
  supportEscalationIds: ['support-escalation:001'],
  terminalPublisherStatusUpdateIds: ['terminal-status:001'],
  immutableIdentityAuditRecordIds: ['identity-audit:001'],
  identityFingerprints: ['v1:runbook-action%3A001|support-escalation%3A001|publisher-status%3A001'],
  providerFilingIds: ['provider-filing:001'],
  productionCallbackIds: ['production-callback:001'],
  replayIds: ['monitoring-replay:001'],
  duplicateFilingSuppressionIds: ['duplicate-filing-suppression:001'],
  rollbackEmergencyDecisionIdentity: {
    decisionId: 'exception-decision:001',
    rollbackPlanId: 'rollback-plan:001',
    emergencyHoldSwitchId: 'emergency-hold:001',
  },
} as const;

const RETENTION_POLICY: WorkersCoordinatorPublisherTaxProductionExceptionRetentionPolicyEvidence = {
  policyId: 'tax-exception-retention:7y',
  minimumRetentionMs: 7 * 365 * 86_400_000,
  retentionStartsAtMs: DIGESTED_AT,
  retentionEndsAtMs: DIGESTED_AT + 8 * 365 * 86_400_000,
  legalHold: false,
  operationalHold: true,
  deletionEligible: false,
  deletionReview: {
    reviewId: 'deletion-review:001',
    decision: 'retain',
    reason: 'operational hold remains active',
    reviewedAtMs: EXPORTED_AT + 100_000,
    nextReviewAtMs: CAPTURED_AT + 86_400_000,
  },
};

async function createArchivePackage(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage> = {},
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage> {
  const unsigned = {
    schemaVersion: '1.0.0' as const,
    archiveId: ARCHIVE_ID,
    createdAtMs: DIGESTED_AT,
    identity: IDENTITY,
  };
  const base: WorkersCoordinatorPublisherTaxProductionExceptionArchivePackage = {
    ...unsigned,
    contentDigest: await computeWorkersCoordinatorPublisherTaxProductionExceptionArchiveDigest(unsigned),
  };
  return { ...base, ...overrides };
}

async function createArchiveRetentionReport(
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport> = {},
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport> {
  const archivePackage = await createArchivePackage();
  const base = {
    runtime: 'publisher-tax-filing-production-exception-audit-archive-retention-gate',
    status: 'pass',
    previewRunnerUrl: 'https://preview.unzen-workers.example/runners/signed/runner.html',
    archivePackage,
    archiveExport: {
      archiveId: ARCHIVE_ID,
      archiveLocator: 'r2://tax-compliance/archive/2026/001.json',
      storageClass: 'compliance-archive',
      retentionPolicyId: RETENTION_POLICY.policyId,
      exportedAtMs: EXPORTED_AT,
      contentDigest: archivePackage.contentDigest,
    },
    retentionPolicy: RETENTION_POLICY,
    retrievalProofs: [
      {
        retrievalProofId: 'retrieval:archive:001',
        archiveId: ARCHIVE_ID,
        lookupKind: 'archive-id',
        lookupValue: ARCHIVE_ID,
        retrievedAtMs: EXPORTED_AT + 10_000,
        contentDigest: archivePackage.contentDigest,
      },
      {
        retrievalProofId: 'retrieval:provider:001',
        archiveId: ARCHIVE_ID,
        lookupKind: 'provider-filing-id',
        lookupValue: 'provider-filing:001',
        retrievedAtMs: EXPORTED_AT + 20_000,
        contentDigest: archivePackage.contentDigest,
      },
    ],
    bottlenecksToIssue: ['publisher-tax-filing-production-exception-archive-restore-drill'],
  } as unknown as WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport;
  return { ...base, ...overrides };
}

async function createEvidence(
  report: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport,
  overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence> = {},
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence> {
  const archive = report.archivePackage;
  const base: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence = {
    source: 'publisher-tax-filing-production-exception-archive-restore-drill',
    capturedAtMs: CAPTURED_AT,
    primaryAvailability: 'available',
    restoreAttempt: {
      restoreAttemptId: 'restore-attempt:001',
      archiveId: ARCHIVE_ID,
      source: 'primary-archive',
      requestedAtMs: CAPTURED_AT - 60_000,
      restoredAtMs: CAPTURED_AT - 50_000,
      restoredPackage: archive,
    },
    integrityChecks: [
      {
        integrityCheckId: 'integrity-check:001',
        archiveId: ARCHIVE_ID,
        verifierId: 'verifier:tax-archive-integrity',
        expectedDigest: archive.contentDigest,
        observedDigest: archive.contentDigest,
        result: 'match',
        checkedAtMs: CAPTURED_AT - 40_000,
      },
    ],
    accessAuditRecords: [
      {
        accessLogId: 'access:restore:001',
        archiveId: ARCHIVE_ID,
        actorId: 'operator:tax-ops',
        purpose: 'scheduled restore drill',
        operation: 'restore',
        occurredAtMs: CAPTURED_AT - 55_000,
        result: 'success',
      },
      {
        accessLogId: 'access:integrity:001',
        archiveId: ARCHIVE_ID,
        actorId: 'verifier:tax-archive-integrity',
        purpose: 'post-restore digest verification',
        operation: 'integrity-check',
        occurredAtMs: CAPTURED_AT - 40_000,
        result: 'success',
      },
    ],
    retentionPolicySnapshot: report.retentionPolicy,
    cspConnectSrc: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin',
    coep: 'require-corp',
    allowedOrigins: ['https://coordinator.unzen.dev', 'wss://coordinator.unzen.dev', 'https://cdn.unzen.dev'],
    networkAttempts: [
      {
        url: 'https://coordinator.unzen.dev/tax-archive/restore',
        initiator: 'dedicated-worker',
        blocked: false,
      },
      {
        url: 'https://collector.example.test/tax-archive/restore',
        initiator: 'dedicated-worker',
        blocked: true,
        reason: 'browser CSP connect-src rejected non-Coordinator/CDN origin',
      },
    ],
  };
  return { ...base, ...overrides };
}

async function createBackupEvidence(
  report: WorkersCoordinatorPublisherTaxProductionExceptionArchiveRetentionReport,
): Promise<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillEvidence> {
  const base = await createEvidence(report);
  return {
    ...base,
    primaryAvailability: 'missing',
    restoreAttempt: {
      ...base.restoreAttempt,
      source: 'backup-replica',
    },
    backupRecovery: {
      recoveryId: 'backup-recovery:001',
      backupId: 'backup:tax-exception-archive:001',
      archiveId: ARCHIVE_ID,
      backupLocator: 'r2://tax-compliance-backup/archive/2026/001.json',
      contentDigest: report.archivePackage.contentDigest,
      recoveredAtMs: CAPTURED_AT - 52_000,
      restoredPackage: report.archivePackage,
    },
    accessAuditRecords: [
      ...base.accessAuditRecords,
      {
        accessLogId: 'access:backup:001',
        archiveId: ARCHIVE_ID,
        actorId: 'operator:tax-ops',
        purpose: 'recover missing primary archive',
        operation: 'backup-recovery',
        occurredAtMs: CAPTURED_AT - 52_000,
        result: 'success',
      },
    ],
  };
}

describe('publisher tax production exception archive restore / integrity drill gate', () => {
  it('promotes when the primary archive restores with matching digest and access audit evidence', async () => {
    const report = await createArchiveRetentionReport();
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: await createEvidence(report),
    });
    expect(result.status).toBe('pass');
    expect(result.restoreSummary.backupRecoveryUsed).toBe(false);
    expect(result.bottlenecksToIssue).toEqual([
      'publisher-tax-filing-production-exception-archive-disaster-recovery-operations',
    ]);
  });

  it('promotes when a missing primary archive is recovered from an identical backup replica', async () => {
    const report = await createArchiveRetentionReport();
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: await createBackupEvidence(report),
    });
    expect(result.status).toBe('pass');
    expect(result.restoreSummary.restoreSource).toBe('backup-replica');
    expect(result.restoreSummary.backupRecoveryUsed).toBe(true);
  });

  it('holds when upstream archive retention failed', async () => {
    const report = await createArchiveRetentionReport({ status: 'fail', failureReason: 'archive-invalid' });
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: await createEvidence(report),
    });
    expect(result.failureReason).toBe(
      'publisher-tax-production-exception-archive-retention-gate-not-clean: archive-invalid',
    );
  });

  it('holds when restored archive content is mutated', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const mutated = {
      ...report.archivePackage,
      archiveId: 'tax-exception-archive:mutated',
    };
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        restoreAttempt: { ...evidence.restoreAttempt, restoredPackage: mutated },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-package-invalid',
    );
  });

  it('holds when a missing primary has no backup recovery evidence', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        primaryAvailability: 'missing',
        restoreAttempt: { ...evidence.restoreAttempt, source: 'backup-replica' },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-backup-required',
    );
  });

  it('holds when backup digest or identity differs from upstream archive', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createBackupEvidence(report);
    const corruptedBackup = {
      ...report.archivePackage,
      contentDigest: 'sha256:corrupted',
    };
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        backupRecovery: evidence.backupRecovery && {
          ...evidence.backupRecovery,
          contentDigest: 'sha256:corrupted',
          restoredPackage: corruptedBackup,
        },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-backup-invalid',
    );
  });

  it('holds when the integrity check reports a mismatch', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        integrityChecks: evidence.integrityChecks.map((entry) => ({
          ...entry,
          observedDigest: 'sha256:mismatch',
          result: 'mismatch' as const,
        })),
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-integrity-check-missing-or-failed',
    );
  });

  it('holds when the latest successful integrity check predates the restore', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        integrityChecks: evidence.integrityChecks.map((entry) => ({
          ...entry,
          checkedAtMs: evidence.restoreAttempt.restoredAtMs - 1,
        })),
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-integrity-check-stale',
    );
  });

  it('holds when restore access is not auditable', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        accessAuditRecords: evidence.accessAuditRecords.filter((entry) => entry.operation !== 'restore'),
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-access-audit-missing: restore',
    );
  });

  it('holds when retention / hold / deletion state is changed during restore', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        retentionPolicySnapshot: {
          ...evidence.retentionPolicySnapshot,
          operationalHold: false,
          deletionEligible: true,
        },
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-retention-state-changed',
    );
  });

  it('holds when restore verification leaks to a non-Coordinator/CDN origin', async () => {
    const report = await createArchiveRetentionReport();
    const evidence = await createEvidence(report);
    const result = await runWorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillGate({
      archiveRetentionReport: report,
      restoreDrillEvidence: {
        ...evidence,
        networkAttempts: [
          ...evidence.networkAttempts,
          {
            url: 'https://collector.example.test/leak',
            initiator: 'dedicated-worker',
            blocked: false,
          },
        ],
      },
    });
    expect(result.promoteHoldThresholds.holdReasons).toContain(
      'publisher-tax-production-exception-archive-restore-non-coordinator-cdn-network-attempt-not-blocked: https://collector.example.test',
    );
  });
});
