export interface SegmentResultRootSnapshot {
  readonly requestId: unknown;
  readonly segmentIndex: unknown;
  readonly workerId: unknown;
  readonly processingTimeMs: unknown;
  readonly checkpoint: unknown;
  readonly output: unknown;
}

export interface SpanResultRootSnapshot {
  readonly requestId: unknown;
  readonly workerId: unknown;
  readonly startSegment: unknown;
  readonly endSegment: unknown;
  readonly processingTimeMs: unknown;
  readonly checkpoint: unknown;
  readonly output: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Capture the complete checkpoint envelope consumed after the worker-result root.
 *
 * The legacy pipelines validate checkpoint identity and payload in several stages.
 * Keep those stages on one owned value so accessor-backed checkpoints cannot return
 * one valid identity during the first comparison and another value during storage.
 * Mutable payloads are copied without using array iteration.
 */
function snapshotCheckpointBoundary(checkpoint: unknown): unknown {
  if (!isRecord(checkpoint)) return checkpoint;

  const requestId = checkpoint.requestId;
  const segmentIndex = checkpoint.segmentIndex;
  const hiddenStates = checkpoint.hiddenStates;
  const metadataValue = checkpoint.metadata;

  let ownedHiddenStates: unknown = hiddenStates;
  if (hiddenStates instanceof Uint8Array) {
    ownedHiddenStates = hiddenStates.slice();
  }

  let ownedMetadata: unknown = metadataValue;
  if (isRecord(metadataValue)) {
    const shapeValue = metadataValue.shape;
    const dtype = metadataValue.dtype;
    const sequenceLength = metadataValue.sequenceLength;
    const timestamp = metadataValue.timestamp;

    let ownedShape: unknown = shapeValue;
    if (Array.isArray(shapeValue)) {
      const length = shapeValue.length;
      const shape: unknown[] = new Array(length);
      for (let index = 0; index < length; index += 1) {
        shape[index] = shapeValue[index];
      }
      ownedShape = Object.freeze(shape);
    }

    ownedMetadata = Object.freeze({
      shape: ownedShape,
      dtype,
      sequenceLength,
      timestamp,
    });
  }

  return Object.freeze({
    requestId,
    segmentIndex,
    hiddenStates: ownedHiddenStates,
    metadata: ownedMetadata,
  });
}

/**
 * Capture every root field consumed by the legacy single-segment result validator.
 *
 * Worker results are runtime-untrusted even when an executor is typed as returning
 * SegmentResult. Accessor- or Proxy-backed values therefore need one stable root
 * envelope before type, identity, range, and nested-boundary validation begins.
 */
export function snapshotSegmentResultRoot(
  result: Record<string, unknown>,
): SegmentResultRootSnapshot {
  const requestId = result.requestId;
  const segmentIndex = result.segmentIndex;
  const workerId = result.workerId;
  const processingTimeMs = result.processingTimeMs;
  const checkpoint = snapshotCheckpointBoundary(result.checkpoint);
  const output = result.output;

  return Object.freeze({
    requestId,
    segmentIndex,
    workerId,
    processingTimeMs,
    checkpoint,
    output,
  });
}

/** Capture the root fields consumed by SpanPipeline validation exactly once. */
export function snapshotSpanResultRoot(
  result: Record<string, unknown>,
): SpanResultRootSnapshot {
  const requestId = result.requestId;
  const workerId = result.workerId;
  const startSegment = result.startSegment;
  const endSegment = result.endSegment;
  const processingTimeMs = result.processingTimeMs;
  const checkpoint = snapshotCheckpointBoundary(result.checkpoint);
  const output = result.output;

  return Object.freeze({
    requestId,
    workerId,
    startSegment,
    endSegment,
    processingTimeMs,
    checkpoint,
    output,
  });
}
