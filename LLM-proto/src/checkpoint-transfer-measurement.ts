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
  const header = new TextEncoder().encode(JSON.stringify({
    requestId: checkpoint.requestId,
    segmentIndex: checkpoint.segmentIndex,
    metadata: checkpoint.metadata,
  }));
  const bytes = new Uint8Array(4 + header.byteLength + checkpoint.hiddenStates.byteLength);
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
  const headerBytes = new DataView(
    serialized.buffer,
    serialized.byteOffset,
    serialized.byteLength,
  ).getUint32(0, true);
  const headerStart = 4;
  const payloadStart = headerStart + headerBytes;
  const header = JSON.parse(
    new TextDecoder().decode(serialized.slice(headerStart, payloadStart)),
  ) as {
    readonly requestId: string;
    readonly segmentIndex: number;
    readonly metadata: Checkpoint['metadata'];
  };

  return {
    requestId: inferenceRequestId(header.requestId),
    segmentIndex: header.segmentIndex,
    hiddenStates: serialized.slice(payloadStart),
    metadata: header.metadata,
  };
}

export function computeCheckpointPayloadBytes(tensor: CheckpointTensorSpec): number {
  return tensor.batchSize * tensor.sequenceLength * tensor.hiddenSize * BYTES_PER_DTYPE[tensor.dtype];
}

function measureCoordinatorTransfer(
  manifest: CheckpointTransferMeasurementManifest,
  serializedBytes: number,
) {
  const failuresBeforeSuccess = manifest.simulatedFailuresBeforeSuccess ?? 0;
  const retryCount = Math.min(failuresBeforeSuccess, manifest.maxRetries);
  const attempts = retryCount + 1;
  const transferMsPerAttempt = ceilDurationMs(serializedBytes, manifest.coordinatorTransferBytesPerSecond);
  const observedTransferMs = attempts * transferMsPerAttempt + retryCount * manifest.retryBackoffMs;

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
  if (bytesPerSecond <= 0) {
    throw new Error('bytesPerSecond must be greater than 0');
  }

  return Math.ceil((bytes / bytesPerSecond) * 1000);
}
