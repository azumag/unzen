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
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout' as const;

export const CONTINUOUS_ASSURANCE_RUNTIME_SERVICE = 'unzen-llm-continuous-assurance' as const;
export const CONTINUOUS_ASSURANCE_ENGINE_SERVICE = 'unzen-llm-continuous-assurance-engine' as const;
export const CONTINUOUS_ASSURANCE_PRODUCTION_CANARY_SERVICE = 'unzen-llm-continuous-assurance-production-canary' as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
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
    validateDeployments(payload.deployments, reasons);
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
      : [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK],
  };
}

function validateDeployments(
  deployments: readonly ContinuousAssuranceWorkerDeploymentIdentity[],
  reasons: string[],
): void {
  const roles = Object.keys(EXPECTED_SERVICES) as ContinuousAssuranceDeploymentServiceRole[];
  for (const role of roles) {
    const matches = deployments.filter((deployment) => deployment.role === role);
    if (matches.length !== 1) {
      reasons.push(`production-deployment-canary-deployment-cardinality-invalid:${role}`);
      continue;
    }
    const deployment = matches[0];
    if (deployment.service !== EXPECTED_SERVICES[role] ||
      !VERSION_ID_PATTERN.test(deployment.versionId) ||
      !SHA256_PATTERN.test(deployment.configFingerprintSha256) ||
      !deployment.versionTimestamp || !Number.isFinite(Date.parse(deployment.versionTimestamp))) {
      reasons.push(`production-deployment-canary-deployment-invalid:${role}`);
    }
  }
  if (deployments.length !== roles.length) reasons.push('production-deployment-canary-deployment-set-invalid');
}

function validateRuntimeResult(
  result: ContinuousAssuranceDeploymentRuntimeResult,
  reasons: string[],
): void {
  if (result.status !== 'pass' || result.runtimeDelivery.durableState !== 'completed' ||
    result.runtimeDelivery.replayCount !== 0 || result.runtimeDelivery.replayed || result.failureReason) {
    reasons.push('production-deployment-canary-runtime-not-clean');
  }
  if (!result.cycleId || !result.latestCycleRunId || !result.latestAggregateRunId) {
    reasons.push('production-deployment-canary-runtime-output-incomplete');
  }
  if (result.actionIdempotencyKeys.length === 0 ||
    result.actionIdempotencyKeys.some((key) => !key || key.length > 512) ||
    new Set(result.actionIdempotencyKeys).size !== result.actionIdempotencyKeys.length) {
    reasons.push('production-deployment-canary-idempotency-set-invalid');
  }
}
