import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import type { Checkpoint } from '../src/types.js';
import {
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

describe('worker-result checkpoint snapshot boundary', () => {
  it('captures accessor-backed checkpoint identity and payload exactly once', () => {
    const reads: Record<string, number> = {};
    const payload = new Uint8Array([1, 2, 3]);
    const shapeTarget = [1, 3];
    const shape = new Proxy(shapeTarget, {
      get(target, property, receiver) {
        if (property === '0' || property === '1') {
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
      shape: [1, 3],
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
    ]);
  });

  it('isolates SpanPipeline checkpoint payloads from later source mutation', () => {
    const payload = new Uint8Array([4, 5, 6]);
    const shape = [1, 3];
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
      shape: [1, 3],
      dtype: 'float16',
      sequenceLength: 3,
      timestamp: 456,
    });

    const store = new CheckpointStore();
    store.save(owned);
    expect(store.get(owned.requestId, 1)).toEqual(owned);
  });
});
