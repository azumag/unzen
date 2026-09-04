import { describe, expect, it } from 'vitest';
import {
  argmaxLastLogits,
  validateCheckpointBoundaryNames,
} from '../browser-harness/webgpu-2b-split/runtime-validation.js';

describe('browser split runtime validation', () => {
  const manifest = {
    boundary: {
      tensors: [
        { name: 'boundary-a' },
        { name: 'boundary-b' },
      ],
    },
  };

  it('accepts the exact manifest boundary names independent of relay order', () => {
    expect(() => validateCheckpointBoundaryNames({
      tensors: [
        { name: 'boundary-b' },
        { name: 'boundary-a' },
      ],
    }, manifest)).not.toThrow();
  });

  it('rejects duplicate, missing, and unexpected boundary names', () => {
    expect(() => validateCheckpointBoundaryNames({
      tensors: [{ name: 'boundary-a' }, { name: 'boundary-a' }],
    }, manifest)).toThrow(/duplicate/);
    expect(() => validateCheckpointBoundaryNames({
      tensors: [{ name: 'boundary-a' }, { name: 'other' }],
    }, manifest)).toThrow(/do not match manifest/);
    expect(() => validateCheckpointBoundaryNames({ tensors: [{ name: 'boundary-a' }] }, manifest)).toThrow(/exactly two/);
  });

  it('returns the final-position argmax for finite logits', () => {
    const result = argmaxLastLogits({
      type: 'float32',
      dims: [1, 2, 3],
      data: new Float32Array([9, 8, 7, -1, 4, 2]),
    });
    expect(result).toEqual({ tokenId: 1, logit: 4, elementCount: 6 });
  });

  it.each([
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, '+Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
  ])('rejects non-finite logits (%s)', (invalid) => {
    expect(() => argmaxLastLogits({
      type: 'float32',
      dims: [1, 1, 3],
      data: new Float32Array([1, invalid, 2]),
    })).toThrow(/non-finite logit/);
  });

  it('rejects empty logits dimensions and data-length mismatches', () => {
    expect(() => argmaxLastLogits({
      type: 'float32',
      dims: [1, 0, 3],
      data: new Float32Array([]),
    })).toThrow(/unexpected logits shape/);
    expect(() => argmaxLastLogits({
      type: 'float32',
      dims: [1, 2, 3],
      data: new Float32Array([1, 2, 3]),
    })).toThrow(/data length mismatch/);
  });
});
