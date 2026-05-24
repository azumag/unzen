import type {
  WorkersCoordinatorPrototypeManifest,
} from './workers-coordinator-prototype.js';
import type {
  WorkersCoordinatorMiniflareSmokeReport,
} from './workers-coordinator-miniflare-smoke.js';

export type WorkersCoordinatorDeploymentRuntime = 'wrangler-preview' | 'deployed-worker';

export interface WorkersCoordinatorDeploymentTarget {
  readonly baseUrl: string;
  readonly runtime: WorkersCoordinatorDeploymentRuntime;
  readonly environment: string;
  readonly authHeaderName?: string;
  readonly authToken?: string;
  readonly durableObjectMigrationTag: string;
  readonly edgePlacementHints: readonly string[];
}

export interface WorkersCoordinatorBrowserHeartbeatAck {
  readonly ok: true;
  readonly workerId: string;
  readonly requestId: string;
  readonly burst: number;
  readonly clientMeasuredLatencyMs: number;
  readonly edgeColo?: string;
}

export interface WorkersCoordinatorDeployedSmokeClient {
  postRequest(
    target: WorkersCoordinatorDeploymentTarget,
    manifest: WorkersCoordinatorPrototypeManifest,
  ): Promise<{ readonly httpStatus: number; readonly edgeColo?: string; readonly latencyMs: number }>;
  sendHeartbeat(
    target: WorkersCoordinatorDeploymentTarget,
    workerId: string,
    payload: {
      readonly requestId: string;
      readonly sentAtMs: number;
      readonly burst: number;
    },
  ): Promise<WorkersCoordinatorBrowserHeartbeatAck>;
  rejectDirectWorkerNetworking(
    target: WorkersCoordinatorDeploymentTarget,
  ): Promise<WorkersCoordinatorMiniflareSmokeReport['directWorkerNetworking']>;
  readReport(
    target: WorkersCoordinatorDeploymentTarget,
    requestId: string,
  ): Promise<WorkersCoordinatorMiniflareSmokeReport>;
}

export interface WorkersCoordinatorDeployedSmokeOptions {
  readonly manifest: WorkersCoordinatorPrototypeManifest;
  readonly target: WorkersCoordinatorDeploymentTarget;
  readonly client: WorkersCoordinatorDeployedSmokeClient;
  readonly heartbeatBursts?: number;
  readonly maxBrowserP95FanoutLatencyMs?: number;
  readonly maxEdgePlacementVarianceMs?: number;
}

export interface WorkersCoordinatorDeployedSmokeReport {
  readonly runtime: 'deployed-workers-smoke';
  readonly status: 'pass' | 'fail';
  readonly requestId: string;
  readonly target: {
    readonly baseUrl: string;
    readonly runtime: WorkersCoordinatorDeploymentRuntime;
    readonly environment: string;
    readonly authHeaderName?: string;
    readonly authHeaderPresent: boolean;
    readonly durableObjectMigrationTag: string;
    readonly edgePlacementHints: readonly string[];
  };
  readonly requestLifecycle: WorkersCoordinatorMiniflareSmokeReport['requestLifecycle'] & {
    readonly edgeColo?: string;
    readonly deployedFetchLatencyMs: number;
  };
  readonly browserWebSocketTiming: {
    readonly source: 'real-browser-websocket-client';
    readonly heartbeatBursts: number;
    readonly attemptedHeartbeatCount: number;
    readonly acceptedHeartbeatCount: number;
    readonly fanoutLatencySamplesMs: readonly number[];
    readonly p95FanoutLatencyMs: number;
  };
  readonly edgePlacement: {
    readonly observations: readonly {
      readonly edgeColo: string;
      readonly apiLatencyMs?: number;
      readonly webSocketLatencyMs?: number;
    }[];
    readonly varianceMs: number;
  };
  readonly directWorkerNetworking: WorkersCoordinatorMiniflareSmokeReport['directWorkerNetworking'];
  readonly upstreamReport: WorkersCoordinatorMiniflareSmokeReport;
  readonly failureReason?: string;
  readonly bottlenecksToIssue: readonly string[];
}

const DEFAULT_HEARTBEAT_BURSTS = 4;
const DEFAULT_EDGE_PLACEMENT_VARIANCE_MS = 250;

export async function runWorkersCoordinatorDeployedSmoke(
  options: WorkersCoordinatorDeployedSmokeOptions,
): Promise<WorkersCoordinatorDeployedSmokeReport> {
  const heartbeatBursts = options.heartbeatBursts ?? DEFAULT_HEARTBEAT_BURSTS;
  const maxBrowserP95FanoutLatencyMs =
    options.maxBrowserP95FanoutLatencyMs ?? options.manifest.maxFanoutLatencyMs;
  const maxEdgePlacementVarianceMs =
    options.maxEdgePlacementVarianceMs ?? DEFAULT_EDGE_PLACEMENT_VARIANCE_MS;

  const requestResult = await options.client.postRequest(options.target, options.manifest);
  const heartbeatAcks: WorkersCoordinatorBrowserHeartbeatAck[] = [];

  for (let burst = 0; burst < heartbeatBursts; burst++) {
    heartbeatAcks.push(...await Promise.all(
      options.manifest.workers.map((worker) =>
        options.client.sendHeartbeat(options.target, worker.id, {
          requestId: options.manifest.requestId,
          sentAtMs: Date.now(),
          burst,
        }),
      ),
    ));
  }

  const directWorkerNetworking = await options.client.rejectDirectWorkerNetworking(options.target);
  const upstreamReport = await options.client.readReport(options.target, options.manifest.requestId);
  const fanoutLatencySamplesMs = heartbeatAcks.map((ack) => ack.clientMeasuredLatencyMs);
  const p95FanoutLatencyMs = percentileNumber(fanoutLatencySamplesMs, 95);
  const edgePlacement = computeEdgePlacement(
    requestResult,
    heartbeatAcks,
  );
  const failureReason = selectDeployedSmokeFailureReason({
    requestHttpStatus: requestResult.httpStatus,
    directWorkerNetworkingRejected: directWorkerNetworking.rejected,
    upstreamFailureReason: upstreamReport.failureReason,
    acceptedHeartbeatCount: heartbeatAcks.length,
    expectedHeartbeatCount: options.manifest.workers.length * heartbeatBursts,
    p95FanoutLatencyMs,
    maxBrowserP95FanoutLatencyMs,
    edgePlacementVarianceMs: edgePlacement.varianceMs,
    maxEdgePlacementVarianceMs,
  });

  return {
    runtime: 'deployed-workers-smoke',
    status: failureReason ? 'fail' : 'pass',
    requestId: options.manifest.requestId,
    target: {
      baseUrl: options.target.baseUrl,
      runtime: options.target.runtime,
      environment: options.target.environment,
      authHeaderName: options.target.authHeaderName,
      authHeaderPresent: Boolean(options.target.authToken),
      durableObjectMigrationTag: options.target.durableObjectMigrationTag,
      edgePlacementHints: options.target.edgePlacementHints,
    },
    requestLifecycle: {
      ...upstreamReport.requestLifecycle,
      edgeColo: requestResult.edgeColo,
      deployedFetchLatencyMs: requestResult.latencyMs,
    },
    browserWebSocketTiming: {
      source: 'real-browser-websocket-client',
      heartbeatBursts,
      attemptedHeartbeatCount: options.manifest.workers.length * heartbeatBursts,
      acceptedHeartbeatCount: heartbeatAcks.length,
      fanoutLatencySamplesMs,
      p95FanoutLatencyMs,
    },
    edgePlacement,
    directWorkerNetworking,
    upstreamReport,
    failureReason,
    bottlenecksToIssue: selectBottlenecksToIssue(failureReason),
  };
}

function computeEdgePlacement(
  requestResult: { readonly edgeColo?: string; readonly latencyMs: number },
  heartbeatAcks: readonly WorkersCoordinatorBrowserHeartbeatAck[],
): WorkersCoordinatorDeployedSmokeReport['edgePlacement'] {
  const observations: {
    readonly edgeColo: string;
    readonly apiLatencyMs?: number;
    readonly webSocketLatencyMs?: number;
  }[] = [];

  if (requestResult.edgeColo) {
    observations.push({
      edgeColo: requestResult.edgeColo,
      apiLatencyMs: requestResult.latencyMs,
    });
  }
  for (const ack of heartbeatAcks) {
    if (!ack.edgeColo) {
      continue;
    }
    observations.push({
      edgeColo: ack.edgeColo,
      webSocketLatencyMs: ack.clientMeasuredLatencyMs,
    });
  }

  const latencies = observations
    .map((observation) => observation.apiLatencyMs ?? observation.webSocketLatencyMs)
    .filter((latency): latency is number => typeof latency === 'number');

  return {
    observations,
    varianceMs: latencies.length === 0 ? 0 : Math.max(...latencies) - Math.min(...latencies),
  };
}

function selectDeployedSmokeFailureReason(input: {
  readonly requestHttpStatus: number;
  readonly directWorkerNetworkingRejected: boolean;
  readonly upstreamFailureReason: string | undefined;
  readonly acceptedHeartbeatCount: number;
  readonly expectedHeartbeatCount: number;
  readonly p95FanoutLatencyMs: number;
  readonly maxBrowserP95FanoutLatencyMs: number;
  readonly edgePlacementVarianceMs: number;
  readonly maxEdgePlacementVarianceMs: number;
}): string | undefined {
  if (input.requestHttpStatus !== 202) {
    return `deployed-request-not-accepted: ${input.requestHttpStatus}`;
  }
  if (input.acceptedHeartbeatCount !== input.expectedHeartbeatCount) {
    return `browser-heartbeat-acceptance-mismatch: ${input.acceptedHeartbeatCount}/${input.expectedHeartbeatCount}`;
  }
  if (!input.directWorkerNetworkingRejected) {
    return 'direct-worker-networking-not-rejected';
  }
  if (input.upstreamFailureReason) {
    return input.upstreamFailureReason;
  }
  if (input.p95FanoutLatencyMs > input.maxBrowserP95FanoutLatencyMs) {
    return `browser-websocket-p95-exceeded: ${input.p95FanoutLatencyMs}ms exceeds ${input.maxBrowserP95FanoutLatencyMs}ms`;
  }
  if (input.edgePlacementVarianceMs > input.maxEdgePlacementVarianceMs) {
    return `edge-placement-variance-exceeded: ${input.edgePlacementVarianceMs}ms exceeds ${input.maxEdgePlacementVarianceMs}ms`;
  }
  return undefined;
}

function selectBottlenecksToIssue(failureReason: string | undefined): readonly string[] {
  if (failureReason?.startsWith('browser-websocket-p95-exceeded')) {
    return ['real-browser-websocket-fanout-p95'];
  }
  if (failureReason?.startsWith('edge-placement-variance-exceeded')) {
    return ['worker-edge-placement-variance-routing'];
  }
  if (failureReason) {
    return [`deployed-workers-smoke-failure: ${failureReason}`];
  }
  return ['production-observability-and-canary-release'];
}

function percentileNumber(samples: readonly number[], percentileRank: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
