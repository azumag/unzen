import {
  evidenceSupportsReadiness,
  validateEvidenceEnvelope,
  type EvidenceLevel,
  type EvidenceValidationOptions,
  type EvidenceValidationResult,
  type ReadinessStatus,
} from './evidence.js';
import type {
  WorkersCoordinatorSignedRunnerBrowserPreviewReport,
} from './workers-coordinator-signed-runner-browser-preview.js';
import {
  runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot,
  type WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence,
  type WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport,
} from './workers-coordinator-signed-runner-webgpu-worker-pilot.js';

export const SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND =
  'signed-runner-webgpu-worker-pilot' as const;

export type WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGateStatus =
  | 'pass'
  | 'fail'
  | 'not-evaluated';

export type WorkersCoordinatorSignedRunnerWebGpuWorkerPilotMinimumReadiness = Extract<
  ReadinessStatus,
  'verified-pilot' | 'production-candidate' | 'production-approved'
>;

export interface WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGateOptions {
  readonly previewReport: WorkersCoordinatorSignedRunnerBrowserPreviewReport;
  /** Untrusted input. Trust anchors must come from validationOptions. */
  readonly evidenceEnvelope: unknown;
  readonly validationOptions: EvidenceValidationOptions;
  readonly minimumReadiness?: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotMinimumReadiness;
}

export interface WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGateReport {
  readonly runtime: 'signed-runner-webgpu-worker-pilot-evidence-gate';
  readonly status: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGateStatus;
  readonly minimumReadiness: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotMinimumReadiness;
  readonly evidenceValidation: EvidenceValidationResult<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence>;
  readonly effectiveEvidenceLevel?: EvidenceLevel;
  readonly effectiveReadinessStatus?: ReadinessStatus;
  readonly contractReport?: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport;
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export async function runWorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGate(
  options: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGateOptions,
): Promise<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidenceGateReport> {
  const minimumReadiness = options.minimumReadiness ?? 'verified-pilot';
  const evidenceValidation =
    await validateEvidenceEnvelope<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence>(
      options.evidenceEnvelope,
      options.validationOptions,
    );

  const base = {
    runtime: 'signed-runner-webgpu-worker-pilot-evidence-gate' as const,
    minimumReadiness,
    evidenceValidation,
    effectiveEvidenceLevel: evidenceValidation.effectiveEvidenceLevel,
    effectiveReadinessStatus: evidenceValidation.effectiveReadinessStatus,
  };

  if (evidenceValidation.status === 'invalid') {
    const failureReason = `webgpu-pilot-evidence-invalid: ${issueCodes(evidenceValidation)}`;
    return {
      ...base,
      status: 'fail',
      failureReason,
      bottlenecksToIssue: ['signed-runner-webgpu-pilot-evidence-validation'],
    };
  }

  if (evidenceValidation.status === 'not-evaluated') {
    const failureReason = `webgpu-pilot-evidence-not-evaluated: ${issueCodes(evidenceValidation)}`;
    return {
      ...base,
      status: 'not-evaluated',
      failureReason,
      bottlenecksToIssue: ['signed-runner-webgpu-pilot-artifact-capture-or-verifier'],
    };
  }

  const envelope = evidenceValidation.envelope;
  if (!envelope) {
    return {
      ...base,
      status: 'fail',
      failureReason: 'webgpu-pilot-evidence-valid-without-envelope',
      bottlenecksToIssue: ['signed-runner-webgpu-pilot-evidence-validation'],
    };
  }

  if (envelope.evidenceKind !== SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND) {
    return {
      ...base,
      status: 'fail',
      failureReason: `webgpu-pilot-evidence-kind-mismatch: ${envelope.evidenceKind}`,
      bottlenecksToIssue: ['signed-runner-webgpu-pilot-evidence-kind'],
    };
  }

  if (!evidenceSupportsReadiness(evidenceValidation, minimumReadiness)) {
    return {
      ...base,
      status: 'not-evaluated',
      failureReason: `webgpu-pilot-evidence-does-not-support-readiness: ${minimumReadiness}`,
      bottlenecksToIssue: ['signed-runner-webgpu-pilot-captured-and-verified-evidence'],
    };
  }

  if (envelope.scenario?.feature !== SIGNED_RUNNER_WEBGPU_WORKER_PILOT_EVIDENCE_KIND) {
    return {
      ...base,
      status: 'fail',
      failureReason: `webgpu-pilot-evidence-scenario-feature-mismatch: ${envelope.scenario?.feature ?? 'missing'}`,
      bottlenecksToIssue: ['signed-runner-webgpu-pilot-evidence-scenario'],
    };
  }

  const contractReport = runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot({
    previewReport: options.previewReport,
    pilotEvidence: envelope.payload,
  });

  if (contractReport.status === 'fail') {
    return {
      ...base,
      status: 'fail',
      contractReport,
      failureReason: `webgpu-pilot-contract-failed: ${contractReport.failureReason ?? 'unknown'}`,
      bottlenecksToIssue: contractReport.bottlenecksToIssue,
    };
  }

  return {
    ...base,
    status: 'pass',
    contractReport,
    bottlenecksToIssue: contractReport.bottlenecksToIssue,
  };
}

function issueCodes(
  validation: EvidenceValidationResult<WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence>,
): string {
  return validation.issues.map((entry) => entry.code).join(',') || 'unknown';
}
