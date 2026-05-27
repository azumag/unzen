import type {
  WorkersCoordinatorProductionObservabilityCanaryReport,
} from './workers-coordinator-production-observability-canary.js';
import {
  runWorkersCoordinatorSignedRunnerReleaseGate,
  type WorkersCoordinatorRunnerNetworkAttempt,
  type WorkersCoordinatorSignedRunnerContract,
  type WorkersCoordinatorSignedRunnerReleaseGateReport,
} from './workers-coordinator-signed-runner-release-gate.js';

export interface WorkersCoordinatorSignedRunnerBrowserPreviewTarget {
  readonly baseUrl: string;
  readonly runtime: 'wrangler-preview' | 'deployed-worker';
  readonly environment: 'preview' | 'production';
  readonly authHeaderName: string;
  readonly authHeaderPresent: boolean;
}

export interface WorkersCoordinatorSignedRunnerBrowserEvidence {
  readonly source: 'real-browser-harness';
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
  readonly capturedAtMs: number;
}

export interface WorkersCoordinatorSignedRunnerBrowserPreviewOptions {
  readonly target: WorkersCoordinatorSignedRunnerBrowserPreviewTarget;
  readonly productionGateReport: WorkersCoordinatorProductionObservabilityCanaryReport;
  readonly browserEvidence: WorkersCoordinatorSignedRunnerBrowserEvidence;
}

export interface WorkersCoordinatorSignedRunnerBrowserPreviewReport {
  readonly runtime: 'signed-runner-browser-preview-verification';
  readonly status: 'pass' | 'fail';
  readonly target: WorkersCoordinatorSignedRunnerBrowserPreviewTarget;
  readonly browserHarness: {
    readonly source: 'real-browser-harness';
    readonly capturedAtMs: number;
    readonly runnerUrl: string;
    readonly cspConnectSrc: readonly string[];
    readonly sandboxFlags: readonly string[];
    readonly coop: string | null;
    readonly coep: string | null;
  };
  readonly releaseGateReport: WorkersCoordinatorSignedRunnerReleaseGateReport;
  readonly allowedOrigins: readonly string[];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export function runWorkersCoordinatorSignedRunnerBrowserPreviewVerification(
  options: WorkersCoordinatorSignedRunnerBrowserPreviewOptions,
): WorkersCoordinatorSignedRunnerBrowserPreviewReport {
  const contract = browserEvidenceToRunnerContract(options.browserEvidence);
  const releaseGateReport = runWorkersCoordinatorSignedRunnerReleaseGate({
    productionGateReport: options.productionGateReport,
    runner: contract,
  });
  const targetFailureReason = selectTargetFailureReason(options.target, options.browserEvidence);
  const failureReason = targetFailureReason ?? releaseGateReport.failureReason;

  return {
    runtime: 'signed-runner-browser-preview-verification',
    status: failureReason ? 'fail' : 'pass',
    target: options.target,
    browserHarness: {
      source: options.browserEvidence.source,
      capturedAtMs: options.browserEvidence.capturedAtMs,
      runnerUrl: options.browserEvidence.runnerUrl,
      cspConnectSrc: releaseGateReport.csp.connectSrc,
      sandboxFlags: options.browserEvidence.sandboxIframe.flags,
      coop: releaseGateReport.coopCoepHeaders.coop,
      coep: releaseGateReport.coopCoepHeaders.coep,
    },
    releaseGateReport,
    allowedOrigins: releaseGateReport.networkBoundary.allowedOrigins,
    blockedNonCoordinatorCdnNetworkAttempt:
      releaseGateReport.networkBoundary.blockedNonCoordinatorCdnNetworkAttempt,
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function browserEvidenceToRunnerContract(
  evidence: WorkersCoordinatorSignedRunnerBrowserEvidence,
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
  evidence: WorkersCoordinatorSignedRunnerBrowserEvidence,
): string | undefined {
  if (!target.authHeaderPresent) {
    return `authenticated-preview-header-missing: ${target.authHeaderName}`;
  }
  if (evidence.source !== 'real-browser-harness') {
    return 'signed-runner-preview-must-use-real-browser-harness';
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
