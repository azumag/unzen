import { workerId, WorkerTier, type SegmentConfig, type WorkerId } from './types.js';
import { AllowlistedPrototypeTransport } from './two-worker-prototype.js';

export interface WorkerTelemetry {
  readonly uptimeMs: number;
  readonly vramFreeMB: number;
  readonly gpuBusyRatio: number;
  readonly cpuBusyRatio: number;
  readonly cacheHits: readonly number[];
  readonly tokensPerSecond: number;
  readonly checkpointBytesPerSecond: number;
  readonly failureRate: number;
  readonly heartbeatJitterMs: number;
}

export interface AdaptiveWorkerRegistration {
  readonly id: string;
  readonly tier: WorkerTier;
  readonly telemetry: WorkerTelemetry;
}

export interface DispatchScoreInputs {
  readonly capacityScore: number;
  readonly stabilityScore: number;
  readonly cacheScore: number;
  readonly throughputScore: number;
  readonly transferAvoidanceScore: number;
  readonly loadPenalty: number;
  readonly freshnessPenalty: number;
  readonly rollingConsecutiveBonus: number;
  readonly total: number;
}

export interface AdaptiveChunkAssignmentReport {
  readonly workerId: WorkerId;
  readonly tier: WorkerTier;
  readonly startSegment: number;
  readonly endSegment: number;
  readonly selectedChunkLength: number;
  readonly scoreInputs: DispatchScoreInputs;
  readonly loadReadings: {
    readonly gpuBusyRatio: number;
    readonly cpuBusyRatio: number;
  };
  readonly cacheHit: boolean;
  readonly retryCount: number;
  readonly checkpointTransferMs: number;
  readonly checkpointTransferBytes: number;
  readonly coldLoad: boolean;
  readonly rollingConsecutive: boolean;
}

export interface AdaptiveDispatcherRunReport {
  readonly requestId: string;
  readonly assignments: readonly AdaptiveChunkAssignmentReport[];
  readonly skippedWorkers: readonly {
    readonly workerId: WorkerId;
    readonly reason: string;
    readonly loadReadings: {
      readonly gpuBusyRatio: number;
      readonly cpuBusyRatio: number;
    };
  }[];
  readonly transport: {
    readonly allowlist: readonly string[];
    readonly connections: readonly string[];
  };
}

interface AdaptiveWorkerState {
  readonly id: WorkerId;
  readonly tier: WorkerTier;
  telemetry: WorkerTelemetry;
  lastAssignmentOrder: number;
  readonly residentSegments: Set<number>;
}

interface CandidateScore {
  readonly worker: AdaptiveWorkerState;
  readonly targetChunkLength: number;
  readonly scoreInputs: DispatchScoreInputs;
  readonly rollingConsecutive: boolean;
}

export interface AdaptiveChunkDispatcherOptions {
  readonly segments: readonly SegmentConfig[];
  readonly transport?: AllowlistedPrototypeTransport;
  readonly coordinatorUrl?: string;
  readonly cdnUrl?: string;
  readonly loadBudgetRatio?: number;
  readonly longLivedWorkerMs?: number;
  readonly configuredVramLimitMB?: number;
  readonly checkpointBytes?: number;
}

const DEFAULT_COORDINATOR_URL = 'https://coordinator.unzen.local';
const DEFAULT_CDN_URL = 'https://cdn.unzen.local';
const DEFAULT_LOAD_BUDGET_RATIO = 0.03;
const DEFAULT_LONG_LIVED_WORKER_MS = 30 * 60 * 1000;
const DEFAULT_CHECKPOINT_BYTES = 4 * 1024 * 1024;

export class AdaptiveChunkDispatcher {
  private readonly workers = new Map<WorkerId, AdaptiveWorkerState>();
  private readonly transport: AllowlistedPrototypeTransport;
  private readonly coordinatorUrl: string;
  private readonly cdnUrl: string;
  private readonly loadBudgetRatio: number;
  private readonly longLivedWorkerMs: number;
  private readonly configuredVramLimitMB: number;
  private readonly checkpointBytes: number;
  private assignmentCounter = 0;
  private requestCounter = 0;

  constructor(private readonly options: AdaptiveChunkDispatcherOptions) {
    if (options.segments.length === 0) {
      throw new Error('AdaptiveChunkDispatcher requires at least one segment');
    }

    this.coordinatorUrl = options.coordinatorUrl ?? DEFAULT_COORDINATOR_URL;
    this.cdnUrl = options.cdnUrl ?? DEFAULT_CDN_URL;
    this.transport = options.transport ?? new AllowlistedPrototypeTransport([
      this.coordinatorUrl,
      this.cdnUrl,
    ]);
    this.loadBudgetRatio = options.loadBudgetRatio ?? DEFAULT_LOAD_BUDGET_RATIO;
    this.longLivedWorkerMs = options.longLivedWorkerMs ?? DEFAULT_LONG_LIVED_WORKER_MS;
    this.configuredVramLimitMB = options.configuredVramLimitMB ?? Number.POSITIVE_INFINITY;
    this.checkpointBytes = options.checkpointBytes ?? DEFAULT_CHECKPOINT_BYTES;
  }

  registerWorker(registration: AdaptiveWorkerRegistration): void {
    const id = workerId(registration.id);
    this.workers.set(id, {
      id,
      tier: registration.tier,
      telemetry: registration.telemetry,
      lastAssignmentOrder: 0,
      residentSegments: new Set(registration.telemetry.cacheHits),
    });
  }

  updateHeartbeat(worker: WorkerId, telemetry: WorkerTelemetry): void {
    const state = this.workers.get(worker);
    if (!state) {
      throw new Error(`Unknown adaptive worker: ${worker}`);
    }

    state.telemetry = telemetry;
    for (const segment of telemetry.cacheHits) {
      state.residentSegments.add(segment);
    }
  }

  run(requestId = `adaptive-${++this.requestCounter}`): AdaptiveDispatcherRunReport {
    const transportStartIndex = this.transport.connectionCount;
    const assignments: AdaptiveChunkAssignmentReport[] = [];
    const skippedWorkers: {
      readonly workerId: WorkerId;
      readonly reason: string;
      readonly loadReadings: {
        readonly gpuBusyRatio: number;
        readonly cpuBusyRatio: number;
      };
    }[] = [];
    const skippedWorkerIds = new Set<WorkerId>();
    let nextSegment = 0;
    let previousAssignment: AdaptiveChunkAssignmentReport | undefined;

    while (nextSegment < this.options.segments.length) {
      for (const worker of this.workers.values()) {
        if (this.isOverBudget(worker.telemetry) && !skippedWorkerIds.has(worker.id)) {
          skippedWorkerIds.add(worker.id);
          skippedWorkers.push({
            workerId: worker.id,
            reason: 'load-budget-exceeded',
            loadReadings: {
              gpuBusyRatio: worker.telemetry.gpuBusyRatio,
              cpuBusyRatio: worker.telemetry.cpuBusyRatio,
            },
          });
        }
      }

      const candidates = [...this.workers.values()]
        .map((candidate) => this.scoreCandidate(candidate, nextSegment, previousAssignment))
        .filter((candidate): candidate is CandidateScore => candidate !== null);

      if (candidates.length === 0) {
        throw new Error(`No eligible adaptive worker for segment ${nextSegment}`);
      }

      candidates.sort((a, b) => b.scoreInputs.total - a.scoreInputs.total);
      const selected = candidates[0];
      const chunkLength = Math.min(
        selected.targetChunkLength,
        this.options.segments.length - nextSegment,
      );
      const endSegment = nextSegment + chunkLength - 1;
      const cacheHit = this.allSegmentsResident(selected.worker, nextSegment, endSegment);
      const coldLoad = !cacheHit && !selected.rollingConsecutive;
      const checkpointTransferMs = this.estimateCheckpointTransferMs(selected.worker.telemetry);

      this.transport.connect(`${this.coordinatorUrl}/adaptive/${requestId}/chunk/${nextSegment}`);
      for (let segment = nextSegment; segment <= endSegment; segment++) {
        this.transport.connect(`${this.cdnUrl}/models/proto-2b-q4/seg-${segment}.bin`);
        selected.worker.residentSegments.add(segment);
      }

      const report: AdaptiveChunkAssignmentReport = {
        workerId: selected.worker.id,
        tier: selected.worker.tier,
        startSegment: nextSegment,
        endSegment,
        selectedChunkLength: chunkLength,
        scoreInputs: selected.scoreInputs,
        loadReadings: {
          gpuBusyRatio: selected.worker.telemetry.gpuBusyRatio,
          cpuBusyRatio: selected.worker.telemetry.cpuBusyRatio,
        },
        cacheHit,
        retryCount: 0,
        checkpointTransferMs,
        checkpointTransferBytes: nextSegment === 0 ? 0 : this.checkpointBytes,
        coldLoad,
        rollingConsecutive: selected.rollingConsecutive,
      };

      selected.worker.lastAssignmentOrder = ++this.assignmentCounter;
      assignments.push(report);
      previousAssignment = report;
      nextSegment = endSegment + 1;
    }

    return {
      requestId,
      assignments,
      skippedWorkers,
      transport: {
        allowlist: this.transport.allowlist,
        connections: this.transport.connectionsSince(transportStartIndex),
      },
    };
  }

  private scoreCandidate(
    worker: AdaptiveWorkerState,
    startSegment: number,
    previousAssignment: AdaptiveChunkAssignmentReport | undefined,
  ): CandidateScore | null {
    const targetChunkLength = this.computeTargetChunkLength(worker);
    if (targetChunkLength < 1) {
      return null;
    }

    const isSameAsPrevious = previousAssignment?.workerId === worker.id;
    const rollingConsecutive = Boolean(
      isSameAsPrevious &&
      previousAssignment.endSegment + 1 === startSegment &&
      this.canReceiveRollingAssignment(worker),
    );
    if (isSameAsPrevious && !rollingConsecutive) {
      return null;
    }

    const scoreInputs = this.computeScoreInputs(
      worker,
      startSegment,
      targetChunkLength,
      rollingConsecutive,
    );
    return { worker, targetChunkLength, scoreInputs, rollingConsecutive };
  }

  private computeTargetChunkLength(worker: AdaptiveWorkerState): number {
    const vramPerSegment = this.options.segments[0].estimatedVramMB;
    const maxResidentSegments = Math.floor(
      Math.min(worker.telemetry.vramFreeMB, this.configuredVramLimitMB) / vramPerSegment,
    );
    if (maxResidentSegments < 1) {
      return 0;
    }

    const loadBudgetScale = this.computeLoadBudgetScale(worker.telemetry);
    const stabilityScale = this.computeStabilityScale(worker);
    if (loadBudgetScale === 0 || stabilityScale === 0) {
      return 0;
    }

    const chunkLength = Math.floor(maxResidentSegments * loadBudgetScale * stabilityScale);
    const tierLimit = worker.tier === WorkerTier.TIER_3 ? 1 : maxResidentSegments;
    return clamp(1, Math.min(maxResidentSegments, tierLimit), chunkLength);
  }

  private computeLoadBudgetScale(telemetry: WorkerTelemetry): number {
    if (this.isOverBudget(telemetry)) {
      return 0;
    }

    const nearBudget = this.loadBudgetRatio * 0.75;
    if (telemetry.gpuBusyRatio >= nearBudget || telemetry.cpuBusyRatio >= nearBudget) {
      return 0.5;
    }

    return 1;
  }

  private computeStabilityScale(worker: AdaptiveWorkerState): number {
    if (worker.telemetry.failureRate >= 0.5) {
      return 0;
    }
    if (worker.telemetry.failureRate > 0.1 || worker.telemetry.heartbeatJitterMs > 750) {
      return 0.5;
    }
    if (worker.tier === WorkerTier.TIER_3 || worker.telemetry.uptimeMs < this.longLivedWorkerMs) {
      return 0.5;
    }
    return 1;
  }

  private computeScoreInputs(
    worker: AdaptiveWorkerState,
    startSegment: number,
    chunkLength: number,
    rollingConsecutive: boolean,
  ): DispatchScoreInputs {
    const capacityScore = chunkLength * 20;
    const stabilityScore = Math.min(30, worker.telemetry.uptimeMs / 60_000) +
      (worker.tier === WorkerTier.TIER_1 ? 10 : worker.tier === WorkerTier.TIER_2 ? 5 : 0) -
      worker.telemetry.failureRate * 50 -
      Math.min(10, worker.telemetry.heartbeatJitterMs / 100);
    const cacheScore = this.countCachedSegments(worker, startSegment, chunkLength) * 12;
    const throughputScore = Math.min(25, worker.telemetry.tokensPerSecond);
    const transferAvoidanceScore = Math.min(
      20,
      (worker.telemetry.checkpointBytesPerSecond / this.checkpointBytes) * chunkLength * 5,
    );
    const loadPenalty = (
      worker.telemetry.gpuBusyRatio + worker.telemetry.cpuBusyRatio
    ) / this.loadBudgetRatio * 10;
    const freshnessPenalty = worker.lastAssignmentOrder === 0
      ? 0
      : Math.max(0, 8 - (this.assignmentCounter - worker.lastAssignmentOrder));
    const rollingConsecutiveBonus = rollingConsecutive ? 18 : 0;
    const total = capacityScore +
      stabilityScore +
      cacheScore +
      throughputScore +
      transferAvoidanceScore +
      rollingConsecutiveBonus -
      loadPenalty -
      freshnessPenalty;

    return {
      capacityScore,
      stabilityScore,
      cacheScore,
      throughputScore,
      transferAvoidanceScore,
      loadPenalty,
      freshnessPenalty,
      rollingConsecutiveBonus,
      total,
    };
  }

  private canReceiveRollingAssignment(worker: AdaptiveWorkerState): boolean {
    return worker.tier !== WorkerTier.TIER_3 &&
      worker.telemetry.uptimeMs >= this.longLivedWorkerMs &&
      !this.isOverBudget(worker.telemetry) &&
      worker.telemetry.failureRate < 0.1;
  }

  private isOverBudget(telemetry: WorkerTelemetry): boolean {
    return telemetry.gpuBusyRatio > this.loadBudgetRatio ||
      telemetry.cpuBusyRatio > this.loadBudgetRatio;
  }

  private countCachedSegments(
    worker: AdaptiveWorkerState,
    startSegment: number,
    chunkLength: number,
  ): number {
    let count = 0;
    for (let segment = startSegment; segment < startSegment + chunkLength; segment++) {
      if (worker.residentSegments.has(segment) || worker.telemetry.cacheHits.includes(segment)) {
        count++;
      }
    }
    return count;
  }

  private allSegmentsResident(
    worker: AdaptiveWorkerState,
    startSegment: number,
    endSegment: number,
  ): boolean {
    for (let segment = startSegment; segment <= endSegment; segment++) {
      if (!worker.residentSegments.has(segment) && !worker.telemetry.cacheHits.includes(segment)) {
        return false;
      }
    }
    return true;
  }

  private estimateCheckpointTransferMs(telemetry: WorkerTelemetry): number {
    if (telemetry.checkpointBytesPerSecond <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.round((this.checkpointBytes / telemetry.checkpointBytesPerSecond) * 1000);
  }
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}
