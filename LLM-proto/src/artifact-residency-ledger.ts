/**
 * Exact browser-artifact residency inventory for one segmented model.
 *
 * The model manifest owns immutable artifact facts (digest, locator and the
 * measured graph + external-data byte total). This ledger owns only the
 * mutable question of which worker reports which segment bundle as cached.
 * Keeping those concerns separate prevents telemetry from silently changing
 * artifact sizes or accepting a cache hit for a different model revision.
 */

import { assertValidModelManifest } from './model-manifest-validator.js';
import type {
  SegmentArtifact,
  SegmentArtifactComponent,
  SegmentedModelManifest,
} from './model-manifest.js';
import type { SegmentConfig, WorkerId } from './types.js';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface WorkerArtifactResidencySnapshot {
  readonly workerId: WorkerId;
  readonly residentSegmentIndexes: readonly number[];
  readonly residentArtifactBytes: number;
  readonly totalArtifactBytes: number;
  readonly coverageRatio: number;
}

/**
 * Tracks browser cache residency for exactly one validated model revision.
 * Segment indexes are deliberately model-local; callers must create a separate
 * ledger for each manifest instead of mixing equal indexes from different
 * models.
 */
export class ArtifactResidencyLedger {
  private readonly artifactsByIndex = new Map<number, SegmentArtifact>();
  private readonly residentByWorker = new Map<WorkerId, Set<number>>();
  private readonly measuredTotalArtifactBytes: number;

  constructor(artifacts: readonly SegmentArtifact[]) {
    if (artifacts.length === 0) {
      throw new Error('ArtifactResidencyLedger requires at least one segment artifact');
    }

    const sorted = [...artifacts].sort((left, right) => left.index - right.index);
    for (let expectedIndex = 0; expectedIndex < sorted.length; expectedIndex++) {
      const artifact = sorted[expectedIndex];
      if (artifact.index !== expectedIndex) {
        throw new Error(
          `segment indexes must be exactly 0..${sorted.length - 1}; ` +
          `expected ${expectedIndex}, found ${artifact.index}`,
        );
      }
      if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0) {
        throw new Error(
          `segment ${artifact.index} byteSize must be a safe positive integer; ` +
          `found ${artifact.byteSize}`,
        );
      }
      if (!SHA256_HEX_PATTERN.test(artifact.sha256)) {
        throw new Error(
          `segment ${artifact.index} sha256 must be exactly 64 lowercase hexadecimal characters`,
        );
      }
      if (artifact.artifactLocator.trim().length === 0) {
        throw new Error(`segment ${artifact.index} artifactLocator must be non-empty`);
      }

      const components = cloneAndValidateComponents(artifact);
      // Copy and freeze every array/object that is reachable through the
      // inventory. A caller may have built a plain mutable object even though
      // the public TypeScript interface is readonly; telemetry and routing must
      // never observe those later mutations.
      this.artifactsByIndex.set(artifact.index, Object.freeze({
        ...artifact,
        compatibleRuntimes: Object.freeze([...artifact.compatibleRuntimes]),
        ...(components === undefined ? {} : { components }),
      }));
    }

    this.measuredTotalArtifactBytes = sorted.reduce(
      (sum, artifact) => sum + artifact.byteSize,
      0,
    );
    if (!Number.isSafeInteger(this.measuredTotalArtifactBytes)) {
      throw new Error('total artifact byte size exceeds JavaScript safe integer range');
    }
  }

  /**
   * Build a ledger from the same structural validation gate used by the
   * Coordinator. Full digest/signature verification remains the caller's
   * responsibility before production execution.
   */
  static fromManifest(manifest: SegmentedModelManifest): ArtifactResidencyLedger {
    const validated = assertValidModelManifest(manifest);
    return new ArtifactResidencyLedger(validated.segments);
  }

  get segmentCount(): number {
    return this.artifactsByIndex.size;
  }

  /** Exact graph + external-data bytes for every segment bundle. */
  get totalArtifactBytes(): number {
    return this.measuredTotalArtifactBytes;
  }

  getArtifact(segmentIndex: number): SegmentArtifact {
    const artifact = this.artifactsByIndex.get(segmentIndex);
    if (!artifact) {
      throw new Error(`unknown segment ${segmentIndex}`);
    }
    return artifact;
  }

  /**
   * Fail closed when execution geometry was derived from another manifest or
   * was hand-written inconsistently with this artifact inventory.
   */
  assertCompatibleSegments(segments: readonly SegmentConfig[]): void {
    if (segments.length !== this.segmentCount) {
      throw new Error(
        `segment config count ${segments.length} does not match artifact count ${this.segmentCount}`,
      );
    }

    const byIndex = new Map(segments.map((segment) => [segment.index, segment]));
    for (let index = 0; index < this.segmentCount; index++) {
      const artifact = this.getArtifact(index);
      const segment = byIndex.get(index);
      if (!segment) {
        throw new Error(`segment config ${index} is missing`);
      }
      // Check revision identity before geometry. A stale/foreign digest should
      // never be treated as the same artifact merely because its layer range
      // happens to overlap the active model.
      if (segment.modelWeightHash.toLowerCase() !== artifact.sha256) {
        throw new Error(`segment ${index} hash does not match artifact inventory`);
      }
      if (segment.layerStart !== artifact.layerStart || segment.layerEnd !== artifact.layerEnd) {
        throw new Error(
          `segment ${index} layer range ${segment.layerStart}..${segment.layerEnd} ` +
          `does not match artifact range ${artifact.layerStart}..${artifact.layerEnd}`,
        );
      }
      if (segment.estimatedVramMB !== artifact.estimatedMemoryMB) {
        throw new Error(
          `segment ${index} estimatedVramMB ${segment.estimatedVramMB} ` +
          `does not match artifact estimate ${artifact.estimatedMemoryMB}`,
        );
      }
    }
  }

  /**
   * Replace one worker's cache inventory atomically. Browser heartbeat cache
   * lists are authoritative snapshots, not append-only observations; clearing
   * stale entries avoids routing work to artifacts that have been evicted.
   */
  synchronizeWorker(
    worker: WorkerId,
    segmentIndexes: readonly number[],
  ): WorkerArtifactResidencySnapshot {
    const next = new Set<number>();
    for (const segmentIndex of segmentIndexes) {
      this.getArtifact(segmentIndex);
      next.add(segmentIndex);
    }

    if (next.size === 0) {
      this.residentByWorker.delete(worker);
    } else {
      this.residentByWorker.set(worker, next);
    }
    return this.snapshot(worker);
  }

  markResident(worker: WorkerId, segmentIndex: number): void {
    this.getArtifact(segmentIndex);
    let residency = this.residentByWorker.get(worker);
    if (!residency) {
      residency = new Set<number>();
      this.residentByWorker.set(worker, residency);
    }
    residency.add(segmentIndex);
  }

  markResidentRange(worker: WorkerId, startSegment: number, endSegment: number): void {
    this.validateRange(startSegment, endSegment);
    // Validate the complete range before mutating so a programmer error cannot
    // leave a partially committed residency observation.
    const indexes = Array.from(
      { length: endSegment - startSegment + 1 },
      (_, offset) => startSegment + offset,
    );
    for (const index of indexes) {
      this.getArtifact(index);
    }
    for (const index of indexes) {
      this.markResident(worker, index);
    }
  }

  markEvicted(worker: WorkerId, segmentIndex: number): boolean {
    this.getArtifact(segmentIndex);
    const residency = this.residentByWorker.get(worker);
    if (!residency) return false;
    const removed = residency.delete(segmentIndex);
    if (residency.size === 0) {
      this.residentByWorker.delete(worker);
    }
    return removed;
  }

  clearWorker(worker: WorkerId): boolean {
    return this.residentByWorker.delete(worker);
  }

  isResident(worker: WorkerId, segmentIndex: number): boolean {
    this.getArtifact(segmentIndex);
    return this.residentByWorker.get(worker)?.has(segmentIndex) ?? false;
  }

  /** Number of consecutive cached artifacts beginning at startSegment. */
  residentPrefixLength(
    worker: WorkerId,
    startSegment: number,
    maximumLength = Number.POSITIVE_INFINITY,
  ): number {
    this.getArtifact(startSegment);
    if (maximumLength < 0 || Number.isNaN(maximumLength)) {
      throw new Error('maximumLength must be non-negative');
    }

    const limit = Number.isFinite(maximumLength)
      ? Math.min(this.segmentCount, startSegment + Math.floor(maximumLength))
      : this.segmentCount;
    let length = 0;
    for (let index = startSegment; index < limit; index++) {
      if (!this.residentByWorker.get(worker)?.has(index)) break;
      length++;
    }
    return length;
  }

  residentArtifactBytes(
    worker: WorkerId,
    startSegment = 0,
    endSegment = this.segmentCount - 1,
  ): number {
    this.validateRange(startSegment, endSegment);
    let bytes = 0;
    for (let index = startSegment; index <= endSegment; index++) {
      if (this.residentByWorker.get(worker)?.has(index)) {
        bytes += this.getArtifact(index).byteSize;
      }
    }
    return bytes;
  }

  artifactBytes(startSegment: number, endSegment: number): number {
    this.validateRange(startSegment, endSegment);
    let bytes = 0;
    for (let index = startSegment; index <= endSegment; index++) {
      bytes += this.getArtifact(index).byteSize;
    }
    return bytes;
  }

  missingArtifacts(
    worker: WorkerId,
    startSegment: number,
    endSegment: number,
  ): readonly SegmentArtifact[] {
    this.validateRange(startSegment, endSegment);
    const missing: SegmentArtifact[] = [];
    for (let index = startSegment; index <= endSegment; index++) {
      if (!this.residentByWorker.get(worker)?.has(index)) {
        missing.push(this.getArtifact(index));
      }
    }
    return missing;
  }

  missingArtifactBytes(worker: WorkerId, startSegment: number, endSegment: number): number {
    return this.missingArtifacts(worker, startSegment, endSegment).reduce(
      (sum, artifact) => sum + artifact.byteSize,
      0,
    );
  }

  snapshot(worker: WorkerId): WorkerArtifactResidencySnapshot {
    const indexes = [...(this.residentByWorker.get(worker) ?? [])].sort((a, b) => a - b);
    const residentArtifactBytes = indexes.reduce(
      (sum, index) => sum + this.getArtifact(index).byteSize,
      0,
    );
    return {
      workerId: worker,
      residentSegmentIndexes: indexes,
      residentArtifactBytes,
      totalArtifactBytes: this.totalArtifactBytes,
      coverageRatio: residentArtifactBytes / this.totalArtifactBytes,
    };
  }

  private validateRange(startSegment: number, endSegment: number): void {
    if (
      !Number.isInteger(startSegment) ||
      !Number.isInteger(endSegment) ||
      startSegment < 0 ||
      endSegment < startSegment ||
      endSegment >= this.segmentCount
    ) {
      throw new Error(
        `invalid segment range ${startSegment}..${endSegment}; ` +
        `expected 0..${this.segmentCount - 1}`,
      );
    }
  }
}

function cloneAndValidateComponents(
  artifact: SegmentArtifact,
): readonly SegmentArtifactComponent[] | undefined {
  if (artifact.components === undefined) {
    return undefined;
  }
  if (artifact.components.length === 0) {
    throw new Error(`segment ${artifact.index} component bundle must not be empty`);
  }

  let componentBytes = 0;
  const copied = artifact.components.map((component, componentIndex) => {
    if (!Number.isSafeInteger(component.byteSize) || component.byteSize <= 0) {
      throw new Error(
        `segment ${artifact.index} component ${componentIndex} byteSize must be a safe positive integer`,
      );
    }
    componentBytes += component.byteSize;
    if (!Number.isSafeInteger(componentBytes)) {
      throw new Error(`segment ${artifact.index} component bytes exceed JavaScript safe integer range`);
    }
    return Object.freeze({ ...component });
  });

  if (componentBytes !== artifact.byteSize) {
    throw new Error(
      `segment ${artifact.index} component bytes ${componentBytes} ` +
      `do not match artifact byteSize ${artifact.byteSize}`,
    );
  }
  return Object.freeze(copied);
}
