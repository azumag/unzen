import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import type { ProviderProductionReadinessPayload } from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-readiness.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate,
  type ProviderProductionCutoverOptions,
  type ProviderProductionCutoverPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-production-cutover.js';

const CONTENT = 'verified DR provider pilot artifact';
const SHA = '8b3fbcc32808fb472a9d138f86e3a160899c168558be039fc0ba3441fa0820fa';
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const START = Date.parse('2026-08-19T12:00:00.000Z');
const WINDOW_START = START + 10_000_000;
const WINDOW_END = START + 11_000_000;
const EXECUTION_START = START + 10_100_000;
const RETENTION = { policyId: 'retention-v1', legalHold: false, operationalHold: false } as never;

function envelope<T>(kind: string, readinessStatus: 'production-candidate' | 'production-approved', runId: string, payload: T, capturedAtMs: number): EvidenceEnvelope<T> {
  return {
    schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'captured-and-verified', readinessStatus,
    producer: { name: 'archive-provider-harness', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
    runId, capturedAt: new Date(capturedAtMs).toISOString(),
    environment: { runtime: 'node', runtimeVersion: '22.0.0', executionSurface: 'server-process', os: { name: 'linux', version: '24.04' } },
    scenario: { feature: kind, scenario: runId, expectedResult: 'verified provider production evidence' },
    artifact: { locator: `artifact://${runId}/report.json`, sha256: SHA, expiresAt: '2026-08-21T13:00:00.000Z' },
    verification: { verifier: 'unzen-ci-evidence-verifier', version: '1.0.0', verifiedAt: new Date(capturedAtMs + 60_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'provider-production-v1' }, payload,
  };
}

function readinessPayload(): ProviderProductionReadinessPayload {
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
    replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    recurringRunIds: ['run-1', 'run-2', 'run-3'], restoreWindowIds: ['window-a', 'window-b'],
    productionRestoreWindow: { windowId: 'prod-window-1', startsAtMs: WINDOW_START, endsAtMs: WINDOW_END, changeTicketId: 'CHG-123', scope: 'archive DR production cutover', approverIds: ['approver-a', 'approver-b'] },
    operatorApprovals: [
      { approvalId: 'approval-a', approverId: 'approver-a', role: 'operations', approvedAtMs: START + 1_000_000 },
      { approvalId: 'approval-b', approverId: 'approver-b', role: 'security', approvedAtMs: START + 1_100_000 },
    ],
    monitoring: { evaluatedFromMs: START, evaluatedToMs: START + 1_000_000, verifiedRunCount: 3, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, allowedFailureBudget: 1, remainingFailureBudget: 1 },
    credentialRotation: { credentialSetId: 'cred-set-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1', secretStoreBoundary: 'managed://secrets/archive-provider', managedSecretStore: true, lastRotatedAtMs: START - 1_000_000, nextRotationDueAtMs: START + 20_000_000, rotationEvidenceId: 'rotation-1' },
    failoverPolicy: { policyId: 'failover-v1', version: '1.0.0', failoverTrigger: 'primary unavailable', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', lastExercisedRunId: 'run-3', recoveryObjective: 'restore from backup' },
    controls: { rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', holdCriteria: ['integrity failure'] },
    recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', incidentIds: [], retentionPolicySnapshot: RETENTION,
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: START + 2_000_000,
  };
}

function readinessEvidence(payload = readinessPayload()) {
  return envelope('publisher-tax-filing-production-exception-archive-dr-provider-production-readiness', 'production-candidate', 'production-readiness-1', payload, START + 2_000_000);
}

function cutoverPayload(): ProviderProductionCutoverPayload {
  const completedAtMs = EXECUTION_START + 30_000;
  const monitoringEndedAtMs = completedAtMs + 10_000;
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    authorization: { cutoverId: 'cutover-1', authorizationId: 'auth-1', readinessRunId: 'production-readiness-1', productionWindowId: 'prod-window-1', changeTicketId: 'CHG-123', approverIds: ['approver-a', 'approver-b'], credentialSetId: 'cred-set-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1', authorizedAtMs: EXECUTION_START - 20_000, expiresAtMs: EXECUTION_START + 300_000 },
    execution: { providerOperationId: 'op-1', providerTraceId: 'trace-1', restoreExecutionId: 'restore-1', sourceStorageId: 'primary-1', startedAtMs: EXECUTION_START, completedAtMs, recoveryPointAtMs: EXECUTION_START - 60_000, primarySnapshotAtMs: EXECUTION_START - 10_000, backupSnapshotAtMs: EXECUTION_START - 40_000, replicationLagMs: 30_000, archiveId: 'archive-1', observedContentDigest: DIGEST, postCutoverIntegrityCheckId: 'integrity-1', integrityStatus: 'pass' },
    monitoring: { startedAtMs: EXECUTION_START - 1_000, endedAtMs: monitoringEndedAtMs, providerHealth: 'healthy', integrityStatus: 'pass', rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, alertIds: [], unresolvedCriticalAlertIds: [] },
    controls: { rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmedBeforeExecution: true, emergencyHoldArmedBeforeExecution: true, rollbackArmedAfterExecution: true, emergencyHoldArmedAfterExecution: true, rollbackInvoked: false, emergencyHoldInvoked: false },
    recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', incidentIds: [], retentionPolicySnapshot: RETENTION,
    observedCredentialSetId: 'cred-set-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1', reconciliationId: 'reconciliation-1',
    allowedOrigins: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], cspConnectSrc: ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'], sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: monitoringEndedAtMs + 1_000,
  };
}

function cutoverEvidence(payload = cutoverPayload()) {
  return envelope(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_PRODUCTION_CUTOVER_EVIDENCE_KIND, 'production-approved', 'production-cutover-1', payload, payload.capturedAtMs);
}

const validation: EvidenceValidationOptions = {
  now: '2026-08-19T15:30:00.000Z', trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async () => CONTENT, verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

function upstream(readiness: EvidenceEnvelope<ProviderProductionReadinessPayload>): ProviderProductionCutoverOptions['productionReadinessReport'] {
  const p = readiness.payload;
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-production-readiness-gate', status: 'pass', previewRunnerUrl: 'https://worker.unzen.dev/runner',
    providerPilotEvidence: { disasterRecoveryEvidence: { objectives: { rtoMs: 60_000, rpoMs: 300_000, maxBackupAgeMs: 600_000, maxReplicationLagMs: 120_000 }, ownership: { recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead' }, incidents: [] } } as never,
    readinessInputEvidence: readiness,
    readinessEvidenceSummary: { validationStatus: 'valid', effectiveEvidenceLevel: 'captured-and-verified', effectiveReadinessStatus: 'production-candidate', evidenceKind: readiness.evidenceKind, runId: readiness.runId },
    recurringRunSummary: { totalRuns: 3, distinctRunIds: 3, distinctRestoreWindows: 2, validatedRuns: 3 },
    productionRestoreWindow: p.productionRestoreWindow, operatorApprovals: p.operatorApprovals, monitoring: p.monitoring, credentialRotation: p.credentialRotation, failoverPolicy: p.failoverPolicy, controls: p.controls,
    retentionPolicySnapshot: RETENTION, securityBoundaryDuringProductionReadiness: { allowedOrigins: p.allowedOrigins, cspConnectSrc: p.cspConnectSrc, sandboxFlags: p.sandboxFlags, coop: p.coop, coep: p.coep, blockedNonCoordinatorCdnNetworkAttempt: p.networkAttempts[0] },
    promoteHoldThresholds: { decision: 'promote', holdReasons: [] }, failureReason: undefined, bottlenecksToIssue: ['publisher-tax-filing-production-exception-archive-dr-provider-production-cutover'],
  } as ProviderProductionCutoverOptions['productionReadinessReport'];
}

async function run(readiness = readinessEvidence(), cutover = cutoverEvidence(), report = upstream(readiness)) {
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderProductionCutoverGate({ productionReadinessReport: report, productionReadinessEvidence: readiness, productionCutoverEvidence: cutover, evidenceValidationOptions: validation });
}

describe('provider production cutover exact binding and timeline', () => {
  it('rejects a same-run-id readiness payload swap', async () => {
    const original = readinessEvidence();
    const swapped = readinessEvidence({ ...readinessPayload(), controls: { rollbackControlId: 'rollback-swapped', emergencyHoldControlId: 'hold-1', holdCriteria: ['integrity failure'] } });
    expect((await run(swapped, cutoverEvidence(), upstream(original))).promoteHoldThresholds.holdReasons).toContain('readiness-input-mismatch');
  });

  it('requires authorization to remain valid through cutover completion', async () => {
    const p = cutoverPayload();
    const result = await run(readinessEvidence(), cutoverEvidence({ ...p, authorization: { ...p.authorization, expiresAtMs: p.execution.startedAtMs + 5_000 } }));
    expect(result.promoteHoldThresholds.holdReasons).toContain('cutover-authorization-invalid');
  });

  it('requires readiness key rotation to remain current through completion', async () => {
    const r = readinessPayload();
    const readiness = readinessEvidence({ ...r, credentialRotation: { ...r.credentialRotation, nextRotationDueAtMs: EXECUTION_START + 5_000 } });
    const p = cutoverPayload();
    const cutover = cutoverEvidence({ ...p, authorization: { ...p.authorization, credentialSetId: r.credentialRotation.credentialSetId, signingKeyId: r.credentialRotation.signingKeyId, encryptionKeyId: r.credentialRotation.encryptionKeyId } });
    expect((await run(readiness, cutover)).promoteHoldThresholds.holdReasons).toContain('cutover-authorization-invalid');
  });

  it('requires evidence capture after monitoring finishes', async () => {
    const p = cutoverPayload();
    const bad = { ...p, capturedAtMs: p.monitoring.endedAtMs - 1 };
    expect((await run(readinessEvidence(), cutoverEvidence(bad))).promoteHoldThresholds.holdReasons).toContain('cutover-capture-timeline-invalid');
  });
});
