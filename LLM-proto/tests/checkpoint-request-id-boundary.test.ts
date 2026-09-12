import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { inferenceRequestId, type Checkpoint, type InferenceRequestId } from '../src/types.js';

function checkpoint(requestId: InferenceRequestId): Checkpoint {
  return {
    requestId,
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

function assertedRequestId(value: unknown): InferenceRequestId {
  return value as InferenceRequestId;
}

describe('CheckpointStore request identity boundary', () => {
  it.each([['empty', ''], ['whitespace', '  \t\n']])(
    'rejects %s request identity before save mutates state',
    (_label, raw) => {
      const store = new CheckpointStore();
      const malformed = checkpoint(assertedRequestId(raw));

      expect(() => store.save(malformed)).toThrow(/requestId must be a non-empty string/);
      expect(store.size).toBe(0);
    },
  );

  it('rejects a non-string asserted request identity before save mutates state', () => {
    const store = new CheckpointStore();
    const malformed = checkpoint(assertedRequestId(123));

    expect(() => store.save(malformed)).toThrow(/requestId must be a non-empty string/);
    expect(store.size).toBe(0);
  });

  it('fails closed on invalid request identities for every public lookup/delete boundary', () => {
    const store = new CheckpointStore();
    const valid = inferenceRequestId('valid-request');
    store.save(checkpoint(valid));
    const invalid = assertedRequestId('   ');

    expect(() => store.get(invalid, 0)).toThrow(/requestId must be a non-empty string/);
    expect(() => store.latest(invalid)).toThrow(/requestId must be a non-empty string/);
    expect(() => store.deleteAll(invalid)).toThrow(/requestId must be a non-empty string/);

    expect(store.size).toBe(1);
    expect(store.get(valid, 0)).toBeDefined();
  });

  it('preserves padded non-empty request ids as exact identities', () => {
    const store = new CheckpointStore();
    const padded = inferenceRequestId(' request-with-padding ');
    const trimmed = inferenceRequestId('request-with-padding');

    store.save(checkpoint(padded));

    expect(store.get(padded, 0)).toBeDefined();
    expect(store.get(trimmed, 0)).toBeUndefined();
    expect(store.latest(padded)?.requestId).toBe(padded);
  });
});
