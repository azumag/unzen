import { describe, expect, it } from 'vitest';
import { runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate } from '../src/workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.js';
import type { WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport } from '../src/workers-coordinator-publisher-tax-production-exception-archive-restore-drill.js';

const nowMs = Date.parse('2026-08-19T12:00:00.000Z');
const restoredAtMs = nowMs - 3_600_000;
const archiveId = 'archive:failed-drill';
const digest = `sha256:${'c'.repeat(64)}`;
const retention = {
  policyId: 'retention:failed-drill', minimumRetentionMs: 86_400_000,
  retentionStartsAtMs: restoredAtMs - 86_400_000, retentionEndsAtMs: restoredAtMs + 86_400_000,
  legalHold: false, operationalHold: false, deletionEligible: false,
  deletionReview: { reviewId: 'review:failed-drill', decision: 'retain' as const, reason: 'retain', reviewedAtMs: restoredAtMs - 1_000 },
};

const upstream = {
  status: 'fail',
  failureReason: 'fixture restore failure',
  previewRunnerUrl: 'https://runner.unzen.test/preview',
  restoreAttempt: { restoreAttemptId: 'restore:failed', restoredAtMs },
  primaryAvailability: 'available',
  backupRecovery: undefined,
  retentionPolicySnapshot: retention,
  archiveRetentionEvidence: { archivePackage: { archiveId, contentDigest: digest } },
} as unknown as WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport;

const providerEvidence = {
  schemaVersion: '1.0.0', evidenceKind: 'archive-dr-provider-operations',
  evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed',
  producer: { name: 'fixture-provider', version: '0.1.0' }, runId: 'provider:failed-drill',
  capturedAt: new Date(nowMs - 10_000).toISOString(),
  environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'unit-test' },
  redaction: { applied: false, policyVersion: 'none' },
  payload: {
    providerName: 'fixture', accountId: 'acct', primaryStorageId: 'primary', backupStorageId: 'backup', replicaSiteId: 'replica',
    archiveId, archiveContentDigest: digest, capturedAtMs: nowMs - 10_000,
  },
} as const;

const disasterRecoveryEvidence = {
  source: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations' as const,
  schemaVersion: '1.0.0' as const,
  capturedAtMs: nowMs,
  schedule: { scheduleId: 'schedule:failed', cadenceMs: 86_400_000, lastSuccessfulDrillAtMs: restoredAtMs, nextDueAtMs: restoredAtMs + 86_400_000 },
  objectives: { rtoMs: 600_000, rpoMs: 600_000, maxBackupAgeMs: 600_000, maxReplicationLagMs: 120_000 },
  measurements: {
    recoveryStartedAtMs: nowMs - 300_000, recoveryCompletedAtMs: nowMs - 240_000,
    recoveryPointAtMs: nowMs - 360_000, primarySnapshotAtMs: nowMs - 360_000,
    backupSnapshotAtMs: nowMs - 420_000, replicationLagMs: 60_000, measuredAtMs: nowMs - 240_000,
  },
  ownership: { recoveryOwnerId: 'owner', onCallRoute: 'pager://dr', escalationTarget: 'incident-commander' },
  incidents: [], providerEvidence, retentionPolicySnapshot: retention, archiveId, archiveContentDigest: digest,
  allowedOrigins: ['https://coordinator.unzen.test', 'https://cdn.unzen.test'],
  cspConnectSrc: ['https://coordinator.unzen.test', 'https://cdn.unzen.test'], sandboxFlags: ['allow-scripts'],
  coop: 'same-origin', coep: 'require-corp',
  networkAttempts: [{ url: 'https://evil.example/probe', blocked: true }],
};

describe('archive DR failed restore drill incident', () => {
  it('holds for the failed drill and separately reports missing restore-drill-failed incident evidence', async () => {
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({
      restoreDrillReport: upstream,
      disasterRecoveryEvidence,
      providerEvidenceValidationOptions: { now: nowMs },
    });
    expect(report.status).toBe('fail');
    expect(report.promoteHoldThresholds.holdReasons[0]).toContain('restore-drill-not-clean');
    expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-incident-missing: restore-drill-failed');
  });
});
