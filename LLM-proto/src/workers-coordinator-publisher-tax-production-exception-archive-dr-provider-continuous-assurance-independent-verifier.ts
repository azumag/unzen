import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND,
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-steady-state-operations.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary';

export interface IndependentVerifierOptions {
  readonly verifierName: string;
  readonly verifierVersion: string;
}

export async function handleContinuousAssuranceIndependentVerifierRequest(
  request: Request,
  options: IndependentVerifierOptions,
): Promise<Response> {
  try {
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    const path = new URL(request.url).pathname;
    const body = await readJsonBounded(request, MAX_BODY_BYTES);
    if (path === '/verify/capture') {
      const result = verifyCapture(body, options);
      return Response.json(result, { status: result.result === 'pass' ? 200 : 409 });
    }
    if (path === '/verify/artifact') {
      const result = await verifyArtifact(body, options);
      return Response.json(result, { status: result.result === 'pass' ? 200 : 409 });
    }
    return Response.json({ error: 'verifier-not-found' }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function expectedReadiness(evidenceKind: string): 'production-approved' | 'production-candidate' | null {
  if (evidenceKind === PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND) return 'production-candidate';
  if (evidenceKind === PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND ||
    evidenceKind === PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND) {
    return 'production-approved';
  }
  return null;
}

function verifyCapture(input: unknown, options: IndependentVerifierOptions) {
  if (!isRecord(input)) return failed(options, 'capture-request-invalid');
  const evidenceKind = stringValue(input.evidenceKind);
  const runId = stringValue(input.runId);
  const requestedReadinessStatus = stringValue(input.requestedReadinessStatus);
  const artifactSha256 = stringValue(input.artifactSha256);
  const payload = input.payload;
  const readiness = expectedReadiness(evidenceKind);
  if (!evidenceKind || !runId || !readiness || requestedReadinessStatus !== readiness ||
    !SHA256_PATTERN.test(artifactSha256) || !isRecord(payload)) {
    return failed(options, 'capture-request-invalid');
  }
  const reason = validateProductionPayload(evidenceKind, runId, payload);
  if (reason) return failed(options, reason, evidenceKind, runId);
  const capturedAtMs = numberValue(payload.capturedAtMs);
  if (capturedAtMs === undefined) return failed(options, 'capture-timestamp-invalid', evidenceKind, runId);
  return {
    verifier: options.verifierName,
    version: options.verifierVersion,
    verifiedAt: new Date(capturedAtMs + 1_000).toISOString(),
    result: 'pass' as const,
    evidenceKind,
    runId,
    readinessStatus: readiness,
  };
}

async function verifyArtifact(input: unknown, options: IndependentVerifierOptions) {
  if (!isRecord(input) || !isRecord(input.envelope)) return failed(options, 'artifact-request-invalid');
  const envelope = input.envelope;
  const actualSha256 = stringValue(input.actualSha256);
  const artifactContent = input.artifactContent;
  const expectedSha256 = isRecord(envelope.artifact) ? stringValue(envelope.artifact.sha256) : '';
  if (!SHA256_PATTERN.test(actualSha256) || !SHA256_PATTERN.test(expectedSha256)) {
    return failed(options, 'artifact-digest-invalid');
  }
  const bytes = artifactBytes(artifactContent);
  const recomputed = await sha256Hex(bytes);
  if (recomputed !== actualSha256 || recomputed !== expectedSha256) {
    return failed(options, 'artifact-digest-mismatch');
  }
  const evidenceKind = stringValue(envelope.evidenceKind);
  const runId = stringValue(envelope.runId);
  const payload = envelope.payload;
  if (!isRecord(payload)) return failed(options, 'artifact-payload-invalid', evidenceKind, runId);
  const readiness = expectedReadiness(evidenceKind);
  if (!readiness || envelope.readinessStatus !== readiness) {
    return failed(options, 'artifact-readiness-invalid', evidenceKind, runId);
  }
  const reason = validateProductionPayload(evidenceKind, runId, payload);
  if (reason) return failed(options, reason, evidenceKind, runId);
  const capturedAtMs = numberValue(payload.capturedAtMs);
  if (capturedAtMs === undefined) return failed(options, 'artifact-capture-timestamp-invalid', evidenceKind, runId);
  const verifiedAt = new Date(capturedAtMs + 1_000).toISOString();
  if (!isRecord(envelope.verification) || envelope.verification.verifier !== options.verifierName ||
    envelope.verification.version !== options.verifierVersion || envelope.verification.verifiedAt !== verifiedAt ||
    envelope.verification.result !== 'pass') {
    return failed(options, 'artifact-envelope-attestation-invalid', evidenceKind, runId);
  }
  return {
    verifier: options.verifierName,
    version: options.verifierVersion,
    verifiedAt,
    result: 'pass' as const,
  };
}

function validateProductionPayload(evidenceKind: string, runId: string, payload: Record<string, unknown>): string | undefined {
  if (evidenceKind === PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND) {
    if (payload.cycleId !== runId) return 'cycle-run-identity-invalid';
    if (!isRecord(payload.primaryRetrieval) || payload.primaryRetrieval.integrityStatus !== 'pass' ||
      !isRecord(payload.backupRetrieval) || payload.backupRetrieval.integrityStatus !== 'pass') {
      return 'cycle-archive-integrity-invalid';
    }
    if (numberValue(payload.failureCount) !== 0 || numberValue(payload.rtoBreachCount) !== 0 ||
      numberValue(payload.rpoBreachCount) !== 0 || numberValue(payload.integrityFailureCount) !== 0) {
      return 'cycle-health-not-clean';
    }
    if (payload.rollbackArmed !== true || payload.emergencyHoldArmed !== true) return 'cycle-controls-not-armed';
    if (!isRecord(payload.retainedEvidence) || !SHA256_PATTERN.test(stringValue(payload.retainedEvidence.evidenceContentDigest))) {
      return 'cycle-retained-evidence-invalid';
    }
    return undefined;
  }
  if (evidenceKind === PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND) {
    if (!runId.endsWith('-aggregate')) return 'aggregate-run-identity-invalid';
    if (!Array.isArray(payload.cycleRunIds) || payload.cycleRunIds.length === 0) return 'aggregate-cycle-set-invalid';
    if (!isRecord(payload.rollingSlo) || numberValue(payload.rollingSlo.rtoBreachCount) !== 0 ||
      numberValue(payload.rollingSlo.rpoBreachCount) !== 0 || numberValue(payload.rollingSlo.integrityFailureCount) !== 0 ||
      (numberValue(payload.rollingSlo.remainingFailureBudget) ?? 0) <= 0) {
      return 'aggregate-slo-not-clean';
    }
    if (!isRecord(payload.schedule) || !Number.isFinite(payload.schedule.nextDueAtMs)) return 'aggregate-schedule-invalid';
    return undefined;
  }
  if (evidenceKind === PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND) {
    if (payload.canaryRunId !== runId) return 'deployment-canary-run-identity-invalid';
    if (!Array.isArray(payload.deployments) || payload.deployments.length !== 7) {
      return 'deployment-canary-version-set-invalid';
    }
    for (const deployment of payload.deployments) {
      if (!isRecord(deployment) || !stringValue(deployment.service) || stringValue(deployment.versionId).length < 8 ||
        !SHA256_PATTERN.test(stringValue(deployment.configFingerprintSha256)) ||
        !Number.isFinite(Date.parse(stringValue(deployment.versionTimestamp)))) {
        return 'deployment-canary-version-identity-invalid';
      }
    }
    if (!isRecord(payload.runtimeResult) || payload.runtimeResult.status !== 'idle' ||
      !isRecord(payload.runtimeResult.runtimeDelivery) || payload.runtimeResult.runtimeDelivery.durableState !== 'completed' ||
      numberValue(payload.runtimeResult.runtimeDelivery.replayCount) !== 0 || payload.runtimeResult.runtimeDelivery.replayed !== false ||
      !stringValue(payload.runtimeResult.cycleId) || payload.runtimeResult.latestCycleRunId !== null ||
      payload.runtimeResult.latestAggregateRunId !== null || !Array.isArray(payload.runtimeResult.actionIdempotencyKeys) ||
      payload.runtimeResult.actionIdempotencyKeys.length !== 0) {
      return 'deployment-canary-runtime-not-read-only';
    }
    if (!isRecord(payload.negativeChecks) || !Object.values(payload.negativeChecks).every((value) => value === true)) {
      return 'deployment-canary-negative-check-incomplete';
    }
    if (!SHA256_PATTERN.test(stringValue(payload.artifactSha256)) || !stringValue(payload.artifactLocator)) {
      return 'deployment-canary-artifact-invalid';
    }
    return undefined;
  }
  return 'unsupported-evidence-kind';
}

function failed(
  options: IndependentVerifierOptions,
  reason: string,
  evidenceKind = '',
  runId = '',
) {
  return {
    verifier: options.verifierName,
    version: options.verifierVersion,
    verifiedAt: new Date(0).toISOString(),
    result: 'fail' as const,
    reason,
    ...(evidenceKind ? { evidenceKind } : {}),
    ...(runId ? { runId } : {}),
    readinessStatus: 'contract-tested' as const,
  };
}

function artifactBytes(value: unknown): Uint8Array {
  if (!isRecord(value)) throw new Error('artifact-content-invalid');
  if (value.kind === 'utf8' && typeof value.content === 'string') return new TextEncoder().encode(value.content);
  if (value.kind === 'bytes' && Array.isArray(value.bytes) && value.bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return new Uint8Array(value.bytes as number[]);
  }
  throw new Error('artifact-content-invalid');
}

async function readJsonBounded(request: Request, maxBytes: number): Promise<unknown> {
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
      if (total > maxBytes) throw new Error('body-too-large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('json-body-invalid');
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number | undefined {
  return Number.isFinite(value) ? value as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
