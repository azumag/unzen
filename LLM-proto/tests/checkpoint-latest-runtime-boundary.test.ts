import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { inferenceRequestId, type Checkpoint } from '../src/types.js';

function checkpoint(): Checkpoint {
  return {
    requestId: inferenceRequestId('req-latest-runtime'),
    segmentIndex: 2,
    hiddenStates: new Uint8Array([1]),
    metadata: {
      shape: [1],
      dtype: 'float16',
      sequenceLength: 1,
      timestamp: 1,
    },
  };
}

describe('CheckpointStore latest runtime upper-bound contract', () => {
  it.each([
    ['symbol', Symbol('segment')],
    ['string', '2'],
    ['object', {}],
    ['array', []],
    ['NaN', Number.NaN],
    ['fractional', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s without coercing the malformed bound or mutating state', (_label, raw) => {
    const store = new CheckpointStore();
    const saved = checkpoint();
    store.save(saved);

    expect(() => store.latest(saved.requestId, raw as number)).toThrow(
      'atOrBeforeSegmentIndex must be a safe integer',
    );
    expect(store.size).toBe(1);
    expect(store.latest(saved.requestId, 2)).toEqual(saved);
  });

  it('preserves negative safe-integer empty-range semantics', () => {
    const store = new CheckpointStore();
    const saved = checkpoint();
    store.save(saved);

    expect(store.latest(saved.requestId, -1)).toBeUndefined();
    expect(store.size).toBe(1);
  });
});
