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
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_BOTTLENECK,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate,
  type ProviderPostCutoverReconciliationPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.js';

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
    scenario: { feature: kind, scenario: runId, expectedResult: 'verified provider evidence passes declared production controls' },
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
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
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
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: monitoringEndedAtMs + 1_000,
  };
}

function cutoverEvidence(payload = cutoverPayload()) {
  return captured(
    PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND,
    'production-approved',
    'production-cutover-1', payload,
    new Date(payload.capturedAtMs).toISOString(), new Date(payload.capturedAtMs + 60_000).toISOString(),
  );
}

function postCutoverPayload(): ProviderPostCutoverReconciliationPayload {
  const cutover = cutoverPayload();
  const startsAtMs = cutover.execution.completedAtMs;
  const endsAtMs = cutover.monitoring.endedAtMs + 3_600_000;
  return {
    providerName: cutover.providerName, accountId: cutover.accountId, primaryStorageId: cutover.primaryStorageId, backupStorageId: cutover.backupStorageId,
    replicaSiteId: cutover.replicaSiteId, replicaRegion: cutover.replicaRegion, archiveId: cutover.archiveId, archiveContentDigest: cutover.archiveContentDigest,
    cutoverRunId: 'production-cutover-1', cutoverId: cutover.authorization.cutoverId, productionWindowId: cutover.authorization.productionWindowId, changeTicketId: cutover.authorization.changeTicketId,
    providerOperationId: cutover.execution.providerOperationId, providerTraceId: cutover.execution.providerTraceId, restoreExecutionId: cutover.execution.restoreExecutionId,
    observationWindow: { windowId: 'post-cutover-window-1', startsAtMs, endsAtMs, minimumDurationMs: 3_600_000 },
    providerAuditStreamId: 'provider-audit-stream-1', providerAuditCursor: 'cursor-200',
    providerAuditRecords: [
      { auditRecordId: 'audit-1', providerName: cutover.providerName, accountId: cutover.accountId, primaryStorageId: cutover.primaryStorageId, backupStorageId: cutover.backupStorageId, replicaSiteId: cutover.replicaSiteId, replicaRegion: cutover.replicaRegion, archiveId: cutover.archiveId, archiveContentDigest: cutover.archiveContentDigest, cutoverRunId: 'production-cutover-1', providerOperationId: cutover.execution.providerOperationId, providerTraceId: cutover.execution.providerTraceId, restoreExecutionId: cutover.execution.restoreExecutionId, observedAtMs: cutover.monitoring.endedAtMs + 60_000, outcome: 'success' },
      { auditRecordId: 'audit-2', providerName: cutover.providerName, accountId: cutover.accountId, primaryStorageId: cutover.primaryStorageId, backupStorageId: cutover.backupStorageId, replicaSiteId: cutover.replicaSiteId, replicaRegion: cutover.replicaRegion, archiveId: cutover.archiveId, archiveContentDigest: cutover.archiveContentDigest, cutoverRunId: 'production-cutover-1', providerOperationId: cutover.execution.providerOperationId, providerTraceId: cutover.execution.providerTraceId, restoreExecutionId: cutover.execution.restoreExecutionId, observedAtMs: endsAtMs - 60_000, outcome: 'success' },
    ],
    archiveRetrievals: [
      { retrievalOperationId: 'post-primary-read', storageId: cutover.primaryStorageId, archiveId: cutover.archiveId, requestedAtMs: cutover.monitoring.endedAtMs + 120_000, completedAtMs: cutover.monitoring.endedAtMs + 121_000, observedContentDigest: DIGEST, integrityCheckId: 'post-primary-integrity', integrityStatus: 'pass' },
      { retrievalOperationId: 'post-backup-read', storageId: cutover.backupStorageId, archiveId: cutover.archiveId, requestedAtMs: cutover.monitoring.endedAtMs + 180_000, completedAtMs: cutover.monitoring.endedAtMs + 181_000, observedContentDigest: DIGEST, integrityCheckId: 'post-backup-integrity', integrityStatus: 'pass' },
    ],
    alertDispositions: [{ alertId: 'cutover-info-1', severity: 'info', status: 'resolved', dispositionId: 'disposition-cutover-info', observedAtMs: cutover.monitoring.startedAtMs, resolvedAtMs: cutover.monitoring.endedAtMs }],
    baselineIncidentIds: [], incidentReconciliations: [],
    controlState: { rollbackControlId: cutover.controls.rollbackControlId, emergencyHoldControlId: cutover.controls.emergencyHoldControlId, rollbackArmed: true, emergencyHoldArmed: true, invocations: [] },
    slo: { policyId: 'provider-production-slo', policyVersion: '1.0.0', observedFromMs: startsAtMs, observedToMs: endsAtMs, operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99, requiredProviderAvailabilityPct: 99.9, allowedFailureBudget: 2, remainingFailureBudget: 2 },
    observedCredentialSetId: cutover.observedCredentialSetId, observedSigningKeyId: cutover.observedSigningKeyId, observedEncryptionKeyId: cutover.observedEncryptionKeyId,
    recoveryOwnerId: cutover.recoveryOwnerId, onCallRoute: cutover.onCallRoute, escalationTarget: cutover.escalationTarget, retentionPolicySnapshot: RETENTION,
    reconciliationId: 'post-cutover-reconciliation-1', allowedOrigins: [...cutover.allowedOrigins], cspConnectSrc: [...cutover.cspConnectSrc], sandboxFlags: [...cutover.sandboxFlags], coop: cutover.coop, coep: cutover.coep,
    networkAttempts: [{ url: 'https://evil.example/post-cutover-exfiltrate', blocked: true }], capturedAtMs: endsAtMs + 1_000,
  };
}

function postCutoverEvidence(payload = postCutoverPayload()): EvidenceEnvelope<ProviderPostCutoverReconciliationPayload> {
  return captured(
    PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND,
    'production-approved', 'post-cutover-reconciliation-1', payload,
    new Date(payload.capturedAtMs).toISOString(), new Date(payload.capturedAtMs + 60_000).toISOString(),
  );
}

const validationOptions: EvidenceValidationOptions = {
  now: '2026-08-19T17:00:00.000Z',
  trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async () => ARTIFACT_CONTENT,
  verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

async function readinessReport() {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate({
    providerPilotReport: pilotReport(), providerPilotEvidence: pilotEvidence(),
    recurringProviderRunEvidence: [recurring('run-1', 'window-a'), recurring('run-2', 'window-a'), recurring('run-3', 'window-b', 'backup-1')],
    productionReadinessEvidence: readinessEvidence(), evidenceValidationOptions: validationOptions,
  });
}

async function cutoverReport() {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate({
    productionReadinessReport: await readinessReport(), productionReadinessEvidence: readinessEvidence(),
    productionCutoverEvidence: cutoverEvidence(), evidenceValidationOptions: validationOptions,
  });
}

async function run(
  reconciliation = postCutoverEvidence(),
  cutover = cutoverEvidence(),
  options: EvidenceValidationOptions = validationOptions,
) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate({
    productionCutoverReport: await cutoverReport(), productionCutoverEvidence: cutover,
    postCutoverReconciliationEvidence: reconciliation, evidenceValidationOptions: options,
  });
}

describe('publisher tax exception archive DR provider post-cutover reconciliation gate', () => {
  it('passes independently verified longer-window reconciliation and points to steady-state operations', async () => {
    const result = await run();
    expect(result.status).toBe('pass');
    expect(result.auditSummary).toMatchObject({ providerAuditRecordCount: 2, archiveRetrievalCount: 2 });
    expect(result.bottlenecksToIssue).toEqual([PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_BOTTLENECK]);
  });

  it('rejects self-reported reconciliation evidence', async () => {
    const p = postCutoverPayload();
    const evidence = { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', producer: { name: 'x', version: '1' }, runId: 'self-post', capturedAt: new Date(p.capturedAtMs).toISOString(), environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'server-process' }, redaction: { applied: true, policyVersion: '1' }, payload: p } as EvidenceEnvelope<ProviderPostCutoverReconciliationPayload>;
    expect((await run(evidence)).promoteHoldThresholds.holdReasons).toContain('requires-production-approved-reconciliation-evidence');
  });

  it('does not trust captured literals without loader and independent verification', async () => {
    const result = await run(postCutoverEvidence(), cutoverEvidence(), { now: '2026-08-19T17:00:00.000Z', trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }] });
    expect(result.status).toBe('fail');
    expect(result.reconciliationEvidenceSummary.validationStatus).toBe('not-evaluated');
  });

  it('rejects same-run-ID cutover payload substitution', async () => {
    const p = cutoverPayload();
    const substituted = cutoverEvidence({ ...p, reconciliationId: 'substituted-but-valid' });
    expect((await run(postCutoverEvidence(), substituted)).promoteHoldThresholds.holdReasons).toContain('cutover-input-mismatch');
  });

  it('requires an observation window beginning after completion and extending past immediate monitoring', async () => {
    const p = postCutoverPayload();
    const bad = { ...p, observationWindow: { ...p.observationWindow, startsAtMs: cutoverPayload().execution.completedAtMs - 1 } };
    expect((await run(postCutoverEvidence(bad))).promoteHoldThresholds.holdReasons).toContain('post-cutover-observation-window-invalid');
  });

  it('requires provider audit evidence to extend beyond immediate monitoring', async () => {
    const p = postCutoverPayload();
    const t = cutoverPayload().monitoring.endedAtMs;
    const records = p.providerAuditRecords.map((record, index) => ({ ...record, observedAtMs: t - 2_000 + index }));
    const result = await run(postCutoverEvidence({ ...p, providerAuditRecords: records }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('provider-audit-does-not-extend-beyond-immediate-monitoring');
  });

  it('rejects provider audit identity drift', async () => {
    const p = postCutoverPayload();
    const records = [{ ...p.providerAuditRecords[0], accountId: 'other-account' }, p.providerAuditRecords[1]];
    expect((await run(postCutoverEvidence({ ...p, providerAuditRecords: records }))).promoteHoldThresholds.holdReasons.some((x) => x.startsWith('provider-audit-record-invalid'))).toBe(true);
  });

  it('requires archive re-retrieval from both primary and backup', async () => {
    const p = postCutoverPayload();
    const onlyPrimary = [p.archiveRetrievals[0], { ...p.archiveRetrievals[1], storageId: p.primaryStorageId }];
    expect((await run(postCutoverEvidence({ ...p, archiveRetrievals: onlyPrimary }))).promoteHoldThresholds.holdReasons).toContain('archive-reretrieval-must-cover-primary-and-backup');
  });

  it('holds archive digest or integrity failure', async () => {
    const p = postCutoverPayload();
    const retrievals = [p.archiveRetrievals[0], { ...p.archiveRetrievals[1], observedContentDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', integrityStatus: 'fail' as const }];
    expect((await run(postCutoverEvidence({ ...p, archiveRetrievals: retrievals }))).promoteHoldThresholds.holdReasons.some((x) => x.startsWith('archive-reretrieval-invalid'))).toBe(true);
  });

  it('holds an unresolved critical alert', async () => {
    const p = postCutoverPayload();
    const alertDispositions = [...p.alertDispositions, { alertId: 'critical-1', severity: 'critical' as const, status: 'open' as const, dispositionId: 'critical-disposition', observedAtMs: p.observationWindow.startsAtMs + 1_000 }];
    expect((await run(postCutoverEvidence({ ...p, alertDispositions }))).promoteHoldThresholds.holdReasons).toContain('unresolved-critical-alert:critical-1');
  });

  it('requires audit warnings to map to a reconciled alert', async () => {
    const p = postCutoverPayload();
    const records = [{ ...p.providerAuditRecords[0], outcome: 'warning' as const, alertId: 'missing-alert' }, p.providerAuditRecords[1]];
    expect((await run(postCutoverEvidence({ ...p, providerAuditRecords: records }))).promoteHoldThresholds.holdReasons.some((x) => x.startsWith('provider-audit-record-invalid'))).toBe(true);
  });

  it('holds an active rollback or emergency-hold invocation', async () => {
    const p = postCutoverPayload();
    const controlState = { ...p.controlState, invocations: [{ invocationId: 'hold-invoke-1', controlId: p.controlState.emergencyHoldControlId, invokedAtMs: p.observationWindow.startsAtMs + 1_000, status: 'active' as const, reconciliationId: 'hold-recon-1' }] };
    expect((await run(postCutoverEvidence({ ...p, controlState }))).promoteHoldThresholds.holdReasons).toContain('active-control-invocation:hold-invoke-1');
  });

  it('holds exhausted error budget or SLO breach', async () => {
    const p = postCutoverPayload();
    const slo = { ...p.slo, failureCount: 2, allowedFailureBudget: 2, remainingFailureBudget: 0, rtoBreachCount: 1 };
    expect((await run(postCutoverEvidence({ ...p, slo }))).promoteHoldThresholds.holdReasons).toContain('post-cutover-slo-error-budget-invalid');
  });

  it('holds when the observation window crosses the approved key-rotation deadline', async () => {
    const p = postCutoverPayload();
    const deadline = readinessPayload().credentialRotation.nextRotationDueAtMs;
    const endsAtMs = deadline + 1_000;
    const observationWindow = { ...p.observationWindow, endsAtMs, minimumDurationMs: 1 };
    const slo = { ...p.slo, observedToMs: endsAtMs };
    const records = p.providerAuditRecords.map((record, index) => ({ ...record, observedAtMs: p.observationWindow.startsAtMs + 10_000 + index }));
    const archiveRetrievals = p.archiveRetrievals.map((item, index) => ({ ...item, requestedAtMs: p.observationWindow.startsAtMs + 20_000 + index * 10_000, completedAtMs: p.observationWindow.startsAtMs + 20_500 + index * 10_000 }));
    const changed = { ...p, observationWindow, slo, providerAuditRecords: records, archiveRetrievals, capturedAtMs: endsAtMs + 1_000 };
    const evidence = postCutoverEvidence(changed);
    const laterOptions = { ...validationOptions, now: new Date(endsAtMs + 120_000).toISOString() };
    expect((await run(evidence, cutoverEvidence(), laterOptions)).promoteHoldThresholds.holdReasons).toContain('credential-key-posture-invalid');
  });

  it('preserves retention state', async () => {
    const p = postCutoverPayload();
    expect((await run(postCutoverEvidence({ ...p, retentionPolicySnapshot: { policyId: 'changed' } as never }))).promoteHoldThresholds.holdReasons).toContain('retention-state-drift');
  });

  it('rejects an unblocked non-Coordinator/CDN network attempt', async () => {
    const p = postCutoverPayload();
    const networkAttempts = [...p.networkAttempts, { url: 'https://evil.example/leak', blocked: false }];
    expect((await run(postCutoverEvidence({ ...p, networkAttempts }))).promoteHoldThresholds.holdReasons).toContain('network-leak:https://evil.example');
  });
});
