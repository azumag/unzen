import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
  type ProductionProviderCanaryPayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ProductionProviderCanaryVerifierOptions {
  readonly verifierName: string;
  readonly verifierVersion: string;
}

export async function handleProductionProviderCanaryVerifierRequest(
  request: Request,
  options: ProductionProviderCanaryVerifierOptions,
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
    return Response.json({ error: 'verifier-not-found' }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function verifyCapture(input: unknown, options: ProductionProviderCanaryVerifierOptions) {
  if (!record(input) || input.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND ||
    input.requestedReadinessStatus !== 'production-candidate' || !SHA256.test(text(input.artifactSha256)) ||
    !record(input.payload)) return fail(options, 'provider-canary-capture-request-invalid');
  const runId = text(input.runId);
  const payload = input.payload;
  const reason = validatePayload(payload, runId);
  if (reason) return fail(options, reason, runId);
  return pass(options, runId, number(payload.completedAtMs));
}

async function verifyArtifact(input: unknown, options: ProductionProviderCanaryVerifierOptions) {
  if (!record(input) || !record(input.envelope)) {
    return fail(options, 'provider-canary-artifact-request-invalid');
  }
  const envelope = input.envelope;
  const artifact = envelope.artifact;
  const payload = envelope.payload;
  if (!record(artifact) || !record(payload)) {
    return fail(options, 'provider-canary-artifact-request-invalid');
  }
  if (envelope.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND ||
    envelope.readinessStatus !== 'production-candidate') return fail(options, 'provider-canary-artifact-envelope-invalid');
  const actualSha = text(input.actualSha256);
  const expectedSha = text(artifact.sha256);
  if (!SHA256.test(actualSha) || actualSha !== expectedSha) return fail(options, 'provider-canary-artifact-digest-invalid');
  const bytes = artifactBytes(input.artifactContent);
  if (await sha256(bytes) !== expectedSha) return fail(options, 'provider-canary-artifact-digest-mismatch');
  const runId = text(envelope.runId);
  const reason = validatePayload(payload, runId);
  if (reason) return fail(options, reason, runId);
  const bindingReason = validateArtifactRecord(bytes, payload as unknown as ProductionProviderCanaryPayload);
  if (bindingReason) return fail(options, bindingReason, runId);
  const completedAtMs = number(payload.completedAtMs);
  const verifiedAt = new Date(completedAtMs + 1_000).toISOString();
  if (!record(envelope.verification) || envelope.verification.verifier !== options.verifierName ||
    envelope.verification.version !== options.verifierVersion || envelope.verification.verifiedAt !== verifiedAt ||
    envelope.verification.result !== 'pass') return fail(options, 'provider-canary-attestation-mismatch', runId);
  return { verifier: options.verifierName, version: options.verifierVersion, verifiedAt, result: 'pass' as const };
}

function validatePayload(payload: Record<string, unknown>, runId: string): string | undefined {
  if (!runId || payload.canaryRunId !== runId) return 'provider-canary-run-identity-invalid';
  if (!record(payload.authorization) || !text(payload.authorization.authorizationId) || !text(payload.authorization.changeTicketId) ||
    !Array.isArray(payload.authorization.approvers) || new Set(payload.authorization.approvers.filter(Boolean)).size < 2 ||
    !SHA256.test(text(payload.authorization.archiveContentDigest))) return 'provider-canary-authorization-invalid';
  const allowed = payload.authorization.allowedActions;
  const required = ['provider-health', 'provider-audit', 'primary-archive-retrieval', 'backup-archive-retrieval', 'pager-canary'];
  if (!Array.isArray(allowed) || allowed.length !== required.length || required.some((action) => !allowed.includes(action))) {
    return 'provider-canary-action-allowlist-invalid';
  }
  if (!Array.isArray(payload.receipts) || payload.receipts.length !== 6) return 'provider-canary-receipts-invalid';
  for (const receipt of payload.receipts) {
    if (!record(receipt) || !required.includes(text(receipt.action)) || !text(receipt.idempotencyKey) ||
      !text(receipt.operationId) || !Number.isFinite(receipt.observedAtMs)) return 'provider-canary-receipt-invalid';
  }
  const pager = payload.receipts.filter((item) => record(item) && item.action === 'pager-canary') as Record<string, unknown>[];
  if (pager.length !== 2 || pager[0].status !== 'success' || pager[1].status !== 'deduplicated' ||
    pager[0].idempotencyKey !== pager[1].idempotencyKey) return 'provider-canary-pager-dedupe-invalid';
  for (const action of ['primary-archive-retrieval', 'backup-archive-retrieval']) {
    const receipt = payload.receipts.find((item) => record(item) && item.action === action) as Record<string, unknown> | undefined;
    if (!receipt || receipt.integrityStatus !== 'pass' || receipt.observedContentDigest !== payload.authorization.archiveContentDigest) {
      return `provider-canary-archive-integrity-invalid:${action}`;
    }
  }
  if (!record(payload.negativeChecks) || !Object.values(payload.negativeChecks).every((value) => value === true)) {
    return 'provider-canary-negative-check-incomplete';
  }
  if (!text(payload.artifactLocator) || !SHA256.test(text(payload.artifactSha256)) ||
    !text(payload.verifier) || !text(payload.verifierVersion) || !text(payload.verificationId)) {
    return 'provider-canary-artifact-identity-invalid';
  }
  return undefined;
}

function validateArtifactRecord(bytes: Uint8Array, payload: ProductionProviderCanaryPayload): string | undefined {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return 'provider-canary-artifact-json-invalid'; }
  if (!record(value) || value.schema !== 'unzen-continuous-assurance-production-provider-canary-v1') return 'provider-canary-artifact-schema-invalid';
  if (value.canaryRunId !== payload.canaryRunId ||
    stable(value.authorization) !== stable(payload.authorization) ||
    stable(value.receipts) !== stable(payload.receipts) ||
    stable(value.negativeChecks) !== stable(payload.negativeChecks) ||
    value.deploymentCanaryRunId !== payload.deploymentCanaryInputEvidence.runId) {
    return 'provider-canary-artifact-binding-mismatch';
  }
  return undefined;
}

function pass(options: ProductionProviderCanaryVerifierOptions, runId: string, completedAtMs: number) {
  return {
    verifier: options.verifierName,
    version: options.verifierVersion,
    verifiedAt: new Date(completedAtMs + 1_000).toISOString(),
    result: 'pass' as const,
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    runId,
    readinessStatus: 'production-candidate' as const,
  };
}
function fail(options: ProductionProviderCanaryVerifierOptions, reason: string, runId = '') {
  return { verifier: options.verifierName, version: options.verifierVersion, verifiedAt: new Date(0).toISOString(), result: 'fail' as const, reason, ...(runId ? { runId } : {}), readinessStatus: 'contract-tested' as const };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function number(value: unknown): number { return Number.isFinite(value) ? value as number : NaN; }
function stable(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown { return Array.isArray(value) ? value.map(sort) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value; }
function artifactBytes(value: unknown): Uint8Array {
  if (!record(value)) throw new Error('artifact-content-invalid');
  if (value.kind === 'utf8' && typeof value.content === 'string') return new TextEncoder().encode(value.content);
  if (value.kind === 'bytes' && Array.isArray(value.bytes) && value.bytes.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return new Uint8Array(value.bytes as number[]);
  throw new Error('artifact-content-invalid');
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}
async function readJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('json-body-required');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; if (!value) continue; total += value.byteLength; if (total > MAX_BODY_BYTES) throw new Error('body-too-large'); chunks.push(value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
