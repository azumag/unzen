import type { ArtifactResidencyLedger } from './artifact-residency-ledger.js';
import {
  inferenceRequestId,
  workerId,
  WorkerTier,
  type SegmentConfig,
  type WorkerId,
} from './types.js';
import { AllowlistedPrototypeTransport } from './two-worker-prototype.js';

export interface CachedArtifactIdentity {
  readonly segmentIndex: number;
  readonly sha256: string;
}

export interface WorkerTelemetry {
  readonly uptimeMs: number;
  readonly vramFreeMB: number;
  readonly gpuBusyRatio: number;
  readonly cpuBusyRatio: number;
  readonly cacheHits: readonly number[];
  /**
   * Exact identities for cacheHits when dispatch uses a manifest-backed
   * ArtifactResidencyLedger. Bare segment indexes are insufficient because a
   * worker may still hold the same index from an older model revision.
   */
  readonly cacheArtifacts?: readonly CachedArtifactIdentity[];
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

export interface ArtifactResidencyAssignmentReport {
  /** Exact graph + external-data bytes for every segment in this assignment. */
  readonly totalArtifactBytes: number;
  /** Exact bytes already resident before this assignment began. */
  readonly residentArtifactBytesBeforeAssignment: number;
  /** Exact bytes fetched from the artifact origin for this assignment. */
  readonly downloadedArtifactBytes: number;
  /** Segment bundles that were absent before this assignment. */
  readonly missingSegmentIndexes: readonly number[];
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
  /** Present when a manifest-backed artifact inventory was supplied. */
  readonly artifactResidency?: ArtifactResidencyAssignmentReport;
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
  /**
   * Optional exact artifact inventory. When present, cache scoring and transfer
   * reports use measured graph + external-data bytes, and cached artifacts are
   * not requested from the CDN again.
   */
  readonly artifactResidencyLedger?: ArtifactResidencyLedger;
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
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ARRAY_LENGTH = 0xffff_ffff;

export class AdaptiveChunkDispatcher {
  private readonly workers = new Map<WorkerId, AdaptiveWorkerState>();
  private readonly transport: AllowlistedPrototypeTransport;
  private readonly coordinatorUrl: string;
  private readonly cdnUrl: string;
  private readonly loadBudgetRatio: number;
  private readonly longLivedWorkerMs: number;
  private readonly configuredVramLimitMB: number;
  private readonly checkpointBytes: number;
  private readonly artifactResidencyLedger?: ArtifactResidencyLedger;
  private readonly segments: readonly SegmentConfig[];
  private assignmentCounter = 0;
  private requestCounter = 0;

  constructor(options: AdaptiveChunkDispatcherOptions) {
    assertAdaptiveChunkDispatcherOptionsContainer(options);
    const runtimeOptions = options as unknown as Record<string, unknown>;
    const segmentInput = readRuntimeField(
      runtimeOptions,
      'segments',
      'AdaptiveChunkDispatcher segments could not be read',
    );
    if (!isArrayWithoutThrow(segmentInput)) {
      throw new Error('AdaptiveChunkDispatcher segments must be an array');
    }
    const segmentCount = readArrayLength(
      segmentInput,
      'AdaptiveChunkDispatcher segments length could not be read',
    );
    if (segmentCount === 0) {
      throw new Error('AdaptiveChunkDispatcher requires at least one segment');
    }

    // Detach the top-level membership before any segment field is observed.
    // Runtime-originated accessors or proxies can otherwise replace a later
    // slot while an earlier segment is being validated.
    const segmentEntries: unknown[] = new Array(segmentCount);
    for (let index = 0; index < segmentCount; index++) {
      segmentEntries[index] = readArrayIndex(
        segmentInput,
        index,
        `AdaptiveChunkDispatcher segment ${index} could not be read`,
      );
    }

    const segments = Object.freeze(
      segmentEntries.map((segment, arrayIndex) =>
        Object.freeze(validateAdaptiveSegmentConfig(segment, arrayIndex)),
      ),
    );
    for (let index = 1; index < segments.length; index++) {
      const previous = segments[index - 1];
      const current = segments[index];
      if (current.layerStart !== previous.layerEnd + 1) {
        throw new Error(
          `AdaptiveChunkDispatcher segment layer ranges must be contiguous: ` +
          `segment ${index - 1} ends at ${previous.layerEnd}, ` +
          `segment ${index} starts at ${current.layerStart}`,
        );
      }
    }
    this.segments = segments;

    const loadBudgetRatioInput = readRuntimeField(
      runtimeOptions,
      'loadBudgetRatio',
      'AdaptiveChunkDispatcher loadBudgetRatio could not be read',
    );
    const loadBudgetRatio = loadBudgetRatioInput === undefined
      ? DEFAULT_LOAD_BUDGET_RATIO
      : loadBudgetRatioInput;
    if (
      typeof loadBudgetRatio !== 'number' ||
      !Number.isFinite(loadBudgetRatio) ||
      loadBudgetRatio <= 0 ||
      loadBudgetRatio > 1
    ) {
      throw new Error('loadBudgetRatio must be a finite number in (0, 1]');
    }
    const longLivedWorkerMsInput = readRuntimeField(
      runtimeOptions,
      'longLivedWorkerMs',
      'AdaptiveChunkDispatcher longLivedWorkerMs could not be read',
    );
    const longLivedWorkerMs = longLivedWorkerMsInput === undefined
      ? DEFAULT_LONG_LIVED_WORKER_MS
      : longLivedWorkerMsInput;
    if (typeof longLivedWorkerMs !== 'number') {
      throw new Error('longLivedWorkerMs must be a finite non-negative number');
    }
    assertFiniteNonNegative('longLivedWorkerMs', longLivedWorkerMs);
    const configuredVramLimitMBInput = readRuntimeField(
      runtimeOptions,
      'configuredVramLimitMB',
      'AdaptiveChunkDispatcher configuredVramLimitMB could not be read',
    );
    const configuredVramLimitMB = configuredVramLimitMBInput === undefined
      ? Number.POSITIVE_INFINITY
      : configuredVramLimitMBInput;
    if (
      typeof configuredVramLimitMB !== 'number' ||
      Number.isNaN(configuredVramLimitMB) ||
      configuredVramLimitMB < 0 ||
      configuredVramLimitMB === Number.NEGATIVE_INFINITY
    ) {
      throw new Error('configuredVramLimitMB must be non-negative or positive infinity');
    }
    const checkpointBytesInput = readRuntimeField(
      runtimeOptions,
      'checkpointBytes',
      'AdaptiveChunkDispatcher checkpointBytes could not be read',
    );
    const checkpointBytes = checkpointBytesInput === undefined
      ? DEFAULT_CHECKPOINT_BYTES
      : checkpointBytesInput;
    if (
      typeof checkpointBytes !== 'number' ||
      !Number.isFinite(checkpointBytes) ||
      checkpointBytes <= 0
    ) {
      throw new Error('checkpointBytes must be a positive finite number');
    }

    const coordinatorUrlInput = readRuntimeField(
      runtimeOptions,
      'coordinatorUrl',
      'AdaptiveChunkDispatcher coordinatorUrl could not be read',
    ) as AdaptiveChunkDispatcherOptions['coordinatorUrl'];
    const coordinatorUrl = coordinatorUrlInput ?? DEFAULT_COORDINATOR_URL;
    const cdnUrlInput = readRuntimeField(
      runtimeOptions,
      'cdnUrl',
      'AdaptiveChunkDispatcher cdnUrl could not be read',
    ) as AdaptiveChunkDispatcherOptions['cdnUrl'];
    const cdnUrl = cdnUrlInput ?? DEFAULT_CDN_URL;
    const artifactResidencyLedger = readRuntimeField(
      runtimeOptions,
      'artifactResidencyLedger',
      'AdaptiveChunkDispatcher artifactResidencyLedger could not be read',
    ) as AdaptiveChunkDispatcherOptions['artifactResidencyLedger'];
    const transportInput = readRuntimeField(
      runtimeOptions,
      'transport',
      'AdaptiveChunkDispatcher transport could not be read',
    ) as AdaptiveChunkDispatcherOptions['transport'];
    const transport = transportInput ?? new AllowlistedPrototypeTransport([
      coordinatorUrl,
      cdnUrl,
    ]);
    transport.assertConnectable(coordinatorUrl);
    if (artifactResidencyLedger === undefined) {
      transport.assertConnectable(cdnUrl);
    }

    this.coordinatorUrl = coordinatorUrl;
    this.cdnUrl = cdnUrl;
    this.transport = transport;
    this.loadBudgetRatio = loadBudgetRatio;
    this.longLivedWorkerMs = longLivedWorkerMs;
    this.configuredVramLimitMB = configuredVramLimitMB;
    this.checkpointBytes = checkpointBytes;
    this.artifactResidencyLedger = artifactResidencyLedger;
    this.artifactResidencyLedger?.assertCompatibleSegments(this.segments);
  }

  registerWorker(registration: AdaptiveWorkerRegistration): void {
    assertAdaptiveWorkerRegistrationContainer(registration);
    const id = workerId(registration.id);
    const tier = registration.tier;
    assertWorkerTier(tier);
    const telemetry = snapshotWorkerTelemetry(registration.telemetry);
    this.validateTelemetry(telemetry);
    const cacheHits = this.validateAndSynchronizeCacheResidency(id, telemetry);
    this.workers.set(id, {
      id,
      tier,
      telemetry,
      lastAssignmentOrder: 0,
      residentSegments: new Set(cacheHits),
    });
  }

  updateHeartbeat(worker: WorkerId, telemetry: WorkerTelemetry): void {
    const validatedWorker = workerId(worker);
    const state = this.workers.get(validatedWorker);
    if (!state) {
      throw new Error(`Unknown adaptive worker: ${validatedWorker}`);
    }

    // Snapshot before validation so validation, cache synchronization, and the
    // stored worker state all refer to one dispatcher-owned telemetry value.
    const telemetrySnapshot = snapshotWorkerTelemetry(telemetry);
    // Validate telemetry before touching either cache-residency view. Invalid
    // heartbeats must preserve the last known-good telemetry and cache state.
    this.validateTelemetry(telemetrySnapshot);
    const cacheHits = this.validateAndSynchronizeCacheResidency(validatedWorker, telemetrySnapshot);
    state.telemetry = telemetrySnapshot;
    state.residentSegments.clear();
    for (const segment of cacheHits) {
      state.residentSegments.add(segment);
    }
  }

  run(requestId = `adaptive-${++this.requestCounter}`): AdaptiveDispatcherRunReport {
    const validatedRequestId = inferenceRequestId(requestId);
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

    while (nextSegment < this.segments.length) {
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

      candidates.sort((left, right) =>
        right.scoreInputs.total - left.scoreInputs.total ||
        left.worker.id.localeCompare(right.worker.id),
      );
      const selected = candidates[0];
      const chunkLength = Math.min(
        selected.targetChunkLength,
        this.segments.length - nextSegment,
      );
      const endSegment = nextSegment + chunkLength - 1;
      const missingArtifacts = this.artifactResidencyLedger?.missingArtifacts(
        selected.worker.id,
        nextSegment,
        endSegment,
      );
      const cacheHit = missingArtifacts !== undefined
        ? missingArtifacts.length === 0
        : this.allSegmentsResident(selected.worker, nextSegment, endSegment);
      // Manifest-backed reports have an exact pre-assignment artifact snapshot.
      // A rolling assignment can still be a cold artifact load when it must fetch
      // one or more missing bundles, so do not let worker continuity hide that IO.
      // Preserve the legacy no-ledger meaning for the prototype path.
      const coldLoad = missingArtifacts !== undefined
        ? missingArtifacts.length > 0
        : !cacheHit && !selected.rollingConsecutive;
      // A rolling consecutive chunk stays on the same worker, so its hidden
      // state does not cross the Coordinator relay boundary between assignments.
      const checkpointTransferBytes = nextSegment === 0 || selected.rollingConsecutive
        ? 0
        : this.checkpointBytes;
      const checkpointTransferMs = checkpointTransferBytes === 0
        ? 0
        : this.estimateCheckpointTransferMs(selected.worker.telemetry);
      const coordinatorConnectionUrl =
        `${this.coordinatorUrl}/adaptive/${validatedRequestId}/chunk/${nextSegment}`;
      const artifactConnectionUrls = missingArtifacts !== undefined
        ? missingArtifacts.flatMap((artifact) =>
          artifact.components?.map((component) => component.artifactLocator) ??
          [artifact.artifactLocator],
        )
        : Array.from(
          { length: endSegment - nextSegment + 1 },
          (_, offset) => `${this.cdnUrl}/models/proto-2b-q4/seg-${nextSegment + offset}.bin`,
        );

      // Validate every target for this assignment before recording any
      // simulated network activity or committing cache residency. A later bad
      // component must not leave an earlier connection as a partial side effect.
      this.transport.assertConnectable(coordinatorConnectionUrl);
      for (const url of artifactConnectionUrls) {
        this.transport.assertConnectable(url);
      }

      this.transport.connect(coordinatorConnectionUrl);
      for (const url of artifactConnectionUrls) {
        this.transport.connect(url);
      }

      if (missingArtifacts !== undefined) {
        for (const artifact of missingArtifacts) {
          selected.worker.residentSegments.add(artifact.index);
          this.artifactResidencyLedger?.markResident(selected.worker.id, artifact.index);
        }
      } else {
        // Legacy prototype path retained for callers that do not yet supply a
        // validated model manifest and exact artifact inventory.
        for (let segment = nextSegment; segment <= endSegment; segment++) {
          selected.worker.residentSegments.add(segment);
        }
      }

      const artifactResidency = this.artifactResidencyLedger === undefined
        ? undefined
        : this.buildArtifactResidencyReport(
          selected.worker.id,
          nextSegment,
          endSegment,
          missingArtifacts ?? [],
        );
      const report: AdaptiveChunkAssignmentReport = {
        workerId: selected.worker.id,
        tier: selected.worker.tier,
        startSegment: nextSegment,
        endSegment: endSegment,
        selectedChunkLength: chunkLength,
        scoreInputs: selected.scoreInputs,
        loadReadings: {
          gpuBusyRatio: selected.worker.telemetry.gpuBusyRatio,
          cpuBusyRatio: selected.worker.telemetry.cpuBusyRatio,
        },
        cacheHit,
        retryCount: 0,
        checkpointTransferMs,
        checkpointTransferBytes,
        coldLoad,
        rollingConsecutive: selected.rollingConsecutive,
        artifactResidency,
      };

      selected.worker.lastAssignmentOrder = ++this.assignmentCounter;
      assignments.push(report);
      previousAssignment = report;
      nextSegment = endSegment + 1;
    }

    return {
      requestId: validatedRequestId,
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
    const targetChunkLength = this.computeTargetChunkLength(worker, startSegment);
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

  /**
   * Compute the longest contiguous span that fits this worker from the current
   * segment. Unlike the original prototype, this supports unequal edge shards
   * produced by byte-budget-driven ONNX partitioning.
   *
   * Load/stability scaling is applied to the worker's model-wide capacity, not
   * repeatedly to the shrinking number of remaining segments. Otherwise a 50%
   * throttle turns a four-segment capacity into chunks 2, 1, 1 instead of the
   * intended steady two-segment target, adding avoidable checkpoint boundaries.
   */
  private computeTargetChunkLength(worker: AdaptiveWorkerState, startSegment: number): number {
    const availableVramMB = Math.min(
      worker.telemetry.vramFreeMB,
      this.configuredVramLimitMB,
    );
    const currentMaximumSpanLength = this.computeMaximumSpanLength(
      availableVramMB,
      startSegment,
    );
    if (currentMaximumSpanLength < 1) {
      return 0;
    }

    const loadBudgetScale = this.computeLoadBudgetScale(worker.telemetry);
    const stabilityScale = this.computeStabilityScale(worker);
    if (loadBudgetScale === 0 || stabilityScale === 0) {
      return 0;
    }

    const modelMaximumSpanLength = this.computeModelMaximumSpanLength(availableVramMB);
    const chunkLength = Math.floor(
      modelMaximumSpanLength * loadBudgetScale * stabilityScale,
    );
    const tierLimit = worker.tier === WorkerTier.TIER_3
      ? 1
      : modelMaximumSpanLength;
    return clamp(
      1,
      Math.min(currentMaximumSpanLength, tierLimit),
      chunkLength,
    );
  }

  private computeMaximumSpanLength(availableVramMB: number, startSegment: number): number {
    let consumedVramMB = 0;
    let maximumSpanLength = 0;
    for (let index = startSegment; index < this.segments.length; index++) {
      const nextVramMB = this.segments[index].estimatedVramMB;
      if (consumedVramMB + nextVramMB > availableVramMB) break;
      consumedVramMB += nextVramMB;
      maximumSpanLength++;
    }
    return maximumSpanLength;
  }

  /** Maximum count of any contiguous segment window that fits the worker. */
  private computeModelMaximumSpanLength(availableVramMB: number): number {
    let start = 0;
    let consumedVramMB = 0;
    let maximumSpanLength = 0;

    for (let end = 0; end < this.segments.length; end++) {
      consumedVramMB += this.segments[end].estimatedVramMB;
      while (consumedVramMB > availableVramMB && start <= end) {
        consumedVramMB -= this.segments[start].estimatedVramMB;
        start++;
      }
      maximumSpanLength = Math.max(maximumSpanLength, end - start + 1);
    }

    return maximumSpanLength;
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
    const cacheScore = this.computeCacheScore(worker, startSegment, chunkLength);
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

  private computeCacheScore(
    worker: AdaptiveWorkerState,
    startSegment: number,
    chunkLength: number,
  ): number {
    if (this.artifactResidencyLedger === undefined) {
      return this.countCachedSegments(worker, startSegment, chunkLength) * 12;
    }

    const endSegment = startSegment + chunkLength - 1;
    const totalBytes = this.artifactResidencyLedger.artifactBytes(startSegment, endSegment);
    const residentBytes = this.artifactResidencyLedger.residentArtifactBytes(
      worker.id,
      startSegment,
      endSegment,
    );
    return totalBytes === 0 ? 0 : (residentBytes / totalBytes) * chunkLength * 12;
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
      if (this.isSegmentResident(worker, segment)) {
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
      if (!this.isSegmentResident(worker, segment)) {
        return false;
      }
    }
    return true;
  }

  private isSegmentResident(worker: AdaptiveWorkerState, segmentIndex: number): boolean {
    if (this.artifactResidencyLedger !== undefined) {
      return this.artifactResidencyLedger.isResident(worker.id, segmentIndex);
    }
    return worker.residentSegments.has(segmentIndex) ||
      worker.telemetry.cacheHits.includes(segmentIndex);
  }

  private buildArtifactResidencyReport(
    worker: WorkerId,
    startSegment: number,
    endSegment: number,
    missingArtifacts: readonly { readonly index: number; readonly byteSize: number }[],
  ): ArtifactResidencyAssignmentReport {
    if (this.artifactResidencyLedger === undefined) {
      throw new Error('artifact residency report requires a ledger');
    }
    const totalArtifactBytes = this.artifactResidencyLedger.artifactBytes(
      startSegment,
      endSegment,
    );
    const downloadedArtifactBytes = missingArtifacts.reduce(
      (sum, artifact) => sum + artifact.byteSize,
      0,
    );
    // This value describes the state before missing artifacts were marked
    // resident, so derive it from the immutable assignment total.
    const residentArtifactBytesBeforeAssignment = totalArtifactBytes - downloadedArtifactBytes;
    // The worker argument is intentionally retained in the signature so a
    // future report can include post-assignment worker coverage without
    // changing call sites. Assert current postcondition now.
    if (
      this.artifactResidencyLedger.residentArtifactBytes(worker, startSegment, endSegment) !==
      totalArtifactBytes
    ) {
      throw new Error(`worker ${worker} artifact residency was not committed after assignment`);
    }
    return {
      totalArtifactBytes,
      residentArtifactBytesBeforeAssignment,
      downloadedArtifactBytes,
      missingSegmentIndexes: missingArtifacts.map((artifact) => artifact.index),
    };
  }

  private validateTelemetry(telemetry: WorkerTelemetry): void {
    assertFiniteNonNegative('uptimeMs', telemetry.uptimeMs);
    assertFiniteNonNegative('vramFreeMB', telemetry.vramFreeMB);
    assertUnitRatio('gpuBusyRatio', telemetry.gpuBusyRatio);
    assertUnitRatio('cpuBusyRatio', telemetry.cpuBusyRatio);
    assertFiniteNonNegative('tokensPerSecond', telemetry.tokensPerSecond);
    assertFiniteNonNegative('checkpointBytesPerSecond', telemetry.checkpointBytesPerSecond);
    assertUnitRatio('failureRate', telemetry.failureRate);
    assertFiniteNonNegative('heartbeatJitterMs', telemetry.heartbeatJitterMs);
  }

  private validateAndSynchronizeCacheResidency(
    worker: WorkerId,
    telemetry: WorkerTelemetry,
  ): readonly number[] {
    this.validateCacheHits(telemetry.cacheHits);
    if (this.artifactResidencyLedger === undefined) {
      return telemetry.cacheHits;
    }

    const cacheArtifacts = telemetry.cacheArtifacts ?? [];
    const cacheHitSet = new Set(telemetry.cacheHits);
    if (cacheHitSet.size !== telemetry.cacheHits.length) {
      throw new Error('manifest-backed cacheHits must not contain duplicate segment indexes');
    }
    if (cacheArtifacts.length !== telemetry.cacheHits.length) {
      throw new Error(
        'manifest-backed cacheHits require one cacheArtifacts identity per segment index',
      );
    }

    const identityIndexes = new Set<number>();
    for (const identity of cacheArtifacts) {
      this.validateCacheHits([identity.segmentIndex]);
      if (identityIndexes.has(identity.segmentIndex)) {
        throw new Error(
          `manifest-backed cacheArtifacts contains duplicate segment ${identity.segmentIndex}`,
        );
      }
      identityIndexes.add(identity.segmentIndex);
      if (!cacheHitSet.has(identity.segmentIndex)) {
        throw new Error(
          `cache artifact identity for segment ${identity.segmentIndex} is not present in cacheHits`,
        );
      }
      if (!SHA256_HEX_PATTERN.test(identity.sha256)) {
        throw new Error(
          `cache artifact identity for segment ${identity.segmentIndex} must use canonical sha256`,
        );
      }
      const expectedSha256 = this.artifactResidencyLedger.getArtifact(identity.segmentIndex).sha256;
      if (identity.sha256 !== expectedSha256) {
        throw new Error(
          `cache artifact identity for segment ${identity.segmentIndex} does not match active manifest`,
        );
      }
    }

    this.artifactResidencyLedger.synchronizeWorker(worker, telemetry.cacheHits);
    return telemetry.cacheHits;
  }

  private validateCacheHits(cacheHits: readonly number[]): void {
    for (const segmentIndex of cacheHits) {
      if (typeof segmentIndex !== 'number') {
        throw new Error('cache hit segment must be a number');
      }
      if (
        !Number.isInteger(segmentIndex) ||
        segmentIndex < 0 ||
        segmentIndex >= this.segments.length
      ) {
        throw new Error(
          `cache hit segment ${segmentIndex} is outside 0..${this.segments.length - 1}`,
        );
      }
    }
  }

  private estimateCheckpointTransferMs(telemetry: WorkerTelemetry): number {
    if (telemetry.checkpointBytesPerSecond <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.round((this.checkpointBytes / telemetry.checkpointBytesPerSecond) * 1000);
  }
}

function isArrayWithoutThrow(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function readRuntimeField(
  container: Record<string, unknown>,
  field: string,
  failureMessage: string,
): unknown {
  try {
    return container[field];
  } catch {
    throw new Error(failureMessage);
  }
}

function readArrayLength(value: readonly unknown[], failureMessage: string): number {
  let length: unknown;
  try {
    length = value.length;
  } catch {
    throw new Error(failureMessage);
  }
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > MAX_ARRAY_LENGTH
  ) {
    throw new Error(failureMessage);
  }
  return length;
}

function readArrayIndex(
  value: readonly unknown[],
  index: number,
  failureMessage: string,
): unknown {
  try {
    return value[index];
  } catch {
    throw new Error(failureMessage);
  }
}

function isNonNullNonArrayObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function assertAdaptiveWorkerRegistrationContainer(
  value: unknown,
): asserts value is AdaptiveWorkerRegistration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('adaptive worker registration must be a non-null object');
  }
}

function assertAdaptiveChunkDispatcherOptionsContainer(
  value: unknown,
): asserts value is AdaptiveChunkDispatcherOptions {
  if (!isNonNullNonArrayObject(value)) {
    throw new Error('AdaptiveChunkDispatcher options must be a non-null object');
  }
}

function validateAdaptiveSegmentConfig(value: unknown, arrayIndex: number): SegmentConfig {
  if (!isNonNullNonArrayObject(value)) {
    throw new Error(`AdaptiveChunkDispatcher segment ${arrayIndex} must be an object`);
  }
  const segment = value;

  const index = readRuntimeField(
    segment,
    'index',
    `AdaptiveChunkDispatcher segment ${arrayIndex} index could not be read`,
  );
  if (
    typeof index !== 'number' ||
    !Number.isSafeInteger(index) ||
    index < 0
  ) {
    throw new Error(
      'AdaptiveChunkDispatcher segment index must be a non-negative safe integer',
    );
  }
  if (index !== arrayIndex) {
    throw new Error(
      `AdaptiveChunkDispatcher requires segment indexes 0..n-1; ` +
      `expected ${arrayIndex}, found ${index}`,
    );
  }

  const layerStart = readRuntimeField(
    segment,
    'layerStart',
    `AdaptiveChunkDispatcher segment ${arrayIndex} layerStart could not be read`,
  );
  if (
    typeof layerStart !== 'number' ||
    !Number.isSafeInteger(layerStart) ||
    layerStart < 0
  ) {
    throw new Error(
      `AdaptiveChunkDispatcher segment ${arrayIndex} layerStart must be a non-negative safe integer`,
    );
  }

  const layerEnd = readRuntimeField(
    segment,
    'layerEnd',
    `AdaptiveChunkDispatcher segment ${arrayIndex} layerEnd could not be read`,
  );
  if (
    typeof layerEnd !== 'number' ||
    !Number.isSafeInteger(layerEnd) ||
    layerEnd < layerStart
  ) {
    throw new Error(
      `AdaptiveChunkDispatcher segment ${arrayIndex} layerEnd must be a safe integer ` +
      `greater than or equal to layerStart`,
    );
  }

  const modelWeightHash = readRuntimeField(
    segment,
    'modelWeightHash',
    `AdaptiveChunkDispatcher segment ${arrayIndex} modelWeightHash could not be read`,
  );
  if (typeof modelWeightHash !== 'string' || modelWeightHash.trim().length === 0) {
    throw new Error(
      `AdaptiveChunkDispatcher segment ${arrayIndex} modelWeightHash must be a non-empty string`,
    );
  }

  const estimatedVramMB = readRuntimeField(
    segment,
    'estimatedVramMB',
    `AdaptiveChunkDispatcher segment ${arrayIndex} estimatedVramMB could not be read`,
  );
  if (
    typeof estimatedVramMB !== 'number' ||
    !Number.isFinite(estimatedVramMB) ||
    estimatedVramMB <= 0
  ) {
    throw new Error(
      `segment ${arrayIndex} estimatedVramMB must be a positive finite number`,
    );
  }

  return {
    index,
    layerStart,
    layerEnd,
    modelWeightHash,
    estimatedVramMB,
  };
}

function snapshotWorkerTelemetry(telemetry: WorkerTelemetry): WorkerTelemetry {
  if (typeof telemetry !== 'object' || telemetry === null || Array.isArray(telemetry)) {
    throw new Error('worker telemetry must be a non-null object');
  }

  const runtimeTelemetry = telemetry as unknown as Record<string, unknown>;
  const cacheHitsInput = runtimeTelemetry.cacheHits;
  if (!Array.isArray(cacheHitsInput)) {
    throw new Error('worker telemetry cacheHits must be an array');
  }
  const cacheHitCount = cacheHitsInput.length;
  const cacheHits: number[] = new Array(cacheHitCount);
  for (let index = 0; index < cacheHitCount; index++) {
    cacheHits[index] = cacheHitsInput[index] as number;
  }

  const cacheArtifactsInput = runtimeTelemetry.cacheArtifacts;
  let cacheArtifacts: readonly CachedArtifactIdentity[] | undefined;
  if (cacheArtifactsInput !== undefined) {
    if (!Array.isArray(cacheArtifactsInput)) {
      throw new Error('worker telemetry cacheArtifacts must be an array when present');
    }

    const cacheArtifactCount = cacheArtifactsInput.length;
    const cacheArtifactEntries: unknown[] = new Array(cacheArtifactCount);
    for (let index = 0; index < cacheArtifactCount; index++) {
      cacheArtifactEntries[index] = cacheArtifactsInput[index];
    }

    const ownedCacheArtifacts: CachedArtifactIdentity[] = new Array(cacheArtifactCount);
    for (let index = 0; index < cacheArtifactCount; index++) {
      const identity = cacheArtifactEntries[index];
      if (typeof identity !== 'object' || identity === null || Array.isArray(identity)) {
        throw new Error(`worker telemetry cacheArtifacts[${index}] must be a non-null object`);
      }
      const runtimeIdentity = identity as Record<string, unknown>;
      const segmentIndex = runtimeIdentity.segmentIndex;
      if (typeof segmentIndex !== 'number') {
        throw new Error(`worker telemetry cacheArtifacts[${index}].segmentIndex must be a number`);
      }
      const sha256 = runtimeIdentity.sha256;
      if (typeof sha256 !== 'string') {
        throw new Error(`worker telemetry cacheArtifacts[${index}].sha256 must be a string`);
      }
      ownedCacheArtifacts[index] = Object.freeze({ segmentIndex, sha256 });
    }
    cacheArtifacts = Object.freeze(ownedCacheArtifacts);
  }

  const uptimeMs = runtimeTelemetry.uptimeMs as number;
  const vramFreeMB = runtimeTelemetry.vramFreeMB as number;
  const gpuBusyRatio = runtimeTelemetry.gpuBusyRatio as number;
  const cpuBusyRatio = runtimeTelemetry.cpuBusyRatio as number;
  const tokensPerSecond = runtimeTelemetry.tokensPerSecond as number;
  const checkpointBytesPerSecond = runtimeTelemetry.checkpointBytesPerSecond as number;
  const failureRate = runtimeTelemetry.failureRate as number;
  const heartbeatJitterMs = runtimeTelemetry.heartbeatJitterMs as number;

  return Object.freeze({
    uptimeMs,
    vramFreeMB,
    gpuBusyRatio,
    cpuBusyRatio,
    cacheHits: Object.freeze(cacheHits),
    ...(cacheArtifacts === undefined ? {} : { cacheArtifacts }),
    tokensPerSecond,
    checkpointBytesPerSecond,
    failureRate,
    heartbeatJitterMs,
  });
}

function assertWorkerTier(tier: WorkerTier): void {
  if (
    tier !== WorkerTier.TIER_1 &&
    tier !== WorkerTier.TIER_2 &&
    tier !== WorkerTier.TIER_3
  ) {
    throw new Error(`worker tier must be one of 1, 2, or 3; received ${String(tier)}`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number`);
  }
}

function assertUnitRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`);
  }
}

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}
