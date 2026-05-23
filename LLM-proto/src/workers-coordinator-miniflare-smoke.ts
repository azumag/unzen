import { Miniflare } from 'miniflare';
import type { AdaptiveChunkAssignmentReport } from './adaptive-chunk-dispatcher.js';
import type {
  WorkersCoordinatorPrototypeManifest,
  WorkersCoordinatorPrototypeReport,
} from './workers-coordinator-prototype.js';

export interface WorkersCoordinatorMiniflareSmokeOptions {
  readonly manifest: WorkersCoordinatorPrototypeManifest;
  readonly concurrentHeartbeatBursts?: number;
}

export interface WorkersCoordinatorLoadShapedSmokeOptions {
  readonly manifests: readonly WorkersCoordinatorPrototypeManifest[];
  readonly durableObjectsPersistRoot: string;
  readonly heartbeatBursts?: number;
  readonly churnWorkerIds?: readonly string[];
  readonly maxP95FanoutLatencyMs?: number;
}

export interface WorkersCoordinatorMiniflareSmokeReport {
  readonly runtime: 'miniflare';
  readonly requestId: string;
  readonly status: 'pass' | 'fail';
  readonly requestLifecycle: WorkersCoordinatorPrototypeReport['requestLifecycle'] & {
    readonly httpStatus: number;
  };
  readonly durableObjectStorageFields: {
    readonly owner: 'durable-object';
    readonly singleWriter: true;
    readonly storageKeys: readonly string[];
    readonly registeredWorkers: WorkersCoordinatorPrototypeReport['workerStateBoundary']['registeredWorkers'];
    readonly eligibleWorkers: WorkersCoordinatorPrototypeReport['workerStateBoundary']['eligibleWorkers'];
    readonly checkpointMetadata: readonly {
      readonly key: string;
      readonly requestId: string;
      readonly fromSegment: number;
      readonly toSegment: number;
      readonly bytes: number;
      readonly relayMs: number;
      readonly owner: 'coordinator-storage';
    }[];
  };
  readonly assignmentReport: {
    readonly source: 'AdaptiveChunkDispatcher';
    readonly importedByRuntime: true;
    readonly assignments: readonly AdaptiveChunkAssignmentReport[];
  };
  readonly checkpointRelay: WorkersCoordinatorPrototypeReport['checkpointRelay'];
  readonly retryResumeImpact: WorkersCoordinatorPrototypeReport['retryResumeImpact'];
  readonly webSocketHeartbeatPath: WorkersCoordinatorPrototypeReport['webSocketHeartbeatPath'] & {
    readonly acceptedStatus: 101;
    readonly concurrentHeartbeatBursts: number;
  };
  readonly directWorkerNetworking: WorkersCoordinatorPrototypeReport['directWorkerNetworking'] & {
    readonly httpStatus: 403;
  };
  readonly fanoutLatencyMs: number;
  readonly bottlenecksToIssue: readonly string[];
  readonly failureReason?: string;
}

export interface WorkersCoordinatorLoadShapedSmokeReport {
  readonly runtime: 'miniflare-load-shaped';
  readonly status: 'pass' | 'fail';
  readonly requestIds: readonly string[];
  readonly customerTraffic: {
    readonly concurrentApiRequests: number;
    readonly acceptedApiRequests: number;
    readonly heartbeatBursts: number;
    readonly attemptedHeartbeatCount: number;
    readonly acceptedHeartbeatCount: number;
    readonly churnedHeartbeatCount: number;
    readonly churnedWorkerIds: readonly string[];
  };
  readonly clientTiming: {
    readonly source: 'client-performance-now';
    readonly fanoutLatencySamplesMs: readonly number[];
    readonly p95FanoutLatencyMs: number;
  };
  readonly restartPersistence: {
    readonly persisted: boolean;
    readonly durableObjectsPersistRoot: string;
    readonly beforeRestartStorageKeyCount: number;
    readonly afterRestartStorageKeyCount: number;
    readonly persistedRequestIds: readonly string[];
    readonly missingRequestIds: readonly string[];
  };
  readonly requestReports: readonly WorkersCoordinatorMiniflareSmokeReport[];
  readonly directWorkerNetworking: WorkersCoordinatorMiniflareSmokeReport['directWorkerNetworking'];
  readonly retryResumeImpact: {
    readonly totalRetryCount: number;
    readonly totalResumeCount: number;
    readonly maxEstimatedDelayMs: number;
  };
  readonly failureReason?: string;
}

interface WebSocketUpgradeResponse extends Response {
  readonly webSocket?: MiniflareWebSocket | null;
}

interface MiniflareWebSocket {
  accept(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
}

interface HeartbeatAck {
  readonly ok: true;
  readonly type: 'heartbeat-ack';
  readonly workerId: string;
  readonly fanoutLatencyMs: number;
}

interface MeasuredHeartbeatAck extends HeartbeatAck {
  readonly requestId: string;
  readonly burst: number;
  readonly clientMeasuredLatencyMs: number;
}

const DEFAULT_HEARTBEAT_BURSTS = 4;
const DEFAULT_LOAD_SHAPED_HEARTBEAT_BURSTS = 5;

export async function runWorkersCoordinatorMiniflareSmoke(
  options: WorkersCoordinatorMiniflareSmokeOptions,
): Promise<WorkersCoordinatorMiniflareSmokeReport> {
  const heartbeatBursts = options.concurrentHeartbeatBursts ?? DEFAULT_HEARTBEAT_BURSTS;
  const mf = createWorkersCoordinatorMiniflare();

  try {
    const requestResponse = await mf.dispatchFetch('http://workers.local/api/requests', {
      method: 'POST',
      body: JSON.stringify(options.manifest),
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!requestResponse.ok) {
      throw new Error(`Miniflare request endpoint failed: ${requestResponse.status}`);
    }

    for (let burst = 0; burst < heartbeatBursts; burst++) {
      await Promise.all(
        options.manifest.workers.map((worker, workerIndex) =>
          dispatchHeartbeat(mf, worker.id, {
            requestId: options.manifest.requestId,
            sentAtMs: options.manifest.receivedAtMs + burst * 100 + workerIndex * 11,
            fanoutLatencyMs: 100 + burst * 13 + workerIndex * 27,
            burst,
          }),
        ),
      );
    }

    const directResponse = await mf.dispatchFetch('http://workers.local/worker-peer/direct', {
      method: 'POST',
    });
    if (directResponse.status !== 403) {
      throw new Error(`direct worker networking was not rejected: ${directResponse.status}`);
    }

    const reportResponse = await mf.dispatchFetch(
      `http://workers.local/api/requests/${options.manifest.requestId}/report`,
    );
    if (!reportResponse.ok) {
      throw new Error(`Miniflare report endpoint failed: ${reportResponse.status}`);
    }

    return await reportResponse.json() as WorkersCoordinatorMiniflareSmokeReport;
  } finally {
    await mf.dispose();
  }
}

export async function runWorkersCoordinatorLoadShapedSmoke(
  options: WorkersCoordinatorLoadShapedSmokeOptions,
): Promise<WorkersCoordinatorLoadShapedSmokeReport> {
  if (options.manifests.length === 0) {
    throw new Error('Load-shaped Workers Coordinator smoke requires at least one manifest');
  }

  const heartbeatBursts = options.heartbeatBursts ?? DEFAULT_LOAD_SHAPED_HEARTBEAT_BURSTS;
  const fallbackChurnWorkerId = options.manifests[0].lostWorkerId;
  const churnWorkerIds = new Set(
    options.churnWorkerIds ?? (fallbackChurnWorkerId ? [fallbackChurnWorkerId] : []),
  );
  const requestIds = options.manifests.map((manifest) => manifest.requestId);
  const maxP95FanoutLatencyMs = options.maxP95FanoutLatencyMs ?? Math.max(
    ...options.manifests.map((manifest) => manifest.maxFanoutLatencyMs),
  );

  let mf = createWorkersCoordinatorMiniflare(options.durableObjectsPersistRoot);
  let disposed = false;

  try {
    const requestResponses = await Promise.all(
      options.manifests.map((manifest) =>
        mf.dispatchFetch('http://workers.local/api/requests', {
          method: 'POST',
          body: JSON.stringify(manifest),
          headers: {
            'Content-Type': 'application/json',
          },
        }),
      ),
    );
    const acceptedApiRequests = requestResponses.filter((response) => response.status === 202).length;

    const measuredHeartbeats: MeasuredHeartbeatAck[] = [];
    let attemptedHeartbeatCount = 0;
    let churnedHeartbeatCount = 0;
    const churnStartBurst = Math.max(1, Math.floor(heartbeatBursts / 2));

    for (let burst = 0; burst < heartbeatBursts; burst++) {
      const burstHeartbeats: Promise<MeasuredHeartbeatAck>[] = [];
      for (const manifest of options.manifests) {
        for (const worker of manifest.workers) {
          attemptedHeartbeatCount++;
          if (churnWorkerIds.has(worker.id) && burst >= churnStartBurst) {
            churnedHeartbeatCount++;
            continue;
          }
          burstHeartbeats.push(dispatchMeasuredHeartbeat(mf, worker.id, {
            requestId: manifest.requestId,
            sentAtMs: Date.now(),
            burst,
          }));
        }
      }
      measuredHeartbeats.push(...await Promise.all(burstHeartbeats));
    }

    const directResponse = await mf.dispatchFetch('http://workers.local/worker-peer/direct', {
      method: 'POST',
    });
    if (directResponse.status !== 403) {
      throw new Error(`direct worker networking was not rejected: ${directResponse.status}`);
    }

    const beforeRestartReports = await readSmokeReports(mf, requestIds);
    const beforeRestartStorageKeyCount = countUniqueStorageKeys(beforeRestartReports);

    await mf.dispose();
    disposed = true;

    mf = createWorkersCoordinatorMiniflare(options.durableObjectsPersistRoot);
    disposed = false;

    const afterRestartReports = await readSmokeReports(mf, requestIds);
    const afterRestartStorageKeyCount = countUniqueStorageKeys(afterRestartReports);
    const persistedRequestIds = afterRestartReports
      .filter((report) => report.durableObjectStorageFields.storageKeys.includes(`manifest:${report.requestId}`))
      .map((report) => report.requestId);
    const missingRequestIds = requestIds.filter((requestId) => !persistedRequestIds.includes(requestId));
    const persisted = missingRequestIds.length === 0 && afterRestartStorageKeyCount >= beforeRestartStorageKeyCount;

    const fanoutLatencySamplesMs = measuredHeartbeats.map(
      (heartbeat) => heartbeat.clientMeasuredLatencyMs,
    );
    const p95FanoutLatencyMs = percentileNumber(fanoutLatencySamplesMs, 95);
    const totalRetryCount = afterRestartReports.reduce(
      (sum, report) => sum + report.retryResumeImpact.retryCount,
      0,
    );
    const totalResumeCount = afterRestartReports.reduce(
      (sum, report) => sum + report.retryResumeImpact.resumeCount,
      0,
    );
    const maxEstimatedDelayMs = afterRestartReports.reduce(
      (max, report) => Math.max(max, report.retryResumeImpact.estimatedDelayMs),
      0,
    );
    const directWorkerNetworking = afterRestartReports[0]?.directWorkerNetworking ?? {
      attemptedEndpoint: 'https://worker-peer.example/direct',
      rejected: false,
      reason: 'direct worker-to-worker route was not exercised',
      httpStatus: 200,
    };
    const nestedFailure = afterRestartReports.find((report) => report.failureReason)?.failureReason;
    const failureReason = selectLoadShapedFailureReason({
      nestedFailure,
      persisted,
      directWorkerNetworkingRejected: directWorkerNetworking.rejected,
      p95FanoutLatencyMs,
      maxP95FanoutLatencyMs,
      acceptedApiRequests,
      expectedApiRequests: options.manifests.length,
    });

    return {
      runtime: 'miniflare-load-shaped',
      status: failureReason ? 'fail' : 'pass',
      requestIds,
      customerTraffic: {
        concurrentApiRequests: options.manifests.length,
        acceptedApiRequests,
        heartbeatBursts,
        attemptedHeartbeatCount,
        acceptedHeartbeatCount: measuredHeartbeats.length,
        churnedHeartbeatCount,
        churnedWorkerIds: [...churnWorkerIds],
      },
      clientTiming: {
        source: 'client-performance-now',
        fanoutLatencySamplesMs,
        p95FanoutLatencyMs,
      },
      restartPersistence: {
        persisted,
        durableObjectsPersistRoot: options.durableObjectsPersistRoot,
        beforeRestartStorageKeyCount,
        afterRestartStorageKeyCount,
        persistedRequestIds,
        missingRequestIds,
      },
      requestReports: afterRestartReports,
      directWorkerNetworking,
      retryResumeImpact: {
        totalRetryCount,
        totalResumeCount,
        maxEstimatedDelayMs,
      },
      failureReason,
    };
  } finally {
    if (!disposed) {
      await mf.dispose();
    }
  }
}

async function dispatchHeartbeat(
  mf: Miniflare,
  workerId: string,
  payload: {
    readonly requestId: string;
    readonly sentAtMs: number;
    readonly fanoutLatencyMs: number;
    readonly burst: number;
  },
): Promise<HeartbeatAck> {
  const response = await mf.dispatchFetch(`http://workers.local/workers/${workerId}/socket`, {
    headers: {
      Upgrade: 'websocket',
    },
  }) as unknown as WebSocketUpgradeResponse;

  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`WebSocket upgrade failed for ${workerId}: ${response.status}`);
  }

  const socket = response.webSocket;
  socket.accept();
  const ack = new Promise<HeartbeatAck>((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      resolve(JSON.parse(String(event.data)) as HeartbeatAck);
    });
    socket.addEventListener('error', (event) => {
      reject(new Error(`WebSocket heartbeat failed for ${workerId}: ${String(event)}`));
    });
  });
  socket.send(JSON.stringify({
    type: 'heartbeat',
    ...payload,
  }));
  const result = await ack;
  socket.close(1000, 'heartbeat complete');
  return result;
}

async function dispatchMeasuredHeartbeat(
  mf: Miniflare,
  workerId: string,
  payload: {
    readonly requestId: string;
    readonly sentAtMs: number;
    readonly burst: number;
  },
): Promise<MeasuredHeartbeatAck> {
  const response = await mf.dispatchFetch(`http://workers.local/workers/${workerId}/socket`, {
    headers: {
      Upgrade: 'websocket',
    },
  }) as unknown as WebSocketUpgradeResponse;

  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`WebSocket upgrade failed for ${workerId}: ${response.status}`);
  }

  const socket = response.webSocket;
  socket.accept();
  const startedAt = performance.now();
  const ack = new Promise<HeartbeatAck>((resolve, reject) => {
    socket.addEventListener('message', (event) => {
      resolve(JSON.parse(String(event.data)) as HeartbeatAck);
    });
    socket.addEventListener('error', (event) => {
      reject(new Error(`WebSocket heartbeat failed for ${workerId}: ${String(event)}`));
    });
  });
  socket.send(JSON.stringify({
    type: 'heartbeat',
    ...payload,
  }));
  const result = await ack;
  const clientMeasuredLatencyMs = performance.now() - startedAt;
  socket.close(1000, 'heartbeat complete');
  return {
    ...result,
    requestId: payload.requestId,
    burst: payload.burst,
    clientMeasuredLatencyMs,
  };
}

async function readSmokeReports(
  mf: Miniflare,
  requestIds: readonly string[],
): Promise<WorkersCoordinatorMiniflareSmokeReport[]> {
  return Promise.all(
    requestIds.map(async (requestId) => {
      const response = await mf.dispatchFetch(`http://workers.local/api/requests/${requestId}/report`);
      if (!response.ok) {
        throw new Error(`Miniflare report endpoint failed for ${requestId}: ${response.status}`);
      }
      return await response.json() as WorkersCoordinatorMiniflareSmokeReport;
    }),
  );
}

function countUniqueStorageKeys(reports: readonly WorkersCoordinatorMiniflareSmokeReport[]): number {
  return new Set(reports.flatMap((report) => report.durableObjectStorageFields.storageKeys)).size;
}

function createWorkersCoordinatorMiniflare(durableObjectsPersistRoot?: string): Miniflare {
  return new Miniflare({
    modules: true,
    script: createWorkersCoordinatorMiniflareScript(),
    compatibilityDate: '2025-01-01',
    durableObjects: {
      COORDINATOR: 'WorkersCoordinatorDurableObject',
    },
    durableObjectsPersist: durableObjectsPersistRoot ?? false,
  });
}

function createWorkersCoordinatorMiniflareScript(): string {
  return `
export class WorkersCoordinatorDurableObject {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/api/requests') {
      return this.acceptRequest(request);
    }
    const reportMatch = url.pathname.match(/^\\/api\\/requests\\/([^/]+)\\/report$/);
    if (request.method === 'GET' && reportMatch) {
      return this.reportRequest(reportMatch[1]);
    }
    const socketMatch = url.pathname.match(/^\\/workers\\/([^/]+)\\/socket$/);
    if (socketMatch) {
      return this.acceptHeartbeatSocket(request, socketMatch[1]);
    }
    if (url.pathname === '/worker-peer/direct') {
      const rejection = {
        attemptedEndpoint: 'https://worker-peer.example/direct',
        rejected: true,
        reason: 'worker-to-worker networking is outside the Coordinator/CDN allowlist',
        httpStatus: 403,
      };
      await this.state.storage.put('direct-worker-networking', rejection);
      return Response.json(rejection, { status: 403 });
    }
    return new Response('not found', { status: 404 });
  }

  async acceptRequest(request) {
    const manifest = await request.json();
    const lifecycle = {
      endpoint: '/api/requests',
      acceptedAtMs: manifest.receivedAtMs,
      plannedSegmentCount: manifest.segments.length,
      promptTokens: manifest.promptTokens,
      completedAtMs: manifest.receivedAtMs,
    };
    await this.state.storage.put('manifest:' + manifest.requestId, manifest);
    await this.state.storage.put('request:' + manifest.requestId + ':lifecycle', lifecycle);
    for (const worker of manifest.workers) {
      await this.state.storage.put('worker:' + worker.id + ':registration', {
        workerId: worker.id,
        tier: worker.tier,
        heartbeatAtMs: worker.heartbeatAtMs,
        eligible: worker.eligible,
        maxChunkLength: worker.maxChunkLength,
      });
    }
    await this.state.storage.put('request:' + manifest.requestId + ':assignments', {
      source: 'AdaptiveChunkDispatcher',
      importedByRuntime: true,
      assignments: manifest.assignments,
    });
    const checkpointMetadata = manifest.assignments.slice(0, -1).map((assignment) => ({
      key: manifest.requestId + '/segment-' + assignment.endSegment + '/to-' + (assignment.endSegment + 1),
      requestId: manifest.requestId,
      fromSegment: assignment.endSegment,
      toSegment: assignment.endSegment + 1,
      bytes: manifest.checkpointBytes,
      relayMs: manifest.checkpointRelayMs,
      owner: 'coordinator-storage',
    }));
    for (const checkpoint of checkpointMetadata) {
      await this.state.storage.put('checkpoint:' + checkpoint.key, checkpoint);
    }
    return Response.json({
      requestLifecycle: {
        ...lifecycle,
        httpStatus: 202,
      },
    }, { status: 202 });
  }

  async acceptHeartbeatSocket(request, workerId) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.addEventListener('message', async (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type !== 'heartbeat') {
        server.send(JSON.stringify({ ok: false, reason: 'unsupported-message' }));
        return;
      }
      const serverReceivedAtMs = Date.now();
      const fanoutLatencyMs = typeof message.fanoutLatencyMs === 'number'
        ? message.fanoutLatencyMs
        : Math.max(0, serverReceivedAtMs - message.sentAtMs);
      await this.state.storage.put(
        'worker:' + workerId + ':heartbeat:' + message.requestId + ':' + message.burst,
        {
          workerId,
          requestId: message.requestId,
          sentAtMs: message.sentAtMs,
          serverReceivedAtMs,
          fanoutLatencyMs,
          burst: message.burst,
        },
      );
      server.send(JSON.stringify({
        ok: true,
        type: 'heartbeat-ack',
        workerId,
        requestId: message.requestId,
        burst: message.burst,
        serverReceivedAtMs,
        fanoutLatencyMs,
      }));
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async reportRequest(requestId) {
    const manifest = await this.state.storage.get('manifest:' + requestId);
    if (!manifest) {
      return Response.json({ error: 'unknown request' }, { status: 404 });
    }
    const lifecycle = await this.state.storage.get('request:' + requestId + ':lifecycle');
    const assignments = await this.state.storage.get('request:' + requestId + ':assignments');
    const storage = await this.state.storage.list();
    const storageKeys = [...storage.keys()].sort();
    const registeredWorkers = manifest.workers.map((worker) => storage.get('worker:' + worker.id + ':registration'));
    const eligibleWorkers = registeredWorkers
      .filter((worker) => worker.eligible)
      .map((worker) => worker.workerId);
    const checkpointMetadata = storageKeys
      .filter((key) => key.startsWith('checkpoint:' + requestId + '/'))
      .map((key) => storage.get(key));
    const heartbeatSamples = storageKeys
      .filter((key) => key.includes(':heartbeat:' + requestId + ':'))
      .map((key) => storage.get(key).fanoutLatencyMs)
      .filter((sample) => typeof sample === 'number')
      .sort((a, b) => a - b);
    const p95FanoutLatencyMs = percentile(heartbeatSamples, 95);
    const retryResumeImpact = computeRetryResumeImpact(manifest);
    const failureReason = selectFailureReason(
      manifest,
      eligibleWorkers,
      assignments.assignments,
      retryResumeImpact,
      p95FanoutLatencyMs,
    );
    const directWorkerNetworking = await this.state.storage.get('direct-worker-networking') ?? {
      attemptedEndpoint: 'https://worker-peer.example/direct',
      rejected: false,
      reason: 'direct worker-to-worker route was not exercised',
      httpStatus: 200,
    };
    const checkpointRelay = {
      owner: 'coordinator-storage',
      directWorkerNetworking: false,
      bytes: manifest.checkpointBytes,
      relayMs: manifest.checkpointRelayMs,
      storageKeys: checkpointMetadata.map((checkpoint) => checkpoint.key),
    };
    return Response.json({
      runtime: 'miniflare',
      requestId,
      status: failureReason ? 'fail' : 'pass',
      requestLifecycle: {
        ...lifecycle,
        completedAtMs: manifest.receivedAtMs + p95FanoutLatencyMs + retryResumeImpact.estimatedDelayMs,
        httpStatus: 202,
      },
      durableObjectStorageFields: {
        owner: 'durable-object',
        singleWriter: true,
        storageKeys,
        registeredWorkers,
        eligibleWorkers,
        checkpointMetadata,
      },
      assignmentReport: assignments,
      checkpointRelay,
      retryResumeImpact,
      webSocketHeartbeatPath: {
        upgradeEndpoint: '/workers/:workerId/socket',
        acceptedStatus: 101,
        processedHeartbeatCount: heartbeatSamples.length,
        fanoutLatencySamplesMs: heartbeatSamples,
        p95FanoutLatencyMs,
        concurrentHeartbeatBursts: heartbeatSamples.length / Math.max(1, registeredWorkers.length),
      },
      directWorkerNetworking,
      fanoutLatencyMs: p95FanoutLatencyMs,
      bottlenecksToIssue: selectBottlenecksToIssue(failureReason, retryResumeImpact),
      failureReason,
    });
  }
}

export default {
  fetch(request, env) {
    const id = env.COORDINATOR.idFromName('workers-coordinator-runtime-smoke');
    return env.COORDINATOR.get(id).fetch(request);
  },
};

function computeRetryResumeImpact(manifest) {
  const lostAssignment = manifest.lostWorkerId
    ? manifest.assignments.find((assignment) => assignment.workerId === manifest.lostWorkerId)
    : undefined;
  const retryCount = lostAssignment ? 1 : 0;
  return {
    lostWorkerId: manifest.lostWorkerId,
    retryCount,
    resumeCount: retryCount,
    estimatedDelayMs: retryCount * (manifest.checkpointRelayMs + manifest.retryBackoffMs),
    resumedFromSegment: lostAssignment?.startSegment ?? null,
  };
}

function selectFailureReason(
  manifest,
  eligibleWorkers,
  assignments,
  retryResumeImpact,
  p95FanoutLatencyMs,
) {
  if (eligibleWorkers.length === 0) {
    return 'no-eligible-workers';
  }
  const eligibleWorkerIds = new Set(eligibleWorkers);
  const ineligibleAssignment = assignments.find(
    (assignment) => !eligibleWorkerIds.has(assignment.workerId),
  );
  if (ineligibleAssignment) {
    return 'assignment-worker-ineligible: ' + ineligibleAssignment.workerId;
  }
  if (p95FanoutLatencyMs > manifest.maxFanoutLatencyMs) {
    return 'fanout-latency-exceeded: ' + p95FanoutLatencyMs + 'ms exceeds ' + manifest.maxFanoutLatencyMs + 'ms';
  }
  if (retryResumeImpact.estimatedDelayMs > manifest.maxRetryResumeImpactMs) {
    return 'retry-resume-impact-exceeded: ' + retryResumeImpact.estimatedDelayMs + 'ms exceeds ' + manifest.maxRetryResumeImpactMs + 'ms';
  }
  return undefined;
}

function selectBottlenecksToIssue(failureReason, retryResumeImpact) {
  if (failureReason?.startsWith('fanout-latency-exceeded')) {
    return ['miniflare-durable-object-websocket-fanout-p95'];
  }
  if (retryResumeImpact.retryCount > 0) {
    return ['wrangler-preview-retry-resume-load-shed-policy'];
  }
  return ['real-worker-customer-traffic-load-test'];
}

function percentile(samples, percentileRank) {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
`;
}

function selectLoadShapedFailureReason(input: {
  readonly nestedFailure: string | undefined;
  readonly persisted: boolean;
  readonly directWorkerNetworkingRejected: boolean;
  readonly p95FanoutLatencyMs: number;
  readonly maxP95FanoutLatencyMs: number;
  readonly acceptedApiRequests: number;
  readonly expectedApiRequests: number;
}): string | undefined {
  if (input.acceptedApiRequests !== input.expectedApiRequests) {
    return `api-request-acceptance-mismatch: ${input.acceptedApiRequests}/${input.expectedApiRequests}`;
  }
  if (!input.directWorkerNetworkingRejected) {
    return 'direct-worker-networking-not-rejected';
  }
  if (!input.persisted) {
    return 'durable-object-storage-not-persisted-across-restart';
  }
  if (input.nestedFailure) {
    return input.nestedFailure;
  }
  if (input.p95FanoutLatencyMs > input.maxP95FanoutLatencyMs) {
    return `client-timing-p95-exceeded: ${input.p95FanoutLatencyMs}ms exceeds ${input.maxP95FanoutLatencyMs}ms`;
  }
  return undefined;
}

function percentileNumber(samples: readonly number[], percentileRank: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}
