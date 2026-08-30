import type {
  EvidenceEnvelope,
  EvidenceValidationOptions,
  IndependentEvidenceVerification,
} from './evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
  type ProductionOperationsRolloutPhasePayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout.js';
import type {
  ProductionOperationsRolloutCaptureRequest,
  ProductionOperationsRolloutPhaseCapture,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout-runner.js';

const BUCKET_NAME = 'continuous-assurance-evidence';

export interface ProductionOperationsRolloutR2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ProductionOperationsRolloutR2Bucket {
  put(key: string, value: string | Uint8Array, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<ProductionOperationsRolloutR2Object | null>;
}

export interface ProductionOperationsRolloutVerifierBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ProductionOperationsRolloutCaptureOptions {
  readonly bucket: ProductionOperationsRolloutR2Bucket;
  readonly verifier: ProductionOperationsRolloutVerifierBinding;
  readonly verifierName: string;
  readonly verifierVersion: string;
  readonly producerName: string;
  readonly producerVersion: string;
  readonly producerCommitSha: string;
  readonly retentionMs: number;
}

export function createProductionOperationsRolloutPhaseCapture(
  options: ProductionOperationsRolloutCaptureOptions,
): ProductionOperationsRolloutPhaseCapture {
  return {
    capturePhaseEvidence: (request) => capturePhaseEvidence(request, options),
  };
}

async function capturePhaseEvidence(
  request: ProductionOperationsRolloutCaptureRequest,
  options: ProductionOperationsRolloutCaptureOptions,
): Promise<EvidenceEnvelope<ProductionOperationsRolloutPhasePayload>> {
  const record = {
    schema: 'unzen-continuous-assurance-production-rollout-phase-v1',
    runId: request.expectedRunId,
    authorization: request.authorization,
    payload: request.payload,
    actionReceipts: request.actionReceipts,
  };
  const artifactContent = stableJson(record);
  const artifactSha256 = await sha256Hex(artifactContent);
  const key = [
    'production-rollout',
    safeSegment(request.payload.rolloutId),
    `${request.payload.sequence}-${safeSegment(request.payload.phase)}`,
    `${artifactSha256}.json`,
  ].join('/');
  await options.bucket.put(key, artifactContent, {
    customMetadata: {
      sha256: artifactSha256,
      rolloutId: request.payload.rolloutId,
      phase: request.payload.phase,
      runId: request.expectedRunId,
      authorizationId: request.authorization.authorizationId,
    },
  });
  const artifactLocator = `r2://${BUCKET_NAME}/${encodeURIComponent(key)}`;

  const capture = await callVerifier(options.verifier, '/verify/capture', {
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
    runId: request.expectedRunId,
    payload: request.payload,
    authorization: request.authorization,
    actionReceipts: request.actionReceipts,
    requestedReadinessStatus: 'production-approved',
    artifactLocator,
    artifactSha256,
  });
  if (capture.result !== 'pass' || capture.verifier !== options.verifierName ||
    capture.version !== options.verifierVersion || capture.readinessStatus !== 'production-approved') {
    throw new Error('production-rollout-capture-attestation-invalid');
  }

  const envelope: EvidenceEnvelope<ProductionOperationsRolloutPhasePayload> = {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_PHASE_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-approved',
    producer: {
      name: options.producerName,
      version: options.producerVersion,
      commitSha: options.producerCommitSha,
    },
    runId: request.expectedRunId,
    capturedAt: new Date(request.payload.completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers',
      runtimeVersion: 'managed',
      executionSurface: 'production-operations-rollout',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: {
      feature: 'continuous-assurance-production-operations-rollout',
      scenario: request.payload.phase,
      expectedResult: 'authorized production rollout phase passes',
    },
    artifact: {
      locator: artifactLocator,
      sha256: artifactSha256,
      expiresAt: new Date(request.payload.completedAtMs + Math.max(1, options.retentionMs)).toISOString(),
    },
    verification: {
      verifier: options.verifierName,
      version: options.verifierVersion,
      verifiedAt: capture.verifiedAt,
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'production-rollout-phase-v1' },
    payload: request.payload,
  };

  const reverified = await callVerifier(options.verifier, '/verify/artifact', {
    envelope,
    actualSha256: artifactSha256,
    artifactContent: { kind: 'utf8', content: artifactContent },
  });
  if (reverified.result !== 'pass' || reverified.verifier !== options.verifierName ||
    reverified.version !== options.verifierVersion) {
    throw new Error('production-rollout-artifact-reverification-failed');
  }
  return envelope;
}

export interface ProductionOperationsDirectEvidenceValidationOptions {
  readonly bucket: ProductionOperationsRolloutR2Bucket;
  readonly verifier: ProductionOperationsRolloutVerifierBinding;
  readonly verifierName: string;
  readonly verifierVersion: string;
  readonly now?: Date | string | number;
}

export function createProductionOperationsDirectEvidenceValidationOptions(
  options: ProductionOperationsDirectEvidenceValidationOptions,
): EvidenceValidationOptions {
  return {
    now: options.now,
    trustedVerifiers: [{ name: options.verifierName, version: options.verifierVersion }],
    loadArtifact: async (locator) => {
      const key = parseR2Locator(locator);
      const object = await options.bucket.get(key);
      if (!object) throw new Error(`production-rollout-artifact-not-found:${key}`);
      return new Uint8Array(await object.arrayBuffer());
    },
    verifyArtifact: async (context) => callVerifier(options.verifier, '/verify/artifact', {
      envelope: context.envelope,
      actualSha256: context.actualSha256,
      artifactContent: artifactTransport(context.artifactContent),
    }) as Promise<IndependentEvidenceVerification>,
  };
}

function parseR2Locator(locator: string): string {
  const prefix = `r2://${BUCKET_NAME}/`;
  if (!locator.startsWith(prefix)) throw new Error('production-rollout-artifact-locator-invalid');
  const encoded = locator.slice(prefix.length);
  const key = decodeURIComponent(encoded);
  if (!key || key.includes('..')) throw new Error('production-rollout-artifact-key-invalid');
  return key;
}

type RolloutVerifierResponse = {
  result: string;
  verifier: string;
  version: string;
  verifiedAt: string;
  readinessStatus?: string;
};

async function callVerifier(
  binding: ProductionOperationsRolloutVerifierBinding,
  path: string,
  body: unknown,
): Promise<RolloutVerifierResponse> {
  const response = await binding.fetch(new Request(`https://rollout-verifier.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-rollout-verifier-http-${response.status}`);
  return (await response.json()) as RolloutVerifierResponse;
}

function artifactTransport(content: string | Uint8Array | ArrayBuffer): unknown {
  if (typeof content === 'string') return { kind: 'utf8', content };
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  return { kind: 'bytes', bytes: Array.from(bytes) };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, '0')).join('');
}
function safeSegment(value: string): string { return encodeURIComponent(value).replace(/%/g, '_'); }
function stableJson(value: unknown): string { return JSON.stringify(sort(value)); }
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sort(record[key])]));
  }
  return value;
}
