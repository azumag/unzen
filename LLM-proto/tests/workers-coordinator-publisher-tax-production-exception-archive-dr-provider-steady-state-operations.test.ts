import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_AUTOMATION_BOTTLENECK,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate,
  type ProviderSteadyStateCyclePayload,
  type ProviderSteadyStateOperationsPayload,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND,
  type ProviderPostCutoverReconciliationPayload,
  type runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-post-cutover-reconciliation.js';

const ARTIFACT_CONTENT = 'verified DR provider pilot artifact';
const ARTIFACT_SHA256 = '8b3fbcc32808fb472a9d138f86e3a160899c168558be039fc0ba3441fa0820fa';
const DIGEST = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = Date.parse('2026-08-19T12:00:00.000Z');
const BASELINE_END = BASE + 600_000;
const CADENCE = 300_000;
const GRACE = 30_000;
const CYCLE1 = BASE + 900_000;
const CYCLE2 = CYCLE1 + CADENCE;
const CYCLE3 = CYCLE2 + CADENCE;
const RETENTION = { policyId: 'retention-v1', legalHold: false, operationalHold: false } as never;
const ALLOWED = ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'];

function captured<T>(kind: string, runId: string, payload: T, capturedAtMs: number): EvidenceEnvelope<T> {
  return {
    schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'captured-and-verified', readinessStatus: 'production-approved',
    producer: { name: 'archive-provider-harness', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
    runId, capturedAt: new Date(capturedAtMs).toISOString(),
    environment: { runtime: 'node', runtimeVersion: '22.0.0', executionSurface: 'server-process', os: { name: 'linux', version: '24.04' } },
    scenario: { feature: kind, scenario: runId, expectedResult: 'verified recurring provider operations remain healthy' },
    artifact: { locator: `artifact://${runId}/report.json`, sha256: ARTIFACT_SHA256, expiresAt: '2026-08-21T13:00:00.000Z' },
    verification: { verifier: 'unzen-ci-evidence-verifier', version: '1.0.0', verifiedAt: new Date(capturedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'provider-steady-state-v1' }, payload,
  };
}

function baselinePayload(): ProviderPostCutoverReconciliationPayload {
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1',
    replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    cutoverRunId: 'production-cutover-1', cutoverId: 'cutover-1', productionWindowId: 'prod-window-1', changeTicketId: 'CHG-123',
    providerOperationId: 'provider-cutover-op-1', providerTraceId: 'provider-trace-1', restoreExecutionId: 'production-restore-1',
    observationWindow: { windowId: 'post-window-1', startsAtMs: BASE + 100_000, endsAtMs: BASELINE_END, minimumDurationMs: 300_000 },
    providerAuditStreamId: 'audit-stream-1', providerAuditCursor: 'cursor-baseline', providerAuditRecords: [], archiveRetrievals: [], alertDispositions: [],
    baselineIncidentIds: [], incidentReconciliations: [],
    controlState: { rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true, invocations: [] },
    slo: { policyId: 'slo-v1', policyVersion: '1.0.0', observedFromMs: BASE, observedToMs: BASELINE_END, operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99, requiredProviderAvailabilityPct: 99.9, allowedFailureBudget: 3, remainingFailureBudget: 3 },
    observedCredentialSetId: 'cred-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1',
    recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: RETENTION,
    reconciliationId: 'post-reconciliation-1', allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp',
    networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: BASELINE_END + 1_000,
  };
}

function baselineEvidence(payload = baselinePayload()) {
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND, 'post-cutover-reconciliation-1', payload, payload.capturedAtMs);
}

type ReconciliationReport = Awaited<ReturnType<typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate>>;

function upstreamReport(evidence = baselineEvidence()): ReconciliationReport {
  return {
    status: 'pass', previewRunnerUrl: 'https://worker.unzen.dev/runner', reconciliationInputEvidence: evidence,
    reconciliationEvidenceSummary: { runId: evidence.runId, validationStatus: 'valid', effectiveEvidenceLevel: 'captured-and-verified', effectiveReadinessStatus: 'production-approved', evidenceKind: evidence.evidenceKind },
    productionCutoverEvidence: {
      productionReadinessEvidence: {
        readinessInputEvidence: {
          payload: {
            credentialRotation: {
              credentialSetId: 'cred-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1',
              lastRotatedAtMs: BASE - 600_000, nextRotationDueAtMs: BASE + 2_500_000,
            },
          },
        },
      },
    },
  } as unknown as ReconciliationReport;
}

function retrieval(cycleId: string, storageId: string, startedAtMs: number, completedAtMs: number) {
  return {
    retrievalOperationId: `${cycleId}-${storageId}-read`, storageId, archiveId: 'archive-1',
    requestedAtMs: startedAtMs + 5_000, completedAtMs: completedAtMs - 5_000,
    observedContentDigest: DIGEST, integrityCheckId: `${cycleId}-${storageId}-integrity`, integrityStatus: 'pass' as const,
  };
}

function cyclePayload(index: 1 | 2 | 3): ProviderSteadyStateCyclePayload {
  const scheduledAtMs = index === 1 ? CYCLE1 : index === 2 ? CYCLE2 : CYCLE3;
  const startedAtMs = scheduledAtMs + 5_000;
  const completedAtMs = startedAtMs + 60_000;
  const id = `cycle-${index}`;
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    cycleId: id, scheduleId: 'steady-schedule-1', scheduledAtMs, startedAtMs, completedAtMs,
    auditStreamId: 'steady-audit-stream-1', auditCursorStart: `cursor-${index - 1}`, auditCursorEnd: `cursor-${index}`,
    providerAuditRecordIds: [`${id}-audit-a`, `${id}-audit-b`],
    primaryRetrieval: retrieval(id, 'primary-1', startedAtMs, completedAtMs), backupRetrieval: retrieval(id, 'backup-1', startedAtMs, completedAtMs),
    operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99,
    observedCredentialSetId: 'cred-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1',
    ...(index === 3 ? { drExercise: { exerciseId: 'dr-exercise-1', sourceStorageId: 'backup-1', startedAtMs: completedAtMs - 40_000, completedAtMs: completedAtMs - 10_000, recoveryPointAtMs: completedAtMs - 80_000, observedContentDigest: DIGEST, integrityCheckId: 'dr-integrity-1', integrityStatus: 'pass' as const } } : {}),
    alertDispositions: [{ alertId: `${id}-info`, severity: 'info', status: 'resolved', dispositionId: `${id}-disp` }], incidentReviews: [],
    rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true, controlInvocations: [],
    retainedEvidence: { evidenceArchiveId: `${id}-evidence-archive`, evidenceContentDigest: ARTIFACT_SHA256, retentionUntilMs: completedAtMs + 2_100_000, retrievalProofId: `${id}-evidence-retrieval` },
    baselineIncidentIds: [], recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: RETENTION,
    allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
    capturedAtMs: completedAtMs + 1_000,
  };
}

function cycleEvidence(index: 1 | 2 | 3, payload = cyclePayload(index)) {
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND, `cycle-${index}`, payload, payload.capturedAtMs);
}

function operationsPayload(): ProviderSteadyStateOperationsPayload {
  const last = cyclePayload(3);
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    baselineReconciliationRunId: 'post-cutover-reconciliation-1', cycleRunIds: ['cycle-1', 'cycle-2', 'cycle-3'],
    schedule: { scheduleId: 'steady-schedule-1', cadenceMs: CADENCE, graceMs: GRACE, lastSuccessfulCycleAtMs: last.completedAtMs, nextDueAtMs: CYCLE3 + CADENCE },
    rollingSlo: { policyId: 'steady-slo-v1', policyVersion: '1.0.0', requiredProviderAvailabilityPct: 99.9, minimumOperationCount: 300, totalOperationCount: 300, totalFailureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityFloorPct: 99.99, allowedFailureBudget: 3, remainingFailureBudget: 3 },
    credentialRotation: { rotationCadenceMs: 3_100_000, lastRotatedAtMs: BASE - 600_000, nextRotationDueAtMs: BASE + 2_500_000, currentCredentialSetId: 'cred-1', currentSigningKeyId: 'sign-1', currentEncryptionKeyId: 'enc-1', rotationEvidenceIds: [] },
    drPolicy: { policyId: 'steady-dr-v1', drillCadenceMs: 1_200_000, graceMs: 60_000, baselineLastExerciseAtMs: BASE + 500_000, lastExerciseAtMs: last.drExercise!.completedAtMs, nextExerciseDueAtMs: last.drExercise!.completedAtMs + 1_200_000, requiredBackupSourceStorageId: 'backup-1' },
    evidenceRetention: { policyId: 'steady-evidence-retention-v1', minimumRetentionMs: 1_000_000 },
    rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', baselineIncidentIds: [], recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: RETENTION,
    allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }],
    capturedAtMs: last.completedAtMs + 15_000,
  };
}

function operationsEvidence(payload = operationsPayload()) {
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND, 'steady-state-operations-1', payload, payload.capturedAtMs);
}

const validationOptions: EvidenceValidationOptions = {
  now: '2026-08-19T13:00:00.000Z', trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async () => ARTIFACT_CONTENT,
  verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

async function run(options: {
  baseline?: EvidenceEnvelope<ProviderPostCutoverReconciliationPayload>;
  cycles?: EvidenceEnvelope<ProviderSteadyStateCyclePayload>[];
  operations?: EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
  validation?: EvidenceValidationOptions;
} = {}) {
  const baseline = options.baseline ?? baselineEvidence();
  return runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate({
    postCutoverReconciliationReport: upstreamReport(baselineEvidence()),
    postCutoverReconciliationEvidence: baseline,
    steadyStateCycleEvidence: options.cycles ?? [cycleEvidence(1), cycleEvidence(2), cycleEvidence(3)],
    steadyStateOperationsEvidence: options.operations ?? operationsEvidence(),
    evidenceValidationOptions: options.validation ?? validationOptions,
  });
}

describe('publisher tax exception archive DR provider steady-state operations gate', () => {
  it('passes three independently verified recurring production cycles', async () => {
    const result = await run();
    expect(result.status).toBe('pass');
    expect(result.cycleSummary.validatedCycles).toBe(3);
    expect(result.bottlenecksToIssue).toEqual([PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_AUTOMATION_BOTTLENECK]);
  });

  it('rejects self-reported steady-state operations evidence', async () => {
    const payload = operationsPayload();
    const evidence = { schemaVersion: '1.0.0', evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed', producer: { name: 'x', version: '1' }, runId: 'self', capturedAt: new Date(payload.capturedAtMs).toISOString(), environment: { runtime: 'node', runtimeVersion: '22', executionSurface: 'server-process' }, redaction: { applied: true, policyVersion: '1' }, payload } as EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
    expect((await run({ operations: evidence })).promoteHoldThresholds.holdReasons).toContain('requires-production-approved-steady-state-evidence');
  });

  it('does not trust captured literals without artifact loading and independent verification', async () => {
    const result = await run({ validation: { now: '2026-08-19T13:00:00.000Z', trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }] } });
    expect(result.status).toBe('fail');
  });

  it('rejects same-run-ID reconciliation payload substitution', async () => {
    const changed = baselinePayload();
    changed.providerAuditCursor = 'substituted-cursor';
    expect((await run({ baseline: baselineEvidence(changed) })).promoteHoldThresholds.holdReasons).toContain('reconciliation-input-mismatch');
  });

  it('requires at least three distinct verified cycles', async () => {
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2)] })).promoteHoldThresholds.holdReasons).toContain('requires-three-distinct-steady-state-cycles');
  });

  it('holds a missed reconciliation cadence', async () => {
    const p = cyclePayload(2); p.scheduledAtMs += 60_000;
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-cycle-cadence-gap');
  });

  it('holds archive integrity drift on either storage path', async () => {
    const p = cyclePayload(2); p.backupRetrieval = { ...p.backupRetrieval, integrityStatus: 'fail' };
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-backup-archive-retrieval-invalid:cycle-2');
  });

  it('holds broken provider audit cursor continuity', async () => {
    const p = cyclePayload(2); p.auditCursorStart = 'wrong-cursor';
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-audit-continuity-broken');
  });

  it('holds an exhausted rolling error budget', async () => {
    const op = operationsPayload(); op.rollingSlo = { ...op.rollingSlo, allowedFailureBudget: 0, remainingFailureBudget: 0 };
    expect((await run({ operations: operationsEvidence(op) })).promoteHoldThresholds.holdReasons).toContain('steady-state-rolling-slo-invalid');
  });

  it('holds an RTO or integrity breach in a recurring cycle', async () => {
    const p = cyclePayload(2); p.rtoBreachCount = 1;
    const op = operationsPayload(); op.rollingSlo = { ...op.rollingSlo, rtoBreachCount: 1 };
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)], operations: operationsEvidence(op) })).promoteHoldThresholds.holdReasons).toContain('steady-state-rolling-slo-invalid');
  });

  it('holds unexplained credential or key drift', async () => {
    const p = cyclePayload(2); p.observedSigningKeyId = 'sign-other';
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-key-rotation-missing-or-drift:cycle-2');
  });

  it('holds when a key rotation deadline is crossed without rotation evidence', async () => {
    const report = upstreamReport();
    (report.productionCutoverEvidence.productionReadinessEvidence.readinessInputEvidence.payload.credentialRotation as { nextRotationDueAtMs: number }).nextRotationDueAtMs = CYCLE3 + 10_000;
    const result = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate({
      postCutoverReconciliationReport: report,
      postCutoverReconciliationEvidence: baselineEvidence(), steadyStateCycleEvidence: [cycleEvidence(1), cycleEvidence(2), cycleEvidence(3)],
      steadyStateOperationsEvidence: operationsEvidence(), evidenceValidationOptions: validationOptions,
    });
    expect(result.promoteHoldThresholds.holdReasons.some((reason) => reason.includes('steady-state-key-rotation'))).toBe(true);
  });

  it('requires a backup-source DR exercise within cadence', async () => {
    const p = cyclePayload(3); p.drExercise = undefined;
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2), cycleEvidence(3, p)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-backup-dr-exercise-missing');
  });

  it('holds active high-severity incidents and active control invocations', async () => {
    const p = cyclePayload(2);
    p.incidentReviews = [{ incidentId: 'incident-1', severity: 'sev1', status: 'active', reconciliationId: 'recon-1' }];
    p.controlInvocations = [{ invocationId: 'inv-1', controlId: 'rollback-1', status: 'active' }];
    const reasons = (await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons;
    expect(reasons).toContain('steady-state-incident-invalid:cycle-2');
    expect(reasons).toContain('steady-state-control-invocation-invalid:cycle-2');
  });

  it('holds retained operational evidence digest or retention drift', async () => {
    const p = cyclePayload(2); p.retainedEvidence = { ...p.retainedEvidence, evidenceContentDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-evidence-retention-invalid:cycle-2');
  });

  it('rejects an unblocked non-Coordinator/CDN network attempt', async () => {
    const p = cyclePayload(2); p.networkAttempts = [...p.networkAttempts, { url: 'https://evil.example/leak', blocked: false }];
    expect((await run({ cycles: [cycleEvidence(1), cycleEvidence(2, p), cycleEvidence(3)] })).promoteHoldThresholds.holdReasons).toContain('steady-state-cycle-network-leak:cycle-2');
  });
});
