import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorSignedRunnerBrowserPreviewReport,
} from './workers-coordinator-signed-runner-browser-preview.js';

export interface WorkersCoordinatorSignedRunnerWebGpuSegmentExecution {
  readonly modelId: string;
  readonly segmentId: string;
  readonly runtime: 'webgpu-dedicated-worker';
  readonly state: 'not-started' | 'started' | 'completed' | 'failed';
  readonly layerStart: number;
  readonly layerEnd: number;
  readonly startedAtMs: number;
  readonly completedAtMs?: number;
  readonly outputCheckpointKey?: string;
  readonly failureReason?: string;
}

export interface WorkersCoordinatorSignedRunnerWebGpuCacheEvidence {
  readonly backend: 'indexeddb';
  readonly databaseName: string;
  readonly segmentWeightKey: string;
  readonly cacheHit: boolean;
  readonly topLevelStorageAccessed: boolean;
}

export interface WorkersCoordinatorSignedRunnerWebGpuCheckpointRelayEvidence {
  readonly owner: 'coordinator-storage';
  readonly checkpointKey: string;
  readonly relayUrl: string;
  readonly directWorkerNetworking: boolean;
  readonly topLevelDomAccessed: boolean;
  readonly topLevelCookieAccessed: boolean;
  readonly topLevelStorageAccessed: boolean;
}

export interface WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence {
  readonly source: 'real-browser-webgpu-worker-pilot';
  readonly runnerUrl: string;
  readonly capturedAtMs: number;
  readonly segmentExecution: WorkersCoordinatorSignedRunnerWebGpuSegmentExecution;
  readonly indexedDbCache: WorkersCoordinatorSignedRunnerWebGpuCacheEvidence;
  readonly checkpointRelay: WorkersCoordinatorSignedRunnerWebGpuCheckpointRelayEvidence;
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly allowedOrigins: readonly string[];
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorSignedRunnerWebGpuWorkerPilotOptions {
  readonly previewReport: WorkersCoordinatorSignedRunnerBrowserPreviewReport;
  readonly pilotEvidence: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence;
}

export interface WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport {
  readonly runtime: 'signed-runner-real-webgpu-worker-pilot';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly segmentExecution: WorkersCoordinatorSignedRunnerWebGpuSegmentExecution;
  readonly indexedDbCache: WorkersCoordinatorSignedRunnerWebGpuCacheEvidence;
  readonly checkpointRelay: WorkersCoordinatorSignedRunnerWebGpuCheckpointRelayEvidence;
  readonly securityBoundaryDuringExecution: {
    readonly cspConnectSrc: readonly string[];
    readonly sandboxFlags: readonly string[];
    readonly coop: string | null;
    readonly coep: string | null;
    readonly allowedOrigins: readonly string[];
    readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
  };
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export function runWorkersCoordinatorSignedRunnerWebGpuWorkerPilot(
  options: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotOptions,
): WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.pilotEvidence);
  const failureReason = selectFailureReason({
    previewReport: options.previewReport,
    pilotEvidence: options.pilotEvidence,
    blockedNonCoordinatorCdnNetworkAttempt,
  });

  return {
    runtime: 'signed-runner-real-webgpu-worker-pilot',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.previewReport.browserHarness.runnerUrl,
    segmentExecution: options.pilotEvidence.segmentExecution,
    indexedDbCache: options.pilotEvidence.indexedDbCache,
    checkpointRelay: options.pilotEvidence.checkpointRelay,
    securityBoundaryDuringExecution: {
      cspConnectSrc: options.pilotEvidence.cspConnectSrc,
      sandboxFlags: options.pilotEvidence.sandboxFlags,
      coop: options.pilotEvidence.coop,
      coep: options.pilotEvidence.coep,
      allowedOrigins: options.pilotEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectFailureReason(input: {
  readonly previewReport: WorkersCoordinatorSignedRunnerBrowserPreviewReport;
  readonly pilotEvidence: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence;
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): string | undefined {
  if (input.previewReport.status === 'fail') {
    return `browser-preview-gate-not-clean: ${input.previewReport.failureReason ?? 'unknown'}`;
  }
  if (input.pilotEvidence.source !== 'real-browser-webgpu-worker-pilot') {
    return 'webgpu-pilot-must-use-real-browser-worker-evidence';
  }
  if (input.pilotEvidence.runnerUrl !== input.previewReport.browserHarness.runnerUrl) {
    return 'webgpu-pilot-runner-url-mismatch';
  }
  if (input.pilotEvidence.segmentExecution.runtime !== 'webgpu-dedicated-worker') {
    return 'segment-execution-must-run-in-webgpu-dedicated-worker';
  }
  if (input.pilotEvidence.segmentExecution.state !== 'completed') {
    return `segment-execution-not-completed: ${input.pilotEvidence.segmentExecution.state}`;
  }
  if (!input.pilotEvidence.segmentExecution.outputCheckpointKey) {
    return 'segment-execution-missing-output-checkpoint';
  }
  if (input.pilotEvidence.indexedDbCache.backend !== 'indexeddb') {
    return 'segment-cache-must-use-indexeddb';
  }
  if (input.pilotEvidence.indexedDbCache.topLevelStorageAccessed) {
    return 'indexeddb-cache-depends-on-top-level-storage';
  }
  if (input.pilotEvidence.checkpointRelay.owner !== 'coordinator-storage') {
    return 'checkpoint-relay-owner-must-be-coordinator-storage';
  }
  if (input.pilotEvidence.checkpointRelay.directWorkerNetworking) {
    return 'checkpoint-relay-must-not-use-direct-worker-networking';
  }
  if (
    input.pilotEvidence.checkpointRelay.topLevelDomAccessed ||
    input.pilotEvidence.checkpointRelay.topLevelCookieAccessed ||
    input.pilotEvidence.checkpointRelay.topLevelStorageAccessed
  ) {
    return 'checkpoint-relay-depends-on-top-level-page-state';
  }
  if (!input.pilotEvidence.allowedOrigins.every((origin) => input.pilotEvidence.cspConnectSrc.includes(origin))) {
    return 'webgpu-pilot-csp-connect-src-missing-coordinator-or-cdn-origin';
  }
  if (!(input.pilotEvidence.sandboxFlags.length === 1 && input.pilotEvidence.sandboxFlags[0] === 'allow-scripts')) {
    return 'webgpu-pilot-sandbox-must-remain-allow-scripts-only';
  }
  if (input.pilotEvidence.coop !== 'same-origin' || input.pilotEvidence.coep !== 'require-corp') {
    return 'webgpu-pilot-cross-origin-isolation-lost';
  }
  const leakedNetworkAttempt = input.pilotEvidence.networkAttempts.find((attempt) =>
    !input.pilotEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    return `webgpu-pilot-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`;
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    return 'webgpu-pilot-missing-blocked-non-coordinator-cdn-network-attempt';
  }
  return undefined;
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.startsWith('segment-execution')) {
    return ['signed-runner-webgpu-segment-execution-hardening'];
  }
  if (failureReason?.startsWith('indexeddb-cache')) {
    return ['signed-runner-indexeddb-cache-isolation-hardening'];
  }
  if (failureReason?.startsWith('checkpoint-relay')) {
    return ['signed-runner-checkpoint-relay-isolation-hardening'];
  }
  if (failureReason?.startsWith('webgpu-pilot-non-coordinator-cdn-network-attempt')) {
    return ['signed-runner-webgpu-network-policy-hardening'];
  }
  if (failureReason) {
    return [`signed-runner-webgpu-worker-pilot-failure: ${failureReason}`];
  }
  return ['webgpu-worker-performance-and-fallback-telemetry'];
}

function originOf(url: string): string {
  return new URL(url).origin;
}
