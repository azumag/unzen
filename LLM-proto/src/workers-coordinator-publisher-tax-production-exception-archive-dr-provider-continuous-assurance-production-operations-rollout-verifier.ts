import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
  type ProductionOperationsRolloutAuthorization,
  type ProductionOperationsRolloutPhase,
  type ProductionOperationsRolloutPhasePayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.js';
import type { ProductionOperationsRolloutActionReceipt } from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-runner.js';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PHASES: readonly ProductionOperationsRolloutPhase[] = [
  'observe-only',
  'maintenance-enabled',
  'dr-exercise-enabled',
  'steady-state-enabled',
];

export interface ProductionOperationsRolloutVerifierOptions {
  readonly verifierName: string;
  readonly verifierVersion: string;
}

export async function handleProductionOperationsRolloutVerifierRequest(
  request: Request,
  options: ProductionOperationsRolloutVerifierOptions,
): Promise<Response> {
  try {
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    const path = new URL(request.url).pathname;
    const body = await readJson(request);
    if (path === '/verify/capture') {
      const result = verifyCapture(body, options);
      return Response.json(result, { status: result.result === 'pass' ? 200 : 409 });
    }
    if (path === '/verify/artifact') {
      const result = await verifyArtifact(body, options);
      return Response.json(result, { status: result.result === 'pass' ? 200 : 409 });
    }
    return Response.json({ error: 'rollout-verifier-not-found' }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function verifyCapture(input: unknown, options: ProductionOperationsRolloutVerifierOptions) {
  if (!record(input) ||
    input.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND ||
    input.requestedReadinessStatus !== 'production-approved' ||
    !SHA256.test(text(input.artifactSha256)) || !record(input.payload) || !record(input.authorization) ||
    !Array.isArray(input.actionReceipts)) {
    return fail(options, 'production-rollout-capture-request-invalid');
  }
  const runId = text(input.runId);
  const reason = validateRecord(
    input.payload as unknown as ProductionOperationsRolloutPhasePayload,
    input.authorization as unknown as ProductionOperationsRolloutAuthorization,
    input.actionReceipts as unknown as ProductionOperationsRolloutActionReceipt[],
    runId,
  );
  if (reason) return fail(options, reason, runId);
  return pass(options, runId, number(input.payload.completedAtMs));
}

async function verifyArtifact(input: unknown, options: ProductionOperationsRolloutVerifierOptions) {
  if (!record(input) || !record(input.envelope) || !record(input.envelope.artifact) || !record(input.envelope.payload)) {
    return fail(options, 'production-rollout-artifact-request-invalid');
  }
  const envelope = input.envelope as Record<string, unknown>;
  const envelopeArtifact = envelope.artifact as Record<string, unknown>;
  const envelopePayload = envelope.payload as Record<string, unknown>;
  if (envelope.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND ||
    envelope.readinessStatus !== 'production-approved') {
    return fail(options, 'production-rollout-artifact-envelope-invalid');
  }
  const actualSha256 = text(input.actualSha256);
  const expectedSha256 = text(envelopeArtifact.sha256);
  if (!SHA256.test(actualSha256) || actualSha256 !== expectedSha256) {
    return fail(options, 'production-rollout-artifact-digest-invalid');
  }
  const bytes = artifactBytes(input.artifactContent);
  if (await sha256(bytes) !== expectedSha256) return fail(options, 'production-rollout-artifact-digest-mismatch');
  let artifact: unknown;
  try { artifact = JSON.parse(new TextDecoder().decode(bytes)); } catch { return fail(options, 'production-rollout-artifact-json-invalid'); }
  if (!record(artifact) || artifact.schema !== 'unzen-continuous-assurance-production-rollout-phase-v1' ||
    !record(artifact.payload) || !record(artifact.authorization) || !Array.isArray(artifact.actionReceipts)) {
    return fail(options, 'production-rollout-artifact-schema-invalid');
  }
  const runId = text(envelope.runId);
  if (stable(artifact.payload) !== stable(envelopePayload) || artifact.runId !== runId) {
    return fail(options, 'production-rollout-artifact-envelope-binding-mismatch', runId);
  }
  const reason = validateRecord(
    artifact.payload as unknown as ProductionOperationsRolloutPhasePayload,
    artifact.authorization as unknown as ProductionOperationsRolloutAuthorization,
    artifact.actionReceipts as unknown as ProductionOperationsRolloutActionReceipt[],
    runId,
  );
  if (reason) return fail(options, reason, runId);
  const completedAtMs = number(envelopePayload.completedAtMs);
  const expectedVerifiedAt = new Date(completedAtMs + 1_000).toISOString();
  if (!record(envelope.verification) || envelope.verification.verifier !== options.verifierName ||
    envelope.verification.version !== options.verifierVersion || envelope.verification.result !== 'pass' ||
    envelope.verification.verifiedAt !== expectedVerifiedAt) {
    return fail(options, 'production-rollout-artifact-attestation-mismatch', runId);
  }
  return pass(options, runId, completedAtMs);
}

function validateRecord(
  payload: ProductionOperationsRolloutPhasePayload,
  authorization: ProductionOperationsRolloutAuthorization,
  receipts: readonly ProductionOperationsRolloutActionReceipt[],
  runId: string,
): string | undefined {
  const expectedIndex = PHASES.indexOf(payload.phase);
  if (expectedIndex < 0 || payload.sequence !== expectedIndex + 1 ||
    runId !== `${payload.rolloutId}:${payload.sequence}:${payload.phase}`) {
    return 'production-rollout-run-identity-invalid';
  }
  if (!payload.rolloutId || !authorization.rolloutId || payload.rolloutId !== authorization.rolloutId ||
    payload.authorizationId !== authorization.authorizationId || !authorization.changeTicketId ||
    new Set(authorization.approvers.filter(Boolean)).size < 2) {
    return 'production-rollout-authorization-binding-invalid';
  }
  if (payload.completedAtMs < payload.startedAtMs || payload.capturedAtMs !== payload.completedAtMs ||
    payload.observedActionCount !== payload.executedActions.length ||
    payload.actionIdempotencyKeys.length !== payload.executedActions.length ||
    new Set(payload.actionIdempotencyKeys).size !== payload.actionIdempotencyKeys.length ||
    receipts.length !== payload.executedActions.length) {
    return 'production-rollout-action-record-invalid';
  }
  for (let index = 0; index < payload.executedActions.length; index += 1) {
    const action = payload.executedActions[index];
    const key = payload.actionIdempotencyKeys[index];
    const receipt = receipts.find((item) => item.action === action);
    if (!receipt || receipt.idempotencyKey !== key || !receipt.operationId || receipt.status === undefined) {
      return `production-rollout-action-receipt-invalid:${action}`;
    }
  }
  const identity = payload.identity;
  if (identity.providerName !== authorization.providerName || identity.accountId !== authorization.accountId ||
    identity.primaryStorageId !== authorization.primaryStorageId || identity.backupStorageId !== authorization.backupStorageId ||
    identity.archiveId !== authorization.archiveId || identity.archiveContentDigest !== authorization.archiveContentDigest ||
    !SHA256.test(identity.archiveContentDigest) ||
    stable(identity.deploymentVersionIds) !== stable(authorization.deploymentVersionIds) ||
    stable(identity.deploymentConfigFingerprints) !== stable(authorization.deploymentConfigFingerprints)) {
    return 'production-rollout-identity-binding-invalid';
  }
  const slo = payload.slo;
  if (slo.operationCount <= 0 || slo.failureCount < 0 || slo.failureCount > slo.operationCount ||
    slo.rtoBreachCount !== 0 || slo.rpoBreachCount !== 0 || slo.integrityFailureCount !== 0 ||
    slo.providerAvailabilityPct < slo.minimumProviderAvailabilityPct || slo.remainingFailureBudget <= 0 ||
    slo.remainingFailureBudget !== slo.allowedFailureBudget - slo.failureCount) {
    return 'production-rollout-slo-invalid';
  }
  if (payload.alerts.some((item) => item.severity === 'critical' && item.status !== 'resolved') ||
    payload.incidents.some((item) => (item.severity === 'sev1' || item.severity === 'sev2') && item.status === 'active') ||
    payload.controlInvocations.some((item) => item.status === 'active')) {
    return 'production-rollout-operational-hold';
  }
  if (payload.phase === 'observe-only' && (payload.rotationTransition || payload.drExercise)) {
    return 'production-rollout-observe-only-side-effect-invalid';
  }
  if (payload.phase === 'maintenance-enabled' && authorization.maintenance.required) {
    if (!payload.rotationTransition || payload.rotationTransition.authorizationId !== authorization.maintenance.authorizationId) {
      return 'production-rollout-maintenance-rotation-invalid';
    }
  }
  if (payload.phase === 'dr-exercise-enabled') {
    if (!payload.drExercise || payload.drExercise.authorizationId !== authorization.drExercise.authorizationId ||
      payload.drExercise.sourceStorageId !== authorization.backupStorageId ||
      payload.drExercise.observedContentDigest !== authorization.archiveContentDigest || payload.drExercise.integrityStatus !== 'pass') {
      return 'production-rollout-dr-exercise-invalid';
    }
  }
  if (payload.phase === 'steady-state-enabled' && !payload.operationalObligations) {
    return 'production-rollout-obligations-missing';
  }
  return undefined;
}

function pass(options: ProductionOperationsRolloutVerifierOptions, runId: string, completedAtMs: number) {
  return {
    verifier: options.verifierName,
    version: options.verifierVersion,
    verifiedAt: new Date(completedAtMs + 1_000).toISOString(),
    result: 'pass' as const,
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
    runId,
    readinessStatus: 'production-approved' as const,
  };
}
function fail(options: ProductionOperationsRolloutVerifierOptions, reason: string, runId = '') {
  return {
    verifier: options.verifierName,
    version: options.verifierVersion,
    verifiedAt: new Date(0).toISOString(),
    result: 'fail' as const,
    reason,
    ...(runId ? { runId } : {}),
    readinessStatus: 'contract-tested' as const,
  };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function number(value: unknown): number { return Number.isFinite(value) ? value as number : NaN; }
function stable(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
  return value;
}
function artifactBytes(value: unknown): Uint8Array {
  if (!record(value)) throw new Error('artifact-content-invalid');
  if (value.kind === 'utf8' && typeof value.content === 'string') return new TextEncoder().encode(value.content);
  if (value.kind === 'bytes' && Array.isArray(value.bytes) && value.bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return new Uint8Array(value.bytes as number[]);
  }
  throw new Error('artifact-content-invalid');
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}
async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('json-body-required');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) throw new Error('body-too-large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
