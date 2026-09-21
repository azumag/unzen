import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { inferenceRequestId, type Checkpoint } from '../src/types.js';

function checkpointWithHiddenStates(hiddenStates: Uint8Array): Checkpoint {
  return {
    requestId: inferenceRequestId('hidden-states-boundary'),
    segmentIndex: 0,
    hiddenStates,
    metadata: {
      shape: [1, 1, 3],
      dtype: 'int8',
      sequenceLength: 1,
      timestamp: 1,
    },
  };
}

describe('checkpoint hidden-state runtime boundary', () => {
  it('rejects a Proxy-wrapped Uint8Array with the checkpoint domain error', () => {
    const proxied = new Proxy(new Uint8Array([1, 2, 3]), {});
    const checkpoint = checkpointWithHiddenStates(proxied as unknown as Uint8Array);

    expect(() => CheckpointStore.snapshotValidatedCheckpoint(checkpoint))
      .toThrow('checkpoint hiddenStates must be a non-empty Uint8Array');
  });

  it('accepts a genuine Uint8Array and returns an ownership-isolated copy', () => {
    const hiddenStates = new Uint8Array([1, 2, 3]);
    const owned = CheckpointStore.snapshotValidatedCheckpoint(
      checkpointWithHiddenStates(hiddenStates),
    );

    expect(owned.hiddenStates).toEqual(hiddenStates);
    expect(owned.hiddenStates).not.toBe(hiddenStates);
  });

  it('keeps genuine Uint8Array subclasses compatible', () => {
    class CheckpointBytes extends Uint8Array {}
    const hiddenStates = new CheckpointBytes([1, 2, 3]);

    const owned = CheckpointStore.snapshotValidatedCheckpoint(
      checkpointWithHiddenStates(hiddenStates),
    );

    expect(owned.hiddenStates).toEqual(new Uint8Array([1, 2, 3]));
  });
});
