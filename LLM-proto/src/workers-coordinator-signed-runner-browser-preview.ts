import type {
  WorkersCoordinatorProductionObservabilityCanaryReport,
} from './workers-coordinator-production-observability-canary.js';
import {
  runWorkersCoordinatorSignedRunnerReleaseGate,
  type WorkersCoordinatorRunnerNetworkAttempt,
  type WorkersCoordinatorSignedRunnerContract,
  type WorkersCoordinatorSignedRunnerReleaseGateReport,
} from './workers-coordinator-signed-runner-release-gate.js';
import {
  deriveSignedRunnerEvidenceProvenance,
  evidenceValidationFailureReason,
  type WorkersCoordinatorSignedRunnerEvidenceProvenance,
} from './workers-coordinator-signed-runner-evidence.js';
import {
  validateEvidenceEnvelope,
  type EvidenceEnvelope,
  type EvidenceValidationOptions,
} from './evidence.js';

export interface WorkersCoordinatorSignedRunnerBrowserPreviewTarget {
  readonly baseUrl: string;
  readonly runtime: 'wrangler-preview' | 'deployed-worker';
  readonly environment: 'preview' | 'production';
  readonly authHeaderName: string;
  readonly authHeaderPresent: boolean;
}

// Contract fields captured by the browser harness. They are carried inside an
// EvidenceEnvelope payload so that provenance (evidenceLevel/readiness) is
// decided by validateEvidenceEnvelope(), never by a hand-written `source`.
export interface WorkersCoordinatorSignedRunnerBrowserEvidencePayload {
  readonly runnerUrl: string;
  readonly responseHeaders: {
    readonly 'content-security-policy': string;
    readonly 'cross-origin-opener-policy': string;
    readonly 'cross-origin-embedder-policy': string;
  };
  readonly coordinatorOrigins: readonly string[];
  readonly cdnOrigins: readonly string[];
  readonly scriptSrc: readonly string[];
  readonly workerSrc?: readonly string[];
  readonly sandboxIframe: {
    readonly flags: readonly string[];
    readonly topLevelDomAccessDenied: boolean;
    readonly topLevelCookieAccessDenied: boolean;
    readonly topLevelStorageAccessDenied: boolean;
  };
  readonly signature: {
    readonly keyId: string;
    readonly runnerSha256: string;
    readonly verified: boolean;
  };
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorSignedRunnerBrowserPreviewOptions {
  readonly target: WorkersCoordinatorSignedRunnerBrowserPreviewTarget;
  readonly productionGateReport: WorkersCoordinatorProductionObservabilityCanaryReport;
  readonly browserEvidenceEnvelope: EvidenceEnvelope<WorkersCoordinatorSignedRunnerBrowserEvidencePayload>;
  // Trust boundary for captured-and-verified evidence: trustedVerifiers,
  // loadArtifact, verifyArtifact, and now must come from outside the envelope.
  readonly evidenceValidation: EvidenceValidationOptions;
}

export interface WorkersCoordinatorSignedRunnerBrowserPreviewReport {
  readonly runtime: 'signed-runner-browser-preview-verification';
  readonly status: 'pass' | 'fail';
  readonly target: WorkersCoordinatorSignedRunnerBrowserPreviewTarget;
  // Present only when the envelope validated, because the fields are extracted
  // from the validated payload rather than trusted by inspection.
  readonly browserHarness?: {
    readonly runnerUrl: string;
    readonly cspConnectSrc: readonly string[];
    readonly sandboxFlags: readonly string[];
    readonly coop: string | null;
    readonly coep: string | null;
  };
  readonly evidence: WorkersCoordinatorSignedRunnerEvidenceProvenance;
  readonly releaseGateReport?: WorkersCoordinatorSignedRunnerReleaseGateReport;
  readonly allowedOrigins?: readonly string[];
  readonly blockedNonCoordinatorCdnNetworkAttempt?: WorkersCoordinatorRunnerNetworkAttempt | null;
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export async function runWorkersCoordinatorSignedRunnerBrowserPreviewVerification(
  options: WorkersCoordinatorSignedRunnerBrowserPreviewOptions,
): Promise<WorkersCoordinatorSignedRunnerBrowserPreviewReport> {
  // The gate only trusts contract fields once the envelope has been validated.
  // A hand-written fixture cannot reach captured-and-verified readiness, so the
  // payload-dependent parts of the report stay absent on rejection.
  const validation = await validateEvidenceEnvelope<WorkersCoordinatorSignedRunnerBrowserEvidencePayload>(
    options.browserEvidenceEnvelope,
    options.evidenceValidation,
  );
  const evidence = deriveSignedRunnerEvidenceProvenance(validation);
  const evidenceFailure = evidenceValidationFailureReason(
    'signed-runner-preview-evidence-not-validated',
    validation,
  );

  if (evidenceFailure) {
    return {
      runtime: 'signed-runner-browser-preview-verification',
      status: 'fail',
      target: options.target,
      evidence,
      failureReason: evidenceFailure,
      bottlenecksToIssue: selectBottlenecksToIssue(evidenceFailure),
    };
  }

  // validation.status === 'valid' guarantees the envelope was returned, so the
  // non-null assertion is safe here.
  const payload = validation.envelope!.payload;
  const contract = browserEvidenceToRunnerContract(payload);
  const releaseGateReport = runWorkersCoordinatorSignedRunnerReleaseGate({
    productionGateReport: options.productionGateReport,
    runner: contract,
  });
  const targetFailureReason = selectTargetFailureReason(options.target, payload);
  const failureReason = targetFailureReason ?? releaseGateReport.failureReason;

  return {
    runtime: 'signed-runner-browser-preview-verification',
    status: failureReason ? 'fail' : 'pass',
    target: options.target,
    browserHarness: {
      runnerUrl: payload.runnerUrl,
      cspConnectSrc: releaseGateReport.csp.connectSrc,
      sandboxFlags: payload.sandboxIframe.flags,
      coop: releaseGateReport.coopCoepHeaders.coop,
      coep: releaseGateReport.coopCoepHeaders.coep,
    },
    evidence,
    releaseGateReport,
    allowedOrigins: releaseGateReport.networkBoundary.allowedOrigins,
    blockedNonCoordinatorCdnNetworkAttempt:
      releaseGateReport.networkBoundary.blockedNonCoordinatorCdnNetworkAttempt,
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function browserEvidenceToRunnerContract(
  evidence: WorkersCoordinatorSignedRunnerBrowserEvidencePayload,
): WorkersCoordinatorSignedRunnerContract {
  return {
    runnerUrl: evidence.runnerUrl,
    coordinatorOrigins: evidence.coordinatorOrigins,
    cdnOrigins: evidence.cdnOrigins,
    csp: {
      connectSrc: parseCspDirective(evidence.responseHeaders['content-security-policy'], 'connect-src'),
      scriptSrc: evidence.scriptSrc,
      workerSrc: evidence.workerSrc,
    },
    sandboxIframe: evidence.sandboxIframe,
    headers: evidence.responseHeaders,
    signature: evidence.signature,
    observedNetworkAttempts: evidence.networkAttempts,
  };
}

function parseCspDirective(cspHeader: string, directiveName: string): readonly string[] {
  const directive = cspHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directiveName} `));

  if (!directive) {
    return [];
  }

  return directive.split(/\s+/).slice(1);
}

function selectTargetFailureReason(
  target: WorkersCoordinatorSignedRunnerBrowserPreviewTarget,
  evidence: WorkersCoordinatorSignedRunnerBrowserEvidencePayload,
): string | undefined {
  if (!target.authHeaderPresent) {
    return `authenticated-preview-header-missing: ${target.authHeaderName}`;
  }
  if (!evidence.runnerUrl.startsWith(target.baseUrl.replace(/\/$/, ''))) {
    return 'runner-url-outside-preview-target';
  }
  return undefined;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.startsWith('authenticated-preview-header-missing')) {
    return ['signed-runner-preview-auth-preflight'];
  }
  if (failureReason === 'runner-url-outside-preview-target') {
    return ['signed-runner-preview-routing-hardening'];
  }
  if (failureReason) {
    return [`signed-runner-browser-preview-failure: ${failureReason}`];
  }
  return ['signed-runner-real-webgpu-worker-pilot'];
}
