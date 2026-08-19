import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import {
  CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE,
  CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
  CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-adapters.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary' as const;

export const CONTINUOUS_ASSURANCE_RUNTIME_SERVICE = 'unzen-llm-continuous-assurance' as const;
export const CONTINUOUS_ASSURANCE_ENGINE_SERVICE = 'unzen-llm-continuous-assurance-engine' as const;
export const CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE = 'unzen-llm-continuous-assurance-production-canary' as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const VERSION_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export type ContinuousAssuranceDeploymentServiceRole =
  | 'controller'
  | 'runtime'
  | 'engine'
  | 'provider'
  | 'evidence'
  | 'pager'
  | 'verifier';

export interface ContinuousAssuranceWorkerDeploymentIdentity {
  readonly role: ContinuousAssuranceDeploymentServiceRole;
  readonly service: string;
  readonly versionId: string;
  readonly versionTag: string | null;
  readonly versionTimestamp: string;
  readonly configFingerprintSha256: string;
}

export interface ContinuousAssuranceDeploymentRuntimeResult {
  readonly status: 'pass' | 'hold' | 'idle' | 'in-progress';
  readonly triggerKey: string;
  readonly cycleId: string | null;
  readonly failureReason: string | null;
  readonly actionIdempotencyKeys: readonly string[];
  readonly latestCycleRunId: string | null;
  readonly latestAggregateRunId: string | null;
  readonly runtimeDelivery: {
    readonly durableState: 'completed' | 'running';
    readonly replayCount: number;
    readonly replayed: boolean;
  };
}

export interface ContinuousAssuranceProductionDeploymentNegativeChecks {
  readonly badDispatchSecretRejected: boolean;
  readonly duplicateCompletedDispatchSuppressed: boolean;
  readonly versionOrConfigMismatchRejected: boolean;
  readonly digestMismatchRejected: boolean;
  readonly untrustedVerifierRejected: boolean;
}

export interface ContinuousAssuranceProductionDeploymentCanaryPayload {
  readonly scope: string;
  readonly cron: string;
  readonly scheduledTimeMs: number;
  readonly triggerKey: string;
  readonly canaryRunId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly deployCommitSha: string;
  readonly deploymentManifestSha256: string;
  readonly deployments: readonly ContinuousAssuranceWorkerDeploymentIdentity[];
  readonly runtimeResult: ContinuousAssuranceDeploymentRuntimeResult;
  readonly artifactLocator: string;
  readonly artifactSha256: string;
  readonly verificationId: string;
  readonly verifier: string;
  readonly verifierVersion: string;
  readonly negativeChecks: ContinuousAssuranceProductionDeploymentNegativeChecks;
  readonly capturedAtMs: number;
}

export interface ContinuousAssuranceProductionDeploymentCanaryGateOptions {
  readonly canaryEvidence: EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
  readonly expectedVerifierName?: string;
  readonly expectedDeployCommitSha: string;
  readonly expectedDeploymentManifestSha256: string;
  readonly expectedConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
}

const EXPECTED_SERVICES: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>> = {
  controller: CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE,
  runtime: CONTINUOUS_ASSURANCE_RUNTIME_SERVICE,
  engine: CONTINUOUS_ASSURANCE_ENGINE_SERVICE,
  provider: CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE,
  evidence: CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE,
  pager: CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE,
  verifier: CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE,
};

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate(
  options: ContinuousAssuranceProductionDeploymentCanaryGateOptions,
) {
  const reasons: string[] = [];
  const validation = await validateEvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>(
    options.canaryEvidence,
    options.evidenceValidationOptions,
  );
  const payload = validation.envelope?.payload;

  if (options.canaryEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND) {
    reasons.push('production-deployment-canary-evidence-kind-invalid');
  }
  if (!evidenceSupportsReadiness(validation, 'production-candidate')) {
    reasons.push('production-deployment-canary-evidence-not-production-candidate');
  }
  if (!GIT_COMMIT_PATTERN.test(options.expectedDeployCommitSha) ||
    !SHA256_PATTERN.test(options.expectedDeploymentManifestSha256)) {
    reasons.push('production-deployment-canary-expected-deployment-identity-invalid');
  }
  if (!payload) reasons.push('production-deployment-canary-payload-missing');

  if (payload) {
    const expectedTriggerKey = `${payload.scope}:${payload.cron}:${payload.scheduledTimeMs}`;
    if (!payload.scope || !payload.cron || payload.triggerKey !== expectedTriggerKey ||
      payload.runtimeResult.triggerKey !== expectedTriggerKey) {
      reasons.push('production-deployment-canary-trigger-identity-invalid');
    }
    if (!payload.canaryRunId || payload.startedAtMs < payload.scheduledTimeMs ||
      payload.completedAtMs < payload.startedAtMs || payload.capturedAtMs !== payload.completedAtMs) {
      reasons.push('production-deployment-canary-timeline-invalid');
    }
    if (!GIT_COMMIT_PATTERN.test(payload.deployCommitSha) || payload.deployCommitSha !== options.expectedDeployCommitSha ||
      !SHA256_PATTERN.test(payload.deploymentManifestSha256) ||
      payload.deploymentManifestSha256 !== options.expectedDeploymentManifestSha256) {
      reasons.push('production-deployment-canary-deployment-manifest-mismatch');
    }
    validateDeployments(payload.deployments, options.expectedConfigFingerprints, reasons);
    validateRuntimeResult(payload.runtimeResult, reasons);
    if (!payload.artifactLocator || !SHA256_PATTERN.test(payload.artifactSha256) ||
      !payload.verificationId || !payload.verifier || !payload.verifierVersion) {
      reasons.push('production-deployment-canary-artifact-invalid');
    }
    if (options.expectedVerifierName && payload.verifier !== options.expectedVerifierName) {
      reasons.push('production-deployment-canary-verifier-invalid');
    }
    if (!Object.values(payload.negativeChecks).every(Boolean)) {
      reasons.push('production-deployment-canary-negative-check-incomplete');
    }
    const capturedAtMs = Date.parse(options.canaryEvidence.capturedAt);
    if (!Number.isFinite(capturedAtMs) || capturedAtMs !== payload.capturedAtMs) {
      reasons.push('production-deployment-canary-envelope-timeline-invalid');
    }
    if (options.canaryEvidence.runId !== payload.canaryRunId) {
      reasons.push('production-deployment-canary-run-identity-invalid');
    }
    if (options.canaryEvidence.producer.commitSha !== payload.deployCommitSha) {
      reasons.push('production-deployment-canary-envelope-commit-mismatch');
    }
    if (options.canaryEvidence.artifact?.locator !== payload.artifactLocator ||
      options.canaryEvidence.artifact?.sha256 !== payload.artifactSha256) {
      reasons.push('production-deployment-canary-envelope-artifact-mismatch');
    }
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    canaryInputEvidence: options.canaryEvidence,
    evidenceSummary: {
      validationStatus: validation.status,
      effectiveEvidenceLevel: validation.effectiveEvidenceLevel,
      effectiveReadinessStatus: validation.effectiveReadinessStatus,
      evidenceKind: options.canaryEvidence.evidenceKind,
      runId: options.canaryEvidence.runId,
    },
    deploymentManifestSha256: payload?.deploymentManifestSha256 ?? null,
    deployCommitSha: payload?.deployCommitSha ?? null,
    deploymentVersionIds: payload
      ? Object.fromEntries(payload.deployments.map((deployment) => [deployment.role, deployment.versionId]))
      : null,
    runtimeResult: payload?.runtimeResult ?? null,
    negativeChecks: payload?.negativeChecks ?? null,
    promoteHoldThresholds: {
      decision: failureReason ? 'hold' as const : 'promote' as const,
      holdReasons: reasons,
    },
    failureReason,
    bottlenecksToIssue: failureReason
      ? []
      : [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_BOTTLENECK],
  };
}

function validateDeployments(
  deployments: readonly ContinuousAssuranceWorkerDeploymentIdentity[],
  expectedConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>,
  reasons: string[],
): void {
  const roles = Object.keys(EXPECTED_SERVICES) as ContinuousAssuranceDeploymentServiceRole[];
  const versionIds = new Set<string>();
  for (const role of roles) {
    const matches = deployments.filter((deployment) => deployment.role === role);
    if (matches.length !== 1) {
      reasons.push(`production-deployment-canary-deployment-cardinality-invalid:${role}`);
      continue;
    }
    const deployment = matches[0];
    const expectedFingerprint = expectedConfigFingerprints?.[role];
    if (deployment.service !== EXPECTED_SERVICES[role] ||
      !VERSION_ID_PATTERN.test(deployment.versionId) ||
      !SHA256_PATTERN.test(deployment.configFingerprintSha256) ||
      !SHA256_PATTERN.test(expectedFingerprint ?? '') ||
      deployment.configFingerprintSha256 !== expectedFingerprint ||
      !deployment.versionTimestamp || !Number.isFinite(Date.parse(deployment.versionTimestamp))) {
      reasons.push(`production-deployment-canary-deployment-invalid:${role}`);
    }
    if (versionIds.has(deployment.versionId)) {
      reasons.push(`production-deployment-canary-version-id-duplicate:${role}`);
    }
    versionIds.add(deployment.versionId);
  }
  if (deployments.length !== roles.length) reasons.push('production-deployment-canary-deployment-set-invalid');
}

function validateRuntimeResult(
  result: ContinuousAssuranceDeploymentRuntimeResult,
  reasons: string[],
): void {
  if (result.status !== 'idle' || result.runtimeDelivery.durableState !== 'completed' ||
    result.runtimeDelivery.replayCount !== 0 || result.runtimeDelivery.replayed || result.failureReason) {
    reasons.push('production-deployment-canary-runtime-not-clean');
  }
  if (!result.cycleId || result.latestCycleRunId !== null || result.latestAggregateRunId !== null) {
    reasons.push('production-deployment-canary-runtime-output-invalid');
  }
  if (result.actionIdempotencyKeys.length !== 0) {
    reasons.push('production-deployment-canary-read-only-actions-detected');
  }
}
