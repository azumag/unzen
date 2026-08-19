import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';
import {
  PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND,
  runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate,
  type ContinuousAssuranceDeploymentServiceRole,
  type ContinuousAssuranceProductionDeploymentCanaryPayload,
} from './workers-coordinator-publisher-tax-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary.js';

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_OPERATIONS_ROLLOUT_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-operations-rollout' as const;

const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_ACTIONS = [
  'provider-health',
  'provider-audit',
  'primary-archive-retrieval',
  'backup-archive-retrieval',
  'pager-canary',
] as const;
export type ProductionProviderCanaryAction = typeof ALLOWED_ACTIONS[number];

export interface ProductionProviderCanaryAuthorization {
  readonly authorizationId: string;
  readonly changeTicketId: string;
  readonly authorizedAtMs: number;
  readonly startsAtMs: number;
  readonly expiresAtMs: number;
  readonly approvers: readonly string[];
  readonly providerName: string;
  readonly accountId: string;
  readonly primaryStorageId: string;
  readonly backupStorageId: string;
  readonly archiveId: string;
  readonly archiveContentDigest: string;
  readonly allowedActions: readonly ProductionProviderCanaryAction[];
  readonly deploymentVersionIds: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
  readonly deploymentConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
}

export interface ProductionProviderCanaryReceipt {
  readonly action: ProductionProviderCanaryAction;
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly observedAtMs: number;
  readonly status: 'success' | 'deduplicated';
  readonly providerName?: string;
  readonly accountId?: string;
  readonly storageId?: string;
  readonly archiveId?: string;
  readonly observedContentDigest?: string;
  readonly integrityStatus?: 'pass' | 'fail';
  readonly pagerDeliveryId?: string;
}

export interface ProductionProviderCanaryNegativeChecks {
  readonly unauthorizedActionRejected: boolean;
  readonly expiredAuthorizationRejected: boolean;
  readonly identityDriftRejected: boolean;
  readonly digestMismatchRejected: boolean;
  readonly pagerDuplicateSuppressed: boolean;
  readonly selfReportedEvidenceRejected: boolean;
}

export interface ProductionProviderCanaryPayload {
  readonly canaryRunId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly deploymentCanaryInputEvidence: EvidenceEnvelope<ContinuousAssuranceProductionDeploymentCanaryPayload>;
  readonly authorization: ProductionProviderCanaryAuthorization;
  readonly receipts: readonly ProductionProviderCanaryReceipt[];
  readonly artifactLocator: string;
  readonly artifactSha256: string;
  readonly verifier: string;
  readonly verifierVersion: string;
  readonly verificationId: string;
  readonly negativeChecks: ProductionProviderCanaryNegativeChecks;
}

export interface ProductionProviderCanaryGateOptions {
  readonly canaryEvidence: EvidenceEnvelope<ProductionProviderCanaryPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
  readonly deploymentEvidenceValidationOptions?: EvidenceValidationOptions;
  readonly expectedDeployCommitSha: string;
  readonly expectedDeploymentManifestSha256: string;
  readonly expectedConfigFingerprints: Readonly<Record<ContinuousAssuranceDeploymentServiceRole, string>>;
  readonly expectedVerifierName?: string;
  readonly expectedDeploymentVerifierName?: string;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionProviderCanaryGate(
  options: ProductionProviderCanaryGateOptions,
) {
  const reasons: string[] = [];
  const validation = await validateEvidenceEnvelope<ProductionProviderCanaryPayload>(
    options.canaryEvidence,
    options.evidenceValidationOptions,
  );
  const payload = validation.envelope?.payload;

  if (options.canaryEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_PROVIDER_CANARY_EVIDENCE_KIND) {
    reasons.push('production-provider-canary-evidence-kind-invalid');
  }
  if (!evidenceSupportsReadiness(validation, 'production-candidate')) {
    reasons.push('production-provider-canary-evidence-not-production-candidate');
  }
  if (!payload) reasons.push('production-provider-canary-payload-missing');

  let deploymentReport: Awaited<ReturnType<typeof runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate>> | null = null;
  if (payload) {
    if (payload.deploymentCanaryInputEvidence.evidenceKind !==
      PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_EVIDENCE_KIND) {
      reasons.push('production-provider-canary-deployment-evidence-kind-invalid');
    }
    deploymentReport = await runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceProductionDeploymentCanaryGate({
      canaryEvidence: payload.deploymentCanaryInputEvidence,
      evidenceValidationOptions: options.deploymentEvidenceValidationOptions,
      expectedDeployCommitSha: options.expectedDeployCommitSha,
      expectedDeploymentManifestSha256: options.expectedDeploymentManifestSha256,
      expectedConfigFingerprints: options.expectedConfigFingerprints,
      expectedVerifierName: options.expectedDeploymentVerifierName,
    });
    if (deploymentReport.status !== 'pass') reasons.push('production-provider-canary-upstream-deployment-invalid');

    validateAuthorization(payload, reasons);
    validateDeploymentBinding(payload, reasons);
    validateReceipts(payload, reasons);

    if (!payload.artifactLocator || !SHA256.test(payload.artifactSha256) || !payload.verifier ||
      !payload.verifierVersion || !payload.verificationId) {
      reasons.push('production-provider-canary-artifact-invalid');
    }
    if (options.expectedVerifierName && payload.verifier !== options.expectedVerifierName) {
      reasons.push('production-provider-canary-verifier-invalid');
    }
    if (!Object.values(payload.negativeChecks).every(Boolean)) {
      reasons.push('production-provider-canary-negative-check-incomplete');
    }
    if (!payload.canaryRunId || payload.completedAtMs < payload.startedAtMs ||
      payload.startedAtMs < payload.authorization.startsAtMs ||
      payload.completedAtMs > payload.authorization.expiresAtMs) {
      reasons.push('production-provider-canary-timeline-invalid');
    }
    if (options.canaryEvidence.runId !== payload.canaryRunId ||
      Date.parse(options.canaryEvidence.capturedAt) !== payload.completedAtMs ||
      options.canaryEvidence.artifact?.locator !== payload.artifactLocator ||
      options.canaryEvidence.artifact?.sha256 !== payload.artifactSha256) {
      reasons.push('production-provider-canary-envelope-binding-invalid');
    }
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-provider-canary-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    canaryInputEvidence: options.canaryEvidence,
    deploymentCanaryInputEvidence: payload?.deploymentCanaryInputEvidence ?? null,
    upstreamDeploymentStatus: deploymentReport?.status ?? null,
    authorizationId: payload?.authorization.authorizationId ?? null,
    actionCount: payload?.receipts.length ?? 0,
    evidenceSummary: {
      validationStatus: validation.status,
      effectiveEvidenceLevel: validation.effectiveEvidenceLevel,
      effectiveReadinessStatus: validation.effectiveReadinessStatus,
    },
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

function validateAuthorization(payload: ProductionProviderCanaryPayload, reasons: string[]): void {
  const auth = payload.authorization;
  if (!auth.authorizationId || !auth.changeTicketId || !auth.providerName || !auth.accountId ||
    !auth.primaryStorageId || !auth.backupStorageId || !auth.archiveId || !SHA256.test(auth.archiveContentDigest)) {
    reasons.push('production-provider-canary-authorization-identity-invalid');
  }
  if (!Number.isFinite(auth.authorizedAtMs) || !Number.isFinite(auth.startsAtMs) ||
    !Number.isFinite(auth.expiresAtMs) || auth.authorizedAtMs > auth.startsAtMs ||
    auth.expiresAtMs <= auth.startsAtMs) {
    reasons.push('production-provider-canary-authorization-window-invalid');
  }
  if (new Set(auth.approvers.filter(Boolean)).size < 2) {
    reasons.push('production-provider-canary-two-person-approval-required');
  }
  const actions = [...auth.allowedActions];
  if (actions.length !== ALLOWED_ACTIONS.length || new Set(actions).size !== actions.length ||
    ALLOWED_ACTIONS.some((action) => !actions.includes(action)) ||
    actions.some((action) => !ALLOWED_ACTIONS.includes(action))) {
    reasons.push('production-provider-canary-action-allowlist-invalid');
  }
}

function validateDeploymentBinding(payload: ProductionProviderCanaryPayload, reasons: string[]): void {
  const deployments = payload.deploymentCanaryInputEvidence.payload.deployments;
  for (const deployment of deployments) {
    if (payload.authorization.deploymentVersionIds[deployment.role] !== deployment.versionId ||
      payload.authorization.deploymentConfigFingerprints[deployment.role] !== deployment.configFingerprintSha256) {
      reasons.push(`production-provider-canary-deployment-binding-mismatch:${deployment.role}`);
    }
  }
}

function validateReceipts(payload: ProductionProviderCanaryPayload, reasons: string[]): void {
  const auth = payload.authorization;
  for (const action of ALLOWED_ACTIONS) {
    const matches = payload.receipts.filter((receipt) => receipt.action === action);
    const expectedCount = action === 'pager-canary' ? 2 : 1;
    if (matches.length !== expectedCount) reasons.push(`production-provider-canary-receipt-cardinality-invalid:${action}`);
  }
  for (const receipt of payload.receipts) {
    if (!auth.allowedActions.includes(receipt.action) || !receipt.idempotencyKey || !receipt.operationId ||
      !Number.isFinite(receipt.observedAtMs) || receipt.observedAtMs < payload.startedAtMs ||
      receipt.observedAtMs > payload.completedAtMs) {
      reasons.push(`production-provider-canary-receipt-invalid:${receipt.action}`);
    }
    if (receipt.action !== 'pager-canary') {
      if (receipt.providerName !== auth.providerName || receipt.accountId !== auth.accountId) {
        reasons.push(`production-provider-canary-provider-identity-mismatch:${receipt.action}`);
      }
    }
    if (receipt.action === 'primary-archive-retrieval' || receipt.action === 'backup-archive-retrieval') {
      const expectedStorage = receipt.action === 'primary-archive-retrieval'
        ? auth.primaryStorageId : auth.backupStorageId;
      if (receipt.storageId !== expectedStorage || receipt.archiveId !== auth.archiveId ||
        receipt.observedContentDigest !== auth.archiveContentDigest || receipt.integrityStatus !== 'pass') {
        reasons.push(`production-provider-canary-archive-integrity-mismatch:${receipt.action}`);
      }
    }
  }
  const pager = payload.receipts.filter((receipt) => receipt.action === 'pager-canary');
  if (pager.length === 2 && (pager[0].idempotencyKey !== pager[1].idempotencyKey ||
    pager[0].status !== 'success' || pager[1].status !== 'deduplicated')) {
    reasons.push('production-provider-canary-pager-dedupe-invalid');
  }
  const nonPager = payload.receipts.filter((receipt) => receipt.action !== 'pager-canary');
  if (new Set(nonPager.map((receipt) => receipt.idempotencyKey)).size !== nonPager.length) {
    reasons.push('production-provider-canary-idempotency-key-duplicate');
  }
}
