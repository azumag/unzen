import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type ArtifactContent,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
  type IndependentEvidenceVerification,
  type TrustedEvidenceVerifier,
} from './evidence.js';
import {
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation,
  type ContinuousAssuranceActionContext,
  type ContinuousAssuranceArchiveCycleRequest,
  type ContinuousAssuranceCaptureAggregateRequest,
  type ContinuousAssuranceCaptureCycleRequest,
  type ContinuousAssuranceExecutor,
  type ContinuousAssuranceHealthResult,
  type ContinuousAssuranceProviderAuditResult,
  type ProviderContinuousAssuranceAutomationOptions,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-automation.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
  type ProviderSteadyStateCyclePayload,
  type ProviderSteadyStateOperationsPayload,
  type SteadyStateArchiveRetrieval,
  type SteadyStateDrExercise,
  type SteadyStateRetainedEvidence,
  type SteadyStateRotationEvent,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_ENGINE_SERVICE_RUNTIME =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-engine-service' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_CANARY_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-provider-adapter-canary' as const;

export type ContinuousAssuranceAutomationResult = Awaited<ReturnType<
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation
>>;
export type ProviderSteadyStateOperationsReport =
  ProviderContinuousAssuranceAutomationOptions['steadyStateOperationsReport'];

export interface ContinuousAssuranceEngineRuntimeRequest {
  readonly scope: string;
  readonly triggerKey: string;
  readonly cron: string;
  readonly scheduledTimeMs: number;
  readonly deliveryAtMs: number;
  readonly replayCount: number;
}

export interface ContinuousAssuranceEngineSnapshot {
  readonly steadyStateOperationsReport: ProviderSteadyStateOperationsReport;
  readonly steadyStateOperationsEvidence: EvidenceEnvelope<ProviderSteadyStateOperationsPayload>;
  readonly updatedAtMs: number;
}

export type ContinuousAssuranceEngineJournalState = 'running' | 'interrupted' | 'completed';

export interface ContinuousAssuranceEngineJournal {
  readonly triggerKey: string;
  readonly scope: string;
  readonly replayCount: number;
  readonly baseAggregateRunId: string;
  readonly state: ContinuousAssuranceEngineJournalState;
  readonly firstFailure: string | null;
  readonly result: ContinuousAssuranceAutomationResult | null;
  readonly committedAggregateRunId: string | null;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}

export type ContinuousAssuranceEngineClaim =
  | { readonly kind: 'claimed'; readonly journal: ContinuousAssuranceEngineJournal }
  | { readonly kind: 'completed'; readonly result: ContinuousAssuranceAutomationResult }
  | { readonly kind: 'in-progress'; readonly activeTriggerKey: string }
  | { readonly kind: 'scope-busy'; readonly activeTriggerKey: string };

export interface ContinuousAssuranceEngineStateRepository {
  loadSnapshot(scope: string): Promise<ContinuousAssuranceEngineSnapshot | null>;
  claimExecution(input: {
    readonly request: ContinuousAssuranceEngineRuntimeRequest;
    readonly baseAggregateRunId: string;
  }): Promise<ContinuousAssuranceEngineClaim>;
  completePassExecution(input: {
    readonly triggerKey: string;
    readonly scope: string;
    readonly expectedAggregateRunId: string;
    readonly snapshot: ContinuousAssuranceEngineSnapshot;
    readonly result: ContinuousAssuranceAutomationResult;
    readonly completedAtMs: number;
  }): Promise<boolean>;
  completeExecution(input: {
    readonly triggerKey: string;
    readonly result: ContinuousAssuranceAutomationResult;
    readonly committedAggregateRunId: string | null;
    readonly completedAtMs: number;
  }): Promise<void>;
  interruptExecution(input: {
    readonly triggerKey: string;
    readonly failure: string;
    readonly updatedAtMs: number;
  }): Promise<void>;
}

export type ContinuousAssuranceAutomationRunner =
  typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation;

export interface ContinuousAssuranceEngineServiceOptions {
  readonly request: ContinuousAssuranceEngineRuntimeRequest;
  readonly repository: ContinuousAssuranceEngineStateRepository;
  readonly executor: ContinuousAssuranceExecutor;
  readonly evidenceValidationOptions: EvidenceValidationOptions;
  readonly automationPolicy?: ProviderContinuousAssuranceAutomationOptions['automationPolicy'];
  readonly automationRunner?: ContinuousAssuranceAutomationRunner;
}

export class ContinuousAssuranceEngineServiceError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceEngineService(
  options: ContinuousAssuranceEngineServiceOptions,
): Promise<ContinuousAssuranceAutomationResult> {
  validateRuntimeRequest(options.request);
  const snapshot = await options.repository.loadSnapshot(options.request.scope);
  if (!snapshot) {
    throw new ContinuousAssuranceEngineServiceError('engine-state-uninitialized');
  }

  const baseAggregateRunId = snapshot.steadyStateOperationsEvidence.runId;
  const claim = await options.repository.claimExecution({
    request: options.request,
    baseAggregateRunId,
  });
  if (claim.kind === 'completed') return claim.result;
  if (claim.kind === 'in-progress') {
    throw new ContinuousAssuranceEngineServiceError(
      'engine-trigger-in-progress',
      `engine trigger is already active: ${claim.activeTriggerKey}`,
    );
  }
  if (claim.kind === 'scope-busy') {
    throw new ContinuousAssuranceEngineServiceError(
      'engine-scope-busy',
      `engine scope is active on another trigger: ${claim.activeTriggerKey}`,
    );
  }

  const runner = options.automationRunner ??
    runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAutomation;
  try {
    const result = await runner({
      steadyStateOperationsReport: snapshot.steadyStateOperationsReport,
      steadyStateOperationsEvidence: snapshot.steadyStateOperationsEvidence,
      nowMs: options.request.deliveryAtMs,
      executor: options.executor,
      automationPolicy: options.automationPolicy,
      evidenceValidationOptions: options.evidenceValidationOptions,
    });

    if (result.status === 'pass') {
      if (!result.newAggregateEvidence || !result.finalSteadyStateReport) {
        throw new ContinuousAssuranceEngineServiceError('engine-pass-missing-next-snapshot');
      }
      const nextSnapshot: ContinuousAssuranceEngineSnapshot = {
        steadyStateOperationsReport: result.finalSteadyStateReport,
        steadyStateOperationsEvidence: result.newAggregateEvidence,
        updatedAtMs: options.request.deliveryAtMs,
      };
      const committed = await options.repository.completePassExecution({
        triggerKey: options.request.triggerKey,
        scope: options.request.scope,
        expectedAggregateRunId: baseAggregateRunId,
        snapshot: nextSnapshot,
        result,
        completedAtMs: options.request.deliveryAtMs,
      });
      if (!committed) {
        throw new ContinuousAssuranceEngineServiceError('engine-snapshot-cas-conflict');
      }
      return result;
    }

    await options.repository.completeExecution({
      triggerKey: options.request.triggerKey,
      result,
      committedAggregateRunId: null,
      completedAtMs: options.request.deliveryAtMs,
    });
    return result;
  } catch (error) {
    await options.repository.interruptExecution({
      triggerKey: options.request.triggerKey,
      failure: errorMessage(error),
      updatedAtMs: options.request.deliveryAtMs,
    });
    throw error;
  }
}

export interface ContinuousAssuranceBootstrapValidationResult {
  readonly valid: boolean;
  readonly failureReason?: string;
}

export async function validateContinuousAssuranceEngineBootstrapSnapshot(
  snapshot: ContinuousAssuranceEngineSnapshot,
  evidenceValidationOptions: EvidenceValidationOptions,
): Promise<ContinuousAssuranceBootstrapValidationResult> {
  const report = snapshot.steadyStateOperationsReport;
  const evidence = snapshot.steadyStateOperationsEvidence;
  if (report.status !== 'pass') return invalidBootstrap('bootstrap-upstream-not-clean');
  if (evidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND) {
    return invalidBootstrap('bootstrap-evidence-kind-invalid');
  }

  const validation = await validateEvidenceEnvelope<ProviderSteadyStateOperationsPayload>(
    evidence,
    evidenceValidationOptions,
  );
  if (!evidenceSupportsReadiness(validation, 'production-approved')) {
    return invalidBootstrap('bootstrap-evidence-not-production-approved');
  }
  if (evidence.runId !== report.steadyStateEvidenceSummary.runId) {
    return invalidBootstrap('bootstrap-run-mismatch');
  }
  if (JSON.stringify(evidence) !== JSON.stringify(report.steadyStateInputEvidence)) {
    return invalidBootstrap('bootstrap-input-mismatch');
  }

  const payload = validation.envelope?.payload;
  if (!payload) return invalidBootstrap('bootstrap-payload-missing');
  const history = report.cycleInputEvidence ?? [];
  if (!sameSet(payload.cycleRunIds, history.map((item) => item.runId))) {
    return invalidBootstrap('bootstrap-cycle-set-mismatch');
  }

  for (const cycleEvidence of history) {
    if (cycleEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND) {
      return invalidBootstrap(`bootstrap-cycle-kind-invalid:${cycleEvidence.runId}`);
    }
    const cycleValidation = await validateEvidenceEnvelope<ProviderSteadyStateCyclePayload>(
      cycleEvidence,
      evidenceValidationOptions,
    );
    if (!evidenceSupportsReadiness(cycleValidation, 'production-approved')) {
      return invalidBootstrap(`bootstrap-cycle-not-production-approved:${cycleEvidence.runId}`);
    }
  }
  return { valid: true };
}

export interface ContinuousAssuranceServiceBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ContinuousAssuranceEngineAdapterBindings {
  readonly provider: ContinuousAssuranceServiceBinding;
  readonly evidence: ContinuousAssuranceServiceBinding;
  readonly pager: ContinuousAssuranceServiceBinding;
}

export function createContinuousAssuranceServiceBindingExecutor(
  bindings: ContinuousAssuranceEngineAdapterBindings,
): ContinuousAssuranceExecutor {
  return {
    collectProviderAudit: (context) => providerAction<ContinuousAssuranceProviderAuditResult>(
      bindings.provider,
      '/provider/audit',
      { context },
      context,
    ),
    retrieveArchive: (role, storageId, archiveId, expectedDigest, context) =>
      providerAction<SteadyStateArchiveRetrieval>(
        bindings.provider,
        '/provider/archive/retrieve',
        { role, storageId, archiveId, expectedDigest, context },
        context,
      ),
    collectOperationalHealth: (context) => providerAction<ContinuousAssuranceHealthResult>(
      bindings.provider,
      '/provider/health',
      { context },
      context,
    ),
    rotateCredentialKeys: (current, context) => providerAction<SteadyStateRotationEvent>(
      bindings.provider,
      '/provider/keys/rotate',
      { current, context },
      context,
    ),
    runDrFailoverExercise: (backupStorageId, archiveId, expectedDigest, context) =>
      providerAction<SteadyStateDrExercise>(
        bindings.provider,
        '/provider/dr/exercise',
        { backupStorageId, archiveId, expectedDigest, context },
        context,
      ),
    archiveCycleEvidence: (request) => evidenceAction<SteadyStateRetainedEvidence>(
      bindings.evidence,
      '/evidence/cycle/archive',
      request,
      request.context,
    ),
    captureCycleEvidence: (request) => evidenceAction<EvidenceEnvelope<ProviderSteadyStateCyclePayload>>(
      bindings.evidence,
      '/evidence/cycle/capture',
      request,
      request.context,
    ),
    captureAggregateEvidence: (request) => evidenceAction<EvidenceEnvelope<ProviderSteadyStateOperationsPayload>>(
      bindings.evidence,
      '/evidence/aggregate/capture',
      request,
      request.context,
    ),
    pageOperator: async (request) => {
      await postJson(bindings.pager, 'pager', '/page', request, request.dedupeKey);
    },
  };
}

export interface ContinuousAssuranceEvidenceValidationBindingOptions {
  readonly binding: ContinuousAssuranceServiceBinding;
  readonly trustedVerifiers: readonly TrustedEvidenceVerifier[];
  readonly now?: Date | string | number;
}

export function createContinuousAssuranceEvidenceValidationOptions(
  options: ContinuousAssuranceEvidenceValidationBindingOptions,
): EvidenceValidationOptions {
  return {
    now: options.now,
    trustedVerifiers: options.trustedVerifiers,
    loadArtifact: async (locator) => {
      const response = await postJson<ArtifactLoadResponse>(
        options.binding,
        'evidence',
        '/evidence/artifact/load',
        { locator },
      );
      if (response.kind === 'utf8' && typeof response.content === 'string') return response.content;
      if (response.kind === 'bytes' && Array.isArray(response.bytes)) return new Uint8Array(response.bytes);
      throw new Error('evidence-adapter-invalid-artifact-load-response');
    },
    verifyArtifact: async (context) => postJson<IndependentEvidenceVerification>(
      options.binding,
      'evidence',
      '/evidence/artifact/verify',
      {
        envelope: context.envelope,
        actualSha256: context.actualSha256,
        artifactContent: artifactContentTransport(context.artifactContent),
      },
    ),
  };
}

interface ArtifactLoadResponse {
  readonly kind: 'utf8' | 'bytes';
  readonly content?: string;
  readonly bytes?: readonly number[];
}

async function providerAction<T>(
  binding: ContinuousAssuranceServiceBinding,
  path: string,
  body: unknown,
  context: ContinuousAssuranceActionContext,
): Promise<T> {
  return postJson<T>(binding, 'provider', path, body, context.idempotencyKey);
}

async function evidenceAction<T>(
  binding: ContinuousAssuranceServiceBinding,
  path: string,
  body: ContinuousAssuranceArchiveCycleRequest | ContinuousAssuranceCaptureCycleRequest | ContinuousAssuranceCaptureAggregateRequest,
  context: ContinuousAssuranceActionContext,
): Promise<T> {
  return postJson<T>(binding, 'evidence', path, body, context.idempotencyKey);
}

async function postJson<T>(
  binding: ContinuousAssuranceServiceBinding,
  label: string,
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (idempotencyKey) headers.set('x-unzen-idempotency-key', idempotencyKey);
  const response = await binding.fetch(new Request(`https://${label}-adapter.internal${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }));
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload.error === 'string') detail = `:${payload.error}`;
    } catch {
      // Preserve the HTTP status as the primary adapter error when no JSON body is available.
    }
    throw new Error(`${label}-adapter-http-${response.status}${detail}`);
  }
  return await response.json() as T;
}

function artifactContentTransport(content: ArtifactContent): unknown {
  if (typeof content === 'string') return { kind: 'utf8', content };
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return { kind: 'bytes', bytes: Array.from(bytes) };
}

function validateRuntimeRequest(request: ContinuousAssuranceEngineRuntimeRequest): void {
  const expectedTriggerKey = `${request.scope}:${request.cron}:${request.scheduledTimeMs}`;
  if (!request.scope || !request.cron || request.triggerKey !== expectedTriggerKey) {
    throw new ContinuousAssuranceEngineServiceError('engine-trigger-identity-invalid');
  }
  if (!Number.isFinite(request.scheduledTimeMs) || !Number.isFinite(request.deliveryAtMs) ||
    request.deliveryAtMs < request.scheduledTimeMs || !Number.isInteger(request.replayCount) || request.replayCount < 0) {
    throw new ContinuousAssuranceEngineServiceError('engine-trigger-timeline-invalid');
  }
}

function invalidBootstrap(failureReason: string): ContinuousAssuranceBootstrapValidationResult {
  return { valid: false, failureReason };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
