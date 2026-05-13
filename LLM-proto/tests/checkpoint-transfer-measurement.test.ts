import { describe, expect, it } from 'vitest';
import {
  createCheckpointPayload,
  createDefaultCheckpointMeasurementManifest,
  deserializeCheckpointPayload,
  measureCheckpointSerializationAndTransfer,
  serializeCheckpointPayload,
  type CheckpointTransferMeasurementManifest,
} from '../src/checkpoint-transfer-measurement.js';

describe('checkpoint serialization and transfer measurement gate', () => {
  it('reports payload size, serialization timing, transfer timing, and feasibility comparison', () => {
    const report = measureCheckpointSerializationAndTransfer(createDefaultCheckpointMeasurementManifest());

    expect(report.status).toBe('pass');
    expect(report.tensorShape).toEqual([1, 512, 6656]);
    expect(report.dtype).toBe('float16');
    expect(report.payloadBytes).toBe(6_815_744);
    expect(report.serializationMs).toBe(13);
    expect(report.deserializationMs).toBe(9);
    expect(report.transferEstimateMs).toBe(407);
    expect(report.observedTransferMs).toBe(407);
    expect(report.retryCount).toBe(0);
    expect(report.failureReason).toBeUndefined();
    expect(report.comparison).toMatchObject({
      expectedCheckpointBytes: 6_815_744,
      expectedCheckpointTransferMs: 407,
      byteDelta: 0,
      transferMsDelta: 0,
    });
    expect(report.serializedBytes).toBeGreaterThan(report.payloadBytes);
    expect(report.observedThroughputBytesPerSecond).toBeGreaterThan(16_000_000);
  });

  it('round-trips generated hidden-state payloads with metadata intact', () => {
    const manifest = createDefaultCheckpointMeasurementManifest();
    const checkpoint = createCheckpointPayload(manifest);
    const serialized = serializeCheckpointPayload(checkpoint);
    const restored = deserializeCheckpointPayload(serialized.bytes);

    expect(serialized.payloadBytes).toBe(checkpoint.hiddenStates.byteLength);
    expect(serialized.headerBytes).toBeGreaterThan(0);
    expect(restored.requestId).toBe(checkpoint.requestId);
    expect(restored.segmentIndex).toBe(3);
    expect(restored.metadata).toEqual(checkpoint.metadata);
    expect(restored.hiddenStates.byteLength).toBe(checkpoint.hiddenStates.byteLength);
    expect([...restored.hiddenStates.slice(0, 8)]).toEqual([...checkpoint.hiddenStates.slice(0, 8)]);
  });

  it('returns a failure reason when coordinator transfer is over the scale-up budget', () => {
    const base = createDefaultCheckpointMeasurementManifest();
    const manifest: CheckpointTransferMeasurementManifest = {
      ...base,
      coordinatorTransferBytesPerSecond: 2 * 1024 * 1024,
      maxTransferMs: 750,
    };

    const report = measureCheckpointSerializationAndTransfer(manifest);

    expect(report.status).toBe('fail');
    expect(report.transferEstimateMs).toBe(3250);
    expect(report.failureReason).toBe(
      'checkpoint-transfer-budget-exceeded: 3250ms exceeds 750ms',
    );
    expect(report.comparison.transferMsDelta).toBe(2843);
  });

  it('reports retry exhaustion separately from transfer budget failures', () => {
    const base = createDefaultCheckpointMeasurementManifest();
    const manifest: CheckpointTransferMeasurementManifest = {
      ...base,
      maxRetries: 1,
      retryBackoffMs: 50,
      simulatedFailuresBeforeSuccess: 2,
    };

    const report = measureCheckpointSerializationAndTransfer(manifest);

    expect(report.status).toBe('fail');
    expect(report.retryCount).toBe(1);
    expect(report.observedTransferMs).toBe(864);
    expect(report.failureReason).toBe(
      'coordinator-transfer-retries-exhausted: 2 failures exceeds 1 retries',
    );
  });

  it('fails when retries succeed but observed transfer time exceeds the budget', () => {
    const base = createDefaultCheckpointMeasurementManifest();
    const manifest: CheckpointTransferMeasurementManifest = {
      ...base,
      maxRetries: 2,
      retryBackoffMs: 50,
      simulatedFailuresBeforeSuccess: 1,
    };

    const report = measureCheckpointSerializationAndTransfer(manifest);

    expect(report.status).toBe('fail');
    expect(report.retryCount).toBe(1);
    expect(report.observedTransferMs).toBe(864);
    expect(report.failureReason).toBe(
      'coordinator-observed-transfer-budget-exceeded: 864ms exceeds 750ms',
    );
  });
});
