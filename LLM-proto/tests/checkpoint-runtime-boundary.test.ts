import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';

function validCheckpoint() {
  return {
    requestId: 'checkpoint-boundary-request',
    segmentIndex: 0,
    hiddenStates: new Uint8Array([1, 2, 3]),
    metadata: {
      shape: [1, 3, 1],
      dtype: 'uint8',
      sequenceLength: 3,
      timestamp: 123,
    },
  };
}

function hostileThrownValue(calls: { count: number }): object {
  const fail = () => {
    calls.count += 1;
    throw new Error('coercion hook must not run');
  };
  return {
    [Symbol.toPrimitive]: fail,
    valueOf: fail,
    toString: fail,
  };
}

function revokedProxy<T extends object>(target: T): T {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

describe('CheckpointStore runtime trust boundary', () => {
  it('rejects a revoked top-level checkpoint through the stable object diagnostic', () => {
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(revokedProxy({})))
      .toThrow('checkpoint must be a non-null object');
  });

  it('does not coerce hostile values thrown by top-level checkpoint accessors', () => {
    const calls = { count: 0 };
    const checkpoint = validCheckpoint();
    Object.defineProperty(checkpoint, 'requestId', {
      get() {
        throw hostileThrownValue(calls);
      },
    });

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpoint))
      .toThrow('checkpoint requestId must be a non-empty string');
    expect(calls.count).toBe(0);
  });

  it('rejects revoked metadata through the stable metadata diagnostic', () => {
    const checkpoint = validCheckpoint();
    checkpoint.metadata = revokedProxy(checkpoint.metadata);

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpoint))
      .toThrow('checkpoint metadata must be an object');
  });

  it('does not coerce hostile values thrown by metadata accessors', () => {
    const calls = { count: 0 };
    const checkpoint = validCheckpoint();
    Object.defineProperty(checkpoint.metadata, 'dtype', {
      get() {
        throw hostileThrownValue(calls);
      },
    });

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpoint))
      .toThrow('checkpoint metadata.dtype must be a non-empty string');
    expect(calls.count).toBe(0);
  });

  it('bounds revoked and throwing checkpoint shape containers', () => {
    const revokedShape = validCheckpoint();
    revokedShape.metadata.shape = revokedProxy([1, 3, 1]);
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(revokedShape))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');

    const lengthCalls = { count: 0 };
    const lengthFailure = hostileThrownValue(lengthCalls);
    const throwingLength = validCheckpoint();
    throwingLength.metadata.shape = new Proxy([1, 3, 1], {
      get(target, property, receiver) {
        if (property === 'length') throw lengthFailure;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(throwingLength))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');
    expect(lengthCalls.count).toBe(0);

    const indexCalls = { count: 0 };
    const indexFailure = hostileThrownValue(indexCalls);
    const throwingIndex = validCheckpoint();
    throwingIndex.metadata.shape = new Proxy([1, 3, 1], {
      get(target, property, receiver) {
        if (property === '1') throw indexFailure;
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(throwingIndex))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');
    expect(indexCalls.count).toBe(0);
  });

  it('keeps valid checkpoints ownership-isolated', () => {
    const checkpoint = validCheckpoint();
    const snapshot = CheckpointStore.snapshotValidatedCheckpoint(checkpoint);

    checkpoint.hiddenStates[0] = 9;
    checkpoint.metadata.shape[0] = 9;

    expect(snapshot.hiddenStates).toEqual(new Uint8Array([1, 2, 3]));
    expect(snapshot.metadata.shape).toEqual([1, 3, 1]);
    expect(snapshot.metadata.dtype).toBe('uint8');
  });
});
