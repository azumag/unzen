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

export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_ADAPTER_CANARY_EVIDENCE_KIND =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-adapter-canary' as const;
export const PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_BOTTLENECK =
  'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-production-deployment-canary' as const;

export type ContinuousAssuranceAdapterCanaryAction =
  | 'provider-audit'
  | 'primary-archive-retrieval'
  | 'backup-archive-retrieval'
  | 'provider-health'
  | 'evidence-cycle-archive'
  | 'evidence-cycle-capture'
  | 'evidence-artifact-load'
  | 'evidence-artifact-verify'
  | 'pager-page';

export interface ContinuousAssuranceAdapterCanaryReceipt {
  readonly adapter: 'provider' | 'evidence' | 'pager';
  readonly action: ContinuousAssuranceAdapterCanaryAction;
  readonly requestId: string;
  readonly path: string;
  readonly idempotencyKey: string;
  readonly idempotencyPreserved: boolean;
  readonly status: 'success' | 'expected-failure';
  readonly observedAtMs: number;
}

export interface ContinuousAssuranceAdapterCanaryNegativeChecks {
  readonly missingIdempotencyRejected: boolean;
  readonly providerFailureRejected: boolean;
  readonly digestMismatchRejected: boolean;
  readonly verifierFailureRejected: boolean;
  readonly pagerDuplicateSuppressed: boolean;
}

export interface ContinuousAssuranceAdapterCanaryPayload {
  readonly scope: string;
  readonly cron: string;
  readonly scheduledTimeMs: number;
  readonly triggerKey: string;
  readonly canaryRunId: string;
  readonly engineService: string;
  readonly providerAdapterService: string;
  readonly evidenceAdapterService: string;
  readonly pagerAdapterService: string;
  readonly independentVerifierService: string;
  readonly configFingerprintSha256: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly receipts: readonly ContinuousAssuranceAdapterCanaryReceipt[];
  readonly artifactLocator: string;
  readonly artifactSha256: string;
  readonly verifier: string;
  readonly verifierVersion: string;
  readonly verificationId: string;
  readonly pagerDedupeKey: string;
  readonly negativeChecks: ContinuousAssuranceAdapterCanaryNegativeChecks;
}

export interface ContinuousAssuranceAdapterCanaryGateOptions {
  readonly canaryEvidence: EvidenceEnvelope<ContinuousAssuranceAdapterCanaryPayload>;
  readonly evidenceValidationOptions?: EvidenceValidationOptions;
  readonly expectedEngineService?: string;
  readonly expectedVerifierName?: string;
}

export async function runWorkersCoordinatorPublisherTaxProductionArchiveDrProviderContinuousAssuranceAdapterCanaryGate(
  options: ContinuousAssuranceAdapterCanaryGateOptions,
) {
  const reasons: string[] = [];
  const validation = await validateEvidenceEnvelope<ContinuousAssuranceAdapterCanaryPayload>(
    options.canaryEvidence,
    options.evidenceValidationOptions,
  );
  const payload = validation.envelope?.payload;

  if (options.canaryEvidence.evidenceKind !== PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_ADAPTER_CANARY_EVIDENCE_KIND) {
    reasons.push('adapter-canary-evidence-kind-invalid');
  }
  if (!evidenceSupportsReadiness(validation, 'production-candidate')) {
    reasons.push('adapter-canary-evidence-not-production-candidate');
  }
  if (!payload) reasons.push('adapter-canary-payload-missing');

  if (payload) {
    const expectedTriggerKey = `${payload.scope}:${payload.cron}:${payload.scheduledTimeMs}`;
    if (!payload.scope || !payload.cron || payload.triggerKey !== expectedTriggerKey) {
      reasons.push('adapter-canary-trigger-identity-invalid');
    }
    if (!payload.canaryRunId || payload.completedAtMs < payload.startedAtMs ||
      payload.startedAtMs < payload.scheduledTimeMs) {
      reasons.push('adapter-canary-timeline-invalid');
    }
    if (payload.engineService !== (options.expectedEngineService ?? 'unzen-llm-continuous-assurance-engine') ||
      payload.providerAdapterService !== CONTINUOUS_ASSURANCE_PROVIDER_ADAPTER_SERVICE ||
      payload.evidenceAdapterService !== CONTINUOUS_ASSURANCE_EVIDENCE_ADAPTER_SERVICE ||
      payload.pagerAdapterService !== CONTINUOUS_ASSURANCE_PAGER_ADAPTER_SERVICE ||
      payload.independentVerifierService !== CONTINUOUS_ASSURANCE_INDEPENDENT_VERIFIER_SERVICE) {
      reasons.push('adapter-canary-service-identity-invalid');
    }
    if (!/^[a-f0-9]{64}$/.test(payload.configFingerprintSha256)) {
      reasons.push('adapter-canary-config-fingerprint-invalid');
    }
    if (!payload.artifactLocator || !/^[a-f0-9]{64}$/.test(payload.artifactSha256) ||
      !payload.verificationId || !payload.verifier || !payload.verifierVersion) {
      reasons.push('adapter-canary-evidence-artifact-invalid');
    }
    if (options.expectedVerifierName && payload.verifier !== options.expectedVerifierName) {
      reasons.push('adapter-canary-verifier-identity-invalid');
    }

    validateReceipts(payload, reasons);
    if (!Object.values(payload.negativeChecks).every(Boolean)) {
      reasons.push('adapter-canary-negative-check-incomplete');
    }
    const pager = payload.receipts.find((receipt) => receipt.action === 'pager-page');
    if (!pager || pager.idempotencyKey !== payload.pagerDedupeKey) {
      reasons.push('adapter-canary-pager-dedupe-invalid');
    }
    const envelopeCapturedAtMs = Date.parse(options.canaryEvidence.capturedAt);
    if (!Number.isFinite(envelopeCapturedAtMs) || envelopeCapturedAtMs !== payload.completedAtMs) {
      reasons.push('adapter-canary-capture-timeline-invalid');
    }
  }

  const failureReason = reasons[0];
  return {
    runtime: 'publisher-tax-filing-production-exception-archive-dr-provider-continuous-assurance-adapter-canary-gate' as const,
    status: failureReason ? 'fail' as const : 'pass' as const,
    canaryInputEvidence: options.canaryEvidence,
    evidenceSummary: {
      validationStatus: validation.status,
      effectiveEvidenceLevel: validation.effectiveEvidenceLevel,
      effectiveReadinessStatus: validation.effectiveReadinessStatus,
      evidenceKind: options.canaryEvidence.evidenceKind,
      runId: options.canaryEvidence.runId,
    },
    adapterServices: payload ? {
      engine: payload.engineService,
      provider: payload.providerAdapterService,
      evidence: payload.evidenceAdapterService,
      pager: payload.pagerAdapterService,
      verifier: payload.independentVerifierService,
    } : null,
    configFingerprintSha256: payload?.configFingerprintSha256 ?? null,
    receiptCount: payload?.receipts.length ?? 0,
    negativeChecks: payload?.negativeChecks ?? null,
    promoteHoldThresholds: {
      decision: failureReason ? 'hold' as const : 'promote' as const,
      holdReasons: reasons,
    },
    failureReason,
    bottlenecksToIssue: failureReason
      ? []
      : [PUBLISHER_TAX_EXCEPTION_ARCHIVE_DR_PROVIDER_CONTINUOUS_ASSURANCE_PRODUCTION_DEPLOYMENT_CANARY_BOTTLENECK],
  };
}

function validateReceipts(
  payload: ContinuousAssuranceAdapterCanaryPayload,
  reasons: string[],
): void {
  const required: readonly ContinuousAssuranceAdapterCanaryAction[] = [
    'provider-audit',
    'primary-archive-retrieval',
    'backup-archive-retrieval',
    'provider-health',
    'evidence-cycle-archive',
    'evidence-cycle-capture',
    'evidence-artifact-load',
    'evidence-artifact-verify',
    'pager-page',
  ];
  const seen = new Set<string>();
  for (const action of required) {
    const matches = payload.receipts.filter((receipt) => receipt.action === action && receipt.status === 'success');
    if (matches.length !== 1) reasons.push(`adapter-canary-receipt-cardinality-invalid:${action}`);
  }
  for (const receipt of payload.receipts) {
    if (!receipt.requestId || !receipt.path || !receipt.idempotencyKey || !receipt.idempotencyPreserved ||
      !Number.isFinite(receipt.observedAtMs) || receipt.observedAtMs < payload.startedAtMs ||
      receipt.observedAtMs > payload.completedAtMs) {
      reasons.push(`adapter-canary-receipt-invalid:${receipt.action}`);
      continue;
    }
    const identity = `${receipt.adapter}:${receipt.action}:${receipt.requestId}`;
    if (seen.has(identity)) reasons.push(`adapter-canary-receipt-duplicate:${receipt.action}`);
    seen.add(identity);
  }
}
