import { describe, expect, it } from 'vitest';
import {
  createCheckpointPayload,
  createDefaultCheckpointMeasurementManifest,
  deserializeCheckpointPayload,
  serializeCheckpointPayload,
} from '../src/checkpoint-transfer-measurement.js';
import type { Checkpoint } from '../src/types.js';

function createSmallCheckpoint(): Checkpoint {
  const base = createDefaultCheckpointMeasurementManifest();
  return createCheckpointPayload({
    ...base,
    tensor: {
      batchSize: 1,
      sequenceLength: 2,
      hiddenSize: 3,
      dtype: 'int8',
    },
  });
}

// Keep the object a genuine TypedArray while shadowing every property/hook that
// direct property access or subclass-aware copy helpers could otherwise invoke.
function withHostileUint8ArrayHooks(source: Uint8Array): {
  readonly view: Uint8Array;
  readonly hookReads: () => number;
} {
  const view = new Uint8Array(source);
  let reads = 0;
  const fail = () => {
    reads += 1;
    throw new Error('caller-controlled Uint8Array hook must not run');
  };

  Object.defineProperties(view, {
    byteLength: { configurable: true, get: fail },
    byteOffset: { configurable: true, get: fail },
    buffer: { configurable: true, get: fail },
    slice: { configurable: true, value: fail },
  });
  Object.defineProperty(view, Symbol.iterator, {
    configurable: true,
    value: fail,
  });

  return {
    view,
    hookReads: () => reads,
  };
}

describe('checkpoint transfer runtime byte-view boundaries', () => {
  it('fails closed for Proxy-wrapped outbound hidden states', () => {
    const checkpoint = createSmallCheckpoint();
    const proxied = new Proxy(checkpoint.hiddenStates, {}) as Uint8Array;

    expect(() => serializeCheckpointPayload({
      ...checkpoint,
      hiddenStates: proxied,
    })).toThrow('checkpoint hiddenStates must be a Uint8Array');
  });

  it('serializes genuine Uint8Array values without consulting subclass-style hooks', () => {
    const checkpoint = createSmallCheckpoint();
    const hostile = withHostileUint8ArrayHooks(checkpoint.hiddenStates);

    const serialized = serializeCheckpointPayload({
      ...checkpoint,
      hiddenStates: hostile.view,
    });
    const restored = deserializeCheckpointPayload(serialized.bytes);

    expect(hostile.hookReads()).toBe(0);
    expect(serialized.payloadBytes).toBe(6);
    expect([...restored.hiddenStates]).toEqual([...checkpoint.hiddenStates]);
  });

  it('fails closed for Proxy-wrapped serialized checkpoint frames', () => {
    const serialized = serializeCheckpointPayload(createSmallCheckpoint());
    const proxied = new Proxy(serialized.bytes, {}) as Uint8Array;

    expect(() => deserializeCheckpointPayload(proxied)).toThrow(
      'serialized checkpoint must be a Uint8Array',
    );
  });

  it('deserializes genuine Uint8Array frames without consulting subclass-style hooks', () => {
    const checkpoint = createSmallCheckpoint();
    const serialized = serializeCheckpointPayload(checkpoint);
    const hostile = withHostileUint8ArrayHooks(serialized.bytes);

    const restored = deserializeCheckpointPayload(hostile.view);

    expect(hostile.hookReads()).toBe(0);
    expect(restored.requestId).toBe(checkpoint.requestId);
    expect(restored.segmentIndex).toBe(checkpoint.segmentIndex);
    expect(restored.metadata).toEqual(checkpoint.metadata);
    expect([...restored.hiddenStates]).toEqual([...checkpoint.hiddenStates]);
  });
});
