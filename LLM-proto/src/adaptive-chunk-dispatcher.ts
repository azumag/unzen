import type { ArtifactResidencyLedger } from './artifact-residency-ledger.js';
import { workerId, WorkerTier, type SegmentConfig, type WorkerId } from './types.js';
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
  /** Segment bundles that were absent before the assignment. */
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
  private assignmentCounter = 0;
  private requestCounter = 0;

  constructor(private readonly options: AdaptiveChunkDispatcherOptions) {
    if (options.segments.length === 0) {
      throw new Error('AdaptiveChunkDispatcher requires at least one segment');
    }
    for (const [arrayIndex, segment] of options.segments.entries()) {
      if (segment.index !== arrayIndex) {
        throw new Error(
          `AdaptiveChunkDispatcher requires segment indexes 0..n-1; ` +
          `expected ${arrayIndex}, found ${segment.index}`,
        );
      }
      if (!Number.isFinite(segment.estimatedVramMB) || segment.estimatedVramMB <= 0) {
        throw new Error(
          `segment ${segment.index} estimatedVramMB must be a positive finite number`,
        );
      }
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
    this.artifactResidencyLedger = options.artifactResidencyLedger;
    this.artifactResidencyLedger?.assertCompatibleSegments(options.segments);
  }

  registerWorker(registration: AdaptiveWorkerRegistration): void {
    const id = workerId(registration.id);
    const cacheHits = this.validateAndSynchronizeCacheResidency(id, registration.telemetry);
    this.workers.set(id, {
      id,
      tier: registration.tier,
      telemetry: registration.telemetry,
      lastAssignmentOrder: 0,
      residentSegments: new Set(cacheHits),
    });
  }

  updateHeartbeat(worker: WorkerId, telemetry: WorkerTelemetry): void {
    const state = this.workers.get(worker);
    if (!state) {
      throw new Error(`Unknown adaptive worker: ${worker}`);
    }

    // Validate and atomically replace the ledger entry before mutating the
    // local worker state. A malformed heartbeat therefore leaves both views
    // unchanged instead of partially applying its cache inventory.
    const cacheHits = this.validateAndSynchronizeCacheResidency(worker, telemetry);
    state.telemetry = telemetry;
    state.residentSegments.clear();
    for (const segment of cacheHits) {
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

      candidates.sort((left, right) =>
        right.scoreInputs.total - left.scoreInputs.total ||
        left.worker.id.localeCompare(right.worker.id),
      );
      const selected = candidates[0];
      const chunkLength = Math.min(
        selected.targetChunkLength,
        this.options.segments.length - nextSegment,
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
      const coldLoad = !cacheHit && !selected.rollingConsecutive;
      const checkpointTransferMs = this.estimateCheckpointTransferMs(selected.worker.telemetry);

      this.transport.connect(`${this.coordinatorUrl}/adaptive/${requestId}/chunk/${nextSegment}`);
      if (missingArtifacts !== undefined) {
        // Validate every file locator for every logical bundle before committing
        // any cache state. If a later component is rejected, the worker must not
        // retain a partial segment-residency claim.
        for (const artifact of missingArtifacts) {
          const locators = artifact.components?.map((component) => component.artifactLocator) ??
            [artifact.artifactLocator];
          for (const locator of locators) {
            this.transport.connect(locator);
          }
        }
        for (const artifact of missingArtifacts) {
          selected.worker.residentSegments.add(artifact.index);
          this.artifactResidencyLedger?.markResident(selected.worker.id, artifact.index);
        }
      } else {
        // Legacy prototype path retained for callers that do not yet supply a
        // validated model manifest and exact artifact inventory.
        for (let segment = nextSegment; segment <= endSegment; segment++) {
          this.transport.connect(`${this.cdnUrl}/models/proto-2b-q4/seg-${segment}.bin`);
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
        checkpointTransferBytes: nextSegment === 0 ? 0 : this.checkpointBytes,
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
    for (let index = startSegment; index < this.options.segments.length; index++) {
      const nextVramMB = this.options.segments[index].estimatedVramMB;
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

    for (let end = 0; end < this.options.segments.length; end++) {
      consumedVramMB += this.options.segments[end].estimatedVramMB;
      while (consumedVramMB > availableVramMB && start <= end) {
        consumedVramMB -= this.options.segments[start].estimatedVramMB;
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
      if (
        !Number.isInteger(segmentIndex) ||
        segmentIndex < 0 ||
        segmentIndex >= this.options.segments.length
      ) {
        throw new Error(
          `cache hit segment ${segmentIndex} is outside 0..${this.options.segments.length - 1}`,
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

function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}