/**
 * Exact browser-artifact residency inventory for one segmented model.
 *
 * The model manifest owns immutable artifact facts (digest, locator and the
 * measured graph + external-data byte total). This ledger owns only the
 * mutable question of which worker reports which segment bundle as cached.
 * Keeping those concerns separate prevents telemetry from silently changing
 * artifact sizes or accepting a cache hit for a different model revision.
 */

import { evaluateBrowserSegmentArtifact } from './browser-segment-artifact-budget.js';
import { assertValidModelManifest } from './model-manifest-validator.js';
import {
  canonicalSegmentArtifactBundleFields,
  type SegmentArtifact,
  type SegmentArtifactComponent,
  type SegmentedModelManifest,
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
    const capturedArtifacts = captureArrayByNumericIndex(artifacts, {
      nonArray: 'ArtifactResidencyLedger artifacts must be an array',
      unreadableLength: 'ArtifactResidencyLedger artifacts length could not be read',
      unreadableElement: (position) =>
        `ArtifactResidencyLedger artifact at position ${position} could not be read`,
    });
    if (capturedArtifacts.length === 0) {
      throw new Error('ArtifactResidencyLedger requires at least one segment artifact');
    }

    // Validate before sorting. Runtime callers can cross the TypeScript boundary
    // with asserted or deserialized data; a malformed index must never reach a
    // numeric comparator (or any trim/spread operation) before it is checked.
    const validated = capturedArtifacts.map((artifact, arrayIndex) =>
      cloneAndValidateArtifact(artifact, arrayIndex),
    );
    let measuredTotalArtifactBytes = 0;
    for (const artifact of validated) {
      if (measuredTotalArtifactBytes > Number.MAX_SAFE_INTEGER - artifact.byteSize) {
        throw new Error('total artifact byte size exceeds JavaScript safe integer range');
      }
      measuredTotalArtifactBytes += artifact.byteSize;
    }
    for (const artifact of validated) {
      const budget = evaluateBrowserSegmentArtifact(artifact);
      if (!budget.usable) {
        throw new Error(
          `segment ${artifact.index} exceeds browser artifact absolute budget: ` +
          `${artifact.byteSize} > ${budget.absoluteMaxBytes} bytes`,
        );
      }
    }
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

    this.measuredTotalArtifactBytes = measuredTotalArtifactBytes;
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
      throw new Error(`unknown segment ${describeRuntimeValue(segmentIndex)}`);
    }
    return artifact;
  }

  /**
   * Fail closed when execution geometry was derived from another manifest or
   * was hand-written inconsistently with this artifact inventory.
   */
  assertCompatibleSegments(segments: readonly SegmentConfig[]): void {
    const capturedSegments = captureArrayByNumericIndex(segments, {
      nonArray: 'segment configs must be an array',
      unreadableLength: 'segment configs length could not be read',
      unreadableElement: (position) => `segment config at position ${position} could not be read`,
      expectedLength: this.segmentCount,
      lengthMismatch: (length) =>
        `segment config count ${length} does not match artifact count ${this.segmentCount}`,
    });

    // This method is a public trust boundary too: callers can bypass the
    // SpanRouter/AdaptiveChunkDispatcher validators with asserted or decoded
    // runtime values. Validate and snapshot every field before .toLowerCase(),
    // numeric comparisons, or artifact compatibility logic can observe it.
    const validatedSegments = Object.freeze(
      capturedSegments.map((segment, arrayIndex) =>
        cloneAndValidateSegmentConfig(segment, arrayIndex),
      ),
    );

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
    const capturedIndexes = captureArrayByNumericIndex(segmentIndexes, {
      nonArray: 'worker segmentIndexes must be an array',
      unreadableLength: 'worker segmentIndexes length could not be read',
      unreadableElement: (position) =>
        `worker segment index at position ${position} could not be read`,
    });

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
        `invalid segment range ${describeRuntimeValue(startSegment)}..${describeRuntimeValue(endSegment)}; ` +
        `expected 0..${this.segmentCount - 1}`,
      );
    }
  }
}

function cloneAndValidateSegmentConfig(input: unknown, arrayIndex: number): SegmentConfig {
  if (!isRecord(input)) {
    throw new Error(`segment config ${arrayIndex} must be an object`);
  }

  const indexDiagnostic = `segment config ${arrayIndex} index must be a non-negative safe integer`;
  const index = readRecordField(input, 'index', indexDiagnostic);
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(indexDiagnostic);
  }

  const layerStartDiagnostic =
    `segment config ${arrayIndex} layerStart must be a non-negative safe integer`;
  const layerStart = readRecordField(input, 'layerStart', layerStartDiagnostic);
  if (
    typeof layerStart !== 'number' ||
    !Number.isSafeInteger(layerStart) ||
    layerStart < 0
  ) {
    throw new Error(layerStartDiagnostic);
  }

  const layerEndDiagnostic =
    `segment config ${arrayIndex} layerEnd must be a safe integer ` +
    `greater than or equal to layerStart`;
  const layerEnd = readRecordField(input, 'layerEnd', layerEndDiagnostic);
  if (
    typeof layerEnd !== 'number' ||
    !Number.isSafeInteger(layerEnd) ||
    layerEnd < layerStart
  ) {
    throw new Error(layerEndDiagnostic);
  }

  const modelWeightHashDiagnostic =
    `segment config ${arrayIndex} modelWeightHash must be a non-empty string`;
  const modelWeightHash = readRecordField(input, 'modelWeightHash', modelWeightHashDiagnostic);
  if (typeof modelWeightHash !== 'string' || modelWeightHash.trim().length === 0) {
    throw new Error(modelWeightHashDiagnostic);
  }

  const estimatedVramDiagnostic =
    `segment config ${arrayIndex} estimatedVramMB must be a positive finite number`;
  const estimatedVramMB = readRecordField(input, 'estimatedVramMB', estimatedVramDiagnostic);
  if (
    typeof estimatedVramMB !== 'number' ||
    !Number.isFinite(estimatedVramMB) ||
    estimatedVramMB <= 0
  ) {
    throw new Error(estimatedVramDiagnostic);
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
  const indexDiagnostic = `segment artifact ${arrayIndex} index must be a non-negative safe integer`;
  const index = readRecordField(input, 'index', indexDiagnostic);
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(indexDiagnostic);
  }

  const layerStartDiagnostic = `segment ${index} layerStart must be a non-negative safe integer`;
  const layerStart = readRecordField(input, 'layerStart', layerStartDiagnostic);
  if (
    typeof layerStart !== 'number' ||
    !Number.isSafeInteger(layerStart) ||
    layerStart < 0
  ) {
    throw new Error(layerStartDiagnostic);
  }

  const layerEndDiagnostic =
    `segment ${index} layerEnd must be a safe integer greater than or equal to layerStart`;
  const layerEnd = readRecordField(input, 'layerEnd', layerEndDiagnostic);
  if (
    typeof layerEnd !== 'number' ||
    !Number.isSafeInteger(layerEnd) ||
    layerEnd < layerStart
  ) {
    throw new Error(layerEndDiagnostic);
  }

  const byteSizeDiagnostic = `segment ${index} byteSize must be a safe positive integer`;
  const byteSize = readRecordField(input, 'byteSize', byteSizeDiagnostic);
  if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error(byteSizeDiagnostic);
  }

  const sha256Diagnostic =
    `segment ${index} sha256 must be exactly 64 lowercase hexadecimal characters`;
  const sha256 = readRecordField(input, 'sha256', sha256Diagnostic);
  if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
    throw new Error(sha256Diagnostic);
  }

  const contentTypeDiagnostic = `segment ${index} contentType must be non-empty`;
  const contentType = readRecordField(input, 'contentType', contentTypeDiagnostic);
  if (typeof contentType !== 'string' || contentType.trim().length === 0) {
    throw new Error(contentTypeDiagnostic);
  }

  const encodingDiagnostic = `segment ${index} encoding must be a string when present`;
  const encoding = readRecordField(input, 'encoding', encodingDiagnostic);
  if (encoding !== undefined && typeof encoding !== 'string') {
    throw new Error(encodingDiagnostic);
  }

  const artifactLocatorDiagnostic = `segment ${index} artifactLocator must be non-empty`;
  const artifactLocator = readRecordField(input, 'artifactLocator', artifactLocatorDiagnostic);
  if (typeof artifactLocator !== 'string' || artifactLocator.trim().length === 0) {
    throw new Error(artifactLocatorDiagnostic);
  }

  const componentsDiagnostic = `segment ${index} components must be an array when present`;
  const componentsInput = readRecordField(input, 'components', componentsDiagnostic);
  let capturedComponents: unknown[] | undefined;
  if (componentsInput !== undefined) {
    capturedComponents = captureArrayByNumericIndex(componentsInput, {
      nonArray: componentsDiagnostic,
      unreadableLength: componentsDiagnostic,
      unreadableElement: (componentIndex) =>
        `segment ${index} component ${componentIndex} must be an object`,
    });
  }

  const estimatedMemoryDiagnostic =
    `segment ${index} estimatedMemoryMB must be a positive finite number`;
  const estimatedMemoryMB = readRecordField(input, 'estimatedMemoryMB', estimatedMemoryDiagnostic);
  if (
    typeof estimatedMemoryMB !== 'number' ||
    !Number.isFinite(estimatedMemoryMB) ||
    estimatedMemoryMB <= 0
  ) {
    throw new Error(estimatedMemoryDiagnostic);
  }

  const memoryBasisDiagnostic =
    `segment ${index} memoryBasis must be measured, budgeted, or estimated`;
  const memoryBasis = readRecordField(input, 'memoryBasis', memoryBasisDiagnostic);
  if (typeof memoryBasis !== 'string' || !MEMORY_BASIS_VALUES.has(memoryBasis)) {
    throw new Error(memoryBasisDiagnostic);
  }

  const measurementConditionsDiagnostic =
    `segment ${index} measurementConditions must be a string when present`;
  const measurementConditions = readRecordField(
    input,
    'measurementConditions',
    measurementConditionsDiagnostic,
  );
  if (measurementConditions !== undefined && typeof measurementConditions !== 'string') {
    throw new Error(measurementConditionsDiagnostic);
  }

  const compatibleRuntimesDiagnostic =
    `segment ${index} compatibleRuntimes must be a non-empty string array`;
  const compatibleRuntimesInput = readRecordField(
    input,
    'compatibleRuntimes',
    compatibleRuntimesDiagnostic,
  );
  const compatibleRuntimeValues = captureArrayByNumericIndex(compatibleRuntimesInput, {
    nonArray: compatibleRuntimesDiagnostic,
    unreadableLength: compatibleRuntimesDiagnostic,
    unreadableElement: () => compatibleRuntimesDiagnostic,
  });
  if (
    compatibleRuntimeValues.length === 0 ||
    !compatibleRuntimeValues.every(
      (runtime) => typeof runtime === 'string' && runtime.trim().length > 0,
    )
  ) {
    throw new Error(compatibleRuntimesDiagnostic);
  }
  const compatibleRuntimes = Object.freeze(compatibleRuntimeValues as string[]);

  const minimumRuntimeVersionDiagnostic = `segment ${index} minimumRuntimeVersion must be non-empty`;
  const minimumRuntimeVersion = readRecordField(
    input,
    'minimumRuntimeVersion',
    minimumRuntimeVersionDiagnostic,
  );
  if (typeof minimumRuntimeVersion !== 'string' || minimumRuntimeVersion.trim().length === 0) {
    throw new Error(minimumRuntimeVersionDiagnostic);
  }

  const components = cloneAndValidateComponents({
    index,
    byteSize,
    artifactLocator,
    ...(capturedComponents === undefined
      ? {}
      : { components: capturedComponents as readonly SegmentArtifactComponent[] }),
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

  // The caller-owned component array was captured before this function is
  // reached. Fix these owned positions before invoking component field accessors
  // so an early component cannot affect which later record is validated.
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

    const roleDiagnostic =
      `segment ${artifact.index} component ${componentIndex} role must be graph or external-data`;
    const role = readRecordField(componentInput, 'role', roleDiagnostic);
    if (typeof role !== 'string' || !COMPONENT_ROLES.has(role)) {
      throw new Error(roleDiagnostic);
    }

    const pathDiagnostic =
      `segment ${artifact.index} component ${componentIndex} path must be non-empty`;
    const path = readRecordField(componentInput, 'path', pathDiagnostic);
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new Error(pathDiagnostic);
    }
    if (componentPaths.has(path)) {
      throw new Error(`segment ${artifact.index} component path ${path} must be unique`);
    }
    componentPaths.add(path);

    const byteSizeDiagnostic =
      `segment ${artifact.index} component ${componentIndex} byteSize must be a safe positive integer`;
    const byteSize = readRecordField(componentInput, 'byteSize', byteSizeDiagnostic);
    if (typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
      throw new Error(byteSizeDiagnostic);
    }

    const sha256Diagnostic =
      `segment ${artifact.index} component ${componentIndex} sha256 must be exactly 64 lowercase hexadecimal characters`;
    const sha256 = readRecordField(componentInput, 'sha256', sha256Diagnostic);
    if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
      throw new Error(sha256Diagnostic);
    }

    const contentTypeDiagnostic =
      `segment ${artifact.index} component ${componentIndex} contentType must be non-empty`;
    const contentType = readRecordField(componentInput, 'contentType', contentTypeDiagnostic);
    if (typeof contentType !== 'string' || contentType.trim().length === 0) {
      throw new Error(contentTypeDiagnostic);
    }

    const artifactLocatorDiagnostic =
      `segment ${artifact.index} component ${componentIndex} artifactLocator must be non-empty`;
    const componentArtifactLocator = readRecordField(
      componentInput,
      'artifactLocator',
      artifactLocatorDiagnostic,
    );
    if (
      typeof componentArtifactLocator !== 'string' ||
      componentArtifactLocator.trim().length === 0
    ) {
      throw new Error(artifactLocatorDiagnostic);
    }

    if (role === 'graph') {
      graphCount++;
      graphLocator = componentArtifactLocator;
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
      artifactLocator: componentArtifactLocator,
    });
  });

  // Re-run the canonical bundle grammar only on the owned copies. This aligns
  // direct-constructor path safety with manifest validation without re-reading
  // caller-controlled component accessors or iterators.
  canonicalSegmentArtifactBundleFields(copied);

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

interface ArrayCaptureDiagnostics {
  readonly nonArray: string;
  readonly unreadableLength: string;
  readonly unreadableElement: (position: number) => string;
  readonly expectedLength?: number;
  readonly lengthMismatch?: (length: number) => string;
}

/**
 * Capture caller-owned arrays without invoking their iterator. Every operation
 * that can execute proxy code is bounded so revoked proxies and throwing traps
 * become ledger-owned diagnostics instead of escaping native/caller errors.
 */
function captureArrayByNumericIndex(
  input: unknown,
  diagnostics: ArrayCaptureDiagnostics,
): unknown[] {
  let isArray: boolean;
  try {
    isArray = Array.isArray(input);
  } catch {
    throw new Error(diagnostics.nonArray);
  }
  if (!isArray) {
    throw new Error(diagnostics.nonArray);
  }

  let length: unknown;
  try {
    length = (input as readonly unknown[]).length;
  } catch {
    throw new Error(diagnostics.unreadableLength);
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    throw new Error(diagnostics.unreadableLength);
  }
  if (diagnostics.expectedLength !== undefined && length !== diagnostics.expectedLength) {
    throw new Error(
      diagnostics.lengthMismatch?.(length) ??
        `${diagnostics.unreadableLength}: expected length ${diagnostics.expectedLength}`,
    );
  }

  const captured: unknown[] = [];
  for (let position = 0; position < length; position++) {
    try {
      captured.push((input as readonly unknown[])[position]);
    } catch {
      throw new Error(diagnostics.unreadableElement(position));
    }
  }
  return captured;
}

/**
 * Read one caller-owned record property without allowing accessor failures or
 * hostile thrown values to escape into the ledger. The value is returned as-is
 * and is never inspected until the caller validates its primitive/shape.
 */
function readRecordField(
  record: Record<string, unknown>,
  field: string,
  diagnostic: string,
): unknown {
  try {
    return record[field];
  } catch {
    throw new Error(diagnostic);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function describeRuntimeValue(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function') return 'unknown';
  return String(value);
}
