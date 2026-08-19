import type {
  EvidenceEnvelope,
  IndependentEvidenceVerification,
  ReadinessStatus,
} from './evidence.js';
import type {
  ContinuousAssuranceArchiveCycleRequest,
  ContinuousAssuranceCaptureAggregateRequest,
  ContinuousAssuranceCaptureCycleRequest,
  ContinuousAssuranceHealthResult,
  ContinuousAssurancePageRequest,
  ContinuousAssuranceProviderAuditResult,
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

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/* -]{7,511}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ADAPTER_ARTIFACT_PREFIX = 'r2://continuous-assurance-evidence/';

export const CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE =
  'unzen-llm-continuous-assurance-provider-adapter' as const;
export const CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE =
  'unzen-llm-continuous-assurance-evidence-adapter' as const;
export const CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE =
  'unzen-llm-continuous-assurance-pager-adapter' as const;
export const CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE =
  'unzen-llm-continuous-assurance-independent-verifier' as const;

export interface ContinuousAssuranceFetchBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ContinuousAssuranceR2ObjectBody {
  readonly size: number;
  readonly customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ContinuousAssuranceR2Bucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { readonly customMetadata?: Record<string, string> },
  ): Promise<unknown>;
  get(key: string): Promise<ContinuousAssuranceR2ObjectBody | null>;
}

export type AdapterFetch = (request: Request) => Promise<Response>;

export interface ProviderAdapterOptions {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly fetcher?: AdapterFetch;
  readonly maxBodyBytes?: number;
}

export interface PagerAdapterOptions {
  readonly apiUrl: string;
  readonly apiToken: string;
  readonly fetcher?: AdapterFetch;
  readonly maxBodyBytes?: number;
  readonly maxAttempts?: number;
}

export interface EvidenceAdapterOptions {
  readonly bucket: ContinuousAssuranceR2Bucket;
  readonly verifier: ContinuousAssuranceFetchBinding;
  readonly producerName: string;
  readonly producerVersion: string;
  readonly producerCommitSha: string;
  readonly verifierName: string;
  readonly verifierVersion?: string;
  readonly defaultRetentionMs: number;
  readonly maxBodyBytes?: number;
  readonly maxArtifactBytes?: number;
}

export async function handleContinuousAssuranceProviderAdapterRequest(
  request: Request,
  options: ProviderAdapterOptions,
): Promise<Response> {
  try {
    requirePost(request);
    const idempotencyKey = requireIdempotencyKey(request);
    const path = new URL(request.url).pathname;
    if (!PROVIDER_PATHS.has(path)) return jsonError('provider-adapter-not-found', 404);
    const body = await readJsonBounded(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const upstreamUrl = joinUrl(options.apiBaseUrl, path);
    const fetcher = options.fetcher ?? ((input) => fetch(input));
    const upstream = await fetcher(new Request(upstreamUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'authorization': `Bearer ${options.apiToken}`,
        'x-unzen-idempotency-key': idempotencyKey,
        'x-unzen-adapter-service': CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
      },
      body: JSON.stringify(body),
    }));
    if (!upstream.ok) {
      return jsonError(`provider-upstream-http-${upstream.status}`, mapUpstreamStatus(upstream.status));
    }
    const payload = await readResponseJsonBounded(upstream, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    validateProviderPayload(path, payload);
    return Response.json(payload, {
      headers: {
        'x-unzen-idempotency-key': idempotencyKey,
        'x-unzen-adapter-service': CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
      },
    });
  } catch (error) {
    return adapterErrorResponse('provider', error);
  }
}

export async function handleContinuousAssuranceEvidenceAdapterRequest(
  request: Request,
  options: EvidenceAdapterOptions,
): Promise<Response> {
  try {
    requirePost(request);
    const path = new URL(request.url).pathname;
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (path === '/evidence/artifact/load') {
      const body = await readJsonBounded(request, maxBodyBytes) as { locator?: unknown };
      const key = artifactKeyFromLocator(body.locator);
      const object = await options.bucket.get(key);
      if (!object) return jsonError('evidence-artifact-not-found', 404);
      const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
      if (object.size > maxArtifactBytes) return jsonError('evidence-artifact-too-large', 413);
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength > maxArtifactBytes) return jsonError('evidence-artifact-too-large', 413);
      return Response.json({ kind: 'bytes', bytes: Array.from(bytes) });
    }
    if (path === '/evidence/artifact/verify') {
      const body = await readJsonBounded(request, maxBodyBytes);
      const attestation = await callVerifier(options, '/verify/artifact', body);
      return Response.json(attestation);
    }

    const idempotencyKey = requireIdempotencyKey(request);
    if (path === '/evidence/cycle/archive') {
      const body = await readJsonBounded(request, maxBodyBytes) as ContinuousAssuranceArchiveCycleRequest;
      validateActionContext(body?.context, idempotencyKey);
      const retained = await archiveCycleEvidence(body, options);
      return Response.json(retained, { headers: { 'x-unzen-idempotency-key': idempotencyKey } });
    }
    if (path === '/evidence/cycle/capture') {
      const body = await readJsonBounded(request, maxBodyBytes) as ContinuousAssuranceCaptureCycleRequest;
      validateActionContext(body?.context, idempotencyKey);
      const envelope = await captureCycleEvidence(body, options);
      return Response.json(envelope, { headers: { 'x-unzen-idempotency-key': idempotencyKey } });
    }
    if (path === '/evidence/aggregate/capture') {
      const body = await readJsonBounded(request, maxBodyBytes) as ContinuousAssuranceCaptureAggregateRequest;
      validateActionContext(body?.context, idempotencyKey);
      const envelope = await captureAggregateEvidence(body, options);
      return Response.json(envelope, { headers: { 'x-unzen-idempotency-key': idempotencyKey } });
    }
    return jsonError('evidence-adapter-not-found', 404);
  } catch (error) {
    return adapterErrorResponse('evidence', error);
  }
}

export async function handleContinuousAssurancePagerAdapterRequest(
  request: Request,
  options: PagerAdapterOptions,
): Promise<Response> {
  try {
    requirePost(request);
    const path = new URL(request.url).pathname;
    if (path !== '/page') return jsonError('pager-adapter-not-found', 404);
    const idempotencyKey = requireIdempotencyKey(request);
    const body = await readJsonBounded(
      request,
      options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    ) as ContinuousAssurancePageRequest;
    if (!body || body.dedupeKey !== idempotencyKey) {
      throw new AdapterContractError('pager-dedupe-key-mismatch', 400);
    }
    if (!body.cycleId || !body.reason || !body.onCallRoute || !body.escalationTarget) {
      throw new AdapterContractError('pager-request-invalid', 400);
    }
    const fetcher = options.fetcher ?? ((input) => fetch(input));
    const maxAttempts = Math.max(1, Math.min(3, Math.floor(options.maxAttempts ?? 2)));
    let lastStatus = 503;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const response = await fetcher(new Request(options.apiUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'accept': 'application/json',
          'authorization': `Bearer ${options.apiToken}`,
          'idempotency-key': idempotencyKey,
          'x-unzen-idempotency-key': idempotencyKey,
          'x-unzen-adapter-service': CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
        },
        body: JSON.stringify({ ...body, attempt }),
      }));
      lastStatus = response.status;
      if (response.status === 409) {
        return Response.json({ status: 'deduplicated', attempts: attempt }, {
          headers: { 'x-unzen-idempotency-key': idempotencyKey },
        });
      }
      if (response.ok) {
        const payload = await readResponseJsonBounded(
          response,
          options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
        );
        if (!isRecord(payload) || typeof payload.deliveryId !== 'string' || !payload.deliveryId) {
          throw new AdapterContractError('pager-upstream-response-invalid', 502);
        }
        return Response.json({ status: 'accepted', deliveryId: payload.deliveryId, attempts: attempt }, {
          headers: { 'x-unzen-idempotency-key': idempotencyKey },
        });
      }
      if (!(response.status === 429 || response.status >= 500)) break;
    }
    return jsonError(`pager-upstream-http-${lastStatus}`, mapUpstreamStatus(lastStatus));
  } catch (error) {
    return adapterErrorResponse('pager', error);
  }
}

async function archiveCycleEvidence(
  request: ContinuousAssuranceArchiveCycleRequest,
  options: EvidenceAdapterOptions,
): Promise<SteadyStateRetainedEvidence> {
  if (!request?.draft || !request.context || !Number.isFinite(request.minimumRetentionMs)) {
    throw new AdapterContractError('evidence-cycle-archive-request-invalid', 400);
  }
  const artifact = canonicalJson({
    schema: 'unzen-continuous-assurance-cycle-archive-v1',
    draft: request.draft,
    minimumRetentionMs: request.minimumRetentionMs,
  });
  const digest = await sha256Hex(artifact);
  const key = `cycle/${safeSegment(request.context.cycleId)}/${digest}.json`;
  const retentionUntilMs = Math.max(
    request.context.nowMs,
    numberField(request.draft, 'completedAtMs') ?? request.context.nowMs,
  ) + Math.max(0, request.minimumRetentionMs);
  await options.bucket.put(key, artifact, {
    customMetadata: {
      sha256: digest,
      cycleId: request.context.cycleId,
      retentionUntilMs: String(retentionUntilMs),
      idempotencyKey: request.context.idempotencyKey,
    },
  });
  return {
    evidenceArchiveId: key,
    evidenceContentDigest: digest,
    retentionUntilMs,
    retrievalProofId: `r2-proof-${(await sha256Hex(`${key}:${digest}`)).slice(0, 24)}`,
  };
}

async function captureCycleEvidence(
  request: ContinuousAssuranceCaptureCycleRequest,
  options: EvidenceAdapterOptions,
): Promise<EvidenceEnvelope<ProviderSteadyStateCyclePayload>> {
  const payload = request?.payload;
  if (!payload || !request.context || payload.cycleId !== request.context.cycleId) {
    throw new AdapterContractError('evidence-cycle-capture-request-invalid', 400);
  }
  const retained = payload.retainedEvidence;
  if (!retained?.evidenceArchiveId || !SHA256_PATTERN.test(retained.evidenceContentDigest)) {
    throw new AdapterContractError('evidence-cycle-retained-evidence-invalid', 400);
  }
  const artifact = await loadAndVerifyR2Artifact(
    retained.evidenceArchiveId,
    retained.evidenceContentDigest,
    options,
  );
  const runId = payload.cycleId;
  const evidenceKind = PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_CYCLE_EVIDENCE_KIND;
  const attestation = await callCaptureVerifier(options, {
    evidenceKind,
    runId,
    payload,
    requestedReadinessStatus: 'production-approved',
    artifactLocator: artifact.locator,
    artifactSha256: artifact.sha256,
  });
  return capturedEnvelope({
    evidenceKind,
    runId,
    payload,
    capturedAtMs: payload.capturedAtMs,
    artifactLocator: artifact.locator,
    artifactSha256: artifact.sha256,
    expiresAtMs: retained.retentionUntilMs,
    attestation,
    options,
  });
}

async function captureAggregateEvidence(
  request: ContinuousAssuranceCaptureAggregateRequest,
  options: EvidenceAdapterOptions,
): Promise<EvidenceEnvelope<ProviderSteadyStateOperationsPayload>> {
  const payload = request?.payload;
  if (!payload || !request.context || !request.expectedRunId) {
    throw new AdapterContractError('evidence-aggregate-capture-request-invalid', 400);
  }
  const artifactContent = canonicalJson({
    schema: 'unzen-continuous-assurance-aggregate-evidence-v1',
    runId: request.expectedRunId,
    payload,
  });
  const digest = await sha256Hex(artifactContent);
  const key = `aggregate/${safeSegment(request.expectedRunId)}/${digest}.json`;
  const expiresAtMs = payload.capturedAtMs + Math.max(1, options.defaultRetentionMs);
  await options.bucket.put(key, artifactContent, {
    customMetadata: {
      sha256: digest,
      runId: request.expectedRunId,
      retentionUntilMs: String(expiresAtMs),
      idempotencyKey: request.context.idempotencyKey,
    },
  });
  const evidenceKind = PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_STEADY_STATE_OPERATIONS_EVIDENCE_KIND;
  const locator = artifactLocator(key);
  const attestation = await callCaptureVerifier(options, {
    evidenceKind,
    runId: request.expectedRunId,
    payload,
    requestedReadinessStatus: 'production-approved',
    artifactLocator: locator,
    artifactSha256: digest,
  });
  return capturedEnvelope({
    evidenceKind,
    runId: request.expectedRunId,
    payload,
    capturedAtMs: payload.capturedAtMs,
    artifactLocator: locator,
    artifactSha256: digest,
    expiresAtMs,
    attestation,
    options,
  });
}

function capturedEnvelope<T>(args: {
  readonly evidenceKind: string;
  readonly runId: string;
  readonly payload: T;
  readonly capturedAtMs: number;
  readonly artifactLocator: string;
  readonly artifactSha256: string;
  readonly expiresAtMs: number;
  readonly attestation: CaptureVerifierAttestation;
  readonly options: EvidenceAdapterOptions;
}): EvidenceEnvelope<T> {
  if (args.attestation.result !== 'pass' ||
    args.attestation.evidenceKind !== args.evidenceKind ||
    args.attestation.runId !== args.runId ||
    args.attestation.readinessStatus !== 'production-approved' ||
    args.attestation.verifier !== args.options.verifierName ||
    (args.options.verifierVersion && args.attestation.version !== args.options.verifierVersion)) {
    throw new AdapterContractError('evidence-independent-verifier-attestation-invalid', 502);
  }
  return {
    schemaVersion: '1.0.0',
    evidenceKind: args.evidenceKind,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-approved',
    producer: {
      name: args.options.producerName,
      version: args.options.producerVersion,
      commitSha: args.options.producerCommitSha,
    },
    runId: args.runId,
    capturedAt: new Date(args.capturedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers',
      runtimeVersion: 'managed',
      executionSurface: 'continuous-assurance-evidence-adapter',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: {
      feature: args.evidenceKind,
      scenario: args.runId,
      expectedResult: 'independently verified continuous assurance evidence',
    },
    artifact: {
      locator: args.artifactLocator,
      sha256: args.artifactSha256,
      expiresAt: new Date(args.expiresAtMs).toISOString(),
    },
    verification: {
      verifier: args.attestation.verifier,
      version: args.attestation.version,
      verifiedAt: args.attestation.verifiedAt,
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'continuous-assurance-adapter-v1' },
    payload: args.payload,
  };
}

interface CaptureVerifierRequest {
  readonly evidenceKind: string;
  readonly runId: string;
  readonly payload: unknown;
  readonly requestedReadinessStatus: ReadinessStatus;
  readonly artifactLocator: string;
  readonly artifactSha256: string;
}

interface CaptureVerifierAttestation extends IndependentEvidenceVerification {
  readonly evidenceKind: string;
  readonly runId: string;
  readonly readinessStatus: ReadinessStatus;
}

async function callCaptureVerifier(
  options: EvidenceAdapterOptions,
  body: CaptureVerifierRequest,
): Promise<CaptureVerifierAttestation> {
  const response = await callVerifier(options, '/verify/capture', body) as CaptureVerifierAttestation;
  if (!response || typeof response.evidenceKind !== 'string' || typeof response.runId !== 'string' ||
    typeof response.readinessStatus !== 'string') {
    throw new AdapterContractError('evidence-independent-verifier-response-invalid', 502);
  }
  return response;
}

async function callVerifier(
  options: EvidenceAdapterOptions,
  path: string,
  body: unknown,
): Promise<IndependentEvidenceVerification | CaptureVerifierAttestation> {
  const response = await options.verifier.fetch(new Request(`https://independent-verifier.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!response.ok) {
    throw new AdapterContractError(`evidence-independent-verifier-http-${response.status}`, 502);
  }
  const payload = await readResponseJsonBounded(
    response,
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  );
  if (!isRecord(payload) || payload.result !== 'pass' ||
    typeof payload.verifier !== 'string' || typeof payload.version !== 'string' ||
    typeof payload.verifiedAt !== 'string') {
    throw new AdapterContractError('evidence-independent-verifier-response-invalid', 502);
  }
  return payload as unknown as IndependentEvidenceVerification | CaptureVerifierAttestation;
}

async function loadAndVerifyR2Artifact(
  key: string,
  expectedDigest: string,
  options: EvidenceAdapterOptions,
): Promise<{ locator: string; sha256: string }> {
  const object = await options.bucket.get(key);
  if (!object) throw new AdapterContractError('evidence-cycle-artifact-not-found', 404);
  const maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (object.size > maxArtifactBytes) throw new AdapterContractError('evidence-artifact-too-large', 413);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== expectedDigest) throw new AdapterContractError('evidence-artifact-digest-mismatch', 409);
  if (object.customMetadata?.sha256 && object.customMetadata.sha256 !== actual) {
    throw new AdapterContractError('evidence-artifact-metadata-digest-mismatch', 409);
  }
  return { locator: artifactLocator(key), sha256: actual };
}

function validateProviderPayload(path: string, payload: unknown): void {
  if (!isRecord(payload)) throw new AdapterContractError('provider-upstream-response-invalid', 502);
  const required = PROVIDER_REQUIRED_FIELDS[path] ?? [];
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new AdapterContractError(`provider-upstream-response-missing:${field}`, 502);
    }
  }
  if (path === '/provider/audit') {
    const value = payload as unknown as ContinuousAssuranceProviderAuditResult;
    if (!value.auditStreamId || !value.auditCursorStart || !value.auditCursorEnd ||
      !Array.isArray(value.providerAuditRecordIds) || !Number.isFinite(value.observedAtMs)) {
      throw new AdapterContractError('provider-audit-response-invalid', 502);
    }
  } else if (path === '/provider/archive/retrieve') {
    const value = payload as unknown as SteadyStateArchiveRetrieval;
    if (!value.retrievalOperationId || !value.storageId || !value.archiveId ||
      value.integrityStatus !== 'pass' || !SHA256_PATTERN.test(value.observedContentDigest)) {
      throw new AdapterContractError('provider-retrieval-response-invalid', 502);
    }
  } else if (path === '/provider/health') {
    const value = payload as unknown as ContinuousAssuranceHealthResult;
    if (!Number.isFinite(value.observedAtMs) || !Array.isArray(value.alertDispositions) ||
      !Array.isArray(value.incidentReviews) || !Array.isArray(value.networkAttempts)) {
      throw new AdapterContractError('provider-health-response-invalid', 502);
    }
  } else if (path === '/provider/keys/rotate') {
    const value = payload as unknown as SteadyStateRotationEvent;
    if (!value.rotationId || !Number.isFinite(value.rotatedAtMs)) {
      throw new AdapterContractError('provider-rotation-response-invalid', 502);
    }
  } else if (path === '/provider/dr/exercise') {
    const value = payload as unknown as SteadyStateDrExercise;
    if (!value.exerciseId || !value.sourceStorageId || value.integrityStatus !== 'pass') {
      throw new AdapterContractError('provider-dr-response-invalid', 502);
    }
  }
}

function validateActionContext(context: unknown, idempotencyKey: string): void {
  if (!isRecord(context) || typeof context.cycleId !== 'string' || !context.cycleId ||
    typeof context.action !== 'string' || !context.action ||
    context.idempotencyKey !== idempotencyKey || !Number.isFinite(context.nowMs)) {
    throw new AdapterContractError('adapter-action-context-invalid', 400);
  }
}

function requirePost(request: Request): void {
  if (request.method !== 'POST') throw new AdapterContractError('method-not-allowed', 405);
}

function requireIdempotencyKey(request: Request): string {
  const key = request.headers.get('x-unzen-idempotency-key') ?? '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new AdapterContractError('idempotency-key-required', 400);
  }
  return key;
}

async function readJsonBounded(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new AdapterContractError('json-body-required', 400);
  const bytes = await readStreamBounded(request.body, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AdapterContractError('json-body-invalid', 400);
  }
}

async function readResponseJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new AdapterContractError('upstream-json-body-required', 502);
  const bytes = await readStreamBounded(response.body, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AdapterContractError('upstream-json-body-invalid', 502);
  }
}

async function readStreamBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new AdapterContractError('body-too-large', 413);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function adapterErrorResponse(label: string, error: unknown): Response {
  if (error instanceof AdapterContractError) return jsonError(error.code, error.status);
  return jsonError(`${label}-adapter-internal-error:${errorMessage(error)}`, 500);
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function mapUpstreamStatus(status: number): number {
  if (status === 401 || status === 403) return 502;
  if (status === 404) return 502;
  if (status === 409) return 409;
  if (status === 429) return 503;
  if (status >= 500) return 503;
  return 502;
}

function joinUrl(base: string, path: string): string {
  const url = new URL(base);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AdapterContractError('provider-api-base-url-invalid', 500);
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function artifactLocator(key: string): string {
  return `${ADAPTER_ARTIFACT_PREFIX}${encodeURIComponent(key)}`;
}

function artifactKeyFromLocator(locator: unknown): string {
  if (typeof locator !== 'string' || !locator.startsWith(ADAPTER_ARTIFACT_PREFIX)) {
    throw new AdapterContractError('evidence-artifact-locator-invalid', 400);
  }
  const key = decodeURIComponent(locator.slice(ADAPTER_ARTIFACT_PREFIX.length));
  if (!key || key.includes('..') || key.startsWith('/')) {
    throw new AdapterContractError('evidence-artifact-locator-invalid', 400);
  }
  return key;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  if (!safe) throw new AdapterContractError('artifact-key-identity-invalid', 400);
  return safe;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

async function sha256Hex(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function numberField(value: unknown, key: string): number | undefined {
  return isRecord(value) && Number.isFinite(value[key]) ? value[key] as number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AdapterContractError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const PROVIDER_PATHS = new Set([
  '/provider/audit',
  '/provider/archive/retrieve',
  '/provider/health',
  '/provider/keys/rotate',
  '/provider/dr/exercise',
]);

const PROVIDER_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  '/provider/audit': ['auditStreamId', 'auditCursorStart', 'auditCursorEnd', 'providerAuditRecordIds', 'observedAtMs'],
  '/provider/archive/retrieve': ['retrievalOperationId', 'storageId', 'archiveId', 'observedContentDigest', 'integrityCheckId', 'integrityStatus'],
  '/provider/health': ['observedAtMs', 'operationCount', 'failureCount', 'providerAvailabilityPct', 'alertDispositions', 'incidentReviews', 'networkAttempts'],
  '/provider/keys/rotate': ['rotationId', 'rotatedAtMs'],
  '/provider/dr/exercise': ['exerciseId', 'sourceStorageId', 'observedContentDigest', 'integrityCheckId', 'integrityStatus'],
};
