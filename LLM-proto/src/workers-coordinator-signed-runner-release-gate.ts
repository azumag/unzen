import type {
  WorkersCoordinatorProductionObservabilityCanaryReport,
} from './workers-coordinator-production-observability-canary.js';

export type WorkersCoordinatorRunnerHeaderName =
  'content-security-policy'
  | 'cross-origin-opener-policy'
  | 'cross-origin-embedder-policy';

export interface WorkersCoordinatorSignedRunnerContract {
  readonly runnerUrl: string;
  readonly coordinatorOrigins: readonly string[];
  readonly cdnOrigins: readonly string[];
  readonly csp: {
    readonly connectSrc: readonly string[];
    readonly scriptSrc: readonly string[];
    readonly workerSrc?: readonly string[];
  };
  readonly sandboxIframe: {
    readonly flags: readonly string[];
    readonly topLevelDomAccessDenied: boolean;
    readonly topLevelCookieAccessDenied: boolean;
    readonly topLevelStorageAccessDenied: boolean;
  };
  readonly headers: Record<WorkersCoordinatorRunnerHeaderName, string>;
  readonly signature: {
    readonly keyId: string;
    readonly runnerSha256: string;
    readonly verified: boolean;
  };
  readonly observedNetworkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorRunnerNetworkAttempt {
  readonly url: string;
  readonly initiator: 'iframe' | 'dedicated-worker';
  readonly blocked: boolean;
  readonly reason?: string;
}

export interface WorkersCoordinatorSignedRunnerReleaseGateOptions {
  readonly productionGateReport: WorkersCoordinatorProductionObservabilityCanaryReport;
  readonly runner: WorkersCoordinatorSignedRunnerContract;
}

export interface WorkersCoordinatorSignedRunnerReleaseGateReport {
  readonly runtime: 'signed-runner-csp-coop-coep-release-gate';
  readonly status: 'pass' | 'fail';
  readonly requestId: string;
  readonly runnerUrl: string;
  readonly csp: {
    readonly connectSrc: readonly string[];
    readonly scriptSrc: readonly string[];
    readonly workerSrc?: readonly string[];
    readonly allowedOrigins: readonly string[];
  };
  readonly sandboxIframe: {
    readonly flags: readonly string[];
    readonly allowScriptsOnly: boolean;
    readonly topLevelDomAccessDenied: boolean;
    readonly topLevelCookieAccessDenied: boolean;
    readonly topLevelStorageAccessDenied: boolean;
  };
  readonly coopCoepHeaders: {
    readonly coop: string | null;
    readonly coep: string | null;
    readonly isolated: boolean;
  };
  readonly signature: {
    readonly keyId: string;
    readonly runnerSha256: string;
    readonly verified: boolean;
  };
  readonly networkBoundary: {
    readonly allowedOrigins: readonly string[];
    readonly attempts: readonly (WorkersCoordinatorRunnerNetworkAttempt & {
      readonly origin: string;
      readonly allowed: boolean;
    })[];
    readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  };
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export function runWorkersCoordinatorSignedRunnerReleaseGate(
  options: WorkersCoordinatorSignedRunnerReleaseGateOptions,
): WorkersCoordinatorSignedRunnerReleaseGateReport {
  const allowedOrigins = uniqueOrigins([
    ...options.runner.coordinatorOrigins,
    ...options.runner.cdnOrigins,
  ]);
  const networkAttempts = options.runner.observedNetworkAttempts.map((attempt) => {
    const origin = originOf(attempt.url);
    return {
      ...attempt,
      origin,
      allowed: allowedOrigins.includes(origin),
    };
  });
  const blockedNonCoordinatorCdnNetworkAttempt = networkAttempts.find((attempt) =>
    !attempt.allowed && attempt.blocked,
  ) ?? null;
  const failureReason = selectFailureReason({
    productionGateStatus: options.productionGateReport.status,
    productionGateFailureReason: options.productionGateReport.failureReason,
    connectSrc: options.runner.csp.connectSrc,
    allowedOrigins,
    sandboxFlags: options.runner.sandboxIframe.flags,
    topLevelDomAccessDenied: options.runner.sandboxIframe.topLevelDomAccessDenied,
    topLevelCookieAccessDenied: options.runner.sandboxIframe.topLevelCookieAccessDenied,
    topLevelStorageAccessDenied: options.runner.sandboxIframe.topLevelStorageAccessDenied,
    coop: options.runner.headers['cross-origin-opener-policy'],
    coep: options.runner.headers['cross-origin-embedder-policy'],
    signatureVerified: options.runner.signature.verified,
    networkAttempts,
    blockedNonCoordinatorCdnNetworkAttempt,
  });

  return {
    runtime: 'signed-runner-csp-coop-coep-release-gate',
    status: failureReason ? 'fail' : 'pass',
    requestId: options.productionGateReport.requestId,
    runnerUrl: options.runner.runnerUrl,
    csp: {
      connectSrc: options.runner.csp.connectSrc,
      scriptSrc: options.runner.csp.scriptSrc,
      workerSrc: options.runner.csp.workerSrc,
      allowedOrigins,
    },
    sandboxIframe: {
      flags: options.runner.sandboxIframe.flags,
      allowScriptsOnly: isAllowScriptsOnly(options.runner.sandboxIframe.flags),
      topLevelDomAccessDenied: options.runner.sandboxIframe.topLevelDomAccessDenied,
      topLevelCookieAccessDenied: options.runner.sandboxIframe.topLevelCookieAccessDenied,
      topLevelStorageAccessDenied: options.runner.sandboxIframe.topLevelStorageAccessDenied,
    },
    coopCoepHeaders: {
      coop: options.runner.headers['cross-origin-opener-policy'] ?? null,
      coep: options.runner.headers['cross-origin-embedder-policy'] ?? null,
      isolated: options.runner.headers['cross-origin-opener-policy'] === 'same-origin'
        && options.runner.headers['cross-origin-embedder-policy'] === 'require-corp',
    },
    signature: options.runner.signature,
    networkBoundary: {
      allowedOrigins,
      attempts: networkAttempts,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectFailureReason(input: {
  readonly productionGateStatus: 'pass' | 'fail';
  readonly productionGateFailureReason: string | undefined;
  readonly connectSrc: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly topLevelDomAccessDenied: boolean;
  readonly topLevelCookieAccessDenied: boolean;
  readonly topLevelStorageAccessDenied: boolean;
  readonly coop: string | undefined;
  readonly coep: string | undefined;
  readonly signatureVerified: boolean;
  readonly networkAttempts: readonly (WorkersCoordinatorRunnerNetworkAttempt & {
    readonly origin: string;
    readonly allowed: boolean;
  })[];
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): string | undefined {
  if (input.productionGateStatus === 'fail') {
    return `production-gate-not-clean: ${input.productionGateFailureReason ?? 'unknown'}`;
  }
  if (!input.allowedOrigins.every((origin) => input.connectSrc.includes(origin))) {
    return 'csp-connect-src-missing-coordinator-or-cdn-origin';
  }
  if (!isAllowScriptsOnly(input.sandboxFlags)) {
    return 'sandbox-iframe-must-be-allow-scripts-only';
  }
  if (!input.topLevelDomAccessDenied || !input.topLevelCookieAccessDenied || !input.topLevelStorageAccessDenied) {
    return 'sandbox-iframe-depends-on-top-level-page-state';
  }
  if (input.coop !== 'same-origin') {
    return 'coop-header-must-be-same-origin';
  }
  if (input.coep !== 'require-corp') {
    return 'coep-header-must-be-require-corp';
  }
  if (!input.signatureVerified) {
    return 'runner-signature-not-verified';
  }
  const leakedNetworkAttempt = input.networkAttempts.find((attempt) => !attempt.allowed && !attempt.blocked);
  if (leakedNetworkAttempt) {
    return `non-coordinator-cdn-network-attempt-not-blocked: ${leakedNetworkAttempt.origin}`;
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    return 'missing-blocked-non-coordinator-cdn-network-attempt';
  }
  return undefined;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.startsWith('non-coordinator-cdn-network-attempt-not-blocked')) {
    return ['signed-runner-network-policy-hardening'];
  }
  if (failureReason?.startsWith('sandbox-iframe')) {
    return ['signed-runner-iframe-isolation-hardening'];
  }
  if (failureReason?.startsWith('coop-header') || failureReason?.startsWith('coep-header')) {
    return ['signed-runner-cross-origin-isolation-hardening'];
  }
  if (failureReason) {
    return [`signed-runner-release-gate-failure: ${failureReason}`];
  }
  return ['signed-runner-browser-poc-and-wrangler-preview-verification'];
}

function isAllowScriptsOnly(flags: readonly string[]): boolean {
  return flags.length === 1 && flags[0] === 'allow-scripts';
}

function uniqueOrigins(origins: readonly string[]): readonly string[] {
  return Array.from(new Set(origins.map((origin) => origin.replace(/\/$/, ''))));
}

function originOf(url: string): string {
  return new URL(url).origin;
}
