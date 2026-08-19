import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import {
  createContinuousAssuranceServiceBindingExecutor,
  type ContinuousAssuranceEngineAdapterBindings,
  type ContinuousAssuranceServiceBinding,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-engine-service.js';
import type {
  ContinuousAssuranceActionContext,
  ContinuousAssuranceHealthResult,
  ContinuousAssuranceProviderAuditResult,
  ContinuousAssurancePageRequest,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.js';
import type {
  SteadyStateArchiveRetrieval,
  SteadyStateDrExercise,
  SteadyStateRotationEvent,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';
import type { ProductionProviderCanaryPayload } from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionOperationsRolloutGate,
  type ProductionOperationsOperationalObligations,
  type ProductionOperationsRolloutAction,
  type ProductionOperationsRolloutAuthorization,
  type ProductionOperationsRolloutGateOptions,
  type ProductionOperationsRolloutPhase,
  type ProductionOperationsRolloutPhasePayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.js';

const PHASES = ['observe-only', 'maintenance-enabled', 'dr-exercise-enabled', 'steady-state-enabled'] as const;
const BASE_ACTIONS: readonly ProductionOperationsRolloutAction[] = [
  'provider-health',
  'provider-audit',
  'primary-archive-retrieval',
  'backup-archive-retrieval',
  'pager-canary',
];

export interface ProductionRolloutPagerResult {
  readonly status: 'accepted' | 'deduplicated';
  readonly deliveryId?: string;
}

export interface ProductionOperationsRolloutExecutor {
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
    current: {
      readonly currentCredentialSetId: string;
      readonly currentSigningKeyId: string;
      readonly currentEncryptionKeyId: string;
      readonly nextRotationDueAtMs: number;
    },
    context: ContinuousAssuranceActionContext,
  ): Promise<SteadyStateRotationEvent>;
  runDrFailoverExercise(
    backupStorageId: string,
    archiveId: string,
    expectedDigest: string,
    context: ContinuousAssuranceActionContext,
  ): Promise<SteadyStateDrExercise>;
  pageCanary(request: ContinuousAssurancePageRequest): Promise<ProductionRolloutPagerResult>;
}

export interface ProductionOperationsRolloutActionReceipt {
  readonly action: ProductionOperationsRolloutAction;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly observedAtMs: number;
  readonly status: 'success' | 'deduplicated';
  readonly storageId?: string;
  readonly observedContentDigest?: string;
}

export interface ProductionOperationsRolloutCaptureRequest {
  readonly payload: ProductionOperationsRolloutPhasePayload;
  readonly authorization: ProductionOperationsRolloutAuthorization;
  readonly actionReceipts: readonly ProductionOperationsRolloutActionReceipt[];
  readonly expectedRunId: string;
}

export interface ProductionOperationsRolloutPhaseCapture {
  capturePhaseEvidence(
    request: ProductionOperationsRolloutCaptureRequest,
  ): Promise<EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>>;
}

export interface ProductionOperationsRolloutExecutionOptions
  extends Omit<ProductionOperationsRolloutGateOptions, 'phaseEvidences'> {
  readonly phase: ProductionOperationsRolloutPhase;
  readonly previousPhaseEvidences: readonly EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>[];
  readonly phaseStartedAtMs: number;
  readonly nowMs: number;
  readonly replayCount: number;
  readonly executor: ProductionOperationsRolloutExecutor;
  readonly capture: ProductionOperationsRolloutPhaseCapture;
  readonly phaseEvidenceValidationOptions: EvidenceValidationOptions;
  readonly steadyStateObligations?: ProductionOperationsOperationalObligations;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
}

export async function runProductionOperationsRolloutPhase(
  options: ProductionOperationsRolloutExecutionOptions,
) {
  const expectedIndex = options.previousPhaseEvidences.length;
  const expectedPhase = PHASES[expectedIndex];
  if (!expectedPhase || options.phase !== expectedPhase) {
    throw new Error(`production-rollout-phase-sequence-invalid:${options.phase}`);
  }
  if (!Number.isInteger(options.replayCount) || options.replayCount < 0) {
    throw new Error('production-rollout-replay-count-invalid');
  }

  await validatePrefix(options);

  const plan = options.rolloutAuthorization.phasePlan[expectedIndex];
  if (!plan || plan.phase !== options.phase || plan.sequence !== expectedIndex + 1) {
    throw new Error(`production-rollout-phase-plan-invalid:${options.phase}`);
  }
  if (!Number.isFinite(options.phaseStartedAtMs) || !Number.isFinite(options.nowMs) ||
    options.phaseStartedAtMs < plan.startsAtMs || options.nowMs > plan.expiresAtMs ||
    options.nowMs < options.phaseStartedAtMs || options.nowMs - options.phaseStartedAtMs < plan.minimumObservationMs) {
    throw new Error(`production-rollout-phase-window-invalid:${options.phase}`);
  }

  const runId = `${options.rolloutAuthorization.rolloutId}:${expectedIndex + 1}:${options.phase}`;
  const actions: ProductionOperationsRolloutAction[] = [...BASE_ACTIONS];
  if (options.phase === 'maintenance-enabled' && options.rolloutAuthorization.maintenance.required) {
    actions.push('credential-key-rotation');
  }
  if (options.phase === 'dr-exercise-enabled') actions.push('dr-failover-exercise');
  if (actions.length > plan.maximumActions) {
    throw new Error(`production-rollout-action-budget-exceeded:${options.phase}`);
  }

  const receipts: ProductionOperationsRolloutActionReceipt[] = [];
  const idempotency = new Map<ProductionOperationsRolloutAction, string>();
  for (const action of actions) idempotency.set(action, `${runId}:${action}`);

  const healthContext = actionContext(runId, 'operational-health', idempotency.get('provider-health')!, options);
  const health = await options.executor.collectOperationalHealth(healthContext);
  validateHealthControlBoundary(health, options.rolloutAuthorization);
  receipts.push(receipt('provider-health', healthContext.idempotencyKey, operationId(health, 'providerHealthOperationId'), options.nowMs));

  const auditContext = actionContext(runId, 'provider-audit', idempotency.get('provider-audit')!, options);
  const audit = await options.executor.collectProviderAudit(auditContext);
  if (!audit.auditStreamId || !audit.auditCursorStart || !audit.auditCursorEnd || audit.auditCursorStart === audit.auditCursorEnd) {
    throw new Error('production-rollout-provider-audit-invalid');
  }
  receipts.push(receipt('provider-audit', auditContext.idempotencyKey, audit.auditStreamId, audit.observedAtMs));

  const primaryContext = actionContext(runId, 'primary-archive-retrieval', idempotency.get('primary-archive-retrieval')!, options);
  const primary = await options.executor.retrieveArchive(
    'primary',
    options.rolloutAuthorization.primaryStorageId,
    options.rolloutAuthorization.archiveId,
    options.rolloutAuthorization.archiveContentDigest,
    primaryContext,
  );
  validateRetrieval(primary, options.rolloutAuthorization.primaryStorageId, options.rolloutAuthorization);
  receipts.push(retrievalReceipt('primary-archive-retrieval', primaryContext.idempotencyKey, primary));

  const backupContext = actionContext(runId, 'backup-archive-retrieval', idempotency.get('backup-archive-retrieval')!, options);
  const backup = await options.executor.retrieveArchive(
    'backup',
    options.rolloutAuthorization.backupStorageId,
    options.rolloutAuthorization.archiveId,
    options.rolloutAuthorization.archiveContentDigest,
    backupContext,
  );
  validateRetrieval(backup, options.rolloutAuthorization.backupStorageId, options.rolloutAuthorization);
  receipts.push(retrievalReceipt('backup-archive-retrieval', backupContext.idempotencyKey, backup));

  const pagerKey = idempotency.get('pager-canary')!;
  const pageRequest: ContinuousAssurancePageRequest = {
    dedupeKey: pagerKey,
    cycleId: runId,
    reason: `production rollout ${options.phase}`,
    nowMs: options.nowMs,
    onCallRoute: options.onCallRoute,
    escalationTarget: options.escalationTarget,
  };
  const firstPage = await options.executor.pageCanary(pageRequest);
  if (firstPage.status !== 'accepted' || !firstPage.deliveryId) {
    throw new Error('production-rollout-pager-first-delivery-invalid');
  }
  const duplicatePage = await options.executor.pageCanary(pageRequest);
  if (duplicatePage.status !== 'deduplicated') {
    throw new Error('production-rollout-pager-duplicate-not-suppressed');
  }
  receipts.push({
    action: 'pager-canary',
    idempotencyKey: pagerKey,
    operationId: firstPage.deliveryId,
    observedAtMs: options.nowMs,
    status: 'deduplicated',
  });

  let rotationTransition: ProductionOperationsRolloutPhasePayload['rotationTransition'];
  if (options.phase === 'maintenance-enabled' && options.rolloutAuthorization.maintenance.required) {
    const maintenance = options.rolloutAuthorization.maintenance;
    const rotationContext = actionContext(runId, 'credential-key-rotation', idempotency.get('credential-key-rotation')!, options);
    const rotation = await options.executor.rotateCredentialKeys({
      currentCredentialSetId: required(maintenance.previousCredentialSetId, 'production-rollout-previous-credential-id-missing'),
      currentSigningKeyId: required(maintenance.previousSigningKeyId, 'production-rollout-previous-signing-key-id-missing'),
      currentEncryptionKeyId: required(maintenance.previousEncryptionKeyId, 'production-rollout-previous-encryption-key-id-missing'),
      nextRotationDueAtMs: requiredNumber(maintenance.rotationDueAtMs, 'production-rollout-rotation-due-missing'),
    }, rotationContext);
    rotationTransition = {
      authorizationId: required(maintenance.authorizationId, 'production-rollout-rotation-authorization-missing'),
      rotatedAtMs: rotation.rotatedAtMs,
      previousCredentialSetId: rotation.previousCredentialSetId,
      previousSigningKeyId: rotation.previousSigningKeyId,
      previousEncryptionKeyId: rotation.previousEncryptionKeyId,
      newCredentialSetId: rotation.newCredentialSetId,
      newSigningKeyId: rotation.newSigningKeyId,
      newEncryptionKeyId: rotation.newEncryptionKeyId,
    };
    receipts.push(receipt('credential-key-rotation', rotationContext.idempotencyKey, rotation.rotationEvidenceId, rotation.rotatedAtMs));
  }

  let drExercise: ProductionOperationsRolloutPhasePayload['drExercise'];
  if (options.phase === 'dr-exercise-enabled') {
    const drContext = actionContext(runId, 'dr-failover-exercise', idempotency.get('dr-failover-exercise')!, options);
    const exercise = await options.executor.runDrFailoverExercise(
      options.rolloutAuthorization.backupStorageId,
      options.rolloutAuthorization.archiveId,
      options.rolloutAuthorization.archiveContentDigest,
      drContext,
    );
    if (exercise.sourceStorageId !== options.rolloutAuthorization.backupStorageId ||
      exercise.observedContentDigest !== options.rolloutAuthorization.archiveContentDigest ||
      exercise.integrityStatus !== 'pass') {
      throw new Error('production-rollout-dr-exercise-integrity-invalid');
    }
    drExercise = {
      authorizationId: options.rolloutAuthorization.drExercise.authorizationId,
      exerciseId: exercise.exerciseId,
      sourceStorageId: exercise.sourceStorageId,
      startedAtMs: exercise.startedAtMs,
      completedAtMs: exercise.completedAtMs,
      observedContentDigest: exercise.observedContentDigest,
      integrityStatus: exercise.integrityStatus,
    };
    receipts.push(receipt('dr-failover-exercise', drContext.idempotencyKey, exercise.exerciseId, exercise.completedAtMs));
  }

  if (options.phase !== 'steady-state-enabled' && options.steadyStateObligations) {
    throw new Error(`production-rollout-premature-obligations:${options.phase}`);
  }
  if (options.phase === 'steady-state-enabled' && !options.steadyStateObligations) {
    throw new Error('production-rollout-steady-state-obligations-required');
  }

  const payload: ProductionOperationsRolloutPhasePayload = {
    rolloutId: options.rolloutAuthorization.rolloutId,
    authorizationId: options.rolloutAuthorization.authorizationId,
    phase: options.phase,
    sequence: expectedIndex + 1,
    providerCanaryRunId: options.providerCanaryEvidence.runId,
    providerCanaryArtifactSha256: required(options.providerCanaryEvidence.artifact?.sha256, 'production-rollout-provider-canary-artifact-missing'),
    startedAtMs: options.phaseStartedAtMs,
    completedAtMs: options.nowMs,
    actionBudget: plan.maximumActions,
    observedActionCount: actions.length,
    replayCount: options.replayCount,
    executedActions: actions,
    actionIdempotencyKeys: actions.map((action) => idempotency.get(action)!),
    identity: {
      providerName: options.rolloutAuthorization.providerName,
      accountId: options.rolloutAuthorization.accountId,
      primaryStorageId: options.rolloutAuthorization.primaryStorageId,
      backupStorageId: options.rolloutAuthorization.backupStorageId,
      archiveId: options.rolloutAuthorization.archiveId,
      archiveContentDigest: options.rolloutAuthorization.archiveContentDigest,
      deploymentVersionIds: options.rolloutAuthorization.deploymentVersionIds,
      deploymentConfigFingerprints: options.rolloutAuthorization.deploymentConfigFingerprints,
    },
    slo: {
      operationCount: health.operationCount,
      failureCount: health.failureCount,
      rtoBreachCount: health.rtoBreachCount,
      rpoBreachCount: health.rpoBreachCount,
      integrityFailureCount: health.integrityFailureCount,
      providerAvailabilityPct: health.providerAvailabilityPct,
      minimumProviderAvailabilityPct: 99,
      allowedFailureBudget: Math.max(1, health.failureCount + 1),
      remainingFailureBudget: 1,
    },
    alerts: health.alertDispositions.map(({ alertId, severity, status }) => ({ alertId, severity, status })),
    incidents: health.incidentReviews.map(({ incidentId, severity, status }) => ({ incidentId, severity, status })),
    controlInvocations: health.controlInvocations.map(({ invocationId, controlId, status }) => ({ invocationId, controlId, status })),
    ...(rotationTransition ? { rotationTransition } : {}),
    ...(drExercise ? { drExercise } : {}),
    ...(options.steadyStateObligations ? { operationalObligations: options.steadyStateObligations } : {}),
    capturedAtMs: options.nowMs,
  };

  const envelope = await options.capture.capturePhaseEvidence({
    payload,
    authorization: options.rolloutAuthorization,
    actionReceipts: receipts,
    expectedRunId: runId,
  });
  const captured = await validateEvidenceEnvelope<ProductionOperationsRolloutPhasePayload>(
    envelope,
    options.phaseEvidenceValidationOptions,
  );
  if (envelope.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND ||
    envelope.runId !== runId || !evidenceSupportsReadiness(captured, 'production-approved')) {
    throw new Error(`production-rollout-captured-phase-invalid:${options.phase}`);
  }

  const phaseEvidences = [...options.previousPhaseEvidences, envelope];
  if (options.phase === 'steady-state-enabled') {
    const terminal = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionOperationsRolloutGate({
      ...gateOptions(options),
      phaseEvidences,
    });
    if (terminal.status !== 'pass' || terminal.decision !== 'steady-state-enabled' || terminal.bottlenecksToIssue.length !== 0) {
      throw new Error(`production-rollout-terminal-hold:${terminal.failureReason ?? 'unknown'}`);
    }
    return { status: 'steady-state-enabled' as const, phaseEvidence: envelope, terminal };
  }

  return {
    status: 'phase-completed' as const,
    phase: options.phase,
    nextPhase: PHASES[expectedIndex + 1],
    phaseEvidence: envelope,
  };
}

export function createProductionOperationsRolloutServiceBindingExecutor(
  bindings: ContinuousAssuranceEngineAdapterBindings,
): ProductionOperationsRolloutExecutor {
  const base = createContinuousAssuranceServiceBindingExecutor(bindings);
  return {
    collectProviderAudit: base.collectProviderAudit,
    retrieveArchive: base.retrieveArchive,
    collectOperationalHealth: base.collectOperationalHealth,
    rotateCredentialKeys: base.rotateCredentialKeys,
    runDrFailoverExercise: base.runDrFailoverExercise,
    pageCanary: (request) => callPager(bindings.pager, request),
  };
}

async function validatePrefix(options: ProductionOperationsRolloutExecutionOptions): Promise<void> {
  const report = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionOperationsRolloutGate({
    ...gateOptions(options),
    phaseEvidences: options.previousPhaseEvidences,
  });
  const allowed = new Set<string>(['production-operations-rollout-phase-count-invalid']);
  for (let index = options.previousPhaseEvidences.length; index < PHASES.length; index += 1) {
    allowed.add(`production-operations-rollout-phase-missing:${PHASES[index]}`);
  }
  const unexpected = report.promoteHoldThresholds.holdReasons.filter((reason) => !allowed.has(reason));
  if (unexpected.length > 0) throw new Error(`production-rollout-prefix-invalid:${unexpected[0]}`);
}

function gateOptions(options: ProductionOperationsRolloutExecutionOptions): Omit<ProductionOperationsRolloutGateOptions, 'phaseEvidences'> {
  return {
    providerCanaryEvidence: options.providerCanaryEvidence,
    rolloutAuthorization: options.rolloutAuthorization,
    evidenceValidationOptions: options.evidenceValidationOptions,
    deploymentEvidenceValidationOptions: options.deploymentEvidenceValidationOptions,
    phaseEvidenceValidationOptions: options.phaseEvidenceValidationOptions,
    expectedDeployCommitSha: options.expectedDeployCommitSha,
    expectedDeploymentManifestSha256: options.expectedDeploymentManifestSha256,
    expectedConfigFingerprints: options.expectedConfigFingerprints,
    expectedVerifierName: options.expectedVerifierName,
    expectedDeploymentVerifierName: options.expectedDeploymentVerifierName,
    expectedPhaseVerifierName: options.expectedPhaseVerifierName,
  };
}

function actionContext(
  runId: string,
  action: ContinuousAssuranceActionContext['action'],
  idempotencyKey: string,
  options: ProductionOperationsRolloutExecutionOptions,
): ContinuousAssuranceActionContext {
  return {
    cycleId: runId,
    scheduledAtMs: options.phaseStartedAtMs,
    nowMs: options.nowMs,
    action,
    idempotencyKey,
    attempt: options.replayCount + 1,
    backoffMsBeforeAttempt: 0,
  };
}

function validateHealthControlBoundary(
  health: ContinuousAssuranceHealthResult,
  authorization: ProductionOperationsRolloutAuthorization,
): void {
  if (health.rollbackControlId !== authorization.rollbackControlId ||
    health.emergencyHoldControlId !== authorization.emergencyHoldControlId ||
    !health.rollbackArmed || !health.emergencyHoldArmed) {
    throw new Error('production-rollout-control-boundary-invalid');
  }
}

function validateRetrieval(
  value: SteadyStateArchiveRetrieval,
  expectedStorage: string,
  auth: ProductionOperationsRolloutAuthorization,
): void {
  if (value.storageId !== expectedStorage || value.archiveId !== auth.archiveId ||
    value.observedContentDigest !== auth.archiveContentDigest || value.integrityStatus !== 'pass') {
    throw new Error('production-rollout-archive-integrity-invalid');
  }
}

function receipt(
  action: ProductionOperationsRolloutAction,
  idempotencyKey: string,
  operationIdValue: string,
  observedAtMs: number,
): ProductionOperationsRolloutActionReceipt {
  if (!operationIdValue) throw new Error(`production-rollout-operation-id-missing:${action}`);
  return { action, idempotencyKey, operationId: operationIdValue, observedAtMs, status: 'success' };
}

function retrievalReceipt(
  action: 'primary-archive-retrieval' | 'backup-archive-retrieval',
  idempotencyKey: string,
  value: SteadyStateArchiveRetrieval,
): ProductionOperationsRolloutActionReceipt {
  return {
    action,
    idempotencyKey,
    operationId: value.retrievalOperationId,
    observedAtMs: value.completedAtMs,
    status: 'success',
    storageId: value.storageId,
    observedContentDigest: value.observedContentDigest,
  };
}

function operationId(value: object, field: string): string {
  const candidate = (value as Record<string, unknown>)[field];
  if (typeof candidate !== 'string' || !candidate) throw new Error(`production-rollout-operation-id-missing:${field}`);
  return candidate;
}

async function callPager(
  binding: ContinuousAssuranceServiceBinding,
  body: ContinuousAssurancePageRequest,
): Promise<ProductionRolloutPagerResult> {
  const response = await binding.fetch(new Request('https://pager-adapter.internal/page', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-unzen-idempotency-key': body.dedupeKey,
    },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-rollout-pager-http-${response.status}`);
  const payload = await response.json() as { status?: unknown; deliveryId?: unknown };
  if (payload.status !== 'accepted' && payload.status !== 'deduplicated') {
    throw new Error('production-rollout-pager-response-invalid');
  }
  return {
    status: payload.status,
    ...(typeof payload.deliveryId === 'string' ? { deliveryId: payload.deliveryId } : {}),
  };
}

function required(value: string | null | undefined, error: string): string {
  if (!value) throw new Error(error);
  return value;
}
function requiredNumber(value: number | null | undefined, error: string): number {
  if (!Number.isFinite(value)) throw new Error(error);
  return value as number;
}
