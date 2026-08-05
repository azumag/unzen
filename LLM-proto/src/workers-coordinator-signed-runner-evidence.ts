import type {
  EvidenceLevel,
  EvidenceValidationResult,
  EvidenceValidationStatus,
  ReadinessStatus,
} from './evidence.js';

// Ordered readiness ladder used to cap a gate's reported maturity by the most
// conservative upstream evidence. The values mirror the READINESS_RANK table in
// evidence.ts, which is intentionally not exported so gates cannot mint ranks.
const READINESS_LADDER: readonly ReadinessStatus[] = [
  'design-only',
  'contract-tested',
  'runtime-observed',
  'verified-pilot',
  'production-candidate',
  'production-approved',
];

// Provenance carried on every signed-runner gate report so that a passing
// contract test is reported as `contract-tested`, never as production-ready.
// The fields come from the EvidenceValidationResult produced by
// validateEvidenceEnvelope(), not from a hand-written `source` field.
export interface WorkersCoordinatorSignedRunnerEvidenceProvenance {
  readonly validationStatus: EvidenceValidationStatus;
  readonly evidenceKind: string;
  readonly evidenceLevel: EvidenceLevel;
  readonly readinessStatus: ReadinessStatus;
  readonly producerName: string;
  readonly producerVersion: string;
  readonly runId: string;
  readonly capturedAt: string;
  readonly issueCodes: readonly string[];
}

// Derives the provenance a gate reports from the validator result. For invalid
// and not-evaluated results the effective levels are absent, so the claimed
// levels are surfaced for diagnostics while validationStatus signals the
// rejection to downstream consumers.
export function deriveSignedRunnerEvidenceProvenance(
  validation: EvidenceValidationResult,
): WorkersCoordinatorSignedRunnerEvidenceProvenance {
  return {
    validationStatus: validation.status,
    evidenceKind: validation.envelope?.evidenceKind ?? 'unknown',
    evidenceLevel: validation.effectiveEvidenceLevel
      ?? validation.claimedEvidenceLevel
      ?? 'synthetic-fixture',
    readinessStatus: validation.effectiveReadinessStatus
      ?? validation.claimedReadinessStatus
      ?? 'design-only',
    producerName: validation.envelope?.producer.name ?? 'unknown',
    producerVersion: validation.envelope?.producer.version ?? 'unknown',
    runId: validation.envelope?.runId ?? 'unknown',
    capturedAt: validation.envelope?.capturedAt ?? '',
    issueCodes: validation.issues.map((issue) => issue.code),
  };
}

// Returns a gate failure reason when the envelope did not validate, or
// undefined when it is safe to treat the payload as trusted contract input.
export function evidenceValidationFailureReason(
  prefix: string,
  validation: EvidenceValidationResult,
): string | undefined {
  if (validation.status === 'valid') {
    return undefined;
  }
  const code = validation.issues[0]?.code ?? validation.status;
  return `${prefix}: ${code}`;
}

// Caps a gate's reported readiness by the most conservative value seen across
// the gate's own envelope and the upstream gate report. This prevents a
// synthetic-fixture upstream from becoming the production root cause of a
// downstream gate that received captured-and-verified evidence of its own.
export function capSignedRunnerReadiness(
  primary: ReadinessStatus,
  upstream: ReadinessStatus,
): ReadinessStatus {
  return rankOf(primary) <= rankOf(upstream) ? primary : upstream;
}

function rankOf(status: ReadinessStatus): number {
  const rank = READINESS_LADDER.indexOf(status);
  return rank === -1 ? 0 : rank;
}
