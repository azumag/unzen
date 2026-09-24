import { describe, expect, it } from 'vitest';
import { exactByteSum } from '../tools/exact_byte_sum.mjs';

describe('exactByteSum', () => {
  it('returns an exact total inside the JavaScript safe-integer range', () => {
    expect(exactByteSum([0, 210_141_184, 210_132_992], 'verified prepared file bytes'))
      .toBe(420_274_176);
  });

  it('fails closed before an addition would cross Number.MAX_SAFE_INTEGER', () => {
    expect(() => exactByteSum(
      [Number.MAX_SAFE_INTEGER, 1],
      'verified prepared file bytes',
    )).toThrow('verified prepared file bytes exceeds JavaScript safe integer range');
  });

  it.each([[-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [Number.MAX_SAFE_INTEGER + 1]])(
    'rejects invalid byte values before aggregation: %j',
    (value) => {
      expect(() => exactByteSum([value], 'verified prepared file bytes'))
        .toThrow('verified prepared file bytes[0] must be a non-negative safe integer');
    },
  );

  it('rejects non-array inputs instead of coercing an arbitrary iterable', () => {
    expect(() => exactByteSum(new Set([1, 2]) as unknown as number[], 'verified prepared file bytes'))
      .toThrow('verified prepared file bytes inputs must be an array');
  });
});
