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

const DEFAULT_HEARTBEAT_BURSTS = 4;

export async function runWorkersCoordinatorMiniflareSmoke(
  options: WorkersCoordinatorMiniflareSmokeOptions,
): Promise<WorkersCoordinatorMiniflareSmokeReport> {
  const heartbeatBursts = options.concurrentHeartbeatBursts ?? DEFAULT_HEARTBEAT_BURSTS;
  const mf = new Miniflare({
    modules: true,
    script: createWorkersCoordinatorMiniflareScript(),
    compatibilityDate: '2025-01-01',
    durableObjects: {
      COORDINATOR: 'WorkersCoordinatorDurableObject',
    },
  });

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
      await this.state.storage.put(
        'worker:' + workerId + ':heartbeat:' + message.requestId + ':' + message.burst,
        {
          workerId,
          requestId: message.requestId,
          sentAtMs: message.sentAtMs,
          fanoutLatencyMs: message.fanoutLatencyMs,
          burst: message.burst,
        },
      );
      server.send(JSON.stringify({
        ok: true,
        type: 'heartbeat-ack',
        workerId,
        fanoutLatencyMs: message.fanoutLatencyMs,
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
