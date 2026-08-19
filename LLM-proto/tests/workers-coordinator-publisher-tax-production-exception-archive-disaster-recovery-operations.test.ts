import { describe, expect, it } from 'vitest';
import type { SelfReportedEvidenceEnvelope } from '../src/evidence.js';
import {
  runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate,
  type WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence,
  type WorkersCoordinatorPublisherTaxProductionArchiveDrIncident,
  type WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-disaster-recovery-operations.js';
import type { WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport } from '../src/workers-coordinator-publisher-tax-production-exception-archive-restore-drill.js';

const NOW_MS = Date.parse('2026-08-19T12:00:00.000Z');
const RESTORED_AT = NOW_MS - 3_600_000;
const ARCHIVE_ID = 'archive:tax-exception:2026:001';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const RETENTION = {
  policyId: 'retention:tax:001',
  minimumRetentionMs: 86_400_000,
  retentionStartsAtMs: RESTORED_AT - 86_400_000,
  retentionEndsAtMs: RESTORED_AT + 365 * 86_400_000,
  legalHold: false,
  operationalHold: false,
  deletionEligible: false,
  deletionReview: {
    reviewId: 'deletion-review:001',
    decision: 'retain' as const,
    reason: 'active retention window',
    reviewedAtMs: RESTORED_AT - 1_000,
  },
};

function restoreReport(overrides: Partial<WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport> = {}): WorkersCoordinatorPublisherTaxProductionExceptionArchiveRestoreDrillReport {
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-restore-drill-gate',
    status: 'pass',
    previewRunnerUrl: 'https://runner.unzen.test/preview',
    archiveRetentionEvidence: {
      runtime: 'publisher-tax-filing-production-exception-audit-archive-retention-gate',
      status: 'pass',
      previewRunnerUrl: 'https://runner.unzen.test/preview',
      resolutionAuditEvidence: {} as never,
      archivePackage: {
        schemaVersion: '1.0.0',
        archiveId: ARCHIVE_ID,
        createdAtMs: RESTORED_AT - 60_000,
        identity: {
          actionResolutionIds: [], actionIds: [], providerCorrectionOutcomeIds: [], supportEscalationIds: [], terminalPublisherStatusUpdateIds: [], immutableIdentityAuditRecordIds: [], identityFingerprints: [], providerFilingIds: [], productionCallbackIds: [], replayIds: [], duplicateFilingSuppressionIds: [],
          rollbackEmergencyDecisionIdentity: { decisionId: 'decision:1', rollbackPlanId: 'rollback:1', emergencyHoldSwitchId: 'hold:1' },
        },
        contentDigest: DIGEST,
      },
      archiveExport: {} as never,
      retentionPolicy: RETENTION,
      retrievalProofs: [],
      archiveSummary: { affectedProviderFilingCount: 0, resolutionCount: 0, carriedForwardCount: 0, retrievalProofCount: 0, retentionDurationMs: RETENTION.retentionEndsAtMs - RETENTION.retentionStartsAtMs, deletionEligible: false },
      promoteHoldThresholds: { decision: 'promote', promoteWhen: [], holdReasons: [] },
      securityBoundaryDuringArchiveVerification: { cspConnectSrc: [], sandboxFlags: [], coop: 'same-origin', coep: 'require-corp', allowedOrigins: [], blockedNonCoordinatorCdnNetworkAttempt: null },
      bottlenecksToIssue: [],
    },
    primaryAvailability: 'available',
    restoreAttempt: {
      restoreAttemptId: 'restore:001', archiveId: ARCHIVE_ID, source: 'primary-archive', requestedAtMs: RESTORED_AT - 30_000, restoredAtMs: RESTORED_AT,
      restoredPackage: {} as never,
    },
    integrityChecks: [],
    accessAuditRecords: [],
    retentionPolicySnapshot: RETENTION,
    restoreSummary: { archiveId: ARCHIVE_ID, restoreSource: 'primary-archive', integrityCheckCount: 1, successfulIntegrityCheckCount: 1, accessAuditRecordCount: 2, backupRecoveryUsed: false },
    promoteHoldThresholds: { decision: 'promote', promoteWhen: [], holdReasons: [] },
    securityBoundaryDuringRestoreVerification: { cspConnectSrc: [], sandboxFlags: [], coop: 'same-origin', coep: 'require-corp', allowedOrigins: [], blockedNonCoordinatorCdnNetworkAttempt: null },
    bottlenecksToIssue: [],
    ...overrides,
  };
}

function providerEnvelope(payloadOverrides: Partial<WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload> = {}): SelfReportedEvidenceEnvelope<WorkersCoordinatorPublisherTaxProductionArchiveProviderPayload> {
  return {
    schemaVersion: '1.0.0',
    evidenceKind: 'archive-dr-provider-operations',
    evidenceLevel: 'self-reported-runtime',
    readinessStatus: 'runtime-observed',
    producer: { name: 'archive-provider-adapter', version: '0.1.0' },
    runId: 'provider-run:001',
    capturedAt: new Date(NOW_MS - 10_000).toISOString(),
    environment: { runtime: 'node', runtimeVersion: '22.23.2', executionSurface: 'dr-operations-fixture' },
    redaction: { applied: false, policyVersion: 'none' },
    payload: {
      providerName: 'fixture-archive-provider', accountId: 'acct:001', primaryStorageId: 'primary:001', backupStorageId: 'backup:001', replicaSiteId: 'region:b', archiveId: ARCHIVE_ID, archiveContentDigest: DIGEST, capturedAtMs: NOW_MS - 10_000,
      ...payloadOverrides,
    },
  };
}

function evidence(overrides: Partial<WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence> = {}): WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence {
  const recoveryStartedAtMs = NOW_MS - 2_400_000;
  const primarySnapshotAtMs = recoveryStartedAtMs - 300_000;
  const backupSnapshotAtMs = primarySnapshotAtMs - 60_000;
  return {
    source: 'publisher-tax-filing-production-exception-archive-disaster-recovery-operations',
    schemaVersion: '1.0.0',
    capturedAtMs: NOW_MS,
    schedule: { scheduleId: 'schedule:001', cadenceMs: 30 * 86_400_000, lastSuccessfulDrillAtMs: RESTORED_AT, nextDueAtMs: RESTORED_AT + 30 * 86_400_000 },
    objectives: { rtoMs: 600_000, rpoMs: 600_000, maxBackupAgeMs: 900_000, maxReplicationLagMs: 120_000 },
    measurements: { recoveryStartedAtMs, recoveryCompletedAtMs: recoveryStartedAtMs + 120_000, recoveryPointAtMs: recoveryStartedAtMs - 180_000, primarySnapshotAtMs, backupSnapshotAtMs, replicationLagMs: 60_000, measuredAtMs: recoveryStartedAtMs + 120_000 },
    ownership: { recoveryOwnerId: 'ops-owner:001', onCallRoute: 'pager://archive-dr', escalationTarget: 'incident-commander' },
    incidents: [],
    providerEvidence: providerEnvelope(),
    retentionPolicySnapshot: RETENTION,
    archiveId: ARCHIVE_ID,
    archiveContentDigest: DIGEST,
    allowedOrigins: ['https://coordinator.unzen.test', 'https://cdn.unzen.test'],
    cspConnectSrc: ['https://coordinator.unzen.test', 'https://cdn.unzen.test'],
    sandboxFlags: ['allow-scripts'],
    coop: 'same-origin', coep: 'require-corp',
    networkAttempts: [
      { url: 'https://coordinator.unzen.test/dr', blocked: false },
      { url: 'https://evil.example/exfiltrate', blocked: true },
    ],
    ...overrides,
  };
}

function incident(trigger: WorkersCoordinatorPublisherTaxProductionArchiveDrIncident['trigger']): WorkersCoordinatorPublisherTaxProductionArchiveDrIncident {
  return { incidentId: `incident:${trigger}`, restoreAttemptId: 'restore:001', trigger, severity: 'sev2', ownerId: 'ops-owner:001', escalationTarget: 'incident-commander', status: 'mitigating', openedAtMs: NOW_MS - 1_000 };
}

describe('publisher tax exception archive disaster recovery operations gate', () => {
  it('passes a clean recurring DR operations report without overstating provider provenance', async () => {
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence(), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('pass');
    expect(report.providerEvidenceSummary.effectiveEvidenceLevel).toBe('self-reported-runtime');
    expect(report.providerEvidenceSummary.provenanceNote).toContain('do not prove a real archival provider run');
    expect(report.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-exception-archive-dr-provider-pilot']);
  });

  it('passes backup recovery only when incident evidence covers primary loss and backup use', async () => {
    const upstream = restoreReport({ primaryAvailability: 'missing', backupRecovery: {} as never, restoreSummary: { archiveId: ARCHIVE_ID, restoreSource: 'backup-replica', integrityCheckCount: 1, successfulIntegrityCheckCount: 1, accessAuditRecordCount: 3, backupRecoveryUsed: true } });
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: upstream, disasterRecoveryEvidence: evidence({ incidents: [incident('primary-unavailable'), incident('backup-recovery-used')] }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('pass');
    expect(report.drSummary.backupRecoveryUsed).toBe(true);
  });

  it('fails when RTO is breached even with an incident record', async () => {
    const base = evidence();
    const measurements = { ...base.measurements, recoveryCompletedAtMs: base.measurements.recoveryStartedAtMs + 700_000, measuredAtMs: base.measurements.recoveryStartedAtMs + 700_000 };
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ measurements, incidents: [incident('rto-breach')] }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-rto-breached');
  });

  it('fails when RPO is breached', async () => {
    const base = evidence();
    const measurements = { ...base.measurements, recoveryPointAtMs: base.measurements.recoveryStartedAtMs - 700_000 };
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ measurements, incidents: [incident('rpo-breach')] }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-rpo-breached');
  });

  it('fails when backup age or replication lag exceeds thresholds', async () => {
    const base = evidence();
    const primarySnapshotAtMs = base.measurements.recoveryStartedAtMs - 100_000;
    const backupSnapshotAtMs = base.measurements.recoveryStartedAtMs - 1_000_000;
    const measurements = { ...base.measurements, primarySnapshotAtMs, backupSnapshotAtMs, replicationLagMs: 900_000 };
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ measurements, incidents: [incident('backup-age-breach'), incident('replication-lag-breach')] }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-backup-age-breached'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-replication-lag-breached');
  });

  it('fails when the restore cadence is overdue and requires incident evidence', async () => {
    const base = evidence();
    const schedule = { ...base.schedule, cadenceMs: 1_000, nextDueAtMs: RESTORED_AT + 1_000 };
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ schedule, incidents: [incident('drill-overdue')] }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-drill-overdue');
  });

  it('fails when a required incident record is missing', async () => {
    const upstream = restoreReport({ primaryAvailability: 'corrupt', backupRecovery: {} as never });
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: upstream, disasterRecoveryEvidence: evidence(), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-incident-missing: primary-unavailable');
  });

  it('fails when provider evidence claims captured-and-verified without external verification', async () => {
    const providerEvidence = { ...providerEnvelope(), evidenceLevel: 'captured-and-verified', readinessStatus: 'production-candidate' } as unknown as WorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsEvidence['providerEvidence'];
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ providerEvidence }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons.some((reason) => reason.startsWith('publisher-tax-production-exception-archive-dr-provider-evidence-'))).toBe(true);
  });

  it('fails when archive identity or retention state changes', async () => {
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ archiveContentDigest: `sha256:${'b'.repeat(64)}`, retentionPolicySnapshot: { ...RETENTION, legalHold: true } }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-archive-identity-changed'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-retention-state-changed');
  });

  it('fails when ownership is missing', async () => {
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ ownership: { recoveryOwnerId: '', onCallRoute: '', escalationTarget: '' } }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.promoteHoldThresholds.holdReasons).toContain('publisher-tax-production-exception-archive-dr-ownership-invalid');
  });

  it('fails when a non-Coordinator/CDN network attempt leaks', async () => {
    const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDisasterRecoveryOperationsGate({ restoreDrillReport: restoreReport(), disasterRecoveryEvidence: evidence({ networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: false }, { url: 'https://other.example/probe', blocked: true }] }), providerEvidenceValidationOptions: { now: NOW_MS } });
    expect(report.status).toBe('fail'); expect(report.failureReason).toContain('non-coordinator-cdn-network-attempt-not-blocked');
  });
});
