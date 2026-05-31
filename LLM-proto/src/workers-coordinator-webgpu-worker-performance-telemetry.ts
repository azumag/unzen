import type {
  WorkersCoordinatorRunnerNetworkAttempt,
} from './workers-coordinator-signed-runner-release-gate.js';
import type {
  WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport,
} from './workers-coordinator-signed-runner-webgpu-worker-pilot.js';

export interface WorkersCoordinatorWebGpuWorkerLatencyDistribution {
  readonly sampleCount: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface WorkersCoordinatorWebGpuWorkerCacheTiming {
  readonly backend: 'indexeddb';
  readonly cacheHit: boolean;
  readonly hitLoadMs?: number;
  readonly missLoadMs?: number;
  readonly topLevelStorageAccessed: boolean;
}

export interface WorkersCoordinatorWebGpuWorkerCheckpointRelayTiming {
  readonly owner: 'coordinator-storage';
  readonly durationMs: number;
  readonly retryCount: number;
  readonly failureReasons: readonly string[];
  readonly directWorkerNetworking: boolean;
  readonly topLevelDomAccessed: boolean;
  readonly topLevelCookieAccessed: boolean;
  readonly topLevelStorageAccessed: boolean;
}

export interface WorkersCoordinatorWebGpuDeviceLossState {
  readonly state: 'not-lost' | 'lost' | 'recovered';
  readonly reason?: string;
}

export interface WorkersCoordinatorCpuFallbackRouting {
  readonly decision: 'not-needed' | 'route-to-cpu' | 'disabled';
  readonly reason?: string;
  readonly targetRuntime?: 'cpu-worker';
}

export interface WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidence {
  readonly source: 'real-browser-webgpu-worker-performance-telemetry';
  readonly runnerUrl: string;
  readonly capturedAtMs: number;
  readonly segmentLatencySamplesMs: readonly number[];
  readonly indexedDbCacheTiming: WorkersCoordinatorWebGpuWorkerCacheTiming;
  readonly checkpointRelayTiming: WorkersCoordinatorWebGpuWorkerCheckpointRelayTiming;
  readonly webGpuDeviceLoss: WorkersCoordinatorWebGpuDeviceLossState;
  readonly cpuFallbackRouting: WorkersCoordinatorCpuFallbackRouting;
  readonly cspConnectSrc: readonly string[];
  readonly sandboxFlags: readonly string[];
  readonly coop: string | null;
  readonly coep: string | null;
  readonly allowedOrigins: readonly string[];
  readonly networkAttempts: readonly WorkersCoordinatorRunnerNetworkAttempt[];
}

export interface WorkersCoordinatorWebGpuWorkerPerformanceTelemetryOptions {
  readonly pilotReport: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport;
  readonly telemetryEvidence: WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidence;
}

export interface WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport {
  readonly runtime: 'webgpu-worker-performance-fallback-telemetry';
  readonly status: 'pass' | 'fail';
  readonly previewRunnerUrl: string;
  readonly segmentLatencyDistribution: WorkersCoordinatorWebGpuWorkerLatencyDistribution | null;
  readonly indexedDbCacheTiming: WorkersCoordinatorWebGpuWorkerCacheTiming;
  readonly checkpointRelayTiming: WorkersCoordinatorWebGpuWorkerCheckpointRelayTiming;
  readonly webGpuDeviceLoss: WorkersCoordinatorWebGpuDeviceLossState;
  readonly cpuFallbackRouting: WorkersCoordinatorCpuFallbackRouting;
  readonly securityBoundaryDuringTelemetry: {
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

export function runWorkersCoordinatorWebGpuWorkerPerformanceTelemetry(
  options: WorkersCoordinatorWebGpuWorkerPerformanceTelemetryOptions,
): WorkersCoordinatorWebGpuWorkerPerformanceTelemetryReport {
  const blockedNonCoordinatorCdnNetworkAttempt =
    selectBlockedNonCoordinatorCdnNetworkAttempt(options.telemetryEvidence);
  const segmentLatencyDistribution = buildLatencyDistribution(
    options.telemetryEvidence.segmentLatencySamplesMs,
  );
  const failureReason = selectFailureReason({
    pilotReport: options.pilotReport,
    telemetryEvidence: options.telemetryEvidence,
    segmentLatencyDistribution,
    blockedNonCoordinatorCdnNetworkAttempt,
  });

  return {
    runtime: 'webgpu-worker-performance-fallback-telemetry',
    status: failureReason ? 'fail' : 'pass',
    previewRunnerUrl: options.pilotReport.previewRunnerUrl,
    segmentLatencyDistribution,
    indexedDbCacheTiming: options.telemetryEvidence.indexedDbCacheTiming,
    checkpointRelayTiming: options.telemetryEvidence.checkpointRelayTiming,
    webGpuDeviceLoss: options.telemetryEvidence.webGpuDeviceLoss,
    cpuFallbackRouting: options.telemetryEvidence.cpuFallbackRouting,
    securityBoundaryDuringTelemetry: {
      cspConnectSrc: options.telemetryEvidence.cspConnectSrc,
      sandboxFlags: options.telemetryEvidence.sandboxFlags,
      coop: options.telemetryEvidence.coop,
      coep: options.telemetryEvidence.coep,
      allowedOrigins: options.telemetryEvidence.allowedOrigins,
      blockedNonCoordinatorCdnNetworkAttempt,
    },
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function selectFailureReason(input: {
  readonly pilotReport: WorkersCoordinatorSignedRunnerWebGpuWorkerPilotReport;
  readonly telemetryEvidence: WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidence;
  readonly segmentLatencyDistribution: WorkersCoordinatorWebGpuWorkerLatencyDistribution | null;
  readonly blockedNonCoordinatorCdnNetworkAttempt: WorkersCoordinatorRunnerNetworkAttempt | null;
}): string | undefined {
  if (input.pilotReport.status === 'fail') {
    return `webgpu-worker-pilot-not-clean: ${input.pilotReport.failureReason ?? 'unknown'}`;
  }
  if (input.telemetryEvidence.source !== 'real-browser-webgpu-worker-performance-telemetry') {
    return 'webgpu-worker-telemetry-must-use-real-browser-evidence';
  }
  if (input.telemetryEvidence.runnerUrl !== input.pilotReport.previewRunnerUrl) {
    return 'webgpu-worker-telemetry-runner-url-mismatch';
  }
  if (!input.segmentLatencyDistribution) {
    return 'segment-latency-distribution-missing-or-invalid';
  }
  if (input.telemetryEvidence.indexedDbCacheTiming.backend !== 'indexeddb') {
    return 'cache-timing-must-use-indexeddb';
  }
  if (input.telemetryEvidence.indexedDbCacheTiming.topLevelStorageAccessed) {
    return 'cache-timing-depends-on-top-level-storage';
  }
  if (
    input.telemetryEvidence.indexedDbCacheTiming.cacheHit &&
    !isNonNegativeFinite(input.telemetryEvidence.indexedDbCacheTiming.hitLoadMs)
  ) {
    return 'cache-hit-timing-missing';
  }
  if (
    !input.telemetryEvidence.indexedDbCacheTiming.cacheHit &&
    !isNonNegativeFinite(input.telemetryEvidence.indexedDbCacheTiming.missLoadMs)
  ) {
    return 'cache-miss-timing-missing';
  }
  if (input.telemetryEvidence.checkpointRelayTiming.owner !== 'coordinator-storage') {
    return 'checkpoint-relay-timing-owner-must-be-coordinator-storage';
  }
  if (!isNonNegativeFinite(input.telemetryEvidence.checkpointRelayTiming.durationMs)) {
    return 'checkpoint-relay-duration-invalid';
  }
  if (!Number.isInteger(input.telemetryEvidence.checkpointRelayTiming.retryCount) ||
    input.telemetryEvidence.checkpointRelayTiming.retryCount < 0) {
    return 'checkpoint-relay-retry-count-invalid';
  }
  if (input.telemetryEvidence.checkpointRelayTiming.directWorkerNetworking) {
    return 'checkpoint-relay-timing-must-not-use-direct-worker-networking';
  }
  if (
    input.telemetryEvidence.checkpointRelayTiming.topLevelDomAccessed ||
    input.telemetryEvidence.checkpointRelayTiming.topLevelCookieAccessed ||
    input.telemetryEvidence.checkpointRelayTiming.topLevelStorageAccessed
  ) {
    return 'checkpoint-relay-timing-depends-on-top-level-page-state';
  }
  if (
    input.telemetryEvidence.webGpuDeviceLoss.state === 'lost' &&
    input.telemetryEvidence.cpuFallbackRouting.decision !== 'route-to-cpu'
  ) {
    return 'webgpu-device-loss-without-cpu-fallback-routing';
  }
  if (
    input.telemetryEvidence.cpuFallbackRouting.decision === 'route-to-cpu' &&
    input.telemetryEvidence.cpuFallbackRouting.targetRuntime !== 'cpu-worker'
  ) {
    return 'cpu-fallback-routing-target-missing';
  }
  if (!input.telemetryEvidence.allowedOrigins.every((origin) => input.telemetryEvidence.cspConnectSrc.includes(origin))) {
    return 'webgpu-worker-telemetry-csp-connect-src-missing-coordinator-or-cdn-origin';
  }
  if (!(input.telemetryEvidence.sandboxFlags.length === 1 && input.telemetryEvidence.sandboxFlags[0] === 'allow-scripts')) {
    return 'webgpu-worker-telemetry-sandbox-must-remain-allow-scripts-only';
  }
  if (input.telemetryEvidence.coop !== 'same-origin' || input.telemetryEvidence.coep !== 'require-corp') {
    return 'webgpu-worker-telemetry-cross-origin-isolation-lost';
  }
  const leakedNetworkAttempt = input.telemetryEvidence.networkAttempts.find((attempt) =>
    !input.telemetryEvidence.allowedOrigins.includes(originOf(attempt.url)) && !attempt.blocked,
  );
  if (leakedNetworkAttempt) {
    return `webgpu-worker-telemetry-non-coordinator-cdn-network-attempt-not-blocked: ${originOf(leakedNetworkAttempt.url)}`;
  }
  if (!input.blockedNonCoordinatorCdnNetworkAttempt) {
    return 'webgpu-worker-telemetry-missing-blocked-non-coordinator-cdn-network-attempt';
  }
  return undefined;
}

function buildLatencyDistribution(
  samplesMs: readonly number[],
): WorkersCoordinatorWebGpuWorkerLatencyDistribution | null {
  if (samplesMs.length === 0 || samplesMs.some((sample) => !isNonNegativeFinite(sample))) {
    return null;
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

function percentile(sortedSamples: readonly number[], percentileValue: number): number {
  const index = Math.ceil(percentileValue * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, Math.min(sortedSamples.length - 1, index))];
}

function selectBlockedNonCoordinatorCdnNetworkAttempt(
  evidence: WorkersCoordinatorWebGpuWorkerPerformanceTelemetryEvidence,
): WorkersCoordinatorRunnerNetworkAttempt | null {
  return evidence.networkAttempts.find((attempt) =>
    !evidence.allowedOrigins.includes(originOf(attempt.url)) && attempt.blocked,
  ) ?? null;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.startsWith('segment-latency')) {
    return ['webgpu-worker-latency-instrumentation-hardening'];
  }
  if (failureReason?.startsWith('cache')) {
    return ['webgpu-worker-cache-telemetry-hardening'];
  }
  if (failureReason?.startsWith('checkpoint-relay')) {
    return ['webgpu-worker-checkpoint-relay-telemetry-hardening'];
  }
  if (failureReason?.startsWith('webgpu-device-loss') || failureReason?.startsWith('cpu-fallback')) {
    return ['webgpu-worker-device-loss-fallback-hardening'];
  }
  if (failureReason?.startsWith('webgpu-worker-telemetry-non-coordinator-cdn-network-attempt')) {
    return ['webgpu-worker-telemetry-network-policy-hardening'];
  }
  if (failureReason) {
    return [`webgpu-worker-performance-telemetry-failure: ${failureReason}`];
  }
  return ['production-worker-fleet-slo-and-cost-gate'];
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function originOf(url: string): string {
  return new URL(url).origin;
}
