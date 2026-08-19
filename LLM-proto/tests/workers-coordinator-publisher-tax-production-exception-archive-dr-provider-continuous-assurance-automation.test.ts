import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope, EvidenceValidationOptions } from '../src/evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_WORKER_RUNTIME_BOTTLENECK,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation,
  type ContinuousAssuranceActionContext,
  type ContinuousAssuranceExecutor,
  type ContinuousAssuranceHealthResult,
  type ContinuousAssuranceProviderAuditResult,
} from '../src/workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate,
  type ProviderSteadyStateCyclePayload,
  type ProviderSteadyStateOperationsPayload,
  type SteadyStateDrExercise,
  type SteadyStateRetainedEvidence,
  type SteadyStateRotationEvent,
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
const CYCLE1 = BASE + 900_000;
const CYCLE2 = CYCLE1 + CADENCE;
const CYCLE3 = CYCLE2 + CADENCE;
const CYCLE4 = CYCLE3 + CADENCE;
const ROTATION_DUE = CYCLE4 + 30_000;
const DR_DUE = CYCLE4 + 50_000;
const RETENTION = { policyId: 'retention-v1', legalHold: false, operationalHold: false } as never;
const ALLOWED = ['https://coordinator.unzen.dev', 'https://cdn.unzen.dev'];

type ReconciliationReport = Awaited<ReturnType<typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderPostCutoverReconciliationGate>>;

type Call = { action: string; key: string; attempt: number; role?: string };

function captured<T>(kind: string, runId: string, payload: T, capturedAtMs: number, level: 'captured-and-verified' | 'self-reported-runtime' = 'captured-and-verified'): EvidenceEnvelope<T> {
  if (level === 'self-reported-runtime') {
    return {
      schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'self-reported-runtime', readinessStatus: 'runtime-observed',
      producer: { name: 'archive-provider-harness', version: '1.0.0' }, runId, capturedAt: new Date(capturedAtMs).toISOString(),
      environment: { runtime: 'node', runtimeVersion: '22.0.0', executionSurface: 'server-process' },
      redaction: { applied: true, policyVersion: 'provider-automation-v1' }, payload,
    };
  }
  return {
    schemaVersion: '1.0.0', evidenceKind: kind, evidenceLevel: 'captured-and-verified', readinessStatus: 'production-approved',
    producer: { name: 'archive-provider-harness', version: '1.0.0', commitSha: '0123456789abcdef0123456789abcdef01234567' },
    runId, capturedAt: new Date(capturedAtMs).toISOString(),
    environment: { runtime: 'node', runtimeVersion: '22.0.0', executionSurface: 'server-process', os: { name: 'linux', version: '24.04' } },
    scenario: { feature: kind, scenario: runId, expectedResult: 'verified recurring provider operations remain healthy' },
    artifact: { locator: `artifact://${runId}/report.json`, sha256: ARTIFACT_SHA256, expiresAt: '2026-08-21T13:00:00.000Z' },
    verification: { verifier: 'unzen-ci-evidence-verifier', version: '1.0.0', verifiedAt: new Date(capturedAtMs + 1_000).toISOString(), result: 'pass' },
    redaction: { applied: true, policyVersion: 'provider-automation-v1' }, payload,
  };
}

const validationOptions: EvidenceValidationOptions = {
  now: '2026-08-19T13:00:00.000Z',
  trustedVerifiers: [{ name: 'unzen-ci-evidence-verifier', version: '1.0.0' }],
  loadArtifact: async () => ARTIFACT_CONTENT,
  verifyArtifact: async ({ envelope }) => ({ ...envelope.verification }),
};

function baselinePayload(): ProviderPostCutoverReconciliationPayload {
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    cutoverRunId: 'production-cutover-1', cutoverId: 'cutover-1', productionWindowId: 'prod-window-1', changeTicketId: 'CHG-123', providerOperationId: 'provider-cutover-op-1', providerTraceId: 'provider-trace-1', restoreExecutionId: 'production-restore-1',
    observationWindow: { windowId: 'post-window-1', startsAtMs: BASE + 100_000, endsAtMs: BASELINE_END, minimumDurationMs: 300_000 },
    providerAuditStreamId: 'audit-stream-1', providerAuditCursor: 'cursor-baseline', providerAuditRecords: [], archiveRetrievals: [], alertDispositions: [], baselineIncidentIds: [], incidentReconciliations: [],
    controlState: { rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true, invocations: [] },
    slo: { policyId: 'slo-v1', policyVersion: '1.0.0', observedFromMs: BASE, observedToMs: BASELINE_END, operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99, requiredProviderAvailabilityPct: 99.9, allowedFailureBudget: 3, remainingFailureBudget: 3 },
    observedCredentialSetId: 'cred-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1', recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: RETENTION,
    reconciliationId: 'post-reconciliation-1', allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: BASELINE_END + 1_000,
  };
}

function baselineEvidence() {
  const payload = baselinePayload();
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_POST_CUTOVER_RECONCILIATION_EVIDENCE_KIND, 'post-cutover-reconciliation-1', payload, payload.capturedAtMs);
}

function reconciliationReport(evidence = baselineEvidence()): ReconciliationReport {
  return {
    status: 'pass', previewRunnerUrl: 'https://worker.unzen.dev/runner', reconciliationInputEvidence: evidence,
    reconciliationEvidenceSummary: { runId: evidence.runId, validationStatus: 'valid', effectiveEvidenceLevel: 'captured-and-verified', effectiveReadinessStatus: 'production-approved', evidenceKind: evidence.evidenceKind },
    productionCutoverEvidence: { productionReadinessEvidence: { readinessInputEvidence: { payload: { credentialRotation: { credentialSetId: 'cred-1', signingKeyId: 'sign-1', encryptionKeyId: 'enc-1', lastRotatedAtMs: BASE - 600_000, nextRotationDueAtMs: ROTATION_DUE } } } } },
  } as unknown as ReconciliationReport;
}

function retrieval(cycleId: string, storageId: string, startedAtMs: number, completedAtMs: number) {
  return { retrievalOperationId: `${cycleId}-${storageId}-read`, storageId, archiveId: 'archive-1', requestedAtMs: startedAtMs + 5_000, completedAtMs: completedAtMs - 5_000, observedContentDigest: DIGEST, integrityCheckId: `${cycleId}-${storageId}-integrity`, integrityStatus: 'pass' as const };
}

function cyclePayload(index: 1 | 2 | 3): ProviderSteadyStateCyclePayload {
  const scheduledAtMs = index === 1 ? CYCLE1 : index === 2 ? CYCLE2 : CYCLE3;
  const startedAtMs = scheduledAtMs + 5_000;
  const completedAtMs = startedAtMs + 60_000;
  const id = `cycle-${index}`;
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    cycleId: id, scheduleId: 'steady-schedule-1', scheduledAtMs, startedAtMs, completedAtMs,
    auditStreamId: 'steady-audit-stream-1', auditCursorStart: `cursor-${index - 1}`, auditCursorEnd: `cursor-${index}`, providerAuditRecordIds: [`${id}-audit-a`, `${id}-audit-b`],
    primaryRetrieval: retrieval(id, 'primary-1', startedAtMs, completedAtMs), backupRetrieval: retrieval(id, 'backup-1', startedAtMs, completedAtMs),
    operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99,
    observedCredentialSetId: 'cred-1', observedSigningKeyId: 'sign-1', observedEncryptionKeyId: 'enc-1',
    ...(index === 3 ? { drExercise: { exerciseId: 'dr-exercise-previous', sourceStorageId: 'backup-1', startedAtMs: completedAtMs - 40_000, completedAtMs: completedAtMs - 10_000, recoveryPointAtMs: completedAtMs - 80_000, observedContentDigest: DIGEST, integrityCheckId: 'dr-integrity-previous', integrityStatus: 'pass' as const } } : {}),
    alertDispositions: [{ alertId: `${id}-info`, severity: 'info', status: 'resolved', dispositionId: `${id}-disp` }], incidentReviews: [], rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true, controlInvocations: [],
    retainedEvidence: { evidenceArchiveId: `${id}-evidence-archive`, evidenceContentDigest: ARTIFACT_SHA256, retentionUntilMs: completedAtMs + 2_100_000, retrievalProofId: `${id}-evidence-retrieval` }, baselineIncidentIds: [], recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: RETENTION,
    allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: completedAtMs + 1_000,
  };
}

function cycleEvidence(index: 1 | 2 | 3) {
  const payload = cyclePayload(index);
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND, payload.cycleId, payload, payload.capturedAtMs);
}

function operationsPayload(): ProviderSteadyStateOperationsPayload {
  const last = cyclePayload(3);
  const drCadenceMs = DR_DUE - last.drExercise!.completedAtMs;
  return {
    providerName: 'archive-provider', accountId: 'acct-1', primaryStorageId: 'primary-1', backupStorageId: 'backup-1', replicaSiteId: 'replica-site-1', replicaRegion: 'us-west-2', archiveId: 'archive-1', archiveContentDigest: DIGEST,
    baselineReconciliationRunId: 'post-cutover-reconciliation-1', cycleRunIds: ['cycle-1', 'cycle-2', 'cycle-3'],
    schedule: { scheduleId: 'steady-schedule-1', cadenceMs: CADENCE, graceMs: 30_000, lastSuccessfulCycleAtMs: last.completedAtMs, nextDueAtMs: CYCLE4 },
    rollingSlo: { policyId: 'steady-slo-v1', policyVersion: '1.0.0', requiredProviderAvailabilityPct: 99.9, minimumOperationCount: 300, totalOperationCount: 300, totalFailureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityFloorPct: 99.99, allowedFailureBudget: 5, remainingFailureBudget: 5 },
    credentialRotation: { rotationCadenceMs: 3_100_000, lastRotatedAtMs: BASE - 600_000, nextRotationDueAtMs: ROTATION_DUE, currentCredentialSetId: 'cred-1', currentSigningKeyId: 'sign-1', currentEncryptionKeyId: 'enc-1', rotationEvidenceIds: [] },
    drPolicy: { policyId: 'steady-dr-v1', drillCadenceMs: drCadenceMs, graceMs: 60_000, baselineLastExerciseAtMs: last.drExercise!.completedAtMs - drCadenceMs, lastExerciseAtMs: last.drExercise!.completedAtMs, nextExerciseDueAtMs: DR_DUE, requiredBackupSourceStorageId: 'backup-1' },
    evidenceRetention: { policyId: 'steady-evidence-retention-v1', minimumRetentionMs: 1_000_000 }, rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', baselineIncidentIds: [], recoveryOwnerId: 'owner-1', onCallRoute: 'pager://archive-dr', escalationTarget: 'ops-lead', retentionPolicySnapshot: RETENTION,
    allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp', networkAttempts: [{ url: 'https://evil.example/exfiltrate', blocked: true }], capturedAtMs: last.completedAtMs + 15_000,
  };
}

function operationsEvidence(payload = operationsPayload()) {
  return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND, 'steady-state-operations-1', payload, payload.capturedAtMs);
}

async function makeUpstream() {
  const baseline = baselineEvidence();
  const cycles = [cycleEvidence(1), cycleEvidence(2), cycleEvidence(3)];
  const operations = operationsEvidence();
  const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate({
    postCutoverReconciliationReport: reconciliationReport(baseline),
    postCutoverReconciliationEvidence: baseline,
    steadyStateCycleEvidence: cycles,
    steadyStateOperationsEvidence: operations,
    evidenceValidationOptions: validationOptions,
  });
  expect(report.status).toBe('pass');
  return { report, operations };
}

function createExecutor(config: {
  failAction?: string;
  failAttempts?: number;
  cycleLevel?: 'captured-and-verified' | 'self-reported-runtime';
  aggregateLevel?: 'captured-and-verified' | 'self-reported-runtime';
  networkLeak?: boolean;
  pageFails?: boolean;
} = {}) {
  const calls: Call[] = [];
  const pages: string[] = [];
  const failures = new Map<string, number>();
  const record = (context: ContinuousAssuranceActionContext, role?: string) => {
    calls.push({ action: context.action, key: context.idempotencyKey, attempt: context.attempt, role });
    if (config.failAction === context.action) {
      const seen = (failures.get(context.action) ?? 0) + 1;
      failures.set(context.action, seen);
      if (seen <= (config.failAttempts ?? Number.POSITIVE_INFINITY)) throw new Error(`${context.action}-boom`);
    }
  };
  const cycleId = `steady-schedule-1-${CYCLE4}`;
  const completedAtMs = CYCLE4 + 60_000;

  const audit: ContinuousAssuranceProviderAuditResult = {
    auditStreamId: 'steady-audit-stream-1', auditCursorStart: 'cursor-3', auditCursorEnd: 'cursor-4', providerAuditRecordIds: [`${cycleId}-audit-a`, `${cycleId}-audit-b`], observedAtMs: CYCLE4 + 20_000,
  };
  const rotation: SteadyStateRotationEvent = {
    rotationEvidenceId: 'rotation-2', rotatedAtMs: CYCLE4 + 20_000,
    previousCredentialSetId: 'cred-1', previousSigningKeyId: 'sign-1', previousEncryptionKeyId: 'enc-1',
    newCredentialSetId: 'cred-2', newSigningKeyId: 'sign-2', newEncryptionKeyId: 'enc-2',
  };
  const drExercise: SteadyStateDrExercise = {
    exerciseId: 'dr-exercise-2', sourceStorageId: 'backup-1', startedAtMs: CYCLE4 + 20_000, completedAtMs: CYCLE4 + 40_000, recoveryPointAtMs: CYCLE4 + 10_000, observedContentDigest: DIGEST, integrityCheckId: 'dr-integrity-2', integrityStatus: 'pass',
  };
  const health: ContinuousAssuranceHealthResult = {
    observedAtMs: completedAtMs, operationCount: 100, failureCount: 0, rtoBreachCount: 0, rpoBreachCount: 0, integrityFailureCount: 0, providerAvailabilityPct: 99.99,
    observedCredentialSetId: 'cred-2', observedSigningKeyId: 'sign-2', observedEncryptionKeyId: 'enc-2',
    alertDispositions: [{ alertId: `${cycleId}-info`, severity: 'info', status: 'resolved', dispositionId: `${cycleId}-disp` }], incidentReviews: [],
    rollbackControlId: 'rollback-1', emergencyHoldControlId: 'hold-1', rollbackArmed: true, emergencyHoldArmed: true, controlInvocations: [],
    allowedOrigins: ALLOWED, cspConnectSrc: ALLOWED, sandboxFlags: ['allow-scripts'], coop: 'same-origin', coep: 'require-corp',
    networkAttempts: config.networkLeak ? [{ url: 'https://evil.example/leak', blocked: false }, { url: 'https://evil.example/blocked', blocked: true }] : [{ url: 'https://evil.example/blocked', blocked: true }],
  };

  const executor: ContinuousAssuranceExecutor = {
    async collectProviderAudit(context) { record(context); return audit; },
    async retrieveArchive(role, storageId, _archiveId, _expectedDigest, context) {
      record(context, role);
      return retrieval(cycleId, storageId, CYCLE4, CYCLE4 + 30_000);
    },
    async collectOperationalHealth(context) { record(context); return health; },
    async rotateCredentialKeys(_current, context) { record(context); return rotation; },
    async runDrFailoverExercise(_backupStorageId, _archiveId, _expectedDigest, context) { record(context); return drExercise; },
    async archiveCycleEvidence({ draft, minimumRetentionMs, context }) {
      record(context);
      const retained: SteadyStateRetainedEvidence = {
        evidenceArchiveId: `${draft.cycleId}-evidence-archive`, evidenceContentDigest: ARTIFACT_SHA256,
        retentionUntilMs: draft.completedAtMs + 1_000 + minimumRetentionMs + 1_000,
        retrievalProofId: `${draft.cycleId}-evidence-retrieval`,
      };
      return retained;
    },
    async captureCycleEvidence({ payload, context }) {
      record(context);
      return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND, payload.cycleId, payload, payload.capturedAtMs, config.cycleLevel ?? 'captured-and-verified');
    },
    async captureAggregateEvidence({ payload, expectedRunId, context }) {
      record(context);
      return captured(PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND, expectedRunId, payload, payload.capturedAtMs, config.aggregateLevel ?? 'captured-and-verified');
    },
    async pageOperator({ dedupeKey }) {
      pages.push(dedupeKey);
      if (config.pageFails) throw new Error('pager-down');
    },
  };
  return { executor, calls, pages };
}

async function runTick(args: {
  nowMs?: number;
  executor?: ReturnType<typeof createExecutor>;
  operations?: EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
  rotationLeadMs?: number;
  drLeadMs?: number;
  maxAttempts?: number;
} = {}) {
  const upstream = await makeUpstream();
  const exec = args.executor ?? createExecutor();
  return {
    result: await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation({
      steadyStateOperationsReport: upstream.report,
      steadyStateOperationsEvidence: args.operations ?? upstream.operations,
      nowMs: args.nowMs ?? CYCLE4,
      executor: exec.executor,
      automationPolicy: { rotationLeadMs: args.rotationLeadMs ?? 60_000, drLeadMs: args.drLeadMs ?? 60_000, retry: { maxAttempts: args.maxAttempts ?? 2, backoffBaseMs: 1_000 } },
      evidenceValidationOptions: validationOptions,
    }),
    exec,
    upstream,
  };
}

describe('publisher tax exception archive DR provider continuous assurance automation', () => {
  it('is idle before the next due time and invokes no provider or pager action', async () => {
    const exec = createExecutor();
    const { result } = await runTick({ nowMs: CYCLE4 - 1, executor: exec });
    expect(result.status).toBe('idle');
    expect(exec.calls).toHaveLength(0);
    expect(exec.pages).toHaveLength(0);
  });

  it('orchestrates a due cycle and returns the existing steady-state gate pass', async () => {
    const exec = createExecutor();
    const { result } = await runTick({ executor: exec });
    expect(result.status).toBe('pass');
    expect(result.finalSteadyStateReport?.status).toBe('pass');
    expect(result.bottlenecksToIssue).toEqual([PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_WORKER_RUNTIME_BOTTLENECK]);
    expect(exec.calls.filter((call) => call.action.includes('archive-retrieval')).map((call) => call.role)).toEqual(['primary', 'backup']);
    expect(result.newCycleEvidence?.payload.rotationEvent?.rotationEvidenceId).toBe('rotation-2');
    expect(result.newCycleEvidence?.payload.drExercise?.sourceStorageId).toBe('backup-1');
    expect(result.newAggregateEvidence?.payload.cycleRunIds).toHaveLength(4);
    expect(exec.pages).toHaveLength(0);
  });

  it('pages once and fabricates no evidence when a cycle is past grace', async () => {
    const exec = createExecutor();
    const { result } = await runTick({ nowMs: CYCLE4 + 30_001, executor: exec });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toBe('continuous-assurance-cycle-overdue');
    expect(exec.calls).toHaveLength(0);
    expect(exec.pages).toHaveLength(1);
    expect(result.newCycleEvidence).toBeNull();
  });

  it('retries idempotent provider actions with the same key', async () => {
    const exec = createExecutor({ failAction: 'primary-archive-retrieval', failAttempts: 1 });
    const { result } = await runTick({ executor: exec });
    expect(result.status).toBe('pass');
    const calls = exec.calls.filter((call) => call.action === 'primary-archive-retrieval');
    expect(calls).toHaveLength(2);
    expect(calls[0].key).toBe(calls[1].key);
    expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
  });

  it('holds and pages when an external action exhausts retries', async () => {
    const exec = createExecutor({ failAction: 'primary-archive-retrieval' });
    const { result } = await runTick({ executor: exec, maxAttempts: 2 });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toContain('continuous-assurance-action-failed:primary-archive-retrieval:');
    expect(exec.pages).toHaveLength(1);
    expect(exec.calls.filter((call) => call.action === 'backup-archive-retrieval')).toHaveLength(0);
  });

  it('triggers rotation inside lead time and propagates new key identities', async () => {
    const { result, exec } = await runTick();
    expect(exec.calls.some((call) => call.action === 'credential-key-rotation')).toBe(true);
    expect(result.newAggregateEvidence?.payload.credentialRotation.currentCredentialSetId).toBe('cred-2');
    expect(result.newAggregateEvidence?.payload.credentialRotation.rotationEvidenceIds).toContain('rotation-2');
  });

  it('does not invent rotation outside lead time and downstream policy holds if the cycle crosses the deadline', async () => {
    const exec = createExecutor();
    const { result } = await runTick({ executor: exec, rotationLeadMs: 0 });
    expect(exec.calls.some((call) => call.action === 'credential-key-rotation')).toBe(false);
    expect(result.status).toBe('hold');
    expect(result.failureReason).toContain('steady-state-key-rotation');
    expect(exec.pages).toHaveLength(1);
  });

  it('triggers the due DR exercise against backup storage', async () => {
    const { result, exec } = await runTick();
    expect(exec.calls.some((call) => call.action === 'dr-failover-exercise')).toBe(true);
    expect(result.newCycleEvidence?.payload.drExercise?.sourceStorageId).toBe('backup-1');
  });

  it('rejects self-reported cycle capture and does not capture aggregate evidence', async () => {
    const exec = createExecutor({ cycleLevel: 'self-reported-runtime' });
    const { result } = await runTick({ executor: exec });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toBe('continuous-assurance-cycle-evidence-not-verified');
    expect(exec.calls.some((call) => call.action === 'aggregate-evidence-capture')).toBe(false);
    expect(exec.pages).toHaveLength(1);
  });

  it('rejects self-reported aggregate capture', async () => {
    const exec = createExecutor({ aggregateLevel: 'self-reported-runtime' });
    const { result } = await runTick({ executor: exec });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toBe('continuous-assurance-aggregate-evidence-not-verified');
    expect(exec.pages).toHaveLength(1);
  });

  it('uses the existing steady-state gate as authoritative final hold decision', async () => {
    const exec = createExecutor({ networkLeak: true });
    const { result } = await runTick({ executor: exec });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toContain('steady-state-cycle-network-leak');
    expect(result.finalSteadyStateReport?.status).toBe('fail');
    expect(exec.pages).toHaveLength(1);
  });

  it('preserves the primary failure when paging also fails', async () => {
    const exec = createExecutor({ failAction: 'provider-audit', pageFails: true });
    const { result } = await runTick({ executor: exec, maxAttempts: 1 });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toContain('continuous-assurance-action-failed:provider-audit:');
    expect(result.paging.succeeded).toBe(false);
    expect(result.paging.error).toBe('pager-down');
  });

  it('rejects same-run-ID steady-state payload substitution before actions', async () => {
    const upstream = await makeUpstream();
    const changed = captured(
      PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
      upstream.operations.runId,
      { ...upstream.operations.payload, archiveId: 'substituted-archive' },
      upstream.operations.payload.capturedAtMs,
    );
    const exec = createExecutor();
    const { result } = await runTick({ executor: exec, operations: changed });
    expect(result.status).toBe('hold');
    expect(result.failureReason).toBe('steady-state-input-mismatch');
    expect(exec.calls).toHaveLength(0);
    expect(exec.pages).toHaveLength(1);
  });

  it('records deterministic action idempotency keys', async () => {
    const { exec } = await runTick();
    const cycleId = `steady-schedule-1-${CYCLE4}`;
    expect(exec.calls.every((call) => call.key.startsWith(`${cycleId}:`))).toBe(true);
  });
});
