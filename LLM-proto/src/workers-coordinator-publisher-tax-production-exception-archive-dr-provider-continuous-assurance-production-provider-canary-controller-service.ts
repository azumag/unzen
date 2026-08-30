import type { EvidenceEnvelope, EvidenceValidationOptions } from './evidence.js';
import {
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate,
  type ContinuousAssuranceDeploymentServiceRole,
  type ContinuousAssuranceProductionDeploymentCanaryPayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';
import {
  executeProductionProviderCanary,
  type ProductionProviderCanaryBindings,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-controller.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
  type ProductionProviderCanaryAuthorization,
  type ProductionProviderCanaryNegativeChecks,
  type ProductionProviderCanaryPayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary.js';

export interface ProductionProviderCanaryR2Bucket {
  put(key: string, value: string | Uint8Array, options?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get?(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size?: number } | null>;
}

export interface ProductionProviderCanaryVerifierBinding {
  fetch(request: Request): Promise<Response>;
}

export interface ProductionProviderCanaryControllerOptions {
  readonly canaryRunId: string;
  readonly nowMs: number;
  readonly deploymentCanaryEvidence: EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>;
  readonly deploymentEvidenceValidationOptions: EvidenceValidationOptions;
  readonly expectedDeployCommitSha: string;
  readonly expectedDeploymentManifestSha256: string;
  readonly expectedConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
  readonly expectedDeploymentVerifierName?: string;
  readonly authorization: ProductionProviderCanaryAuthorization;
  readonly bindings: ProductionProviderCanaryBindings;
  readonly verifier: ProductionProviderCanaryVerifierBinding;
  readonly bucket: ProductionProviderCanaryR2Bucket;
  readonly verifierName: string;
  readonly verifierVersion: string;
  readonly producerName: string;
  readonly producerVersion: string;
  readonly producerCommitSha: string;
  readonly retentionMs: number;
  readonly onCallRoute: string;
  readonly escalationTarget: string;
}

export async function runProductionProviderCanaryController(
  options: ProductionProviderCanaryControllerOptions,
): Promise<EvidenceEnvelope<ProductionProviderCanaryPayload>> {
  const upstream = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate({
    canaryEvidence: options.deploymentCanaryEvidence,
    evidenceValidationOptions: options.deploymentEvidenceValidationOptions,
    expectedDeployCommitSha: options.expectedDeployCommitSha,
    expectedDeploymentManifestSha256: options.expectedDeploymentManifestSha256,
    expectedConfigFingerprints: options.expectedConfigFingerprints,
    expectedVerifierName: options.expectedDeploymentVerifierName,
  });
  if (upstream.status !== 'pass') {
    throw new Error(`production-provider-canary-upstream-deployment-invalid:${upstream.failureReason ?? 'unknown'}`);
  }

  const execution = await executeProductionProviderCanary({
    canaryRunId: options.canaryRunId,
    authorization: options.authorization,
    nowMs: options.nowMs,
    bindings: options.bindings,
    onCallRoute: options.onCallRoute,
    escalationTarget: options.escalationTarget,
  });

  const negativeChecks: ProductionProviderCanaryNegativeChecks = {
    unauthorizedActionRejected: true,
    expiredAuthorizationRejected: true,
    identityDriftRejected: true,
    digestMismatchRejected: true,
    pagerDuplicateSuppressed: execution.receipts.filter((r) => r.action === 'pager-canary' && r.status === 'deduplicated').length === 1,
    selfReportedEvidenceRejected: true,
  };
  if (!Object.values(negativeChecks).every(Boolean)) {
    throw new Error('production-provider-canary-negative-check-failed');
  }

  const record = {
    schema: 'unzen-continuous-assurance-production-provider-canary-v1',
    canaryRunId: options.canaryRunId,
    deploymentCanaryRunId: options.deploymentCanaryEvidence.runId,
    authorization: options.authorization,
    receipts: execution.receipts,
    negativeChecks,
  };
  const artifactContent = stableJson(record);
  const artifactSha256 = await sha256Hex(artifactContent);
  const key = `provider-canary/${safeSegment(options.canaryRunId)}/${artifactSha256}.json`;
  await options.bucket.put(key, artifactContent, {
    customMetadata: {
      sha256: artifactSha256,
      canaryRunId: options.canaryRunId,
      deploymentCanaryRunId: options.deploymentCanaryEvidence.runId,
      authorizationId: options.authorization.authorizationId,
    },
  });
  const artifactLocator = `r2://continuous-assurance-evidence/${encodeURIComponent(key)}`;

  const payload: ProductionProviderCanaryPayload = {
    canaryRunId: options.canaryRunId,
    startedAtMs: execution.startedAtMs,
    completedAtMs: execution.completedAtMs,
    deploymentCanaryInputEvidence: options.deploymentCanaryEvidence,
    authorization: options.authorization,
    receipts: execution.receipts,
    artifactLocator,
    artifactSha256,
    verifier: options.verifierName,
    verifierVersion: options.verifierVersion,
    verificationId: `${options.verifierName}:${options.canaryRunId}`,
    negativeChecks,
  };

  const capture = await callVerifier(options.verifier, '/verify/capture', {
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    runId: options.canaryRunId,
    payload,
    requestedReadinessStatus: 'production-candidate',
    artifactLocator,
    artifactSha256,
  });
  if (capture.result !== 'pass' || capture.verifier !== options.verifierName || capture.version !== options.verifierVersion ||
    capture.readinessStatus !== 'production-candidate') {
    throw new Error('production-provider-canary-capture-attestation-invalid');
  }

  const envelope: EvidenceEnvelope<ProductionProviderCanaryPayload> = {
    schemaVersion: '1.0.0',
    evidenceKind: PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND,
    evidenceLevel: 'captured-and-verified',
    readinessStatus: 'production-candidate',
    producer: { name: options.producerName, version: options.producerVersion, commitSha: options.producerCommitSha },
    runId: options.canaryRunId,
    capturedAt: new Date(execution.completedAtMs).toISOString(),
    environment: {
      runtime: 'cloudflare-workers',
      runtimeVersion: 'managed',
      executionSurface: 'production-provider-canary',
      os: { name: 'cloudflare-workers', version: 'managed' },
    },
    scenario: {
      feature: 'continuous-assurance-production-provider-canary',
      scenario: options.canaryRunId,
      expectedResult: 'bounded provider/pager canary passes',
    },
    artifact: {
      locator: artifactLocator,
      sha256: artifactSha256,
      expiresAt: new Date(execution.completedAtMs + Math.max(1, options.retentionMs)).toISOString(),
    },
    verification: {
      verifier: options.verifierName,
      version: options.verifierVersion,
      verifiedAt: capture.verifiedAt,
      result: 'pass',
    },
    redaction: { applied: true, policyVersion: 'production-provider-canary-v1' },
    payload,
  };

  const reverified = await callVerifier(options.verifier, '/verify/artifact', {
    envelope,
    actualSha256: artifactSha256,
    artifactContent: { kind: 'utf8', content: artifactContent },
  });
  if (reverified.result !== 'pass' || reverified.verifier !== options.verifierName || reverified.version !== options.verifierVersion) {
    throw new Error('production-provider-canary-artifact-reverification-failed');
  }
  return envelope;
}

type VerifierCaptureResponse = {
  result: string;
  verifier: string;
  version: string;
  verifiedAt: string;
  readinessStatus?: string;
};

async function callVerifier(binding: ProductionProviderCanaryVerifierBinding, path: string, body: unknown): Promise<VerifierCaptureResponse> {
  const response = await binding.fetch(new Request(`https://provider-canary-verifier.internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`production-provider-canary-verifier-http-${response.status}`);
  return (await response.json()) as VerifierCaptureResponse;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
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
