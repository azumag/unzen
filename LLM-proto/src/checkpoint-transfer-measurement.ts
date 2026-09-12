import { inferenceRequestId, type Checkpoint } from './types.js';
import {
  createDefault30BFeasibilityManifest,
  evaluateWebGpu30BFeasibility,
  type WebGpu30BFeasibilityReport,
} from './webgpu-30b-feasibility.js';

export type CheckpointMeasurementStatus = 'pass' | 'fail';
export type CheckpointMeasurementDtype = 'float16' | 'float32' | 'int8';

export interface CheckpointTensorSpec {
  readonly batchSize: number;
  readonly sequenceLength: number;
  readonly hiddenSize: number;
  readonly dtype: CheckpointMeasurementDtype;
}

export interface CheckpointTransferMeasurementManifest {
  readonly requestId: string;
  readonly segmentIndex: number;
  readonly tensor: CheckpointTensorSpec;
  readonly serializationBytesPerSecond: number;
  readonly deserializationBytesPerSecond: number;
  readonly coordinatorTransferBytesPerSecond: number;
  readonly maxTransferMs: number;
  readonly maxRetries: number;
  readonly retryBackoffMs: number;
  readonly simulatedFailuresBeforeSuccess?: number;
  readonly expectedCheckpointBytes?: number;
  readonly expectedCheckpointTransferMs?: number;
}

export interface SerializedCheckpointPayload {
  readonly bytes: Uint8Array;
  readonly headerBytes: number;
  readonly payloadBytes: number;
}

export interface CheckpointTransferMeasurementReport {
  readonly requestId: string;
  readonly status: CheckpointMeasurementStatus;
  readonly tensorShape: readonly [number, number, number];
  readonly dtype: CheckpointMeasurementDtype;
  readonly payloadBytes: number;
  readonly serializedBytes: number;
  readonly serializationMs: number;
  readonly deserializationMs: number;
  readonly transferEstimateMs: number;
  readonly observedTransferMs: number;
  readonly observedThroughputBytesPerSecond: number;
  readonly retryCount: number;
  readonly failureReason?: string;
  readonly comparison: {
    readonly expectedCheckpointBytes?: number;
    readonly expectedCheckpointTransferMs?: number;
    readonly byteDelta?: number;
    readonly transferMsDelta?: number;
  };
}

const BYTES_PER_DTYPE = {
  float16: 2,
  float32: 4,
  int8: 1,
} as const;

const MAX_SERIALIZED_HEADER_BYTES = 0xffff_ffff;

export function createDefaultCheckpointMeasurementManifest(
  feasibilityReport: WebGpu30BFeasibilityReport = evaluateWebGpu30BFeasibility(
    createDefault30BFeasibilityManifest(),
  ),
): CheckpointTransferMeasurementManifest {
  return {
    requestId: 'checkpoint-measurement-default',
    segmentIndex: 3,
    tensor: {
      batchSize: feasibilityReport.checkpointTensorShape[0],
      sequenceLength: feasibilityReport.checkpointTensorShape[1],
      hiddenSize: feasibilityReport.checkpointTensorShape[2],
      dtype: 'float16',
    },
    serializationBytesPerSecond: 512 * 1024 * 1024,
    deserializationBytesPerSecond: 768 * 1024 * 1024,
    coordinatorTransferBytesPerSecond: 16 * 1024 * 1024,
    maxTransferMs: 750,
    maxRetries: 2,
    retryBackoffMs: 25,
    expectedCheckpointBytes: feasibilityReport.checkpointBytes,
    expectedCheckpointTransferMs: feasibilityReport.checkpointTransferMs,
  };
}

export function measureCheckpointSerializationAndTransfer(
  manifest: CheckpointTransferMeasurementManifest,
): CheckpointTransferMeasurementReport {
  validateCheckpointTransferMeasurementManifest(manifest);

  const checkpoint = createCheckpointPayload(manifest);
  const serialized = serializeCheckpointPayload(checkpoint);
  const payloadBytes = checkpoint.hiddenStates.byteLength;
  const serializationMs = ceilDurationMs(payloadBytes, manifest.serializationBytesPerSecond);
  const deserializationMs = ceilDurationMs(serialized.payloadBytes, manifest.deserializationBytesPerSecond);
  const transferEstimateMs = ceilDurationMs(payloadBytes, manifest.coordinatorTransferBytesPerSecond);
  const transferResult = measureCoordinatorTransfer(manifest, serialized.bytes.byteLength);
  const comparison = compareWithFeasibilityGate(manifest, payloadBytes, transferEstimateMs);
  const failureReason = selectFailureReason(
    transferResult.failureReason,
    transferEstimateMs,
    transferResult.observedTransferMs,
    manifest.maxTransferMs,
  );

  return {
    requestId: manifest.requestId,
    status: failureReason ? 'fail' : 'pass',
    tensorShape: [
      manifest.tensor.batchSize,
      manifest.tensor.sequenceLength,
      manifest.tensor.hiddenSize,
    ],
    dtype: manifest.tensor.dtype,
    payloadBytes,
    serializedBytes: serialized.bytes.byteLength,
    serializationMs,
    deserializationMs,
    transferEstimateMs,
    observedTransferMs: transferResult.observedTransferMs,
    observedThroughputBytesPerSecond: transferResult.observedThroughputBytesPerSecond,
    retryCount: transferResult.retryCount,
    failureReason,
    comparison,
  };
}

export function createCheckpointPayload(
  manifest: CheckpointTransferMeasurementManifest,
): Checkpoint {
  validateCheckpointPayloadInputs(manifest);

  const payloadBytes = computeCheckpointPayloadBytes(manifest.tensor);
  const hiddenStates = new Uint8Array(payloadBytes);

  for (let index = 0; index < hiddenStates.length; index++) {
    hiddenStates[index] = (index * 31 + manifest.segmentIndex) % 256;
  }

  return {
    requestId: inferenceRequestId(manifest.requestId),
    segmentIndex: manifest.segmentIndex,
    hiddenStates,
    metadata: {
      shape: [
        manifest.tensor.batchSize,
        manifest.tensor.sequenceLength,
        manifest.tensor.hiddenSize,
      ],
      dtype: manifest.tensor.dtype,
      sequenceLength: manifest.tensor.sequenceLength,
      timestamp: 0,
    },
  };
}

export function serializeCheckpointPayload(checkpoint: Checkpoint): SerializedCheckpointPayload {
  const validated = validateCheckpointForSerialization(checkpoint);
  const header = new TextEncoder().encode(JSON.stringify({
    requestId: validated.requestId,
    segmentIndex: validated.segmentIndex,
    metadata: validated.metadata,
  }));
  if (header.byteLength > MAX_SERIALIZED_HEADER_BYTES) {
    throw new Error('serialized checkpoint header exceeds uint32 length prefix');
  }

  const headerAndPrefixBytes = checkedAddSafeInteger(
    4,
    header.byteLength,
    'serialized checkpoint frame byte length',
  );
  const frameBytes = checkedAddSafeInteger(
    headerAndPrefixBytes,
    checkpoint.hiddenStates.byteLength,
    'serialized checkpoint frame byte length',
  );
  const bytes = new Uint8Array(frameBytes);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, header.byteLength, true);
  bytes.set(header, 4);
  bytes.set(checkpoint.hiddenStates, 4 + header.byteLength);

  return {
    bytes,
    headerBytes: header.byteLength,
    payloadBytes: checkpoint.hiddenStates.byteLength,
  };
}

export function deserializeCheckpointPayload(serialized: Uint8Array): Checkpoint {
  if (serialized.byteLength < 4) {
    throw new Error('serialized checkpoint must contain a 4-byte header length');
  }

  const headerBytes = new DataView(
    serialized.buffer,
    serialized.byteOffset,
    serialized.byteLength,
  ).getUint32(0, true);
  if (headerBytes === 0 || headerBytes > serialized.byteLength - 4) {
    throw new Error('serialized checkpoint header length is out of bounds');
  }

  const headerStart = 4;
  const payloadStart = headerStart + headerBytes;
  let parsedHeader: unknown;
  try {
    parsedHeader = JSON.parse(
      new TextDecoder().decode(serialized.slice(headerStart, payloadStart)),
    );
  } catch {
    throw new Error('serialized checkpoint header must be valid JSON');
  }

  const header = validateSerializedCheckpointHeader(parsedHeader);
  const expectedPayloadBytes = computeCheckpointPayloadBytes({
    batchSize: header.metadata.shape[0],
    sequenceLength: header.metadata.shape[1],
    hiddenSize: header.metadata.shape[2],
    dtype: header.metadata.dtype,
  });
  const actualPayloadBytes = serialized.byteLength - payloadStart;
  if (actualPayloadBytes !== expectedPayloadBytes) {
    throw new Error(
      `serialized checkpoint payload length mismatch: expected ${expectedPayloadBytes}, got ${actualPayloadBytes}`,
    );
  }

  return {
    requestId: inferenceRequestId(header.requestId),
    segmentIndex: header.segmentIndex,
    hiddenStates: serialized.slice(payloadStart),
    metadata: header.metadata,
  };
}

export function computeCheckpointPayloadBytes(tensor: CheckpointTensorSpec): number {
  validateCheckpointTensorSpec(tensor);

  const batchSequence = checkedMultiplySafeInteger(
    tensor.batchSize,
    tensor.sequenceLength,
    'checkpoint tensor element count',
  );
  const elementCount = checkedMultiplySafeInteger(
    batchSequence,
    tensor.hiddenSize,
    'checkpoint tensor element count',
  );
  return checkedMultiplySafeInteger(
    elementCount,
    BYTES_PER_DTYPE[tensor.dtype],
    'checkpoint payload byte length',
  );
}

function validateCheckpointTransferMeasurementManifest(
  manifest: CheckpointTransferMeasurementManifest,
): void {
  validateCheckpointPayloadInputs(manifest);
  assertPositiveFiniteNumber(manifest.serializationBytesPerSecond, 'serializationBytesPerSecond');
  assertPositiveFiniteNumber(manifest.deserializationBytesPerSecond, 'deserializationBytesPerSecond');
  assertPositiveFiniteNumber(
    manifest.coordinatorTransferBytesPerSecond,
    'coordinatorTransferBytesPerSecond',
  );
  assertPositiveFiniteNumber(manifest.maxTransferMs, 'maxTransferMs');
  assertNonNegativeSafeInteger(manifest.maxRetries, 'maxRetries');
  assertNonNegativeSafeInteger(manifest.retryBackoffMs, 'retryBackoffMs');

  if (manifest.simulatedFailuresBeforeSuccess !== undefined) {
    assertNonNegativeSafeInteger(
      manifest.simulatedFailuresBeforeSuccess,
      'simulatedFailuresBeforeSuccess',
    );
  }
  if (manifest.expectedCheckpointBytes !== undefined) {
    assertPositiveSafeInteger(manifest.expectedCheckpointBytes, 'expectedCheckpointBytes');
  }
  if (manifest.expectedCheckpointTransferMs !== undefined) {
    assertNonNegativeFiniteNumber(
      manifest.expectedCheckpointTransferMs,
      'expectedCheckpointTransferMs',
    );
  }
}

function validateCheckpointPayloadInputs(
  manifest: Pick<CheckpointTransferMeasurementManifest, 'requestId' | 'segmentIndex' | 'tensor'>,
): void {
  if (typeof manifest.requestId !== 'string' || manifest.requestId.trim().length === 0) {
    throw new Error('requestId must be a non-empty string');
  }
  assertNonNegativeSafeInteger(manifest.segmentIndex, 'segmentIndex');
  validateCheckpointTensorSpec(manifest.tensor);
}

function validateCheckpointTensorSpec(tensor: CheckpointTensorSpec): void {
  if (!tensor || typeof tensor !== 'object') {
    throw new Error('tensor must be an object');
  }
  assertPositiveSafeInteger(tensor.batchSize, 'tensor.batchSize');
  assertPositiveSafeInteger(tensor.sequenceLength, 'tensor.sequenceLength');
  assertPositiveSafeInteger(tensor.hiddenSize, 'tensor.hiddenSize');
  if (!isCheckpointMeasurementDtype(tensor.dtype)) {
    throw new Error(`tensor.dtype must be one of: ${Object.keys(BYTES_PER_DTYPE).join(', ')}`);
  }
}

function validateCheckpointForSerialization(checkpoint: Checkpoint): ReturnType<typeof validateSerializedCheckpointHeader> {
  if (!isRecord(checkpoint)) {
    throw new Error('checkpoint must be an object');
  }
  if (!(checkpoint.hiddenStates instanceof Uint8Array)) {
    throw new Error('checkpoint hiddenStates must be a Uint8Array');
  }

  const header = validateSerializedCheckpointHeader({
    requestId: checkpoint.requestId,
    segmentIndex: checkpoint.segmentIndex,
    metadata: checkpoint.metadata,
  });
  const expectedPayloadBytes = computeCheckpointPayloadBytes({
    batchSize: header.metadata.shape[0],
    sequenceLength: header.metadata.shape[1],
    hiddenSize: header.metadata.shape[2],
    dtype: header.metadata.dtype,
  });
  if (checkpoint.hiddenStates.byteLength !== expectedPayloadBytes) {
    throw new Error(
      `checkpoint payload length mismatch: expected ${expectedPayloadBytes}, got ${checkpoint.hiddenStates.byteLength}`,
    );
  }

  return header;
}

function validateSerializedCheckpointHeader(value: unknown): {
  readonly requestId: string;
  readonly segmentIndex: number;
  readonly metadata: {
    readonly shape: readonly [number, number, number];
    readonly dtype: CheckpointMeasurementDtype;
    readonly sequenceLength: number;
    readonly timestamp: number;
  };
} {
  if (!isRecord(value)) {
    throw new Error('serialized checkpoint header must be an object');
  }

  const requestId = value.requestId;
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new Error('serialized checkpoint requestId must be a non-empty string');
  }

  const segmentIndex = value.segmentIndex;
  assertNonNegativeSafeInteger(segmentIndex, 'serialized checkpoint segmentIndex');

  const metadata = value.metadata;
  if (!isRecord(metadata)) {
    throw new Error('serialized checkpoint metadata must be an object');
  }

  const shape = metadata.shape;
  if (!Array.isArray(shape) || shape.length !== 3) {
    throw new Error('serialized checkpoint metadata.shape must contain exactly 3 dimensions');
  }
  const batchSize = shape[0];
  const sequenceLength = shape[1];
  const hiddenSize = shape[2];
  assertPositiveSafeInteger(batchSize, 'serialized checkpoint metadata.shape[0]');
  assertPositiveSafeInteger(sequenceLength, 'serialized checkpoint metadata.shape[1]');
  assertPositiveSafeInteger(hiddenSize, 'serialized checkpoint metadata.shape[2]');

  const dtype = metadata.dtype;
  if (!isCheckpointMeasurementDtype(dtype)) {
    throw new Error(`serialized checkpoint metadata.dtype must be one of: ${Object.keys(BYTES_PER_DTYPE).join(', ')}`);
  }

  const declaredSequenceLength = metadata.sequenceLength;
  assertPositiveSafeInteger(
    declaredSequenceLength,
    'serialized checkpoint metadata.sequenceLength',
  );
  if (declaredSequenceLength !== sequenceLength) {
    throw new Error('serialized checkpoint metadata.sequenceLength must match metadata.shape[1]');
  }

  const timestamp = metadata.timestamp;
  assertNonNegativeSafeInteger(timestamp, 'serialized checkpoint metadata.timestamp');

  return {
    requestId,
    segmentIndex,
    metadata: {
      shape: [batchSize, sequenceLength, hiddenSize],
      dtype,
      sequenceLength: declaredSequenceLength,
      timestamp,
    },
  };
}

function isCheckpointMeasurementDtype(value: unknown): value is CheckpointMeasurementDtype {
  return value === 'float16' || value === 'float32' || value === 'int8';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertPositiveSafeInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
}

function assertPositiveFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive finite number`);
  }
}

function assertNonNegativeFiniteNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number`);
  }
}

function checkedAddSafeInteger(left: number, right: number, fieldName: string): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new Error(`${fieldName} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return left + right;
}

function checkedMultiplySafeInteger(left: number, right: number, fieldName: string): number {
  if (left !== 0 && right > Math.floor(Number.MAX_SAFE_INTEGER / left)) {
    throw new Error(`${fieldName} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return left * right;
}

function measureCoordinatorTransfer(
  manifest: CheckpointTransferMeasurementManifest,
  serializedBytes: number,
) {
  const failuresBeforeSuccess = manifest.simulatedFailuresBeforeSuccess ?? 0;
  const retryCount = Math.min(failuresBeforeSuccess, manifest.maxRetries);
  const attempts = checkedAddSafeInteger(
    retryCount,
    1,
    'coordinator transfer attempt count',
  );
  const transferMsPerAttempt = ceilDurationMs(
    serializedBytes,
    manifest.coordinatorTransferBytesPerSecond,
  );
  const attemptTransferMs = checkedMultiplySafeInteger(
    attempts,
    transferMsPerAttempt,
    'coordinator transfer attempts duration',
  );
  const retryBackoffTotalMs = checkedMultiplySafeInteger(
    retryCount,
    manifest.retryBackoffMs,
    'coordinator retry backoff duration',
  );
  const observedTransferMs = checkedAddSafeInteger(
    attemptTransferMs,
    retryBackoffTotalMs,
    'coordinator observed transfer duration',
  );

  if (failuresBeforeSuccess > manifest.maxRetries) {
    return {
      observedTransferMs,
      observedThroughputBytesPerSecond: Math.floor((serializedBytes / observedTransferMs) * 1000),
      retryCount,
      failureReason: `coordinator-transfer-retries-exhausted: ${failuresBeforeSuccess} failures exceeds ${manifest.maxRetries} retries`,
    };
  }

  return {
    observedTransferMs,
    observedThroughputBytesPerSecond: Math.floor((serializedBytes / observedTransferMs) * 1000),
    retryCount,
    failureReason: undefined,
  };
}

function compareWithFeasibilityGate(
  manifest: CheckpointTransferMeasurementManifest,
  payloadBytes: number,
  transferEstimateMs: number,
) {
  return {
    expectedCheckpointBytes: manifest.expectedCheckpointBytes,
    expectedCheckpointTransferMs: manifest.expectedCheckpointTransferMs,
    byteDelta: manifest.expectedCheckpointBytes === undefined
      ? undefined
      : payloadBytes - manifest.expectedCheckpointBytes,
    transferMsDelta: manifest.expectedCheckpointTransferMs === undefined
      ? undefined
      : transferEstimateMs - manifest.expectedCheckpointTransferMs,
  };
}

function selectFailureReason(
  transferFailureReason: string | undefined,
  transferEstimateMs: number,
  observedTransferMs: number,
  maxTransferMs: number,
): string | undefined {
  if (transferFailureReason) {
    return transferFailureReason;
  }

  if (transferEstimateMs > maxTransferMs) {
    return `checkpoint-transfer-budget-exceeded: ${transferEstimateMs}ms exceeds ${maxTransferMs}ms`;
  }

  if (observedTransferMs > maxTransferMs) {
    return `coordinator-observed-transfer-budget-exceeded: ${observedTransferMs}ms exceeds ${maxTransferMs}ms`;
  }

  return undefined;
}

function ceilDurationMs(bytes: number, bytesPerSecond: number): number {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    throw new Error('bytesPerSecond must be a positive finite number');
  }

  const durationMs = Math.ceil((bytes / bytesPerSecond) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) {
    throw new Error('checkpoint duration exceeds Number.MAX_SAFE_INTEGER');
  }
  return durationMs;
}
