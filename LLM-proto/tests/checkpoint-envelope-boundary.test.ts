import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { inferenceRequestId } from '../src/types.js';
import type { Checkpoint } from '../src/types.js';

function validCheckpoint(): Checkpoint {
  return {
    requestId: inferenceRequestId('checkpoint-envelope'),
    segmentIndex: 0,
    hiddenStates: new Uint8Array([1, 2, 3, 4]),
    metadata: {
      shape: [1, 1, 4],
      dtype: 'float16',
      sequenceLength: 1,
      timestamp: 1,
    },
  };
}

describe('CheckpointStore checkpoint envelope boundary', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string', 'checkpoint'],
    ['number', 1],
    ['array', []],
    ['symbol', Symbol('checkpoint')],
    ['function', () => undefined],
  ])('rejects a %s checkpoint envelope before field access or state mutation', (_label, value) => {
    const store = new CheckpointStore();

    expect(() => store.save(value as never)).toThrow(/checkpoint must be a non-null object/);
    expect(store.size).toBe(0);
  });

  it('keeps valid save/get snapshot semantics unchanged', () => {
    const store = new CheckpointStore();
    const checkpoint = validCheckpoint();

    store.save(checkpoint);

    const stored = store.get(checkpoint.requestId, checkpoint.segmentIndex);
    expect(stored).toEqual(checkpoint);
    expect(stored).not.toBe(checkpoint);
    expect(stored?.hiddenStates).not.toBe(checkpoint.hiddenStates);
  });
});
