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

  it('should save and retrieve an ownership-isolated checkpoint snapshot', () => {
    const cp = makeCheckpoint(reqId, 0);
    store.save(cp);

    const stored = store.get(reqId, 0);
    expect(store.size).toBe(1);
    expect(stored).toEqual(cp);
    expect(stored).not.toBe(cp);
    expect(stored?.hiddenStates).not.toBe(cp.hiddenStates);
    expect(stored?.metadata).not.toBe(cp.metadata);
    expect(stored?.metadata.shape).not.toBe(cp.metadata.shape);
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
    expect(store.get(reqId, 0)).toEqual(cp0);
    expect(store.get(reqId, 1)).toEqual(cp1);
    expect(store.get(reqId, 2)).toEqual(cp2);
  });

  it('should overwrite checkpoint for same request+segment', () => {
    const cp1 = makeCheckpoint(reqId, 0);
    const cp2 = makeCheckpoint(reqId, 0);
    cp2.hiddenStates[0] = 9;

    store.save(cp1);
    store.save(cp2);

    expect(store.size).toBe(1);
    expect(store.get(reqId, 0)).toEqual(cp2);
  });

  it('should isolate checkpoints between different requests', () => {
    const reqId2 = inferenceRequestId('req-2');
    const cp1 = makeCheckpoint(reqId, 0);
    const cp2 = makeCheckpoint(reqId2, 0);

    store.save(cp1);
    store.save(cp2);

    expect(store.get(reqId, 0)).toEqual(cp1);
    expect(store.get(reqId2, 0)).toEqual(cp2);
  });

  describe('validation', () => {
    it('rejects empty hidden states before mutating the store', () => {
      const checkpoint: Checkpoint = {
        ...makeCheckpoint(reqId, 0),
        hiddenStates: new Uint8Array(),
      };

      expect(() => store.save(checkpoint)).toThrow(/non-empty Uint8Array/);
      expect(store.size).toBe(0);
    });

    it('rejects non-Uint8Array hidden states before mutating the store', () => {
      const checkpoint = {
        ...makeCheckpoint(reqId, 0),
        hiddenStates: [1, 2, 3],
      } as unknown as Checkpoint;

      expect(() => store.save(checkpoint)).toThrow(/non-empty Uint8Array/);
      expect(store.size).toBe(0);
    });

    it('rejects malformed tensor shape before mutating the store', () => {
      const base = makeCheckpoint(reqId, 0);
      const checkpoint: Checkpoint = {
        ...base,
        metadata: {
          ...base.metadata,
          shape: [1, 0, 4096],
        },
      };

      expect(() => store.save(checkpoint)).toThrow(/positive safe integers/);
      expect(store.size).toBe(0);
    });

    it('rejects blank dtype before mutating the store', () => {
      const base = makeCheckpoint(reqId, 0);
      const checkpoint: Checkpoint = {
        ...base,
        metadata: {
          ...base.metadata,
          dtype: '   ',
        },
      };

      expect(() => store.save(checkpoint)).toThrow(/non-empty string/);
      expect(store.size).toBe(0);
    });

    it('rejects invalid sequence length before mutating the store', () => {
      const base = makeCheckpoint(reqId, 0);
      const checkpoint: Checkpoint = {
        ...base,
        metadata: {
          ...base.metadata,
          sequenceLength: Number.NaN,
        },
      };

      expect(() => store.save(checkpoint)).toThrow(/sequenceLength/);
      expect(store.size).toBe(0);
    });

    it('rejects invalid timestamp before mutating the store', () => {
      const base = makeCheckpoint(reqId, 0);
      const checkpoint: Checkpoint = {
        ...base,
        metadata: {
          ...base.metadata,
          timestamp: -1,
        },
      };

      expect(() => store.save(checkpoint)).toThrow(/timestamp/);
      expect(store.size).toBe(0);
    });
  });

  describe('snapshot isolation', () => {
    it('does not let caller-owned input mutate a saved resume point', () => {
      const checkpoint = makeCheckpoint(reqId, 0);
      store.save(checkpoint);

      checkpoint.hiddenStates[0] = 99;
      (checkpoint.metadata.shape as number[])[1] = 1;
      (checkpoint.metadata as { dtype: string }).dtype = 'float32';

      const stored = store.get(reqId, 0);
      expect(stored?.hiddenStates).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(stored?.metadata.shape).toEqual([1, 128, 4096]);
      expect(stored?.metadata.dtype).toBe('float16');
    });

    it('does not let a get() result mutate store-owned state', () => {
      store.save(makeCheckpoint(reqId, 0));

      const firstRead = store.get(reqId, 0);
      expect(firstRead).toBeDefined();
      firstRead!.hiddenStates[0] = 99;
      (firstRead!.metadata.shape as number[])[1] = 1;
      (firstRead!.metadata as { dtype: string }).dtype = 'float32';

      const secondRead = store.get(reqId, 0);
      expect(secondRead?.hiddenStates).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(secondRead?.metadata.shape).toEqual([1, 128, 4096]);
      expect(secondRead?.metadata.dtype).toBe('float16');
    });
  });

  describe('latest', () => {
    it('returns the highest completed segment regardless of insertion order', () => {
      const cp3 = makeCheckpoint(reqId, 3);
      store.save(cp3);
      store.save(makeCheckpoint(reqId, 0));
      store.save(makeCheckpoint(reqId, 2));

      expect(store.latest(reqId)).toEqual(cp3);
    });

    it('can stop at a durable upper boundary', () => {
      const cp1 = makeCheckpoint(reqId, 1);
      store.save(cp1);
      store.save(makeCheckpoint(reqId, 4));
      store.save(makeCheckpoint(reqId, 2));

      expect(store.latest(reqId, 1)).toEqual(cp1);
      expect(store.latest(reqId, -1)).toBeUndefined();
    });

    it('returns a snapshot that cannot mutate the stored resume point', () => {
      store.save(makeCheckpoint(reqId, 3));

      const firstRead = store.latest(reqId);
      expect(firstRead).toBeDefined();
      firstRead!.hiddenStates[0] = 99;
      (firstRead!.metadata.shape as number[])[1] = 1;

      const secondRead = store.latest(reqId);
      expect(secondRead?.hiddenStates).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(secondRead?.metadata.shape).toEqual([1, 128, 4096]);
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

    it('matches request identity exactly instead of deleting prefix-related IDs', () => {
      const parent = inferenceRequestId('req');
      const child = inferenceRequestId('req:child');
      store.save(makeCheckpoint(parent, 0));
      store.save(makeCheckpoint(parent, 1));
      store.save(makeCheckpoint(child, 0));
      store.save(makeCheckpoint(child, 2));

      store.deleteAll(parent);

      expect(store.size).toBe(2);
      expect(store.get(parent, 0)).toBeUndefined();
      expect(store.get(parent, 1)).toBeUndefined();
      expect(store.get(child, 0)).toBeDefined();
      expect(store.get(child, 2)).toBeDefined();
      expect(store.latest(child)?.segmentIndex).toBe(2);
    });

    it('should be safe to call on non-existent request', () => {
      store.deleteAll(inferenceRequestId('nonexistent'));
      expect(store.size).toBe(0);
    });
  });
});
