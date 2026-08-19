import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate,
  type ProviderSteadyStateCyclePayload,
  type ProviderSteadyStateOperationsPayload,
  type SteadyStateAlertDisposition,
  type SteadyStateArchiveRetrieval,
  type SteadyStateControlInvocation,
  type SteadyStateDrExercise,
  type SteadyStateIncidentReview,
  type SteadyStateRetainedEvidence,
  type SteadyStateRotationEvent,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';
import type { WorkersCoordinatorRunnerNetworkAttempt } from './workers-coordinator-signed-runner-release-gate.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_WORKER_RUNTIME_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-worker-runtime' as const;

type ProviderSteadyStateOperationsReport = Awaited<ReturnType<
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate
>>;

type ContinuousAssuranceCycleDraft = Omit<
  ProviderSteadyStateCyclePayload,
  'retainedEvidence' | 'capturedAtMs'
>;

export type ContinuousAssuranceActionName =
  | 'provider-audit'
  | 'primary-archive-retrieval'
  | 'backup-archive-retrieval'
  | 'credential-key-rotation'
  | 'dr-failover-exercise'
  | 'operational-health'
  | 'cycle-evidence-archive'
  | 'cycle-evidence-capture'
  | 'aggregate-evidence-capture';

export interface ContinuousAssuranceActionContext {
  readonly cycleId: string;
  readonly scheduledAtMs: number;
  readonly nowMs: number;
  readonly action: ContinuousAssuranceActionName;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly backoffMsBeforeAttempt: number;
}

export interface ContinuousAssuranceProviderAuditResult {
  readonly auditStreamId: string;
  readonly auditCursorStart: string;
  readonly auditCursorEnd: string;
  readonly providerAuditRecordIds: readonly string[];
  readonly observedAtMs: number;
}

export interface ContinuousAssuranceHealthResult {
  readonly observedAtMs: number;
  readonly operationCount: number;
  readonly failureCount: number;
  readonly rtoBreachCount: number;
  readonly rpoBreachCount: number;
  readonly integrityFailureCount: number;
  readonly providerAvailabilityPct: number;
  readonly observedCredentialSetId: string;
  readonly observedSigningKeyId: string;
  readonly observedEncryptionKeyId: string;
  readonly alertDispositions: readonly SteadyStateAlertDisposition[];
  readonly incidentReviews: readonly SteadyStateIncidentReview[];
  readonly rollbackControlId: string;
  readonly emergencyHoldControlId: string;
  readonly rollbackArmed: boolean;
  readonly emergencyHoldArmed: boolean;
  readonly controlInvocations: readonly SteadyStateControlInvocation[];
  readonly allowedOrigins: readonly string[];
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface ContinuousAssuranceRetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
}

export interface ContinuousAssuranceAutomationPolicy {
  readonly rotationLeadMs: number;
  readonly drLeadMs: number;
  readonly retry: ContinuousAssuranceRetryPolicy;
}

export interface ContinuousAssuranceArchiveCycleRequest {
  readonly draft: ContinuousAssuranceCycleDraft;
  readonly minimumRetentionMs: number;
  readonly context: ContinuousAssuranceActionContext;
}

export interface ContinuousAssuranceCaptureCycleRequest {
  readonly payload: ProviderSteadyStateCyclePayload;
  readonly context: ContinuousAssuranceActionContext;
}

export interface ContinuousAssuranceCaptureAggregateRequest {
  readonly payload: ProviderSteadyStateOperationsPayload;
  readonly expectedRunId: string;
  readonly context: ContinuousAssuranceActionContext;
}

export interface ContinuousAssurancePageRequest {
  readonly dedupeKey: string;
  readonly cycleId: string;
  readonly reason: string;
  readonly nowMs: number;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
}

export interface ContinuousAssuranceExecutor {
  collectProviderAudit(context: ContinuousAssuranceActionContext): Promise<ContinuousAssuranceProviderAuditResult>;
  retrieveArchive(
    role: 'primary' | 'backup',
    storageId: string,
    archiveId: string,
    expectedDigest: string,
    context: ContinuousAssuranceActionContext,
  ): Promise<SteadyStateArchiveRetrieval>;
  collectOperationalHealth(context: ContinuousAssuranceActionContext): Promise<ContinuousAssuranceHealthResult>;
  rotateCredentialKeys(
    current: Pick<
      ProviderSteadyStateOperationsPayload['credentialRotation'],
      'currentCredentialSetId' | 'currentSigningKeyId' | 'currentEncryptionKeyId' | 'nextRotationDueAtMs'
    >,
    context: ContinuousAssuranceActionContext,
  ): Promise<SteadyStateRotationEvent>;
  runDrFailoverExercise(
    backupStorageId: string,
    archiveId: string,
    expectedDigest: string,
    context: ContinuousAssuranceActionContext,
  ): Promise<SteadyStateDrExercise>;
  archiveCycleEvidence(request: ContinuousAssuranceArchiveCycleRequest): Promise<SteadyStateRetainedEvidence>;
  captureCycleEvidence(request: ContinuousAssuranceCaptureCycleRequest): Promise<EvidenceEnvelope<ProviderSteadyStateCyclePayload>>;
  captureAggregateEvidence(request: ContinuousAssuranceCaptureAggregateRequest): Promise<EvidenceEnvelope<ProviderSteadyStateOperationsPayload>>;
  pageOperator(request: ContinuousAssurancePageRequest): Promise<void>;
}

export interface ProviderContinuousAssuranceAutomationOptions {
  readonly steadyStateOperationsReport: ProviderSteadyStateOperationsReport;
  readonly steadyStateOperationsEvidence: EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
  readonly nowMs: number;
  readonly executor: ContinuousAssuranceExecutor;
  readonly automationPolicy?: Partial<ContinuousAssuranceAutomationPolicy> & {
    readonly retry?: Partial<ContinuousAssuranceRetryPolicy>;
  };
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
}

export interface ContinuousAssuranceActionAttempt {
  readonly action: ContinuousAssuranceActionName;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly backoffMsBeforeAttempt: number;
  readonly status: 'success' | 'failure';
  readonly error?: string;
}

export interface ContinuousAssurancePagingResult {
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly dedupeKey: string | null;
  readonly error?: string;
}

class ContinuousAssuranceActionError extends Error {
  readonly action: ContinuousAssuranceActionName;
  readonly idempotencyKey: string;

  constructor(action: ContinuousAssuranceActionName, idempotencyKey: string, message: string) {
    super(message);
    this.action = action;
    this.idempotencyKey = idempotencyKey;
  }
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation(
  options: ProviderContinuousAssuranceAutomationOptions,
) {
  const attempts: ContinuousAssuranceActionAttempt[] = [];
  const policy = normalizePolicy(options.automationPolicy);
  const upstream = options.steadyStateOperationsReport;
  const validation = await validateEvidenceEnvelope<ProviderSteadyStateOperationsPayload>(
    options.steadyStateOperationsEvidence,
    options.evidenceValidationOptions,
  );
  const previous = validation.envelope?.payload;
  const fallbackCycleId = previous
    ? cycleIdFor(previous.schedule.scheduleId, previous.schedule.nextDueAtMs)
    : 'continuous-assurance-unknown-cycle';

  let preflightFailure: string | undefined;
  if (upstream.status !== 'pass') preflightFailure = 'steady-state-upstream-not-clean';
  else if (!evidenceSupportsReadiness(validation, 'production-approved')) preflightFailure = 'steady-state-evidence-not-production-approved';
  else if (options.steadyStateOperationsEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND) {
    preflightFailure = 'steady-state-evidence-kind-invalid';
  } else if (options.steadyStateOperationsEvidence.runId !== upstream.steadyStateEvidenceSummary.runId) {
    preflightFailure = 'steady-state-run-mismatch';
  } else if (JSON.stringify(options.steadyStateOperationsEvidence) !== JSON.stringify(upstream.steadyStateInputEvidence)) {
    preflightFailure = 'steady-state-input-mismatch';
  } else if (!previous) {
    preflightFailure = 'steady-state-payload-missing';
  }

  const history = upstream.cycleInputEvidence ?? [];
  if (!preflightFailure && previous) {
    const historyValidations = await Promise.all(
      history.map((evidence) => validateEvidenceEnvelope<ProviderSteadyStateCyclePayload>(
        evidence,
        options.evidenceValidationOptions,
      )),
    );
    for (let index = 0; index < history.length; index += 1) {
      const evidence = history[index];
      const cycleValidation = historyValidations[index];
      if (evidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND ||
        !evidenceSupportsReadiness(cycleValidation, 'production-approved')) {
        preflightFailure = `historical-cycle-not-verified:${evidence.runId}`;
        break;
      }
    }
    if (!preflightFailure && !sameSet(previous.cycleRunIds, history.map((evidence) => evidence.runId))) {
      preflightFailure = 'historical-cycle-set-mismatch';
    }
  }

  if (preflightFailure || !previous) {
    return holdWithPage({
      reason: preflightFailure ?? 'steady-state-payload-missing',
      cycleId: fallbackCycleId,
      options,
      attempts,
      upstream,
    });
  }

  const cycleId = cycleIdFor(previous.schedule.scheduleId, previous.schedule.nextDueAtMs);
  if (options.nowMs < previous.schedule.nextDueAtMs) {
    return baseResult({
      status: 'idle',
      failureReason: undefined,
      cycleId,
      upstream,
      attempts,
      paging: noPaging(),
      finalSteadyStateReport: null,
      newCycleEvidence: null,
      newAggregateEvidence: null,
      nextDueAtMs: previous.schedule.nextDueAtMs,
    });
  }

  if (options.nowMs > previous.schedule.nextDueAtMs + previous.schedule.graceMs) {
    return holdWithPage({ reason: 'continuous-assurance-cycle-overdue', cycleId, options, attempts, upstream });
  }
  if (options.nowMs > previous.credentialRotation.nextRotationDueAtMs) {
    return holdWithPage({ reason: 'continuous-assurance-key-rotation-overdue', cycleId, options, attempts, upstream });
  }
  if (options.nowMs > previous.drPolicy.nextExerciseDueAtMs + previous.drPolicy.graceMs) {
    return holdWithPage({ reason: 'continuous-assurance-dr-exercise-overdue', cycleId, options, attempts, upstream });
  }

  const scheduledAtMs = previous.schedule.nextDueAtMs;
  const startedAtMs = options.nowMs;
  const invoke = <T>(
    action: ContinuousAssuranceActionName,
    work: (context: ContinuousAssuranceActionContext) => Promise<T>,
  ) => invokeWithRetry({ action, cycleId, scheduledAtMs, options, policy, attempts, work });

  try {
    const audit = await invoke('provider-audit', (context) => options.executor.collectProviderAudit(context));
    const primaryRetrieval = await invoke('primary-archive-retrieval', (context) => options.executor.retrieveArchive(
      'primary', previous.primaryStorageId, previous.archiveId, previous.archiveContentDigest, context,
    ));
    const backupRetrieval = await invoke('backup-archive-retrieval', (context) => options.executor.retrieveArchive(
      'backup', previous.backupStorageId, previous.archiveId, previous.archiveContentDigest, context,
    ));

    const rotationDue = options.nowMs >= previous.credentialRotation.nextRotationDueAtMs - policy.rotationLeadMs;
    const rotationEvent = rotationDue
      ? await invoke('credential-key-rotation', (context) => options.executor.rotateCredentialKeys({
          currentCredentialSetId: previous.credentialRotation.currentCredentialSetId,
          currentSigningKeyId: previous.credentialRotation.currentSigningKeyId,
          currentEncryptionKeyId: previous.credentialRotation.currentEncryptionKeyId,
          nextRotationDueAtMs: previous.credentialRotation.nextRotationDueAtMs,
        }, context))
      : undefined;

    const drDue = options.nowMs >= previous.drPolicy.nextExerciseDueAtMs - policy.drLeadMs;
    const drExercise = drDue
      ? await invoke('dr-failover-exercise', (context) => options.executor.runDrFailoverExercise(
          previous.drPolicy.requiredBackupSourceStorageId,
          previous.archiveId,
          previous.archiveContentDigest,
          context,
        ))
      : undefined;

    const health = await invoke('operational-health', (context) => options.executor.collectOperationalHealth(context));
    const completedAtMs = Math.max(
      audit.observedAtMs,
      primaryRetrieval.completedAtMs,
      backupRetrieval.completedAtMs,
      health.observedAtMs,
      rotationEvent?.rotatedAtMs ?? 0,
      drExercise?.completedAtMs ?? 0,
    );

    const draft: ContinuousAssuranceCycleDraft = {
      providerName: previous.providerName,
      accountId: previous.accountId,
      primaryStorageId: previous.primaryStorageId,
      backupStorageId: previous.backupStorageId,
      replicaSiteId: previous.replicaSiteId,
      replicaRegion: previous.replicaRegion,
      archiveId: previous.archiveId,
      archiveContentDigest: previous.archiveContentDigest,
      cycleId,
      scheduleId: previous.schedule.scheduleId,
      scheduledAtMs,
      startedAtMs,
      completedAtMs,
      auditStreamId: audit.auditStreamId,
      auditCursorStart: audit.auditCursorStart,
      auditCursorEnd: audit.auditCursorEnd,
      providerAuditRecordIds: audit.providerAuditRecordIds,
      primaryRetrieval,
      backupRetrieval,
      operationCount: health.operationCount,
      failureCount: health.failureCount,
      rtoBreachCount: health.rtoBreachCount,
      rpoBreachCount: health.rpoBreachCount,
      integrityFailureCount: health.integrityFailureCount,
      providerAvailabilityPct: health.providerAvailabilityPct,
      observedCredentialSetId: health.observedCredentialSetId,
      observedSigningKeyId: health.observedSigningKeyId,
      observedEncryptionKeyId: health.observedEncryptionKeyId,
      ...(rotationEvent ? { rotationEvent } : {}),
      ...(drExercise ? { drExercise } : {}),
      alertDispositions: health.alertDispositions,
      incidentReviews: health.incidentReviews,
      rollbackControlId: health.rollbackControlId,
      emergencyHoldControlId: health.emergencyHoldControlId,
      rollbackArmed: health.rollbackArmed,
      emergencyHoldArmed: health.emergencyHoldArmed,
      controlInvocations: health.controlInvocations,
      baselineIncidentIds: previous.baselineIncidentIds,
      recoveryOwnerId: previous.recoveryOwnerId,
      onCallRoute: previous.onCallRoute,
      escalationTarget: previous.escalationTarget,
      retentionPolicySnapshot: previous.retentionPolicySnapshot,
      allowedOrigins: health.allowedOrigins,
      cspConnectSrc: health.cspConnectSrc,
      sandboxFlags: health.sandboxFlags,
      coop: health.coop,
      coep: health.coep,
      networkAttempts: health.networkAttempts,
    };

    const retainedEvidence = await invoke('cycle-evidence-archive', (context) => options.executor.archiveCycleEvidence({
      draft,
      minimumRetentionMs: previous.evidenceRetention.minimumRetentionMs,
      context,
    }));
    const capturedAtMs = completedAtMs + 1_000;
    const cyclePayload: ProviderSteadyStateCyclePayload = { ...draft, retainedEvidence, capturedAtMs };
    const newCycleEvidence = await invoke('cycle-evidence-capture', (context) => options.executor.captureCycleEvidence({
      payload: cyclePayload,
      context,
    }));

    const newCycleValidation = await validateEvidenceEnvelope<ProviderSteadyStateCyclePayload>(
      newCycleEvidence,
      options.evidenceValidationOptions,
    );
    if (newCycleEvidence.runId !== cycleId ||
      newCycleEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND ||
      !evidenceSupportsReadiness(newCycleValidation, 'production-approved') ||
      JSON.stringify(newCycleValidation.envelope?.payload) !== JSON.stringify(cyclePayload) ||
      newCycleValidation.envelope?.artifact?.sha256 !== retainedEvidence.evidenceContentDigest) {
      return holdWithPage({
        reason: 'continuous-assurance-cycle-evidence-not-verified',
        cycleId,
        options,
        attempts,
        upstream,
        newCycleEvidence,
      });
    }

    const allCycleEvidence = [...history, newCycleEvidence];
    const aggregatePayload = buildAggregatePayload(previous, allCycleEvidence, cyclePayload, health.networkAttempts);
    const expectedAggregateRunId = `${cycleId}-aggregate`;
    const newAggregateEvidence = await invoke('aggregate-evidence-capture', (context) => options.executor.captureAggregateEvidence({
      payload: aggregatePayload,
      expectedRunId: expectedAggregateRunId,
      context,
    }));
    const aggregateValidation = await validateEvidenceEnvelope<ProviderSteadyStateOperationsPayload>(
      newAggregateEvidence,
      options.evidenceValidationOptions,
    );
    if (newAggregateEvidence.runId !== expectedAggregateRunId ||
      newAggregateEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND ||
      !evidenceSupportsReadiness(aggregateValidation, 'production-approved') ||
      JSON.stringify(aggregateValidation.envelope?.payload) !== JSON.stringify(aggregatePayload)) {
      return holdWithPage({
        reason: 'continuous-assurance-aggregate-evidence-not-verified',
        cycleId,
        options,
        attempts,
        upstream,
        newCycleEvidence,
        newAggregateEvidence,
      });
    }

    const finalSteadyStateReport = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderSteadyStateOperationsGate({
      postCutoverReconciliationReport: upstream.postCutoverReconciliationEvidence,
      postCutoverReconciliationEvidence: upstream.postCutoverReconciliationEvidence.reconciliationInputEvidence,
      steadyStateCycleEvidence: allCycleEvidence,
      steadyStateOperationsEvidence: newAggregateEvidence,
      evidenceValidationOptions: options.evidenceValidationOptions,
    });
    if (finalSteadyStateReport.status !== 'pass') {
      return holdWithPage({
        reason: finalSteadyStateReport.failureReason ?? 'continuous-assurance-steady-state-gate-hold',
        cycleId,
        options,
        attempts,
        upstream,
        newCycleEvidence,
        newAggregateEvidence,
        finalSteadyStateReport,
      });
    }

    return baseResult({
      status: 'pass',
      failureReason: undefined,
      cycleId,
      upstream,
      attempts,
      paging: noPaging(),
      finalSteadyStateReport,
      newCycleEvidence,
      newAggregateEvidence,
      nextDueAtMs: aggregatePayload.schedule.nextDueAtMs,
    });
  } catch (error) {
    const reason = error instanceof ContinuousAssuranceActionError
      ? `continuous-assurance-action-failed:${error.action}:${error.message}`
      : `continuous-assurance-unexpected-failure:${errorMessage(error)}`;
    return holdWithPage({ reason, cycleId, options, attempts, upstream });
  }
}

function buildAggregatePayload(
  previous: ProviderSteadyStateOperationsPayload,
  cycleEvidence: readonly EvidenceEnvelope<ProviderSteadyStateCyclePayload>[],
  newCycle: ProviderSteadyStateCyclePayload,
  networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[],
): ProviderSteadyStateOperationsPayload {
  const cyclePayloads = cycleEvidence.map((evidence) => evidence.payload);
  const totalOperationCount = cyclePayloads.reduce((sum, cycle) => sum + cycle.operationCount, 0);
  const totalFailureCount = cyclePayloads.reduce((sum, cycle) => sum + cycle.failureCount, 0);
  const rtoBreachCount = cyclePayloads.reduce((sum, cycle) => sum + cycle.rtoBreachCount, 0);
  const rpoBreachCount = cyclePayloads.reduce((sum, cycle) => sum + cycle.rpoBreachCount, 0);
  const integrityFailureCount = cyclePayloads.reduce((sum, cycle) => sum + cycle.integrityFailureCount, 0);
  const providerAvailabilityFloorPct = Math.min(...cyclePayloads.map((cycle) => cycle.providerAvailabilityPct));

  const rotation = newCycle.rotationEvent;
  const credentialRotation = rotation
    ? {
        ...previous.credentialRotation,
        lastRotatedAtMs: rotation.rotatedAtMs,
        nextRotationDueAtMs: rotation.rotatedAtMs + previous.credentialRotation.rotationCadenceMs,
        currentCredentialSetId: rotation.newCredentialSetId,
        currentSigningKeyId: rotation.newSigningKeyId,
        currentEncryptionKeyId: rotation.newEncryptionKeyId,
        rotationEvidenceIds: [...previous.credentialRotation.rotationEvidenceIds, rotation.rotationEvidenceId],
      }
    : previous.credentialRotation;

  const drPolicy = newCycle.drExercise
    ? {
        ...previous.drPolicy,
        lastExerciseAtMs: newCycle.drExercise.completedAtMs,
        nextExerciseDueAtMs: newCycle.drExercise.completedAtMs + previous.drPolicy.drillCadenceMs,
      }
    : previous.drPolicy;

  return {
    ...previous,
    cycleRunIds: cycleEvidence.map((evidence) => evidence.runId),
    schedule: {
      ...previous.schedule,
      lastSuccessfulCycleAtMs: newCycle.completedAtMs,
      nextDueAtMs: newCycle.scheduledAtMs + previous.schedule.cadenceMs,
    },
    rollingSlo: {
      ...previous.rollingSlo,
      totalOperationCount,
      totalFailureCount,
      rtoBreachCount,
      rpoBreachCount,
      integrityFailureCount,
      providerAvailabilityFloorPct,
      remainingFailureBudget: previous.rollingSlo.allowedFailureBudget - totalFailureCount,
    },
    credentialRotation,
    drPolicy,
    networkAttempts,
    capturedAtMs: newCycle.capturedAtMs + 1_000,
  };
}

async function invokeWithRetry<T>(args: {
  readonly action: ContinuousAssuranceActionName;
  readonly cycleId: string;
  readonly scheduledAtMs: number;
  readonly options: ProviderContinuousAssuranceAutomationOptions;
  readonly policy: ContinuousAssuranceAutomationPolicy;
  readonly attempts: ContinuousAssuranceActionAttempt[];
  readonly work: (context: ContinuousAssuranceActionContext) => Promise<T>;
}): Promise<T> {
  const idempotencyKey = `${args.cycleId}:${args.action}`;
  let lastError = 'unknown-error';
  for (let attempt = 1; attempt <= args.policy.retry.maxAttempts; attempt += 1) {
    const backoffMsBeforeAttempt = attempt === 1 ? 0 : args.policy.retry.backoffBaseMs * (2 ** (attempt - 2));
    const context: ContinuousAssuranceActionContext = {
      cycleId: args.cycleId,
      scheduledAtMs: args.scheduledAtMs,
      nowMs: args.options.nowMs,
      action: args.action,
      idempotencyKey,
      attempt,
      backoffMsBeforeAttempt,
    };
    try {
      const result = await args.work(context);
      args.attempts.push({ action: args.action, idempotencyKey, attempt, backoffMsBeforeAttempt, status: 'success' });
      return result;
    } catch (error) {
      lastError = errorMessage(error);
      args.attempts.push({ action: args.action, idempotencyKey, attempt, backoffMsBeforeAttempt, status: 'failure', error: lastError });
    }
  }
  throw new ContinuousAssuranceActionError(args.action, idempotencyKey, lastError);
}

async function holdWithPage(args: {
  readonly reason: string;
  readonly cycleId: string;
  readonly options: ProviderContinuousAssuranceAutomationOptions;
  readonly attempts: ContinuousAssuranceActionAttempt[];
  readonly upstream: ProviderSteadyStateOperationsReport;
  readonly newCycleEvidence?: EvidenceEnvelope<ProviderSteadyStateCyclePayload> | null;
  readonly newAggregateEvidence?: EvidenceEnvelope<ProviderSteadyStateOperationsPayload> | null;
  readonly finalSteadyStateReport?: ProviderSteadyStateOperationsReport | null;
}) {
  const previous = args.options.steadyStateOperationsEvidence.payload;
  const dedupeKey = `${args.cycleId}:page:${args.reason}`;
  let paging: ContinuousAssurancePagingResult;
  try {
    await args.options.executor.pageOperator({
      dedupeKey,
      cycleId: args.cycleId,
      reason: args.reason,
      nowMs: args.options.nowMs,
      onCallRoute: previous.onCallRoute,
      escalationTarget: previous.escalationTarget,
    });
    paging = { attempted: true, succeeded: true, dedupeKey };
  } catch (error) {
    paging = { attempted: true, succeeded: false, dedupeKey, error: errorMessage(error) };
  }
  return baseResult({
    status: 'hold',
    failureReason: args.reason,
    cycleId: args.cycleId,
    upstream: args.upstream,
    attempts: args.attempts,
    paging,
    finalSteadyStateReport: args.finalSteadyStateReport ?? null,
    newCycleEvidence: args.newCycleEvidence ?? null,
    newAggregateEvidence: args.newAggregateEvidence ?? null,
    nextDueAtMs: previous.schedule.nextDueAtMs,
  });
}

function baseResult(args: {
  readonly status: 'idle' | 'pass' | 'hold';
  readonly failureReason: string | undefined;
  readonly cycleId: string;
  readonly upstream: ProviderSteadyStateOperationsReport;
  readonly attempts: readonly ContinuousAssuranceActionAttempt[];
  readonly paging: ContinuousAssurancePagingResult;
  readonly finalSteadyStateReport: ProviderSteadyStateOperationsReport | null;
  readonly newCycleEvidence: EvidenceEnvelope<ProviderSteadyStateCyclePayload> | null;
  readonly newAggregateEvidence: EvidenceEnvelope<ProviderSteadyStateOperationsPayload> | null;
  readonly nextDueAtMs: number;
}) {
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-automation' as const,
    status: args.status,
    cycleId: args.cycleId,
    upstreamSteadyStateEvidence: args.upstream,
    actionAttempts: args.attempts,
    paging: args.paging,
    newCycleEvidence: args.newCycleEvidence,
    newAggregateEvidence: args.newAggregateEvidence,
    finalSteadyStateReport: args.finalSteadyStateReport,
    nextDueAtMs: args.nextDueAtMs,
    promoteHoldThresholds: {
      decision: args.status === 'pass' ? 'promote' as const : args.status === 'idle' ? 'idle' as const : 'hold' as const,
      holdReasons: args.failureReason ? [args.failureReason] : [],
    },
    failureReason: args.failureReason,
    bottlenecksToIssue: args.status === 'pass'
      ? [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_WORKER_RUNTIME_BOTTLENECK]
      : [],
  };
}

function normalizePolicy(
  policy: ProviderContinuousAssuranceAutomationOptions['automationPolicy'],
): ContinuousAssuranceAutomationPolicy {
  return {
    rotationLeadMs: Math.max(0, policy?.rotationLeadMs ?? 60_000),
    drLeadMs: Math.max(0, policy?.drLeadMs ?? 60_000),
    retry: {
      maxAttempts: Math.max(1, Math.floor(policy?.retry?.maxAttempts ?? 2)),
      backoffBaseMs: Math.max(0, policy?.retry?.backoffBaseMs ?? 1_000),
    },
  };
}

function noPaging(): ContinuousAssurancePagingResult {
  return { attempted: false, succeeded: false, dedupeKey: null };
}

function cycleIdFor(scheduleId: string, scheduledAtMs: number): string {
  return `${scheduleId}-${scheduledAtMs}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
