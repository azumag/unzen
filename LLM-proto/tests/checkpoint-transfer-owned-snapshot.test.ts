import { describe, expect, it } from 'vitest';
import {
  computeCheckpointPayloadBytes,
  createCheckpointPayload,
  measureCheckpointSerializationAndTransfer,
  type CheckpointTensorSpec,
  type CheckpointTransferMeasurementManifest,
} from '../src/checkpoint-transfer-measurement.js';

function onceThen<T>(first: T, second: T): { readonly get: () => T; readonly reads: () => number } {
  let count = 0;
  return {
    get: () => {
      count += 1;
      return count === 1 ? first : second;
    },
    reads: () => count,
  };
}

describe('checkpoint transfer owned input snapshots', () => {
  it('binds measurement validation, allocation, retry analysis, and report fields to one caller snapshot', () => {
    const requestId = onceThen('owned-request', 'drifted-request');
    const segmentIndex = onceThen(4, 99);
    const batchSize = onceThen(1, Number.MAX_SAFE_INTEGER);
    const sequenceLength = onceThen(2, 4096);
    const hiddenSize = onceThen(3, 8192);
    const dtype = onceThen<'int8' | 'float32'>('int8', 'float32');
    const tensor = onceThen<CheckpointTensorSpec>(
      {
        get batchSize() { return batchSize.get(); },
        get sequenceLength() { return sequenceLength.get(); },
        get hiddenSize() { return hiddenSize.get(); },
        get dtype() { return dtype.get(); },
      },
      {
        batchSize: Number.MAX_SAFE_INTEGER,
        sequenceLength: Number.MAX_SAFE_INTEGER,
        hiddenSize: Number.MAX_SAFE_INTEGER,
        dtype: 'float32',
      },
    );
    const serializationBytesPerSecond = onceThen(1_000_000, Number.NaN);
    const deserializationBytesPerSecond = onceThen(1_000_000, Number.NaN);
    const coordinatorTransferBytesPerSecond = onceThen(1_000_000, Number.NaN);
    const maxTransferMs = onceThen(1_000, 0);
    const maxRetries = onceThen(2, -1);
    const retryBackoffMs = onceThen(5, -1);
    const simulatedFailuresBeforeSuccess = onceThen(1, 99);
    const expectedCheckpointBytes = onceThen(6, 999);
    const expectedCheckpointTransferMs = onceThen(1, 999);

    const manifest = {
      get requestId() { return requestId.get(); },
      get segmentIndex() { return segmentIndex.get(); },
      get tensor() { return tensor.get(); },
      get serializationBytesPerSecond() { return serializationBytesPerSecond.get(); },
      get deserializationBytesPerSecond() { return deserializationBytesPerSecond.get(); },
      get coordinatorTransferBytesPerSecond() { return coordinatorTransferBytesPerSecond.get(); },
      get maxTransferMs() { return maxTransferMs.get(); },
      get maxRetries() { return maxRetries.get(); },
      get retryBackoffMs() { return retryBackoffMs.get(); },
      get simulatedFailuresBeforeSuccess() { return simulatedFailuresBeforeSuccess.get(); },
      get expectedCheckpointBytes() { return expectedCheckpointBytes.get(); },
      get expectedCheckpointTransferMs() { return expectedCheckpointTransferMs.get(); },
    } as CheckpointTransferMeasurementManifest;

    const report = measureCheckpointSerializationAndTransfer(manifest);

    expect(report.requestId).toBe('owned-request');
    expect(report.tensorShape).toEqual([1, 2, 3]);
    expect(report.dtype).toBe('int8');
    expect(report.payloadBytes).toBe(6);
    expect(report.retryCount).toBe(1);
    expect(report.comparison.expectedCheckpointBytes).toBe(6);
    expect(report.comparison.expectedCheckpointTransferMs).toBe(1);
    expect(report.comparison.byteDelta).toBe(0);

    for (const counter of [
      requestId,
      segmentIndex,
      tensor,
      batchSize,
      sequenceLength,
      hiddenSize,
      dtype,
      serializationBytesPerSecond,
      deserializationBytesPerSecond,
      coordinatorTransferBytesPerSecond,
      maxTransferMs,
      maxRetries,
      retryBackoffMs,
      simulatedFailuresBeforeSuccess,
      expectedCheckpointBytes,
      expectedCheckpointTransferMs,
    ]) {
      expect(counter.reads()).toBe(1);
    }
  });

  it('uses the tensor geometry and identity that passed payload validation for allocation and metadata', () => {
    const requestId = onceThen('payload-request', 'changed-request');
    const segmentIndex = onceThen(7, 250);
    const batchSize = onceThen(1, Number.MAX_SAFE_INTEGER);
    const sequenceLength = onceThen(2, Number.MAX_SAFE_INTEGER);
    const hiddenSize = onceThen(3, Number.MAX_SAFE_INTEGER);
    const dtype = onceThen<'int8' | 'float32'>('int8', 'float32');
    const tensor = onceThen<CheckpointTensorSpec>(
      {
        get batchSize() { return batchSize.get(); },
        get sequenceLength() { return sequenceLength.get(); },
        get hiddenSize() { return hiddenSize.get(); },
        get dtype() { return dtype.get(); },
      },
      {
        batchSize: Number.MAX_SAFE_INTEGER,
        sequenceLength: Number.MAX_SAFE_INTEGER,
        hiddenSize: Number.MAX_SAFE_INTEGER,
        dtype: 'float32',
      },
    );

    const checkpoint = createCheckpointPayload({
      get requestId() { return requestId.get(); },
      get segmentIndex() { return segmentIndex.get(); },
      get tensor() { return tensor.get(); },
    } as CheckpointTransferMeasurementManifest);

    expect(checkpoint.requestId).toBe('payload-request');
    expect(checkpoint.segmentIndex).toBe(7);
    expect(checkpoint.hiddenStates.byteLength).toBe(6);
    expect(checkpoint.metadata.shape).toEqual([1, 2, 3]);
    expect(checkpoint.metadata.dtype).toBe('int8');
    expect(checkpoint.metadata.sequenceLength).toBe(2);
    expect([...checkpoint.hiddenStates]).toEqual([7, 38, 69, 100, 131, 162]);

    for (const counter of [requestId, segmentIndex, tensor, batchSize, sequenceLength, hiddenSize, dtype]) {
      expect(counter.reads()).toBe(1);
    }
  });

  it('does not enumerate caller-owned manifests and reads public tensor byte inputs once', () => {
    const base: CheckpointTransferMeasurementManifest = {
      requestId: 'proxy-request',
      segmentIndex: 0,
      tensor: {
        batchSize: 1,
        sequenceLength: 1,
        hiddenSize: 4,
        dtype: 'int8',
      },
      serializationBytesPerSecond: 1_000_000,
      deserializationBytesPerSecond: 1_000_000,
      coordinatorTransferBytesPerSecond: 1_000_000,
      maxTransferMs: 1_000,
      maxRetries: 0,
      retryBackoffMs: 0,
    };
    const manifest = new Proxy(base, {
      ownKeys() {
        throw new Error('caller manifest must not be enumerated');
      },
    });

    expect(() => measureCheckpointSerializationAndTransfer(manifest)).not.toThrow();

    const batchSize = onceThen(1, Number.MAX_SAFE_INTEGER);
    const sequenceLength = onceThen(2, Number.MAX_SAFE_INTEGER);
    const hiddenSize = onceThen(3, Number.MAX_SAFE_INTEGER);
    const dtype = onceThen<'int8' | 'float32'>('int8', 'float32');
    const tensorSpec = {
      get batchSize() { return batchSize.get(); },
      get sequenceLength() { return sequenceLength.get(); },
      get hiddenSize() { return hiddenSize.get(); },
      get dtype() { return dtype.get(); },
    } as CheckpointTensorSpec;

    expect(computeCheckpointPayloadBytes(tensorSpec)).toBe(6);
    expect(batchSize.reads()).toBe(1);
    expect(sequenceLength.reads()).toBe(1);
    expect(hiddenSize.reads()).toBe(1);
    expect(dtype.reads()).toBe(1);
  });
});
