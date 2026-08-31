import { describe, it, expect, beforeEach } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { inferenceRequestId } from '../src/types.js';
import type { Checkpoint, InferenceRequestId } from '../src/types.js';

function makeCheckpoint(
  requestId: InferenceRequestId,
  segmentIndex: number,
): Checkpoint {
  return {
    requestId,
    segmentIndex,
    hiddenStates: new Uint8Array([1, 2, 3, 4]),
    metadata: {
      shape: [1, 128, 4096],
      dtype: 'float16',
      sequenceLength: 128,
      timestamp: Date.now(),
    },
  };
}

describe('CheckpointStore', () => {
  let store: CheckpointStore;
  const reqId = inferenceRequestId('req-1');

  beforeEach(() => {
    store = new CheckpointStore();
  });

  it('should start empty', () => {
    expect(store.size).toBe(0);
  });

  it('should save and retrieve a checkpoint', () => {
    const cp = makeCheckpoint(reqId, 0);
    store.save(cp);

    expect(store.size).toBe(1);
    expect(store.get(reqId, 0)).toBe(cp);
  });

  it('should return undefined for non-existent checkpoint', () => {
    expect(store.get(reqId, 0)).toBeUndefined();
  });

  it('should store multiple checkpoints for the same request', () => {
    const cp0 = makeCheckpoint(reqId, 0);
    const cp1 = makeCheckpoint(reqId, 1);
    const cp2 = makeCheckpoint(reqId, 2);

    store.save(cp0);
    store.save(cp1);
    store.save(cp2);

    expect(store.size).toBe(3);
    expect(store.get(reqId, 0)).toBe(cp0);
    expect(store.get(reqId, 1)).toBe(cp1);
    expect(store.get(reqId, 2)).toBe(cp2);
  });

  it('should overwrite checkpoint for same request+segment', () => {
    const cp1 = makeCheckpoint(reqId, 0);
    const cp2 = makeCheckpoint(reqId, 0);

    store.save(cp1);
    store.save(cp2);

    expect(store.size).toBe(1);
    expect(store.get(reqId, 0)).toBe(cp2);
  });

  it('should isolate checkpoints between different requests', () => {
    const reqId2 = inferenceRequestId('req-2');
    const cp1 = makeCheckpoint(reqId, 0);
    const cp2 = makeCheckpoint(reqId2, 0);

    store.save(cp1);
    store.save(cp2);

    expect(store.get(reqId, 0)).toBe(cp1);
    expect(store.get(reqId2, 0)).toBe(cp2);
  });

  describe('latest', () => {
    it('returns the highest completed segment regardless of insertion order', () => {
      const cp3 = makeCheckpoint(reqId, 3);
      store.save(cp3);
      store.save(makeCheckpoint(reqId, 0));
      store.save(makeCheckpoint(reqId, 2));

      expect(store.latest(reqId)).toBe(cp3);
    });

    it('can stop at a durable upper boundary', () => {
      const cp1 = makeCheckpoint(reqId, 1);
      store.save(cp1);
      store.save(makeCheckpoint(reqId, 4));
      store.save(makeCheckpoint(reqId, 2));

      expect(store.latest(reqId, 1)).toBe(cp1);
      expect(store.latest(reqId, -1)).toBeUndefined();
    });

    it('does not return another request checkpoint', () => {
      const other = inferenceRequestId('req-other');
      store.save(makeCheckpoint(other, 5));

      expect(store.latest(reqId)).toBeUndefined();
    });

    it('rejects a non-integer upper boundary', () => {
      expect(() => store.latest(reqId, 1.5)).toThrow(/integer/);
    });
  });

  describe('deleteAll', () => {
    it('should remove all checkpoints for a request', () => {
      store.save(makeCheckpoint(reqId, 0));
      store.save(makeCheckpoint(reqId, 1));
      store.save(makeCheckpoint(reqId, 2));

      store.deleteAll(reqId);

      expect(store.size).toBe(0);
      expect(store.get(reqId, 0)).toBeUndefined();
    });

    it('should not affect other requests', () => {
      const reqId2 = inferenceRequestId('req-2');
      store.save(makeCheckpoint(reqId, 0));
      store.save(makeCheckpoint(reqId2, 0));

      store.deleteAll(reqId);

      expect(store.size).toBe(1);
      expect(store.get(reqId2, 0)).toBeDefined();
    });

    it('should be safe to call on non-existent request', () => {
      store.deleteAll(inferenceRequestId('nonexistent'));
      expect(store.size).toBe(0);
    });
  });
});
