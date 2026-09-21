import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { snapshotSegmentResultRoot } from '../src/worker-result-root-snapshot.js';

function checkpointWithShape(shape: unknown): Record<string, unknown> {
  return {
    requestId: 'shape-boundary-request',
    segmentIndex: 0,
    hiddenStates: new Uint8Array([1, 2, 3]),
    metadata: {
      shape,
      dtype: 'int8',
      sequenceLength: 1,
      timestamp: 1,
    },
  };
}

function shapeWithReportedLength(length: number): unknown[] {
  return new Proxy([1, 1, 3], {
    get(target, property, receiver) {
      if (property === 'length') return length;
      return Reflect.get(target, property, receiver);
    },
  });
}

describe('checkpoint shape runtime boundary', () => {
  it.each([
    [[1]],
    [[1, 2]],
    [[1, 2, 3, 4]],
  ])('rejects non-three-dimensional checkpoint shape %j', (shape) => {
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpointWithShape(shape)))
      .toThrow('checkpoint metadata.shape must contain exactly 3 dimensions');
  });

  it('preserves the established empty-shape validation error', () => {
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpointWithShape([])))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');
  });

  it('rejects a hostile direct shape length before native array allocation', () => {
    const shape = shapeWithReportedLength(2 ** 32);

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpointWithShape(shape)))
      .toThrow('checkpoint metadata.shape must contain exactly 3 dimensions');
  });

  it('bounds worker-result shape capture before checkpoint validation', () => {
    const shape = shapeWithReportedLength(2 ** 32);
    const snapshot = snapshotSegmentResultRoot({
      requestId: 'shape-boundary-request',
      segmentIndex: 0,
      workerId: 'shape-boundary-worker',
      processingTimeMs: 1,
      checkpoint: checkpointWithShape(shape),
      output: undefined,
    });

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(snapshot.checkpoint))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');
  });

  it('copies only the canonical three dimensions from a valid Proxy-backed shape', () => {
    let lengthReads = 0;
    let memberReads = 0;
    const shape = new Proxy([1, 2, 3], {
      get(target, property, receiver) {
        if (property === 'length') lengthReads += 1;
        if (property === '0' || property === '1' || property === '2') memberReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const snapshot = snapshotSegmentResultRoot({
      requestId: 'shape-boundary-request',
      segmentIndex: 0,
      workerId: 'shape-boundary-worker',
      processingTimeMs: 1,
      checkpoint: checkpointWithShape(shape),
      output: undefined,
    });

    const owned = CheckpointStore.snapshotValidatedCheckpoint(snapshot.checkpoint);

    expect(owned.metadata.shape).toEqual([1, 2, 3]);
    expect(lengthReads).toBe(1);
    expect(memberReads).toBe(3);
  });

  it('fails closed on a revoked shape Proxy instead of leaking Array.isArray errors', () => {
    const revoked = Proxy.revocable([1, 1, 3], {});
    revoked.revoke();
    const snapshot = snapshotSegmentResultRoot({
      requestId: 'shape-boundary-request',
      segmentIndex: 0,
      workerId: 'shape-boundary-worker',
      processingTimeMs: 1,
      checkpoint: checkpointWithShape(revoked.proxy),
      output: undefined,
    });

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(snapshot.checkpoint))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');
  });

  it('fails closed on throwing shape length and numeric-index traps', () => {
    const hostileLength = new Proxy([1, 1, 3], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('hostile shape length');
        return Reflect.get(target, property, receiver);
      },
    });
    const lengthSnapshot = snapshotSegmentResultRoot({
      requestId: 'shape-boundary-request',
      segmentIndex: 0,
      workerId: 'shape-boundary-worker',
      processingTimeMs: 1,
      checkpoint: checkpointWithShape(hostileLength),
      output: undefined,
    });
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(lengthSnapshot.checkpoint))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');

    const hostileIndex = new Proxy([1, 1, 3], {
      get(target, property, receiver) {
        if (property === '1') throw new Error('hostile shape index');
        return Reflect.get(target, property, receiver);
      },
    });
    const indexSnapshot = snapshotSegmentResultRoot({
      requestId: 'shape-boundary-request',
      segmentIndex: 0,
      workerId: 'shape-boundary-worker',
      processingTimeMs: 1,
      checkpoint: checkpointWithShape(hostileIndex),
      output: undefined,
    });
    expect(() => CheckpointStore.snapshotValidatedCheckpoint(indexSnapshot.checkpoint))
      .toThrow('checkpoint metadata.shape must contain positive safe integers');
  });
});
