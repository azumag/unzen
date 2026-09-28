import { describe, expect, it } from 'vitest';
import { isContiguousLayerSuccessor } from '../src/segment-layer-range.js';

describe('isContiguousLayerSuccessor', () => {
  it('accepts ordinary exact adjacent layer ranges', () => {
    expect(isContiguousLayerSuccessor(0, 1)).toBe(true);
    expect(isContiguousLayerSuccessor(127, 128)).toBe(true);
  });

  it('accepts the last representable safe-integer successor', () => {
    expect(isContiguousLayerSuccessor(
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    )).toBe(true);
  });

  it('rejects a successor after Number.MAX_SAFE_INTEGER before adding one', () => {
    expect(isContiguousLayerSuccessor(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    )).toBe(false);
  });

  it.each([
    [-1, 0],
    [0, -1],
    [1.5, 2],
    [1, 2.5],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER],
  ])('rejects invalid runtime layer values: %j -> %j', (previous, current) => {
    expect(isContiguousLayerSuccessor(previous, current)).toBe(false);
  });
});
