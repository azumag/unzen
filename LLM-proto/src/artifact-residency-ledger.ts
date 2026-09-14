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
import { workerId, type SegmentConfig, type WorkerId } from './types.js';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const COMPONENT_ROLES = new Set(['graph', 'external-data']);
const MEMORY_BASIS_VALUES = new Set(['measured', 'budgeted', 'estimated']);

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
    if (!Array.isArray(artifacts)) {
      throw new Error('ArtifactResidencyLedger artifacts must be an array');
    }
    const artifactCount = artifacts.length;
    if (artifactCount === 0) {
      throw new Error('ArtifactResidencyLedger requires at least one segment artifact');
    }

    // Fix caller-owned top-level membership before any artifact field accessor
    // runs. An early artifact getter must not be able to replace/remove a later
    // array slot during the same validation pass.
    const capturedArtifacts: unknown[] = [];
    for (let position = 0; position < artifactCount; position++) {
      capturedArtifacts.push((artifacts as readonly unknown[])[position]);
    }

    // Validate before sorting. Runtime callers can cross the TypeScript boundary
    // with asserted or deserialized data; a malformed index must never reach a
    // numeric comparator (or any trim/spread operation) before it is checked.
    const validated = capturedArtifacts.map((artifact, arrayIndex) =>
      cloneAndValidateArtifact(artifact, arrayIndex),
    );
    const sorted = [...validated].sort((left, right) => left.index - right.index);
    for (let expectedIndex = 0; expectedIndex < sorted.length; expectedIndex++) {
      const artifact = sorted[expectedIndex];
      if (artifact.index !== expectedIndex) {
        throw new Error(
          `segment indexes must be exactly 0..${sorted.length - 1}; ` +
          `expected ${expectedIndex}, found ${artifact.index}`,
        );
      }
      this.artifactsByIndex.set(artifact.index, artifact);
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
    if (!Array.isArray(segments)) {
      throw new Error('segment configs must be an array');
    }

    // Fix caller-owned top-level membership before any segment field accessor
    // runs. This mirrors the constructor boundary and prevents an early getter
    // from swapping a later config before it is validated.
    const segmentConfigCount = segments.length;
    const capturedSegments: unknown[] = [];
    for (let position = 0; position < segmentConfigCount; position++) {
      capturedSegments.push((segments as readonly unknown[])[position]);
    }

    // This method is a public trust boundary too: callers can bypass the
    // SpanRouter/AdaptiveChunkDispatcher validators with asserted or decoded
    // runtime values. Validate and snapshot every field before .toLowerCase(),
    // numeric comparisons, or artifact compatibility logic can observe it.
    const validatedSegments = Object.freeze(
      capturedSegments.map((segment, arrayIndex) =>
        cloneAndValidateSegmentConfig(segment, arrayIndex),
      ),
    );

    if (validatedSegments.length !== this.segmentCount) {
      throw new Error(
        `segment config count ${validatedSegments.length} ` +
        `does not match artifact count ${this.segmentCount}`,
      );
    }

    const byIndex = new Map(validatedSegments.map((segment) => [segment.index, segment]));
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
    if (!Array.isArray(segmentIndexes)) {
      throw new Error('worker segmentIndexes must be an array');
    }

    // Heartbeat/cache inventory is a runtime boundary. Fix membership before
    // reading any element so a caller-owned array cannot shrink while it is
    // being validated, and avoid a caller-overridden Symbol.iterator entirely.
    const segmentIndexCount = segmentIndexes.length;
    const capturedIndexes: unknown[] = [];
    for (let position = 0; position < segmentIndexCount; position++) {
      capturedIndexes.push((segmentIndexes as readonly unknown[])[position]);
    }

    const next = new Set<number>();
    for (let position = 0; position < capturedIndexes.length; position++) {
      const segmentIndex = capturedIndexes[position];
      if (
        typeof segmentIndex !== 'number' ||
        !Number.isSafeInteger(segmentIndex) ||
        segmentIndex < 0
      ) {
        throw new Error(
          `worker segment index at position ${position} must be a non-negative safe integer`,
        );
      }
      this.getArtifact(segmentIndex);
      next.add(segmentIndex);
    }

    const stableWorker = workerId(worker);
    if (next.size === 0) {
      this.residentByWorker.delete(stableWorker);
    } else {
      this.residentByWorker.set(stableWorker, next);
    }
    return this.snapshot(stableWorker);
  }

  markResident(worker: WorkerId, segmentIndex: number): void {
    this.getArtifact(segmentIndex);
    const stableWorker = workerId(worker);
    let residency = this.residentByWorker.get(stableWorker);
    if (!residency) {
      residency = new Set<number>();
      this.residentByWorker.set(stableWorker, residency);
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
    const stableWorker = workerId(worker);
    for (const index of indexes) {
      this.markResident(stableWorker, index);
    }
  }

  markEvicted(worker: WorkerId, segmentIndex: number): boolean {
    this.getArtifact(segmentIndex);
    const stableWorker = workerId(worker);
    const residency = this.residentByWorker.get(stableWorker);
    if (!residency) return false;
    const removed = residency.delete(segmentIndex);
    if (residency.size === 0) {
      this.residentByWorker.delete(stableWorker);
    }
    return removed;
  }

  clearWorker(worker: WorkerId): boolean {
    return this.residentByWorker.delete(workerId(worker));
  }

  isResident(worker: WorkerId, segmentIndex: number): boolean {
    this.getArtifact(segmentIndex);
    return this.residentByWorker.get(workerId(worker))?.has(segmentIndex) ?? false;
  }

  /** Number of consecutive cached artifacts beginning at startSegment. */
  residentPrefixLength(
    worker: WorkerId,
    startSegment: number,
    maximumLength = Number.POSITIVE_INFINITY,
  ): number {
    this.getArtifact(startSegment);
    if (
      typeof maximumLength !== 'number' ||
      maximumLength < 0 ||
      Number.isNaN(maximumLength)
    ) {
      throw new Error('maximumLength must be a non-negative number');
    }

    const stableWorker = workerId(worker);
    const limit = Number.isFinite(maximumLength)
      ? Math.min(this.segmentCount, startSegment + Math.floor(maximumLength))
      : this.segmentCount;
    let length = 0;
    for (let index = startSegment; index < limit; index++) {
      if (!this.residentByWorker.get(stableWorker)?.has(index)) break;
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
    const stableWorker = workerId(worker);
    let bytes = 0;
    for (let index = startSegment; index <= endSegment; index++) {
      if (this.residentByWorker.get(stableWorker)?.has(index)) {
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
    const stableWorker = workerId(worker);
    const missing: SegmentArtifact[] = [];
    for (let index = startSegment; index <= endSegment; index++) {
      if (!this.residentByWorker.get(stableWorker)?.has(index)) {
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
    const stableWorker = workerId(worker);
    const indexes = [...(this.residentByWorker.get(stableWorker) ?? [])].sort((a, b) => a - b);
    const residentArtifactBytes = indexes.reduce(
      (sum, index) => sum + this.getArtifact(index).byteSize,
      0,
    );
    return {
      workerId: stableWorker,
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

function cloneAndValidateSegmentConfig(input: unknown, arrayIndex: number): SegmentConfig {
  if (!isRecord(input)) {
    throw new Error(`segment config ${arrayIndex} must be an object`);
  }

  const index = input.index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`segment config ${arrayIndex} index must be a non-negative safe integer`);
  }

  const layerStart = input.layerStart;
  if (
    typeof layerStart !== 'number' ||
    !Number.isSafeInteger(layerStart) ||
    layerStart < 0
  ) {
    throw new Error(`segment config ${arrayIndex} layerStart must be a non-negative safe integer`);
  }

  const layerEnd = input.layerEnd;
  if (
    typeof layerEnd !== 'number' ||
    !Number.isSafeInteger(layerEnd) ||
    layerEnd < layerStart
  ) {
    throw new Error(
      `segment config ${arrayIndex} layerEnd must be a safe integer ` +
      `greater than or equal to layerStart`,
    );
  }

  const modelWeightHash = input.modelWeightHash;
  if (typeof modelWeightHash !== 'string' || modelWeightHash.trim().length === 0) {
    throw new Error(`segment config ${arrayIndex} modelWeightHash must be a non-empty string`);
  }

  const estimatedVramMB = input.estimatedVramMB;
  if (
    typeof estimatedVramMB !== 'number' ||
    !Number.isFinite(estimatedVramMB) ||
    estimatedVramMB <= 0
  ) {
    throw new Error(
      `segment config ${arrayIndex} estimatedVramMB must be a positive finite number`,
    );
  }

  return Object.freeze({
    index,
    layerStart,
    layerEnd,
    modelWeightHash,
    estimatedVramMB,
  });
}

function cloneAndValidateArtifact(input: unknown, arrayIndex: number): SegmentArtifact {
  if (!isRecord(input)) {
    throw new Error(`segment artifact ${arrayIndex} must be an object`);
  }

  // Capture each field only when validation reaches it. This keeps the existing
  // fail-fast ordering while binding validation and the stored artifact to the
  // exact same caller-observed values.
  const index = input.index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(`segment artifact ${arrayIndex} index must be a non-negative safe integer`);
  }

  const layerStart = input.layerStart;
  if (
    typeof layerStart !== 'number' ||
    !Number.isSafeInteger(layerStart) ||
    layerStart < 0
  ) {
    throw new Error(`segment ${index} layerStart must be a non-negative safe integer`);
  }

  const layerEnd = input.layerEnd;
  if (
    typeof layerEnd !== 'number' ||
    !Number.isSafeInteger(layerEnd) ||
    layerEnd < layerStart
  ) {
    throw new Error(
      `segment ${index} layerEnd must be a safe integer greater than or equal to layerStart`,
    );
  }

  const byteSize = input.byteSize;
  if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error(`segment ${index} byteSize must be a safe positive integer`);
  }

  const sha256 = input.sha256;
  if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
    throw new Error(
      `segment ${index} sha256 must be exactly 64 lowercase hexadecimal characters`,
    );
  }

  const contentType = input.contentType;
  if (typeof contentType !== 'string' || contentType.trim().length === 0) {
    throw new Error(`segment ${index} contentType must be non-empty`);
  }

  const encoding = input.encoding;
  if (encoding !== undefined && typeof encoding !== 'string') {
    throw new Error(`segment ${index} encoding must be a string when present`);
  }

  const artifactLocator = input.artifactLocator;
  if (typeof artifactLocator !== 'string' || artifactLocator.trim().length === 0) {
    throw new Error(`segment ${index} artifactLocator must be non-empty`);
  }

  const componentsInput = input.components;
  if (componentsInput !== undefined && !Array.isArray(componentsInput)) {
    throw new Error(`segment ${index} components must be an array when present`);
  }

  const estimatedMemoryMB = input.estimatedMemoryMB;
  if (
    typeof estimatedMemoryMB !== 'number' ||
    !Number.isFinite(estimatedMemoryMB) ||
    estimatedMemoryMB <= 0
  ) {
    throw new Error(`segment ${index} estimatedMemoryMB must be a positive finite number`);
  }

  const memoryBasis = input.memoryBasis;
  if (typeof memoryBasis !== 'string' || !MEMORY_BASIS_VALUES.has(memoryBasis)) {
    throw new Error(
      `segment ${index} memoryBasis must be measured, budgeted, or estimated`,
    );
  }

  const measurementConditions = input.measurementConditions;
  if (measurementConditions !== undefined && typeof measurementConditions !== 'string') {
    throw new Error(`segment ${index} measurementConditions must be a string when present`);
  }

  const compatibleRuntimesInput = input.compatibleRuntimes;
  if (!Array.isArray(compatibleRuntimesInput)) {
    throw new Error(`segment ${index} compatibleRuntimes must be a non-empty string array`);
  }
  const compatibleRuntimeCount = compatibleRuntimesInput.length;
  if (compatibleRuntimeCount === 0) {
    throw new Error(`segment ${index} compatibleRuntimes must be a non-empty string array`);
  }
  const compatibleRuntimeValues: unknown[] = [];
  for (let runtimeIndex = 0; runtimeIndex < compatibleRuntimeCount; runtimeIndex++) {
    compatibleRuntimeValues.push(compatibleRuntimesInput[runtimeIndex]);
  }
  if (!compatibleRuntimeValues.every(
    (runtime) => typeof runtime === 'string' && runtime.trim().length > 0,
  )) {
    throw new Error(`segment ${index} compatibleRuntimes must be a non-empty string array`);
  }
  const compatibleRuntimes = Object.freeze(compatibleRuntimeValues as string[]);

  const minimumRuntimeVersion = input.minimumRuntimeVersion;
  if (typeof minimumRuntimeVersion !== 'string' || minimumRuntimeVersion.trim().length === 0) {
    throw new Error(`segment ${index} minimumRuntimeVersion must be non-empty`);
  }

  const components = cloneAndValidateComponents({
    index,
    byteSize,
    artifactLocator,
    ...(componentsInput === undefined
      ? {}
      : { components: componentsInput as readonly SegmentArtifactComponent[] }),
  } as SegmentArtifact);

  return Object.freeze({
    index,
    layerStart,
    layerEnd,
    byteSize,
    sha256,
    contentType,
    ...(encoding === undefined ? {} : { encoding }),
    artifactLocator,
    ...(components === undefined ? {} : { components }),
    estimatedMemoryMB,
    memoryBasis: memoryBasis as SegmentArtifact['memoryBasis'],
    ...(measurementConditions === undefined ? {} : { measurementConditions }),
    compatibleRuntimes,
    minimumRuntimeVersion,
  });
}

function cloneAndValidateComponents(
  artifact: SegmentArtifact,
): readonly SegmentArtifactComponent[] | undefined {
  const componentsInput = artifact.components;
  if (componentsInput === undefined) {
    return undefined;
  }

  const componentCount = componentsInput.length;
  if (componentCount === 0) {
    throw new Error(`segment ${artifact.index} component bundle must not be empty`);
  }

  // Fix the original component positions before invoking any component field
  // accessor. A getter that truncates the caller-owned array cannot make a
  // later position disappear silently from validation.
  const componentInputs: unknown[] = [];
  for (let componentIndex = 0; componentIndex < componentCount; componentIndex++) {
    componentInputs.push(componentsInput[componentIndex]);
  }

  let componentBytes = 0;
  let graphCount = 0;
  let graphLocator: string | undefined;
  const componentPaths = new Set<string>();
  const copied = componentInputs.map((componentInput, componentIndex) => {
    if (!isRecord(componentInput)) {
      throw new Error(`segment ${artifact.index} component ${componentIndex} must be an object`);
    }

    const role = componentInput.role;
    if (typeof role !== 'string' || !COMPONENT_ROLES.has(role)) {
      throw new Error(
        `segment ${artifact.index} component ${componentIndex} role must be graph or external-data`,
      );
    }

    const path = componentInput.path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error(`segment ${artifact.index} component ${componentIndex} path must be non-empty`);
    }
    if (componentPaths.has(path)) {
      throw new Error(`segment ${artifact.index} component path ${path} must be unique`);
    }
    componentPaths.add(path);

    const byteSize = componentInput.byteSize;
    if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new Error(
        `segment ${artifact.index} component ${componentIndex} byteSize must be a safe positive integer`,
      );
    }

    const sha256 = componentInput.sha256;
    if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
      throw new Error(
        `segment ${artifact.index} component ${componentIndex} sha256 must be exactly 64 lowercase hexadecimal characters`,
      );
    }

    const contentType = componentInput.contentType;
    if (typeof contentType !== 'string' || contentType.trim().length === 0) {
      throw new Error(
        `segment ${artifact.index} component ${componentIndex} contentType must be non-empty`,
      );
    }

    const artifactLocator = componentInput.artifactLocator;
    if (typeof artifactLocator !== 'string' || artifactLocator.trim().length === 0) {
      throw new Error(
        `segment ${artifact.index} component ${componentIndex} artifactLocator must be non-empty`,
      );
    }

    if (role === 'graph') {
      graphCount++;
      graphLocator = artifactLocator;
    }
    componentBytes += byteSize;
    if (!Number.isSafeInteger(componentBytes)) {
      throw new Error(`segment ${artifact.index} component bytes exceed JavaScript safe integer range`);
    }

    return Object.freeze({
      role: role as SegmentArtifactComponent['role'],
      path,
      byteSize,
      sha256,
      contentType,
      artifactLocator,
    });
  });

  if (graphCount !== 1) {
    throw new Error(
      `segment ${artifact.index} component bundle must contain exactly one graph component; found ${graphCount}`,
    );
  }
  if (graphLocator !== artifact.artifactLocator) {
    throw new Error(
      `segment ${artifact.index} primary artifactLocator must match the graph component locator`,
    );
  }
  if (componentBytes !== artifact.byteSize) {
    throw new Error(
      `segment ${artifact.index} component bytes ${componentBytes} ` +
      `do not match artifact byteSize ${artifact.byteSize}`,
    );
  }
  return Object.freeze(copied);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
