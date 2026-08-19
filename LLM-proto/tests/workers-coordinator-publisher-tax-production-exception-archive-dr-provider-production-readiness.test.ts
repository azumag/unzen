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

const ARTIFACT_CONTENT = 'verified DR provider pilot artifact';
const ARTIFACT_SHA256 = '8b3fbcc32808fb472a9d138f86e3a160899c168558be039fc0ba3441fa0820fa';
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const START = Date.parse('2026-08-19T12:00:00.000Z');
const RETENTION = { policyId: 'retention-v1', legalHold: false, operationalHold: false } as never;

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

function captured<T>(kind: string, readinessStatus: 'verified-pilot' | 'production-candidate', runId: string, payload: T): EvidenceEnvelope<T> {
  return {
    schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'captured-and-verified', readinessStatus,
    producer: { name: 'archive-provider-harness', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
    runId, capturedAt: '2026-08-19T13:00:00.000Z',
    environment: { runtime: 'node', runtimeVersion: '22.0.0', executionSurface: 'server-process', os: { name: 'linux', version: '24.04' } },
    scenario: { feature: kind, scenario: runId, expectedResult: 'verified provider evidence passes declared recovery objectives' },
    artifact: { locator: `artifact://${runId}/report.json`, sha256: ARTIFACT_SHA256, expiresAt: '2026-08-21T13:00:00.000Z' },
    verification: { verifier: 'unzen-ci-evidence-verifier', version: '1.0.0', verifiedAt: '2026-08-19T13:05:00.000Z', result: 'pass' },
    redaction: { applied: true, policyVersion: 'provider-production-v1' }, payload,
  };
}

function pilotEvidence() { return captured('publisher-tax-filing-production-exception-archive-dr-provider-pilot', 'verified-pilot', 'provider-pilot-1', pilotPayload()); }

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

function readinessEvidence(payload = readinessPayload()): EvidenceEnvelope<ProviderProductionReadinessPayload> {
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND, 'production-candidate', 'production-readiness-1', payload);
}

const validationOptions: EvidenceValidationOptions = {
  now: '2026-08-19T13:30:00.000Z',
  trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async () => ARTIFACT_CONTENT,
  verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

async function run(readiness = readinessEvidence(), runs = [recurring('run-1', 'window-a'), recurring('run-2', 'window-a'), recurring('run-3', 'window-b', 'backup-1')], options: EvidenceValidationOptions = validationOptions) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionReadinessGate({ providerPilotReport: pilotReport(), providerPilotEvidence: pilotEvidence(), recurringProviderRunEvidence: runs, productionReadinessEvidence: readiness, evidenceValidationOptions: options });
}

describe('publisher tax exception archive DR provider production readiness gate', () => {
  it('passes recurring verified runs with production controls', async () => { const r = await run(); expect(r.status).toBe('pass'); expect(r.recurringRunSummary).toMatchObject({ distinctRunIds: 3, distinctRestoreWindows: 2, validatedRuns: 3 }); expect(r.bottlenecksToIssue).toEqual(['publisher-tax-filing-production-exception-archive-dr-provider-production-cutover']); });
  it('rejects self-reported readiness evidence', async () => { const p = readinessPayload(); const e = { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_READINESS_EVIDENCE_KIND, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', producer: { name: 'x', version: '1' }, runId: 'self', capturedAt: '2026-08-19T13:00:00.000Z', environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'server-process' }, redaction: { applied: true, policyVersion: '1' }, payload: p } as EvidenceEnvelope<ProviderProductionReadinessPayload>; expect((await run(e)).promoteHoldThresholds.holdReasons).toContain('requires-production-candidate-evidence'); });
  it('does not trust a captured literal without loader/verifier', async () => { const r = await run(readinessEvidence(), undefined, { now: '2026-08-19T13:30:00.000Z', trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }] }); expect(r.status).toBe('fail'); expect(r.readinessEvidenceSummary.validationStatus).toBe('not-evaluated'); });
  it('requires three distinct verified runs', async () => { const r = await run(readinessEvidence({ ...readinessPayload(), recurringRunIds: ['run-1', 'run-2'], restoreWindowIds: ['window-a', 'window-b'], monitoring: { ...readinessPayload().monitoring, verifiedRunCount: 2 } }), [recurring('run-1', 'window-a'), recurring('run-2', 'window-b')]); expect(r.promoteHoldThresholds.holdReasons).toContain('requires-three-distinct-verified-runs'); });
  it('requires at least two restore windows', async () => { const runs = [recurring('run-1', 'window-a'), recurring('run-2', 'window-a'), recurring('run-3', 'window-a', 'backup-1')]; const r = await run(readinessEvidence({ ...readinessPayload(), restoreWindowIds: ['window-a'] }), runs); expect(r.promoteHoldThresholds.holdReasons).toContain('requires-two-restore-windows'); });
  it('rejects provider identity drift', async () => { const r = await run(readinessEvidence({ ...readinessPayload(), accountId: 'other-account' })); expect(r.promoteHoldThresholds.holdReasons).toContain('provider-identity-mismatch'); });
  it('holds on recurring integrity failure', async () => { const bad = recurring('run-2', 'window-a'); (bad.payload as ProviderRecurringRunPayload).integrityStatus = 'fail'; const r = await run(readinessEvidence(), [recurring('run-1', 'window-a'), bad, recurring('run-3', 'window-b', 'backup-1')]); expect(r.status).toBe('fail'); expect(r.promoteHoldThresholds.holdReasons.some((x) => x.startsWith('recurring-run-integrity-invalid'))).toBe(true); });
  it('requires two distinct operator approvals', async () => { const p = readinessPayload(); const r = await run(readinessEvidence({ ...p, operatorApprovals: [p.operatorApprovals[0]] })); expect(r.promoteHoldThresholds.holdReasons).toContain('two-person-approval-invalid'); });
  it('holds when monitoring error budget is exhausted or integrity failed', async () => { const p = readinessPayload(); const r = await run(readinessEvidence({ ...p, monitoring: { ...p.monitoring, integrityFailureCount: 1, remainingFailureBudget: 0 } })); expect(r.promoteHoldThresholds.holdReasons).toContain('monitoring-error-budget-invalid'); });
  it('holds when credential/key rotation is overdue', async () => { const p = readinessPayload(); const r = await run(readinessEvidence({ ...p, credentialRotation: { ...p.credentialRotation, nextRotationDueAtMs: p.capturedAtMs - 1 } })); expect(r.promoteHoldThresholds.holdReasons).toContain('credential-key-rotation-invalid'); });
  it('requires failover policy to reference an exercised verified run', async () => { const p = readinessPayload(); const r = await run(readinessEvidence({ ...p, failoverPolicy: { ...p.failoverPolicy, lastExercisedRunId: 'missing-run' } })); expect(r.promoteHoldThresholds.holdReasons).toContain('failover-policy-invalid'); });
  it('rejects an unblocked non-Coordinator/CDN attempt', async () => { const p = readinessPayload(); const r = await run(readinessEvidence({ ...p, networkAttempts: [...p.networkAttempts, { url: 'https://evil.example/leak', blocked: false }] })); expect(r.promoteHoldThresholds.holdReasons).toContain('network-leak:https://evil.example'); });
});
