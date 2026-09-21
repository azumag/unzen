import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import type { Checkpoint } from '../src/types.js';
import {
  isWorkerResultRecord,
  snapshotSegmentResultRoot,
  snapshotSpanResultRoot,
} from '../src/worker-result-root-snapshot.js';

function bump(reads: Record<string, number>, field: string): number {
  reads[field] = (reads[field] ?? 0) + 1;
  return reads[field];
}

function expectSingleReads(reads: Record<string, number>, fields: readonly string[]): void {
  for (const field of fields) {
    expect(reads[field], `${field} read count`).toBe(1);
  }
}

function validMetadata() {
  return {
    shape: [1, 1, 3],
    dtype: 'float16',
    sequenceLength: 3,
    timestamp: 123,
  };
}

function hostileThrownValue() {
  const hooks = { toString: 0, primitive: 0 };
  return {
    hooks,
    value: {
      toString() {
        hooks.toString += 1;
        throw new Error('hostile toString must not run');
      },
      [Symbol.toPrimitive]() {
        hooks.primitive += 1;
        throw new Error('hostile primitive conversion must not run');
      },
    },
  };
}

describe('worker-result checkpoint snapshot boundary', () => {
  it('captures accessor-backed checkpoint identity and payload exactly once', () => {
    const reads: Record<string, number> = {};
    const payload = new Uint8Array([1, 2, 3]);
    const shapeTarget = [1, 1, 3];
    const shape = new Proxy(shapeTarget, {
      get(target, property, receiver) {
        if (property === '0' || property === '1' || property === '2') {
          const read = bump(reads, `shape.${String(property)}`);
          return read === 1 ? Reflect.get(target, property, receiver) : 999;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const metadata = {
      get shape() {
        bump(reads, 'metadata.shape');
        return shape;
      },
      get dtype() {
        return bump(reads, 'metadata.dtype') === 1 ? 'float16' : '';
      },
      get sequenceLength() {
        return bump(reads, 'metadata.sequenceLength') === 1 ? 3 : -1;
      },
      get timestamp() {
        return bump(reads, 'metadata.timestamp') === 1 ? 123 : -1;
      },
    };
    const checkpoint = {
      get requestId() {
        return bump(reads, 'checkpoint.requestId') === 1 ? 'req-checkpoint-once' : 'changed';
      },
      get segmentIndex() {
        return bump(reads, 'checkpoint.segmentIndex') === 1 ? 0 : 99;
      },
      get hiddenStates() {
        return bump(reads, 'checkpoint.hiddenStates') === 1
          ? payload
          : new Uint8Array([9]);
      },
      get metadata() {
        bump(reads, 'checkpoint.metadata');
        return metadata;
      },
    };

    const snapshot = snapshotSegmentResultRoot({
      requestId: 'req-checkpoint-once',
      segmentIndex: 0,
      workerId: 'worker-1',
      processingTimeMs: 1,
      checkpoint,
      output: undefined,
    });

    CheckpointStore.assertValidCheckpoint(snapshot.checkpoint);
    const owned = snapshot.checkpoint as Checkpoint;
    expect(owned.requestId).toBe('req-checkpoint-once');
    expect(owned.segmentIndex).toBe(0);
    expect([...owned.hiddenStates]).toEqual([1, 2, 3]);
    expect(owned.metadata).toEqual({
      shape: [1, 1, 3],
      dtype: 'float16',
      sequenceLength: 3,
      timestamp: 123,
    });
    expectSingleReads(reads, [
      'checkpoint.requestId',
      'checkpoint.segmentIndex',
      'checkpoint.hiddenStates',
      'checkpoint.metadata',
      'metadata.shape',
      'metadata.dtype',
      'metadata.sequenceLength',
      'metadata.timestamp',
      'shape.0',
      'shape.1',
      'shape.2',
    ]);
  });

  it('isolates SpanPipeline checkpoint payloads from later source mutation', () => {
    const payload = new Uint8Array([4, 5, 6]);
    const shape = [1, 1, 3];
    const metadata = {
      shape,
      dtype: 'float16',
      sequenceLength: 3,
      timestamp: 456,
    };
    const checkpoint = {
      requestId: 'req-checkpoint-owned',
      segmentIndex: 1,
      hiddenStates: payload,
      metadata,
    };

    const snapshot = snapshotSpanResultRoot({
      requestId: 'req-checkpoint-owned',
      workerId: 'worker-2',
      startSegment: 0,
      endSegment: 1,
      processingTimeMs: 1,
      checkpoint,
      output: undefined,
    });
    CheckpointStore.assertValidCheckpoint(snapshot.checkpoint);
    const owned = snapshot.checkpoint as Checkpoint;

    payload[0] = 99;
    shape[0] = 99;
    metadata.dtype = 'mutated';
    checkpoint.requestId = 'mutated-request';
    checkpoint.segmentIndex = 99;

    expect(owned.requestId).toBe('req-checkpoint-owned');
    expect(owned.segmentIndex).toBe(1);
    expect([...owned.hiddenStates]).toEqual([4, 5, 6]);
    expect(owned.metadata).toEqual({
      shape: [1, 1, 3],
      dtype: 'float16',
      sequenceLength: 3,
      timestamp: 456,
    });

    const store = new CheckpointStore();
    store.save(owned);
    expect(store.get(owned.requestId, 1)).toEqual(owned);
  });

  it('fails closed for Proxy-wrapped Uint8Array payloads without leaking native errors', () => {
    const payload = new Proxy(new Uint8Array([1, 2, 3]), {});
    const checkpoint = {
      requestId: 'req-proxy-payload',
      segmentIndex: 0,
      hiddenStates: payload,
      metadata: validMetadata(),
    };

    const snapshot = snapshotSegmentResultRoot({
      requestId: 'req-proxy-payload',
      segmentIndex: 0,
      workerId: 'worker-proxy',
      processingTimeMs: 1,
      checkpoint,
      output: undefined,
    });

    expect(() => CheckpointStore.assertValidCheckpoint(snapshot.checkpoint)).toThrow(
      'checkpoint hiddenStates must be a non-empty Uint8Array',
    );
  });

  it('copies genuine Uint8Array subclasses without caller-defined byte hooks', () => {
    class HostileUint8Array extends Uint8Array {}
    const payload = new HostileUint8Array([7, 8, 9]);
    const hooks = { byteLength: 0, slice: 0, iterator: 0 };

    Object.defineProperties(payload, {
      byteLength: {
        configurable: true,
        get() {
          hooks.byteLength += 1;
          return 999;
        },
      },
      slice: {
        configurable: true,
        value() {
          hooks.slice += 1;
          throw new Error('hostile slice must not run');
        },
      },
      [Symbol.iterator]: {
        configurable: true,
        value() {
          hooks.iterator += 1;
          throw new Error('hostile iterator must not run');
        },
      },
    });

    const snapshot = snapshotSpanResultRoot({
      requestId: 'req-hostile-subclass',
      workerId: 'worker-hostile',
      startSegment: 0,
      endSegment: 1,
      processingTimeMs: 1,
      checkpoint: {
        requestId: 'req-hostile-subclass',
        segmentIndex: 1,
        hiddenStates: payload,
        metadata: validMetadata(),
      },
      output: undefined,
    });

    CheckpointStore.assertValidCheckpoint(snapshot.checkpoint);
    const owned = (snapshot.checkpoint as Checkpoint).hiddenStates;
    expect(owned.constructor).toBe(Uint8Array);
    expect([...owned]).toEqual([7, 8, 9]);
    expect(hooks).toEqual({ byteLength: 0, slice: 0, iterator: 0 });
  });

  it('fails closed on revoked worker-result roots without leaking native Proxy errors', () => {
    const { proxy, revoke } = Proxy.revocable({ requestId: 'revoked' }, {});
    revoke();

    expect(isWorkerResultRecord(proxy)).toBe(false);
    expect(() => snapshotSegmentResultRoot(proxy)).not.toThrow();
    expect(() => snapshotSpanResultRoot(proxy)).not.toThrow();

    const segment = snapshotSegmentResultRoot(proxy);
    const span = snapshotSpanResultRoot(proxy);
    expect(typeof segment.requestId).not.toBe('string');
    expect(typeof span.requestId).not.toBe('string');
  });

  it.each([
    'requestId',
    'segmentIndex',
    'workerId',
    'processingTimeMs',
    'checkpoint',
    'output',
  ] as const)('bounds throwing SegmentResult root getter %s without inspecting the thrown value', (field) => {
    const hostile = hostileThrownValue();
    const result: Record<string, unknown> = {
      requestId: 'root-request',
      segmentIndex: 0,
      workerId: 'root-worker',
      processingTimeMs: 1,
      checkpoint: undefined,
      output: undefined,
    };
    Object.defineProperty(result, field, {
      enumerable: true,
      get() {
        throw hostile.value;
      },
    });

    expect(() => snapshotSegmentResultRoot(result)).not.toThrow();
    expect(hostile.hooks).toEqual({ toString: 0, primitive: 0 });
  });

  it.each([
    'requestId',
    'workerId',
    'startSegment',
    'endSegment',
    'processingTimeMs',
    'checkpoint',
    'output',
  ] as const)('bounds throwing SpanResult root getter %s without inspecting the thrown value', (field) => {
    const hostile = hostileThrownValue();
    const result: Record<string, unknown> = {
      requestId: 'span-root-request',
      workerId: 'span-root-worker',
      startSegment: 0,
      endSegment: 1,
      processingTimeMs: 1,
      checkpoint: undefined,
      output: undefined,
    };
    Object.defineProperty(result, field, {
      enumerable: true,
      get() {
        throw hostile.value;
      },
    });

    expect(() => snapshotSpanResultRoot(result)).not.toThrow();
    expect(hostile.hooks).toEqual({ toString: 0, primitive: 0 });
  });

  it('fails closed on revoked checkpoint and metadata records through checkpoint validation', () => {
    const revokedCheckpoint = Proxy.revocable({ requestId: 'x' }, {});
    revokedCheckpoint.revoke();
    const checkpointSnapshot = snapshotSegmentResultRoot({
      requestId: 'req-revoked-checkpoint',
      segmentIndex: 0,
      workerId: 'worker-revoked',
      processingTimeMs: 1,
      checkpoint: revokedCheckpoint.proxy,
      output: undefined,
    });
    expect(() => CheckpointStore.assertValidCheckpoint(checkpointSnapshot.checkpoint)).toThrow();

    const revokedMetadata = Proxy.revocable(validMetadata(), {});
    revokedMetadata.revoke();
    const metadataSnapshot = snapshotSpanResultRoot({
      requestId: 'req-revoked-metadata',
      workerId: 'worker-revoked',
      startSegment: 0,
      endSegment: 0,
      processingTimeMs: 1,
      checkpoint: {
        requestId: 'req-revoked-metadata',
        segmentIndex: 0,
        hiddenStates: new Uint8Array([1]),
        metadata: revokedMetadata.proxy,
      },
      output: undefined,
    });
    expect(() => CheckpointStore.assertValidCheckpoint(metadataSnapshot.checkpoint)).toThrow();
  });

  it('memoizes throwing checkpoint accessors and leaves nested fields lazy', () => {
    const reads: Record<string, number> = {};
    const hostile = hostileThrownValue();
    const checkpoint = {
      get requestId() {
        bump(reads, 'checkpoint.requestId');
        throw hostile.value;
      },
      get segmentIndex() {
        bump(reads, 'checkpoint.segmentIndex');
        return 0;
      },
      get hiddenStates() {
        bump(reads, 'checkpoint.hiddenStates');
        return new Uint8Array([1]);
      },
      get metadata() {
        bump(reads, 'checkpoint.metadata');
        return validMetadata();
      },
    };

    const snapshot = snapshotSegmentResultRoot({
      requestId: 'req-lazy-checkpoint',
      segmentIndex: 0,
      workerId: 'worker-lazy',
      processingTimeMs: 1,
      checkpoint,
      output: undefined,
    });

    expect(reads).toEqual({});
    const captured = snapshot.checkpoint as Record<string, unknown>;
    expect(captured.requestId).toBe(captured.requestId);
    expect(reads['checkpoint.requestId']).toBe(1);
    expect(reads['checkpoint.segmentIndex']).toBeUndefined();
    expect(reads['checkpoint.hiddenStates']).toBeUndefined();
    expect(reads['checkpoint.metadata']).toBeUndefined();
    expect(hostile.hooks).toEqual({ toString: 0, primitive: 0 });
  });
});
