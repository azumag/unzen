import {
  AdaptiveChunkDispatcher,
  type AdaptiveChunkAssignmentReport,
  type AdaptiveDispatcherRunReport,
  type WorkerTelemetry,
} from './adaptive-chunk-dispatcher.js';
import type { BrowserRetentionMeasurementReport } from './browser-worker-retention.js';
import { AllowlistedPrototypeTransport } from './two-worker-prototype.js';
import { type SegmentConfig, WorkerTier, workerId, type WorkerId } from './types.js';

export interface CoordinatorPrototypeWorkerRegistration {
  readonly id: string;
  readonly tier: WorkerTier;
  readonly telemetry: WorkerTelemetry;
  readonly lastHeartbeatMs: number;
}

export interface CoordinatorPrototypeManifest {
  readonly requestId: string;
  readonly prompt: string;
  readonly segments: readonly SegmentConfig[];
  readonly workers: readonly CoordinatorPrototypeWorkerRegistration[];
  readonly retentionReport?: BrowserRetentionMeasurementReport;
  readonly tier3MinRetentionAtSegmentEnd?: number;
  readonly lostWorkerId?: string;
  readonly lostAfterAssignmentIndex?: number;
  readonly coordinatorUrl?: string;
  readonly cdnUrl?: string;
  readonly loadBudgetRatio?: number;
  readonly checkpointBytes?: number;
}

export interface CoordinatorPrototypeReport {
  readonly requestId: string;
  readonly status: 'pass' | 'fail';
  readonly requestLifecycle: {
    readonly accepted: boolean;
    readonly promptBytes: number;
    readonly assignmentCount: number;
    readonly completed: boolean;
    readonly finalSegment: number;
  };
  readonly workerHeartbeats: readonly {
    readonly workerId: WorkerId;
    readonly tier: WorkerTier;
    readonly lastHeartbeatMs: number;
    readonly eligible: boolean;
    readonly reason?: string;
  }[];
  readonly assignments: readonly (AdaptiveChunkAssignmentReport & {
    readonly assignedBy: 'AdaptiveChunkDispatcher';
  })[];
  readonly checkpointRelay: readonly {
    readonly fromWorkerId: WorkerId;
    readonly toWorkerId: WorkerId;
    readonly segmentIndex: number;
    readonly bytes: number;
    readonly via: 'coordinator';
    readonly directWorkerNetworking: false;
  }[];
  readonly retryResumeImpact: {
    readonly retryCount: number;
    readonly resumeCount: number;
    readonly affectedSegments: readonly number[];
    readonly resumedFromSegment?: number;
    readonly addedCheckpointDelayMs: number;
    readonly failureReason?: string;
  };
  readonly transport: AdaptiveDispatcherRunReport['transport'];
  readonly bottlenecksToIssue: readonly string[];
  readonly failureReason?: string;
}

const DEFAULT_COORDINATOR_URL = 'https://coordinator.unzen.local';
const DEFAULT_CDN_URL = 'https://cdn.unzen.local';

export function createDefaultCoordinatorPrototypeManifest(): CoordinatorPrototypeManifest {
  const segments = buildCoordinatorPrototypeSegments(6);
  return {
    requestId: 'coordinator-prototype-default',
    prompt: 'Summarize the scale-up gate in one paragraph.',
    segments,
    workers: [
      prototypeWorker('tier1-signage-a', WorkerTier.TIER_1, {
        uptimeMs: 12 * 60 * 60 * 1000,
        vramFreeMB: 3_600,
        gpuBusyRatio: 0.01,
        cpuBusyRatio: 0.01,
        cacheHits: [0, 1],
        tokensPerSecond: 24,
        checkpointBytesPerSecond: 24 * 1024 * 1024,
        failureRate: 0.01,
        heartbeatJitterMs: 25,
      }),
      prototypeWorker('tier2-obs-a', WorkerTier.TIER_2, {
        uptimeMs: 90 * 60 * 1000,
        vramFreeMB: 6_000,
        gpuBusyRatio: 0.018,
        cpuBusyRatio: 0.012,
        cacheHits: [2, 3],
        tokensPerSecond: 18,
        checkpointBytesPerSecond: 18 * 1024 * 1024,
        failureRate: 0.04,
        heartbeatJitterMs: 80,
      }),
      prototypeWorker('tier3-visitor-a', WorkerTier.TIER_3, {
        uptimeMs: 9 * 60 * 1000,
        vramFreeMB: 2_400,
        gpuBusyRatio: 0.012,
        cpuBusyRatio: 0.014,
        cacheHits: [],
        tokensPerSecond: 9,
        checkpointBytesPerSecond: 8 * 1024 * 1024,
        failureRate: 0.08,
        heartbeatJitterMs: 180,
      }),
    ],
    lostWorkerId: 'tier1-signage-a',
    lostAfterAssignmentIndex: 1,
  };
}

export function runCoordinatorPrototype(
  manifest: CoordinatorPrototypeManifest,
): CoordinatorPrototypeReport {
  const coordinatorUrl = manifest.coordinatorUrl ?? DEFAULT_COORDINATOR_URL;
  const cdnUrl = manifest.cdnUrl ?? DEFAULT_CDN_URL;
  const eligibility = computeWorkerEligibility(manifest);
  const eligibleWorkers = manifest.workers.filter(
    (worker) => eligibility.get(workerId(worker.id))?.eligible,
  );
  const transport = new AllowlistedPrototypeTransport([coordinatorUrl, cdnUrl]);
  const dispatcher = new AdaptiveChunkDispatcher({
    segments: manifest.segments,
    transport,
    coordinatorUrl,
    cdnUrl,
    loadBudgetRatio: manifest.loadBudgetRatio,
    checkpointBytes: manifest.checkpointBytes,
  });

  for (const worker of eligibleWorkers) {
    dispatcher.registerWorker({
      id: worker.id,
      tier: worker.tier,
      telemetry: worker.telemetry,
    });
  }

  let dispatcherReport: AdaptiveDispatcherRunReport;
  let failureReason: string | undefined;
  try {
    dispatcherReport = dispatcher.run(manifest.requestId);
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    dispatcherReport = {
      requestId: manifest.requestId,
      assignments: [],
      skippedWorkers: [],
      transport: {
        allowlist: transport.allowlist,
        connections: transport.connectionsSince(0),
      },
    };
  }

  const assignments = dispatcherReport.assignments.map((assignment) => ({
    ...assignment,
    assignedBy: 'AdaptiveChunkDispatcher' as const,
  }));
  const checkpointRelay = buildCheckpointRelay(assignments);
  const retryResumeImpact = buildRetryResumeImpact(manifest, assignments);
  const directWorkerNetworking = dispatcherReport.transport.connections.some(
    (connection) => connection.startsWith('worker://'),
  );
  if (directWorkerNetworking) {
    failureReason = 'direct-worker-networking-detected';
  }

  const finalSegment = assignments.at(-1)?.endSegment ?? -1;
  const completed = finalSegment === manifest.segments.length - 1 && !failureReason;

  return {
    requestId: manifest.requestId,
    status: completed ? 'pass' : 'fail',
    requestLifecycle: {
      accepted: true,
      promptBytes: new TextEncoder().encode(manifest.prompt).byteLength,
      assignmentCount: assignments.length,
      completed,
      finalSegment,
    },
    workerHeartbeats: manifest.workers.map((worker) => {
      const id = workerId(worker.id);
      const workerEligibility = eligibility.get(id);
      return {
        workerId: id,
        tier: worker.tier,
        lastHeartbeatMs: worker.lastHeartbeatMs,
        eligible: workerEligibility?.eligible ?? false,
        reason: workerEligibility?.reason,
      };
    }),
    assignments,
    checkpointRelay,
    retryResumeImpact,
    transport: dispatcherReport.transport,
    bottlenecksToIssue: selectBottlenecksToIssue(manifest, retryResumeImpact, failureReason),
    failureReason,
  };
}

export function buildCoordinatorPrototypeSegments(totalSegments: number): SegmentConfig[] {
  const totalLayers = 48;
  const layersPerSegment = Math.ceil(totalLayers / totalSegments);
  return Array.from({ length: totalSegments }, (_, index) => ({
    index,
    layerStart: index * layersPerSegment,
    layerEnd: Math.min((index + 1) * layersPerSegment - 1, totalLayers - 1),
    modelWeightHash: `sha256:coordinator-prototype-segment-${index}`,
    estimatedVramMB: 1_800,
  }));
}

function prototypeWorker(
  id: string,
  tier: WorkerTier,
  telemetry: WorkerTelemetry,
): CoordinatorPrototypeWorkerRegistration {
  return {
    id,
    tier,
    telemetry,
    lastHeartbeatMs: 0,
  };
}

function computeWorkerEligibility(manifest: CoordinatorPrototypeManifest) {
  const tier3RetentionAtSegmentEnd = manifest.retentionReport?.tierBreakdown.find(
    (breakdown) => breakdown.tier === WorkerTier.TIER_3,
  )?.retentionAtSegmentEnd;
  const tier3Threshold = manifest.tier3MinRetentionAtSegmentEnd ?? 0.9;
  const eligibility = new Map<WorkerId, { eligible: boolean; reason?: string }>();

  for (const worker of manifest.workers) {
    const id = workerId(worker.id);
    if (
      worker.tier === WorkerTier.TIER_3 &&
      tier3RetentionAtSegmentEnd !== undefined &&
      tier3RetentionAtSegmentEnd < tier3Threshold
    ) {
      eligibility.set(id, {
        eligible: false,
        reason: `tier3-retention-below-assignment-threshold: ${tier3RetentionAtSegmentEnd}`,
      });
      continue;
    }

    if (worker.telemetry.failureRate >= 0.5) {
      eligibility.set(id, {
        eligible: false,
        reason: `heartbeat-failure-rate-too-high: ${worker.telemetry.failureRate}`,
      });
      continue;
    }

    eligibility.set(id, { eligible: true });
  }

  return eligibility;
}

function buildCheckpointRelay(
  assignments: readonly (AdaptiveChunkAssignmentReport & {
    readonly assignedBy: 'AdaptiveChunkDispatcher';
  })[],
): CoordinatorPrototypeReport['checkpointRelay'] {
  const relays: {
    fromWorkerId: WorkerId;
    toWorkerId: WorkerId;
    segmentIndex: number;
    bytes: number;
    via: 'coordinator';
    directWorkerNetworking: false;
  }[] = [];
  for (let index = 1; index < assignments.length; index++) {
    const previous = assignments[index - 1];
    const current = assignments[index];
    relays.push({
      fromWorkerId: previous.workerId,
      toWorkerId: current.workerId,
      segmentIndex: previous.endSegment,
      bytes: current.checkpointTransferBytes,
      via: 'coordinator',
      directWorkerNetworking: false,
    });
  }
  return relays;
}

function buildRetryResumeImpact(
  manifest: CoordinatorPrototypeManifest,
  assignments: readonly (AdaptiveChunkAssignmentReport & {
    readonly assignedBy: 'AdaptiveChunkDispatcher';
  })[],
): CoordinatorPrototypeReport['retryResumeImpact'] {
  const requestedLostWorker = manifest.lostWorkerId ? workerId(manifest.lostWorkerId) : undefined;
  const lostAssignmentIndex = manifest.lostAfterAssignmentIndex ?? -1;
  const matchingLostAssignment = requestedLostWorker
    ? assignments.find((assignment, index) =>
      assignment.workerId === requestedLostWorker && index >= lostAssignmentIndex
    )
    : undefined;
  const lostAssignment = matchingLostAssignment ?? assignments[lostAssignmentIndex];

  if (!lostAssignment) {
    return {
      retryCount: 0,
      resumeCount: 0,
      affectedSegments: [],
      addedCheckpointDelayMs: 0,
    };
  }

  const precedingCheckpoint = assignments
    .filter((assignment) => assignment.endSegment < lostAssignment.startSegment)
    .at(-1);
  const affectedSegments = range(lostAssignment.startSegment, lostAssignment.endSegment);

  return {
    retryCount: 1,
    resumeCount: precedingCheckpoint ? 1 : 0,
    affectedSegments,
    resumedFromSegment: precedingCheckpoint?.endSegment,
    addedCheckpointDelayMs: lostAssignment.checkpointTransferMs + 50,
    failureReason: `worker-lost: ${lostAssignment.workerId}`,
  };
}

function selectBottlenecksToIssue(
  manifest: CoordinatorPrototypeManifest,
  retryResumeImpact: CoordinatorPrototypeReport['retryResumeImpact'],
  failureReason: string | undefined,
): string[] {
  const bottlenecks: string[] = [];
  if (failureReason) {
    bottlenecks.push(`coordinator-prototype-failure: ${failureReason}`);
  }
  if (retryResumeImpact.addedCheckpointDelayMs > 500) {
    bottlenecks.push('checkpoint-relay-latency-budget');
  }
  if (manifest.retentionReport?.failureReason) {
    bottlenecks.push('tier3-browser-retention-churn');
  }
  if (bottlenecks.length === 0) {
    bottlenecks.push('cloudflare-workers-websocket-durable-state-validation');
  }
  return bottlenecks;
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
