import type { AdaptiveChunkAssignmentReport } from './adaptive-chunk-dispatcher.js';
import { AllowlistedPrototypeTransport } from './two-worker-prototype.js';
import { workerId, WorkerTier, type SegmentConfig, type WorkerId } from './types.js';

export type WorkersCoordinatorStatus = 'pass' | 'fail';

export interface WorkersCoordinatorWorkerRegistration {
  readonly id: string;
  readonly tier: WorkerTier;
  readonly heartbeatAtMs: number;
  readonly eligible: boolean;
  readonly maxChunkLength: number;
}

export interface WorkersCoordinatorPrototypeManifest {
  readonly requestId: string;
  readonly receivedAtMs: number;
  readonly promptTokens: number;
  readonly segments: readonly SegmentConfig[];
  readonly workers: readonly WorkersCoordinatorWorkerRegistration[];
  readonly assignments: readonly AdaptiveChunkAssignmentReport[];
  readonly checkpointBytes: number;
  readonly checkpointRelayMs: number;
  readonly retryBackoffMs: number;
  readonly lostWorkerId?: string;
  readonly coordinatorUrl?: string;
  readonly cdnUrl?: string;
  readonly maxFanoutLatencyMs: number;
  readonly maxRetryResumeImpactMs: number;
}

export interface WorkersCoordinatorPrototypeReport {
  readonly requestId: string;
  readonly status: WorkersCoordinatorStatus;
  readonly requestLifecycle: {
    readonly endpoint: string;
    readonly acceptedAtMs: number;
    readonly plannedSegmentCount: number;
    readonly promptTokens: number;
    readonly completedAtMs: number;
  };
  readonly workerStateBoundary: {
    readonly owner: 'durable-object';
    readonly singleWriter: true;
    readonly registeredWorkers: readonly {
      readonly workerId: WorkerId;
      readonly tier: WorkerTier;
      readonly heartbeatAtMs: number;
      readonly eligible: boolean;
      readonly maxChunkLength: number;
    }[];
    readonly eligibleWorkers: readonly WorkerId[];
  };
  readonly assignmentReport: {
    readonly source: 'AdaptiveChunkDispatcher';
    readonly assignments: readonly AdaptiveChunkAssignmentReport[];
  };
  readonly checkpointRelay: {
    readonly owner: 'coordinator-storage';
    readonly directWorkerNetworking: false;
    readonly bytes: number;
    readonly relayMs: number;
    readonly storageKeys: readonly string[];
  };
  readonly retryResumeImpact: {
    readonly lostWorkerId?: WorkerId;
    readonly retryCount: number;
    readonly resumeCount: number;
    readonly estimatedDelayMs: number;
    readonly resumedFromSegment: number | null;
  };
  readonly fanoutLatencyMs: number;
  readonly transport: {
    readonly allowlist: readonly string[];
    readonly connections: readonly string[];
  };
  readonly failureReason?: string;
}

const DEFAULT_COORDINATOR_URL = 'https://coordinator.unzen.local';
const DEFAULT_CDN_URL = 'https://cdn.unzen.local';

export function createDefaultWorkersCoordinatorManifest(
  assignments: readonly AdaptiveChunkAssignmentReport[],
  segments: readonly SegmentConfig[],
): WorkersCoordinatorPrototypeManifest {
  return {
    requestId: 'workers-coordinator-default',
    receivedAtMs: 1_779_321_600_000,
    promptTokens: 64,
    segments,
    workers: [
      workerRegistration('stable-t2-a', WorkerTier.TIER_2, 1_779_321_600_100, true, 2),
      workerRegistration('stable-t2-b', WorkerTier.TIER_2, 1_779_321_600_120, true, 2),
      workerRegistration('visitor-t3-a', WorkerTier.TIER_3, 1_779_321_600_140, true, 1),
    ],
    assignments,
    checkpointBytes: 4 * 1024 * 1024,
    checkpointRelayMs: 420,
    retryBackoffMs: 50,
    lostWorkerId: assignments[0]?.workerId,
    maxFanoutLatencyMs: 750,
    maxRetryResumeImpactMs: 1_000,
  };
}

export function runWorkersCoordinatorPrototype(
  manifest: WorkersCoordinatorPrototypeManifest,
  transport = new AllowlistedPrototypeTransport([
    manifest.coordinatorUrl ?? DEFAULT_COORDINATOR_URL,
    manifest.cdnUrl ?? DEFAULT_CDN_URL,
  ]),
): WorkersCoordinatorPrototypeReport {
  if (manifest.segments.length === 0) {
    throw new Error('Workers Coordinator prototype requires at least one segment');
  }
  if (manifest.assignments.length === 0) {
    throw new Error('Workers Coordinator prototype requires AdaptiveChunkDispatcher assignments');
  }

  const transportStartIndex = transport.connectionCount;
  const coordinatorUrl = manifest.coordinatorUrl ?? DEFAULT_COORDINATOR_URL;
  const cdnUrl = manifest.cdnUrl ?? DEFAULT_CDN_URL;
  const state = new SimulatedCoordinatorDurableObject(manifest);

  transport.connect(`${coordinatorUrl}/api/requests/${manifest.requestId}`);
  for (const worker of state.registeredWorkers) {
    transport.connect(`${coordinatorUrl}/workers/${worker.workerId}/heartbeat`);
  }
  for (const assignment of manifest.assignments) {
    transport.connect(
      `${coordinatorUrl}/requests/${manifest.requestId}/assignments/${assignment.startSegment}`,
    );
    for (let segment = assignment.startSegment; segment <= assignment.endSegment; segment++) {
      transport.connect(`${cdnUrl}/models/proto-30b-q4/seg-${segment}.bin`);
    }
  }

  const checkpointRelay = state.relayCheckpoint();
  for (const key of checkpointRelay.storageKeys) {
    transport.connect(`${coordinatorUrl}/checkpoints/${key}`);
  }

  const retryResumeImpact = state.computeRetryResumeImpact();
  const fanoutLatencyMs = state.computeFanoutLatencyMs();
  const failureReason = selectFailureReason(manifest, state, retryResumeImpact, fanoutLatencyMs);

  return {
    requestId: manifest.requestId,
    status: failureReason ? 'fail' : 'pass',
    requestLifecycle: {
      endpoint: '/api/requests',
      acceptedAtMs: manifest.receivedAtMs,
      plannedSegmentCount: manifest.segments.length,
      promptTokens: manifest.promptTokens,
      completedAtMs: manifest.receivedAtMs + fanoutLatencyMs + retryResumeImpact.estimatedDelayMs,
    },
    workerStateBoundary: {
      owner: 'durable-object',
      singleWriter: true,
      registeredWorkers: state.registeredWorkers,
      eligibleWorkers: state.registeredWorkers
        .filter((worker) => worker.eligible)
        .map((worker) => worker.workerId),
    },
    assignmentReport: {
      source: 'AdaptiveChunkDispatcher',
      assignments: manifest.assignments,
    },
    checkpointRelay,
    retryResumeImpact,
    fanoutLatencyMs,
    transport: {
      allowlist: transport.allowlist,
      connections: transport.connectionsSince(transportStartIndex),
    },
    failureReason,
  };
}

class SimulatedCoordinatorDurableObject {
  readonly registeredWorkers: WorkersCoordinatorPrototypeReport['workerStateBoundary']['registeredWorkers'];

  constructor(private readonly manifest: WorkersCoordinatorPrototypeManifest) {
    this.registeredWorkers = manifest.workers.map((worker) => ({
      workerId: workerId(worker.id),
      tier: worker.tier,
      heartbeatAtMs: worker.heartbeatAtMs,
      eligible: worker.eligible,
      maxChunkLength: worker.maxChunkLength,
    }));
  }

  relayCheckpoint(): WorkersCoordinatorPrototypeReport['checkpointRelay'] {
    return {
      owner: 'coordinator-storage',
      directWorkerNetworking: false,
      bytes: this.manifest.checkpointBytes,
      relayMs: this.manifest.checkpointRelayMs,
      storageKeys: this.manifest.assignments.slice(0, -1).map(
        (assignment) =>
          `${this.manifest.requestId}/segment-${assignment.endSegment}/to-${assignment.endSegment + 1}`,
      ),
    };
  }

  computeRetryResumeImpact(): WorkersCoordinatorPrototypeReport['retryResumeImpact'] {
    const lostWorkerId = this.manifest.lostWorkerId ? workerId(this.manifest.lostWorkerId) : undefined;
    const lostAssignment = lostWorkerId
      ? this.manifest.assignments.find((assignment) => assignment.workerId === lostWorkerId)
      : undefined;
    const retryCount = lostAssignment ? 1 : 0;

    return {
      lostWorkerId,
      retryCount,
      resumeCount: retryCount,
      estimatedDelayMs: retryCount * (this.manifest.checkpointRelayMs + this.manifest.retryBackoffMs),
      resumedFromSegment: lostAssignment?.startSegment ?? null,
    };
  }

  computeFanoutLatencyMs(): number {
    const assignmentLatency = this.manifest.assignments.reduce(
      (sum, assignment) => sum + assignment.checkpointTransferMs,
      0,
    );
    return Math.round(assignmentLatency / Math.max(1, this.manifest.assignments.length));
  }
}

function selectFailureReason(
  manifest: WorkersCoordinatorPrototypeManifest,
  state: SimulatedCoordinatorDurableObject,
  retryResumeImpact: WorkersCoordinatorPrototypeReport['retryResumeImpact'],
  fanoutLatencyMs: number,
): string | undefined {
  if (state.registeredWorkers.filter((worker) => worker.eligible).length === 0) {
    return 'no-eligible-workers';
  }
  const eligibleWorkerIds = new Set(
    state.registeredWorkers
      .filter((worker) => worker.eligible)
      .map((worker) => worker.workerId),
  );
  const ineligibleAssignment = manifest.assignments.find(
    (assignment) => !eligibleWorkerIds.has(assignment.workerId),
  );
  if (ineligibleAssignment) {
    return `assignment-worker-ineligible: ${ineligibleAssignment.workerId}`;
  }
  if (fanoutLatencyMs > manifest.maxFanoutLatencyMs) {
    return `fanout-latency-exceeded: ${fanoutLatencyMs}ms exceeds ${manifest.maxFanoutLatencyMs}ms`;
  }
  if (retryResumeImpact.estimatedDelayMs > manifest.maxRetryResumeImpactMs) {
    return `retry-resume-impact-exceeded: ${retryResumeImpact.estimatedDelayMs}ms exceeds ${manifest.maxRetryResumeImpactMs}ms`;
  }
  return undefined;
}

function workerRegistration(
  id: string,
  tier: WorkerTier,
  heartbeatAtMs: number,
  eligible: boolean,
  maxChunkLength: number,
): WorkersCoordinatorWorkerRegistration {
  return {
    id,
    tier,
    heartbeatAtMs,
    eligible,
    maxChunkLength,
  };
}
