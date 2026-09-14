import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import { inferenceRequestId, type Checkpoint } from '../src/types.js';

function metadata(shape: number[] = [1, 2, 3]): Checkpoint['metadata'] {
  return {
    shape,
    dtype: 'float16',
    sequenceLength: 2,
    timestamp: 0,
  };
}

describe('CheckpointStore save ownership boundary', () => {
  it('uses the same captured request and segment identity for validation and persistence', () => {
    const store = new CheckpointStore();
    const validatedRequestId = inferenceRequestId('request-validated');
    const alteredRequestId = inferenceRequestId('request-altered');
    let requestIdReads = 0;
    let segmentIndexReads = 0;

    const checkpoint = {
      get requestId() {
        requestIdReads += 1;
        return requestIdReads === 1 ? validatedRequestId : alteredRequestId;
      },
      get segmentIndex() {
        segmentIndexReads += 1;
        return segmentIndexReads === 1 ? 2 : 9;
      },
      hiddenStates: new Uint8Array([1, 2, 3]),
      metadata: metadata(),
    } as Checkpoint;

    store.save(checkpoint);

    expect(requestIdReads).toBe(1);
    expect(segmentIndexReads).toBe(1);
    expect(store.get(validatedRequestId, 2)).toMatchObject({
      requestId: validatedRequestId,
      segmentIndex: 2,
    });
    expect(store.get(alteredRequestId, 9)).toBeUndefined();
  });

  it('captures payload and metadata once and isolates stored state from later caller mutation', () => {
    const store = new CheckpointStore();
    const requestId = inferenceRequestId('request-owned-state');
    const hiddenStates = new Uint8Array([7, 8, 9]);
    const shape = [1, 2, 3];
    const metadataValue = metadata(shape) as Checkpoint['metadata'] & { shape: number[] };
    let hiddenStateReads = 0;
    let shapeReads = 0;

    Object.defineProperty(metadataValue, 'shape', {
      enumerable: true,
      get() {
        shapeReads += 1;
        return shapeReads === 1 ? shape : [0];
      },
    });

    const checkpoint = {
      requestId,
      segmentIndex: 1,
      get hiddenStates() {
        hiddenStateReads += 1;
        return hiddenStateReads === 1 ? hiddenStates : new Uint8Array();
      },
      metadata: metadataValue,
    } as Checkpoint;

    store.save(checkpoint);

    expect(hiddenStateReads).toBe(1);
    expect(shapeReads).toBe(1);

    hiddenStates[0] = 99;
    shape[0] = 9;

    const stored = store.get(requestId, 1);
    expect(stored?.hiddenStates).toEqual(new Uint8Array([7, 8, 9]));
    expect(stored?.metadata.shape).toEqual([1, 2, 3]);
  });
});
