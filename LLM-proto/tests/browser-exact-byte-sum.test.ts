import { describe, expect, it } from 'vitest';
import { exactByteSum } from '../browser-harness/webgpu-2b-split/exact-byte-sum.js';

describe('browser exactByteSum', () => {
  it('returns an exact total inside the JavaScript safe-integer range', () => {
    expect(exactByteSum([0, 210_141_184, 210_132_992], 'boundary bytes'))
      .toBe(420_274_176);
  });

  it('allows an aggregate exactly equal to Number.MAX_SAFE_INTEGER', () => {
    expect(exactByteSum([Number.MAX_SAFE_INTEGER - 1, 1], 'boundary bytes'))
      .toBe(Number.MAX_SAFE_INTEGER);
  });

  it('fails closed before an addition would cross Number.MAX_SAFE_INTEGER', () => {
    expect(() => exactByteSum([Number.MAX_SAFE_INTEGER, 1], 'boundary bytes'))
      .toThrow('boundary bytes exceeds JavaScript safe integer range');
  });

  it.each([
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.MAX_SAFE_INTEGER + 1],
    ['1'],
  ])('rejects invalid component bytes before aggregation: %j', (value) => {
    expect(() => exactByteSum([value] as unknown as number[], 'boundary bytes'))
      .toThrow('boundary bytes[0] must be a non-negative safe integer');
  });

  it('rejects non-array inputs', () => {
    expect(() => exactByteSum(new Set([1, 2]) as unknown as number[], 'boundary bytes'))
      .toThrow('boundary bytes inputs must be an array');
  });
});
