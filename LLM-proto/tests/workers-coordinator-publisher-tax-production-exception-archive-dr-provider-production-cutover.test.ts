import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import type {
  WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport,
  WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-pilot.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_RECURRING_RUN_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate,
  type ProviderProductionReadinessPayload,
  type ProviderRecurringRunPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate,
  type ProviderProductionCutoverPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.js';

const ARTIFACT_CONTENT = 'verified DR provider pilot artifact';
const ARTIFACT_SHA256 = '8b3fbcc32808fb472a9d138f86e3a160899c168558be039fc0ba3441fa0820fa';
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const START = Date.parse('2026-08-19T12:00:00.000Z');
const CUTOVER_START = START + 10_100_000;
const RETENTION = { policyId: 'retention-v1', legalHold: false, operationalHold: false } as never;

function captured<T>(
  kind: string,
  readinessStatus: 'verified-pilot' | 'production-candidate' | 'production-approved',
  runId: string,
  payload: T,
  capturedAt = '2026-08-19T13:00:00.000Z',
  verifiedAt = '2026-08-19T13:05:00.000Z',
): EvidenceEnvelope<T> {
  return {
    schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'captured-and-verified', readinessStatus,
    producer: { name: 'archive-provider-harness', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
    runId, capturedAt,
    environment: { runtime: 'node', runtimeVersion: '22.0.0', executionSurface: 'server-process', os: { name: 'linux', version: '24.04' } },
    scenario: { feature: kind, scenario: runId, expectedResult: 'verified provider evidence passes declared recovery objectives' },
    artifact: { locator: `artifact://${runId}/report.json`, sha256: ARTIFACT_SHA256, expiresAt: '2026-08-21T13:00:00.000Z' },
    verification: { verifier: 'unzen-ci-evidence-verifier', version: '1.0.0', verifiedAt, result: 'pass' },
    redaction: { applied: true, policyVersion: 'provider-production-v1' }, payload,
  };
}

function pilotPayload(): WorkersCoordinatorPublisherTaxProductionArchiveProviderPilotPayload {
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
    replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    primaryRetrieval: { operationId: 'primary-read', storageId: 'primary-1', locator: 'provider://primary/archive-1', archiveId: 'archive-1', observedContentDigest: DIGEST, requestedAtMs: START, completedAtMs: START + 1_000 },
    backupRetrieval: { operationId: 'backup-read', storageId: 'backup-1', locator: 'provider://backup/archive-1', archiveId: 'archive-1', observedContentDigest: DIGEST, requestedAtMs: START, completedAtMs: START + 1_500 },
    restoreExecution: { executionId: 'pilot-restore', scheduleId: 'dr-schedule', sourceStorageId: 'primary-1', startedAtMs: START + 2_000, completedAtMs: START + 32_000, recoveryPointAtMs: START - 30_000, postRestoreIntegrityCheckId: 'pilot-integrity', observedContentDigest: DIGEST },
    primarySnapshotAtMs: START - 5_000, backupSnapshotAtMs: START - 20_000, replicationLagMs: 15_000,
    recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', incidentIds: [], retentionPolicySnapshot: RETENTION,
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp',
    networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
  };
}

function pilotEvidence() {
  return captured('publisher-tax-filing-production-exception-archive-dr-provider-pilot', 'verified-pilot', 'provider-pilot-1', pilotPayload());
}

function pilotReport(): WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport {
  return {
    status: 'pass', previewRunnerUrl: 'https://worker.unzen.dev/runner',
    providerEvidenceSummary: { runId: 'provider-pilot-1', validationStatus: 'valid', effectiveEvidenceLevel: 'captured-and-verified', effectiveReadinessStatus: 'verified-pilot', evidenceKind: 'publisher-tax-filing-production-exception-archive-dr-provider-pilot' },
    disasterRecoveryEvidence: { objectives: { rtoMs: 60_000, rpoMs: 300_000, maxBackupAgeMs: 600_000, maxReplicationLagMs: 120_000 }, ownership: { recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead' }, incidents: [] },
    retentionPolicySnapshot: RETENTION,
  } as unknown as WorkersCoordinatorPublisherTaxProductionArchiveDrProviderPilotReport;
}

function recurring(runId: string, restoreWindowId: string, source = 'primary-1'): EvidenceEnvelope<ProviderRecurringRunPayload> {
  const offset = runId === 'run-1' ? 0 : runId === 'run-2' ? 300_000 : 600_000;
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_RECURRING_RUN_EVIDENCE_KIND, 'verified-pilot', runId, {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    restoreWindowId, primaryRetrievalOperationId: `${runId}-primary`, backupRetrievalOperationId: `${runId}-backup`, restoreExecutionId: `${runId}-restore`, restoreSourceStorageId: source,
    recoveryStartedAtMs: START + offset, recoveryCompletedAtMs: START + offset + 30_000, recoveryPointAtMs: START + offset - 60_000,
    primarySnapshotAtMs: START + offset - 10_000, backupSnapshotAtMs: START + offset - 40_000, replicationLagMs: 30_000,
    postRestoreIntegrityCheckId: `${runId}-integrity`, observedContentDigest: DIGEST, integrityStatus: 'pass',
  });
}

function readinessPayload(): ProviderProductionReadinessPayload {
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    recurringRunIds: ['run-1', 'run-2', 'run-3'], restoreWindowIds: ['window-a', 'window-b'],
    productionRestoreWindow: { windowId: 'prod-window-1', startsAtMs: START + 10_000_000, endsAtMs: START + 11_000_000, changeTicketId: 'CHG-123', scope: 'archive DR production cutover', approverIds: ['approver-a', 'approver-b'] },
    operatorApprovals: [{ approvalId: 'approval-a', approverId: 'approver-a', role: 'operations', approvedAtMs: START + 1_000_000 }, { approvalId: 'approval-b', approverId: 'approver-b', role: 'security', approvedAtMs: START + 1_100_000 }],
    monitoring: { evaluatedFromMs: START, evaluatedToMs: START + 1_000_000, verifiedRunCount: 3, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, allowedFailureBudget: 1, remainingFailureBudget: 1 },
    credentialRotation: { credentialSetId: 'cred-set-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1', secretStoreBoundary: 'managed://secrets/archive-provider', managedSecretStore: true, lastRotatedAtMs: START - 1_000_000, nextRotationDueAtMs: START + 20_000_000, rotationEvidenceId: 'rotation-1' },
    failoverPolicy: { policyId: 'failover-v1', version: '1.0.0', failoverTrigger: 'primary unavailable or integrity failure', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', lastExercisedRunId: 'run-3', recoveryObjective: 'restore from verified backup within RTO/RPO' },
    controls: { rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', holdCriteria: ['integrity failure', 'error budget exhausted'] },
    recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', incidentIds: [], retentionPolicySnapshot: RETENTION,
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: START + 2_000_000,
  };
}

function readinessEvidence(payload = readinessPayload()) {
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND, 'production-candidate', 'production-readiness-1', payload);
}

function cutoverPayload(): ProviderProductionCutoverPayload {
  const readiness = readinessPayload();
  const completedAtMs = CUTOVER_START + 30_000;
  const monitoringEndedAtMs = completedAtMs + 10_000;
  return {
    providerName: readiness.providerName, accountId: readiness.accountId, primaryStorageId: readiness.primaryStorageId, backupStorageId: readiness.backupStorageId,
    replicaSiteId: readiness.replicaSiteId, replicaRegion: readiness.replicaRegion, archiveId: readiness.archiveId, archiveContentDigest: readiness.archiveContentDigest,
    authorization: { cutoverId: 'cutover-1', authorizationId: 'cutover-auth-1', readinessRunId: 'production-readiness-1', productionWindowId: readiness.productionRestoreWindow.windowId, changeTicketId: readiness.productionRestoreWindow.changeTicketId, approverIds: ['approver-a', 'approver-b'], credentialSetId: 'cred-set-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1', authorizedAtMs: CUTOVER_START - 20_000, expiresAtMs: CUTOVER_START + 300_000 },
    execution: { providerOperationId: 'provider-cutover-op-1', providerTraceId: 'provider-trace-1', restoreExecutionId: 'production-restore-1', sourceStorageId: 'primary-1', startedAtMs: CUTOVER_START, completedAtMs, recoveryPointAtMs: CUTOVER_START - 60_000, primarySnapshotAtMs: CUTOVER_START - 10_000, backupSnapshotAtMs: CUTOVER_START - 40_000, replicationLagMs: 30_000, archiveId: 'archive-1', observedContentDigest: DIGEST, postCutoverIntegrityCheckId: 'cutover-integrity-1', integrityStatus: 'pass' },
    monitoring: { startedAtMs: CUTOVER_START - 1_000, endedAtMs: monitoringEndedAtMs, providerHealth: 'healthy', integrityStatus: 'pass', rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, alertIds: ['cutover-info-1'], unresolvedCriticalAlertIds: [] },
    controls: { rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmedBeforeExecution: true, emergencyHoldArmedBeforeExecution: true, rollbackArmedAfterExecution: true, emergencyHoldArmedAfterExecution: true, rollbackInvoked: false, emergencyHoldInvoked: false },
    recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', incidentIds: [], retentionPolicySnapshot: RETENTION,
    observedCredentialSetId: 'cred-set-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1', reconciliationId: 'cutover-reconciliation-1',
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
    capturedAtMs: monitoringEndedAtMs + 1_000,
  };
}

function cutoverEvidence(payload = cutoverPayload()): EvidenceEnvelope<ProviderProductionCutoverPayload> {
  return captured(
    PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND,
    'production-approved',
    'production-cutover-1',
    payload,
    new Date(payload.capturedAtMs).toISOString(),
    new Date(payload.capturedAtMs + 60_000).toISOString(),
  );
}

const validationOptions: EvidenceValidationOptions = {
  now: '2026-08-19T15:30:00.000Z',
  trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async () => ARTIFACT_CONTENT,
  verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

async function readinessReport() {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate({
    providerPilotReport: pilotReport(),
    providerPilotEvidence: pilotEvidence(),
    recurringProviderRunEvidence: [recurring('run-1', 'window-a'), recurring('run-2', 'window-a'), recurring('run-3', 'window-b', 'backup-1')],
    productionReadinessEvidence: readinessEvidence(),
    evidenceValidationOptions: validationOptions,
  });
}

async function run(
  cutover = cutoverEvidence(),
  readiness = readinessEvidence(),
  options: EvidenceValidationOptions = validationOptions,
) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate({
    productionReadinessReport: await readinessReport(),
    productionReadinessEvidence: readiness,
    productionCutoverEvidence: cutover,
    evidenceValidationOptions: options,
  });
}

describe('publisher tax exception archive DR provider production cutover gate', () => {
  it('passes a bounded independently verified production cutover', async () => {
    const result = await run();
    expect(result.status).toBe('pass');
    expect(result.cutoverEvidenceSummary.effectiveReadinessStatus).toBe('production-approved');
    expect(result.execution?.providerOperationId).toBe('provider-cutover-op-1');
    expect(result.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-exception-archive-dr-provider-post-cutover-reconciliation']);
  });

  it('rejects self-reported cutover evidence', async () => {
    const p = cutoverPayload();
    const e = { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', producer: { name: 'x', version: '1' }, runId: 'self-cutover', capturedAt: new Date(p.capturedAtMs).toISOString(), environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'server-process' }, redaction: { applied: true, policyVersion: '1' }, payload: p } as EvidenceEnvelope<ProviderProductionCutoverPayload>;
    expect((await run(e)).promoteHoldThresholds.holdReasons).toContain('requires-production-approved-cutover-evidence');
  });

  it('does not trust captured literals without artifact loading and verification', async () => {
    const result = await run(cutoverEvidence(), readinessEvidence(), { now: '2026-08-19T15:30:00.000Z', trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }] });
    expect(result.status).toBe('fail');
    expect(result.cutoverEvidenceSummary.validationStatus).toBe('not-evaluated');
  });

  it('requires authorization to match the readiness run, window, ticket and approvers', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, authorization: { ...p.authorization, changeTicketId: 'CHG-WRONG' } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-authorization-invalid');
  });

  it('holds an out-of-window execution', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, execution: { ...p.execution, startedAtMs: START + 9_000_000 } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-execution-invalid');
  });

  it('holds archive digest or integrity drift', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, execution: { ...p.execution, observedContentDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', integrityStatus: 'fail' } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-execution-invalid');
  });

  it('holds an RTO breach during cutover', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, execution: { ...p.execution, completedAtMs: p.execution.startedAtMs + 70_000 } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-execution-invalid');
  });

  it('holds credential/key drift', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, observedSigningKeyId: 'sign-other' }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('credential-key-identity-drift');
  });

  it('requires rollback and emergency hold controls to remain armed', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, controls: { ...p.controls, rollbackArmedAfterExecution: false } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-controls-not-armed');
  });

  it('holds an invoked rollback or emergency hold even when reconciled', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, controls: { ...p.controls, rollbackInvoked: true, invocationReconciliationId: 'rollback-reconciliation-1' } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-control-invoked');
  });

  it('holds unresolved critical post-cutover alerts', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, monitoring: { ...p.monitoring, unresolvedCriticalAlertIds: ['alert-critical-1'] } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('post-cutover-monitoring-invalid');
  });

  it('preserves retention state', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, retentionPolicySnapshot: { policyId: 'changed' } as never }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('retention-state-drift');
  });

  it('rejects an unblocked non-Coordinator/CDN network attempt', async () => {
    const p = cutoverPayload();
    const result = await run(cutoverEvidence({ ...p, networkAttempts: [...p.networkAttempts, { url: 'https://evil.example/leak', blocked: false }] }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('network-leak:https://evil.example');
  });
});
