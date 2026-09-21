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

const CHECKPOINT_TENSOR_RANK = 3;
const NativeUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const invalidBoundaryValue = Object.freeze({});
const invalidCheckpointShape = Object.freeze([] as unknown[]);
const uninspectableRecord = Symbol('uninspectable-worker-result-record');

type RecordInspection = Record<string, unknown> | undefined | typeof uninspectableRecord;

function inspectRecord(value: unknown): RecordInspection {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    if (Array.isArray(value)) return undefined;
  } catch {
    return uninspectableRecord;
  }
  return value as Record<string, unknown>;
}

/** Runtime-safe record predicate for worker-controlled result envelopes. */
export function isWorkerResultRecord(value: unknown): value is Record<string, unknown> {
  const inspected = inspectRecord(value);
  return inspected !== undefined && inspected !== uninspectableRecord;
}

function readBoundaryField(
  value: Record<string, unknown>,
  field: string,
  fallback: unknown = invalidBoundaryValue,
): unknown {
  try {
    return value[field];
  } catch {
    // Worker-controlled thrown values are intentionally ignored. Inspecting or
    // coercing them could execute another hostile hook while handling the first.
    return fallback;
  }
}

function memoize<T>(read: () => T): () => T {
  let captured = false;
  let value!: T;
  return () => {
    if (!captured) {
      value = read();
      captured = true;
    }
    return value;
  };
}

function snapshotUint8ArrayBoundary(value: unknown): unknown {
  let isUint8Array = false;
  try {
    isUint8Array = value instanceof NativeUint8Array;
  } catch {
    return invalidBoundaryValue;
  }
  if (!isUint8Array) return value;

  // A Proxy can satisfy instanceof while lacking TypedArray internal slots.
  // Reject it before invoking any TypedArray method so worker-controlled values
  // cannot leak a native incompatible-receiver TypeError through this boundary.
  if (!ArrayBuffer.isView(value)) return invalidBoundaryValue;
  if (
    typeof typedArrayBufferGetter !== 'function'
    || typeof typedArrayByteOffsetGetter !== 'function'
    || typeof typedArrayByteLengthGetter !== 'function'
  ) {
    return invalidBoundaryValue;
  }

  try {
    const buffer = typedArrayBufferGetter.call(value) as ArrayBufferLike;
    const byteOffset = typedArrayByteOffsetGetter.call(value) as number;
    const byteLength = typedArrayByteLengthGetter.call(value) as number;
    const source = new NativeUint8Array(buffer, byteOffset, byteLength);
    const owned = new NativeUint8Array(byteLength);
    NativeUint8Array.prototype.set.call(owned, source);
    return owned;
  } catch {
    // Detached or otherwise invalid TypedArray state is untrusted input. Feed a
    // stable non-TypedArray sentinel into CheckpointStore's existing protocol
    // validation instead of exposing a native internal-slot error.
    return invalidBoundaryValue;
  }
}

function snapshotShapeBoundary(shape: unknown): unknown {
  let isArray = false;
  try {
    isArray = Array.isArray(shape);
  } catch {
    return invalidCheckpointShape;
  }
  if (!isArray) return shape;

  let length: unknown;
  try {
    length = (shape as readonly unknown[]).length;
  } catch {
    return invalidCheckpointShape;
  }

  // An invalid rank is already unusable as a checkpoint. Convert it to a small
  // owned invalid snapshot instead of allocating/iterating according to an
  // untrusted Array/Proxy length; CheckpointStore will report the protocol error.
  if (length !== CHECKPOINT_TENSOR_RANK) {
    return invalidCheckpointShape;
  }

  const owned: unknown[] = new Array(CHECKPOINT_TENSOR_RANK);
  for (let index = 0; index < CHECKPOINT_TENSOR_RANK; index += 1) {
    try {
      owned[index] = (shape as readonly unknown[])[index];
    } catch {
      return invalidCheckpointShape;
    }
  }
  return Object.freeze(owned);
}

function snapshotMetadataBoundary(metadata: unknown): unknown {
  const inspected = inspectRecord(metadata);
  if (inspected === uninspectableRecord) return invalidBoundaryValue;
  if (inspected === undefined) return metadata;

  const readShape = memoize(() => snapshotShapeBoundary(
    readBoundaryField(inspected, 'shape'),
  ));
  const readDtype = memoize(() => readBoundaryField(inspected, 'dtype'));
  const readSequenceLength = memoize(() => readBoundaryField(inspected, 'sequenceLength'));
  const readTimestamp = memoize(() => readBoundaryField(inspected, 'timestamp'));

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
  const inspected = inspectRecord(checkpoint);
  if (inspected === uninspectableRecord) return invalidBoundaryValue;
  if (inspected === undefined) return checkpoint;

  const readRequestId = memoize(() => readBoundaryField(inspected, 'requestId'));
  const readSegmentIndex = memoize(() => readBoundaryField(inspected, 'segmentIndex'));
  const readHiddenStates = memoize(() => snapshotUint8ArrayBoundary(
    readBoundaryField(inspected, 'hiddenStates'),
  ));
  const readMetadata = memoize(() => snapshotMetadataBoundary(
    readBoundaryField(inspected, 'metadata'),
  ));

  return Object.freeze(Object.defineProperties({}, {
    requestId: { enumerable: true, get: readRequestId },
    segmentIndex: { enumerable: true, get: readSegmentIndex },
    hiddenStates: { enumerable: true, get: readHiddenStates },
    metadata: { enumerable: true, get: readMetadata },
  }));
}

function invalidSegmentResultRoot(): SegmentResultRootSnapshot {
  return Object.freeze({
    requestId: invalidBoundaryValue,
    segmentIndex: invalidBoundaryValue,
    workerId: invalidBoundaryValue,
    processingTimeMs: invalidBoundaryValue,
    checkpoint: invalidBoundaryValue,
    output: invalidBoundaryValue,
  });
}

function invalidSpanResultRoot(): SpanResultRootSnapshot {
  return Object.freeze({
    requestId: invalidBoundaryValue,
    workerId: invalidBoundaryValue,
    startSegment: invalidBoundaryValue,
    endSegment: invalidBoundaryValue,
    processingTimeMs: invalidBoundaryValue,
    checkpoint: invalidBoundaryValue,
    output: invalidBoundaryValue,
  });
}

/**
 * Capture every root field consumed by the legacy single-segment result validator.
 *
 * Worker results are runtime-untrusted even when an executor is typed as returning
 * SegmentResult. Accessor- or Proxy-backed values therefore need one stable root
 * envelope before type, identity, range, and nested-boundary validation begins.
 */
export function snapshotSegmentResultRoot(result: unknown): SegmentResultRootSnapshot {
  const inspected = inspectRecord(result);
  if (inspected === undefined || inspected === uninspectableRecord) {
    return invalidSegmentResultRoot();
  }

  const requestId = readBoundaryField(inspected, 'requestId');
  const segmentIndex = readBoundaryField(inspected, 'segmentIndex');
  const workerId = readBoundaryField(inspected, 'workerId');
  const processingTimeMs = readBoundaryField(inspected, 'processingTimeMs');
  const checkpoint = snapshotCheckpointBoundary(readBoundaryField(inspected, 'checkpoint'));
  const output = readBoundaryField(inspected, 'output');

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
export function snapshotSpanResultRoot(result: unknown): SpanResultRootSnapshot {
  const inspected = inspectRecord(result);
  if (inspected === undefined || inspected === uninspectableRecord) {
    return invalidSpanResultRoot();
  }

  const requestId = readBoundaryField(inspected, 'requestId');
  const workerId = readBoundaryField(inspected, 'workerId');
  const startSegment = readBoundaryField(inspected, 'startSegment');
  const endSegment = readBoundaryField(inspected, 'endSegment');
  const processingTimeMs = readBoundaryField(inspected, 'processingTimeMs');
  const checkpoint = snapshotCheckpointBoundary(readBoundaryField(inspected, 'checkpoint'));
  const output = readBoundaryField(inspected, 'output');

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
