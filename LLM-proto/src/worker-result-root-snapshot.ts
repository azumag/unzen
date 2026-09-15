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

function memoize<T>(read: () => T): () => T {
  let captured = false;
  let value: T;
  return () => {
    if (!captured) {
      value = read();
      captured = true;
    }
    return value;
  };
}

function snapshotShapeBoundary(shape: unknown): unknown {
  if (!Array.isArray(shape)) return shape;
  const length = shape.length;
  const owned: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    owned[index] = shape[index];
  }
  return Object.freeze(owned);
}

function snapshotMetadataBoundary(metadata: unknown): unknown {
  if (!isRecord(metadata)) return metadata;

  const readShape = memoize(() => snapshotShapeBoundary(metadata.shape));
  const readDtype = memoize(() => metadata.dtype);
  const readSequenceLength = memoize(() => metadata.sequenceLength);
  const readTimestamp = memoize(() => metadata.timestamp);

  return Object.freeze(Object.defineProperties({}, {
    shape: { enumerable: true, get: readShape },
    dtype: { enumerable: true, get: readDtype },
    sequenceLength: { enumerable: true, get: readSequenceLength },
    timestamp: { enumerable: true, get: readTimestamp },
  }));
}

/**
 * Create a lazy ownership boundary around a worker checkpoint.
 *
 * Root-result validation must retain its existing short-circuit order: for
 * example, a forbidden checkpoint on a final result is rejected without touching
 * hostile checkpoint accessors. Each nested field is therefore captured only when
 * validation first consumes it, then memoized for every later identity check and
 * persistence step. Mutable payloads are copied on that first validated read.
 */
function snapshotCheckpointBoundary(checkpoint: unknown): unknown {
  if (!isRecord(checkpoint)) return checkpoint;

  const readRequestId = memoize(() => checkpoint.requestId);
  const readSegmentIndex = memoize(() => checkpoint.segmentIndex);
  const readHiddenStates = memoize(() => {
    const hiddenStates = checkpoint.hiddenStates;
    return hiddenStates instanceof Uint8Array ? hiddenStates.slice() : hiddenStates;
  });
  const readMetadata = memoize(() => snapshotMetadataBoundary(checkpoint.metadata));

  return Object.freeze(Object.defineProperties({}, {
    requestId: { enumerable: true, get: readRequestId },
    segmentIndex: { enumerable: true, get: readSegmentIndex },
    hiddenStates: { enumerable: true, get: readHiddenStates },
    metadata: { enumerable: true, get: readMetadata },
  }));
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
