import type {
  WorkersCoordinatorDeployedSmokeReport,
} from './workers-coordinator-deployed-smoke.js';

export type WorkersCoordinatorCanaryDecision = 'promote' | 'hold' | 'rollback';
export type WorkersCoordinatorAlertStatus = 'ok' | 'warn' | 'page';

export interface WorkersCoordinatorProductionGateThresholds {
  readonly maxBrowserP95FanoutLatencyMs: number;
  readonly maxEdgePlacementVarianceMs: number;
  readonly requireDirectWorkerNetworkingRejected: boolean;
  readonly maxUpstreamRetryCount: number;
}

export interface WorkersCoordinatorCanaryState {
  readonly stableVersion: string;
  readonly canaryVersion: string;
  readonly sampleRate: number;
  readonly minHealthyRequests: number;
  readonly observedHealthyRequests: number;
  readonly rollbackErrorBudget: number;
  readonly observedErrorCount: number;
  readonly checkpointBoundaryKeys: readonly string[];
}

export interface WorkersCoordinatorProductionObservabilityCanaryOptions {
  readonly deployedReport: WorkersCoordinatorDeployedSmokeReport;
  readonly thresholds: WorkersCoordinatorProductionGateThresholds;
  readonly canary: WorkersCoordinatorCanaryState;
  readonly exportedAtMs: number;
}

export interface WorkersCoordinatorProductionObservabilityCanaryReport {
  readonly runtime: 'production-observability-canary-gate';
  readonly status: 'pass' | 'fail';
  readonly requestId: string;
  readonly metricsExport: {
    readonly sink: 'durable-per-request-metrics';
    readonly requestId: string;
    readonly storageKeys: readonly string[];
    readonly fields: {
      readonly browserWebSocketP95Ms: number;
      readonly edgePlacementVarianceMs: number;
      readonly directWorkerNetworkingRejected: boolean;
      readonly upstreamFailureReason: string | null;
      readonly upstreamRetryCount: number;
      readonly checkpointRelayOwner: 'coordinator-storage';
      readonly exportedAtMs: number;
    };
  };
  readonly alertThresholds: readonly {
    readonly name: string;
    readonly observed: number | boolean | string | null;
    readonly threshold: number | boolean | string | null;
    readonly status: WorkersCoordinatorAlertStatus;
    readonly reason?: string;
  }[];
  readonly canaryRelease: {
    readonly stableVersion: string;
    readonly canaryVersion: string;
    readonly sampleRate: number;
    readonly decision: WorkersCoordinatorCanaryDecision;
    readonly reason: string;
  };
  readonly rollbackCheckpointBoundary: {
    readonly owner: 'coordinator-storage';
    readonly preserved: boolean;
    readonly storageKeys: readonly string[];
    readonly directWorkerNetworking: false;
  };
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

export function runWorkersCoordinatorProductionObservabilityCanaryGate(
  options: WorkersCoordinatorProductionObservabilityCanaryOptions,
): WorkersCoordinatorProductionObservabilityCanaryReport {
  const upstreamRetryCount = options.deployedReport.upstreamReport.retryResumeImpact.retryCount;
  const checkpointStorageKeys = [
    ...options.deployedReport.upstreamReport.checkpointRelay.storageKeys,
    ...options.canary.checkpointBoundaryKeys,
  ];
  const rollbackCheckpointBoundary = {
    owner: 'coordinator-storage' as const,
    preserved: checkpointStorageKeys.length > 0
      && options.deployedReport.upstreamReport.checkpointRelay.owner === 'coordinator-storage'
      && options.deployedReport.upstreamReport.checkpointRelay.directWorkerNetworking === false,
    storageKeys: checkpointStorageKeys,
    directWorkerNetworking: false as const,
  };

  const alertThresholds = evaluateAlertThresholds({
    report: options.deployedReport,
    thresholds: options.thresholds,
    upstreamRetryCount,
  });
  const canaryRelease = decideCanaryRelease({
    canary: options.canary,
    hasPageAlert: alertThresholds.some((alert) => alert.status === 'page'),
    hasWarnAlert: alertThresholds.some((alert) => alert.status === 'warn'),
    rollbackCheckpointBoundaryPreserved: rollbackCheckpointBoundary.preserved,
  });
  const failureReason = selectFailureReason({
    deployedFailureReason: options.deployedReport.failureReason,
    alertThresholds,
    canaryDecision: canaryRelease.decision,
    rollbackCheckpointBoundaryPreserved: rollbackCheckpointBoundary.preserved,
  });

  return {
    runtime: 'production-observability-canary-gate',
    status: failureReason ? 'fail' : 'pass',
    requestId: options.deployedReport.requestId,
    metricsExport: {
      sink: 'durable-per-request-metrics',
      requestId: options.deployedReport.requestId,
      storageKeys: [
        `metrics:${options.deployedReport.requestId}:request`,
        `metrics:${options.deployedReport.requestId}:alerts`,
        `metrics:${options.deployedReport.requestId}:canary`,
      ],
      fields: {
        browserWebSocketP95Ms: options.deployedReport.browserWebSocketTiming.p95FanoutLatencyMs,
        edgePlacementVarianceMs: options.deployedReport.edgePlacement.varianceMs,
        directWorkerNetworkingRejected: options.deployedReport.directWorkerNetworking.rejected,
        upstreamFailureReason: options.deployedReport.upstreamReport.failureReason ?? null,
        upstreamRetryCount,
        checkpointRelayOwner: 'coordinator-storage',
        exportedAtMs: options.exportedAtMs,
      },
    },
    alertThresholds,
    canaryRelease,
    rollbackCheckpointBoundary,
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason, canaryRelease.decision),
  };
}

function evaluateAlertThresholds(input: {
  readonly report: WorkersCoordinatorDeployedSmokeReport;
  readonly thresholds: WorkersCoordinatorProductionGateThresholds;
  readonly upstreamRetryCount: number;
}): WorkersCoordinatorProductionObservabilityCanaryReport['alertThresholds'] {
  const directRejected = input.report.directWorkerNetworking.rejected;
  return [
    {
      name: 'browser-websocket-p95',
      observed: input.report.browserWebSocketTiming.p95FanoutLatencyMs,
      threshold: input.thresholds.maxBrowserP95FanoutLatencyMs,
      status: input.report.browserWebSocketTiming.p95FanoutLatencyMs
        > input.thresholds.maxBrowserP95FanoutLatencyMs ? 'page' : 'ok',
      reason: input.report.browserWebSocketTiming.p95FanoutLatencyMs
        > input.thresholds.maxBrowserP95FanoutLatencyMs ? 'browser websocket p95 exceeded' : undefined,
    },
    {
      name: 'edge-placement-variance',
      observed: input.report.edgePlacement.varianceMs,
      threshold: input.thresholds.maxEdgePlacementVarianceMs,
      status: input.report.edgePlacement.varianceMs > input.thresholds.maxEdgePlacementVarianceMs
        ? 'warn'
        : 'ok',
      reason: input.report.edgePlacement.varianceMs > input.thresholds.maxEdgePlacementVarianceMs
        ? 'edge placement variance exceeded'
        : undefined,
    },
    {
      name: 'direct-worker-networking-rejection',
      observed: directRejected,
      threshold: input.thresholds.requireDirectWorkerNetworkingRejected,
      status: input.thresholds.requireDirectWorkerNetworkingRejected && !directRejected ? 'page' : 'ok',
      reason: input.thresholds.requireDirectWorkerNetworkingRejected && !directRejected
        ? 'direct worker-to-worker networking was not rejected'
        : undefined,
    },
    {
      name: 'upstream-worker-failure-reason',
      observed: input.report.upstreamReport.failureReason ?? null,
      threshold: null,
      status: input.report.upstreamReport.failureReason ? 'page' : 'ok',
      reason: input.report.upstreamReport.failureReason,
    },
    {
      name: 'upstream-retry-count',
      observed: input.upstreamRetryCount,
      threshold: input.thresholds.maxUpstreamRetryCount,
      status: input.upstreamRetryCount > input.thresholds.maxUpstreamRetryCount ? 'warn' : 'ok',
      reason: input.upstreamRetryCount > input.thresholds.maxUpstreamRetryCount
        ? 'upstream retry count exceeded'
        : undefined,
    },
  ];
}

function decideCanaryRelease(input: {
  readonly canary: WorkersCoordinatorCanaryState;
  readonly hasPageAlert: boolean;
  readonly hasWarnAlert: boolean;
  readonly rollbackCheckpointBoundaryPreserved: boolean;
}): WorkersCoordinatorProductionObservabilityCanaryReport['canaryRelease'] {
  if (!input.rollbackCheckpointBoundaryPreserved) {
    return canaryDecision(input.canary, 'rollback', 'checkpoint boundary is not Coordinator-owned');
  }
  if (input.hasPageAlert || input.canary.observedErrorCount > input.canary.rollbackErrorBudget) {
    return canaryDecision(input.canary, 'rollback', 'page alert or rollback error budget breach');
  }
  if (input.hasWarnAlert || input.canary.observedHealthyRequests < input.canary.minHealthyRequests) {
    return canaryDecision(input.canary, 'hold', 'waiting for healthy request floor and clean warnings');
  }
  return canaryDecision(input.canary, 'promote', 'all production observability thresholds are clean');
}

function canaryDecision(
  canary: WorkersCoordinatorCanaryState,
  decision: WorkersCoordinatorCanaryDecision,
  reason: string,
): WorkersCoordinatorProductionObservabilityCanaryReport['canaryRelease'] {
  return {
    stableVersion: canary.stableVersion,
    canaryVersion: canary.canaryVersion,
    sampleRate: canary.sampleRate,
    decision,
    reason,
  };
}

function selectFailureReason(input: {
  readonly deployedFailureReason: string | undefined;
  readonly alertThresholds: WorkersCoordinatorProductionObservabilityCanaryReport['alertThresholds'];
  readonly canaryDecision: WorkersCoordinatorCanaryDecision;
  readonly rollbackCheckpointBoundaryPreserved: boolean;
}): string | undefined {
  if (input.deployedFailureReason) {
    return `deployed-smoke-failed: ${input.deployedFailureReason}`;
  }
  if (!input.rollbackCheckpointBoundaryPreserved) {
    return 'rollback-checkpoint-boundary-broken';
  }
  const pageAlert = input.alertThresholds.find((alert) => alert.status === 'page');
  if (pageAlert) {
    return `production-alert-page: ${pageAlert.name}`;
  }
  if (input.canaryDecision === 'rollback') {
    return 'canary-rollback-required';
  }
  return undefined;
}

function selectBottlenecksToIssue(
  failureReason: string | undefined,
  canaryDecision: WorkersCoordinatorCanaryDecision,
): readonly string[] {
  if (failureReason?.startsWith('production-alert-page')) {
    return ['production-alert-remediation-runbook'];
  }
  if (failureReason === 'rollback-checkpoint-boundary-broken') {
    return ['rollback-checkpoint-boundary-hardening'];
  }
  if (canaryDecision === 'hold') {
    return ['canary-sample-size-and-warning-budget'];
  }
  if (failureReason) {
    return [`production-observability-canary-failure: ${failureReason}`];
  }
  return ['signed-runner-csp-coop-coep-release-gate'];
}
