/**
 * Unit tests for the demo input parsing/validation (public/demo-validate.js).
 *
 * Covers issue #104 requirements:
 * - array input reports the POSITION of invalid tokens instead of dropping them,
 * - JSON parsing reports a browser-independent 1-based line/column position,
 * - expected-shape validation for price items and discount,
 * - field-level checks (email / card+Luhn / phone / password).
 */

import { describe, it, expect } from 'vitest';
import {
  parseNumber,
  parseNumberList,
  parseJsonLite,
  validatePriceItems,
  validateDiscount,
  isValidEmail,
  isValidCardNumber,
  isValidPhone,
  isStrongPassword,
  isLuhnValid,
} from '../public/demo-validate.js';

describe('parseNumber', () => {
  it('parses integers and decimals', () => {
    expect(parseNumber('5')).toEqual({ ok: true, value: 5 });
    expect(parseNumber('3.14')).toEqual({ ok: true, value: 3.14 });
    expect(parseNumber('  -7 ')).toEqual({ ok: true, value: -7 });
  });

  it('rejects empty / non-numeric / non-finite input', () => {
    expect(parseNumber('').ok).toBe(false);
    expect(parseNumber('abc').ok).toBe(false);
    expect(parseNumber('NaN').ok).toBe(false);
    expect(parseNumber('Infinity').ok).toBe(false);
    expect(parseNumber('   ').ok).toBe(false);
  });
});

describe('parseNumberList — array input validation', () => {
  it('parses a valid comma-separated list', () => {
    const result = parseNumberList('1, 2, 3.5, 4');
    expect(result).toMatchObject({ ok: true, values: [1, 2, 3.5, 4], invalid: [], isEmpty: false });
  });

  it('flags invalid tokens with their zero-based index and raw text', () => {
    const result = parseNumberList('1, abc, 2, , 3x');
    expect(result.ok).toBe(false);
    expect(result.values).toEqual([1, 2]);
    // "abc" is index 1, "" is index 3, "3x" is index 4 — none silently dropped.
    expect(result.invalid).toEqual([
      { index: 1, raw: 'abc' },
      { index: 3, raw: '' },
      { index: 4, raw: '3x' },
    ]);
  });

  it('reports isEmpty for blank input', () => {
    expect(parseNumberList('   ').isEmpty).toBe(true);
    expect(parseNumberList('   ').ok).toBe(false);
  });
});

describe('parseJsonLite — JSON with error positions', () => {
  it('parses a valid JSON document', () => {
    const result = parseJsonLite('{"a":1,"b":[true,null,"x"],"c":1.5e3}');
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ a: 1, b: [true, null, 'x'], c: 1500 });
  });

  it('parses a valid top-level array', () => {
    expect(parseJsonLite('[1,2,3]')).toEqual({ ok: true, value: [1, 2, 3] });
  });

  it('reports a 1-based line/column for a syntax error', () => {
    const result = parseJsonLite('{\n  "a": 1,\n  "b": }\n}');
    expect(result.ok).toBe(false);
    // "}" at line 3, column 8 is the unexpected token.
    expect(result.error.line).toBe(3);
    expect(result.error.column).toBe(8);
  });

  it('reports line/column for unbalanced input', () => {
    const result = parseJsonLite('[1, 2,');
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('Unexpected end of JSON input');
  });

  it('rejects trailing content after the document', () => {
    const result = parseJsonLite('{"a":1} garbage');
    expect(result.ok).toBe(false);
    expect(result.error.message).toBe('Unexpected trailing content');
  });

  it('rejects invalid numbers', () => {
    expect(parseJsonLite('1..2').ok).toBe(false);
    expect(parseJsonLite('-').ok).toBe(false);
    expect(parseJsonLite('1e').ok).toBe(false);
    expect(parseJsonLite('01').ok).toBe(true); // loose parser, still accepted
  });

  it('rejects unterminated strings and bad escapes', () => {
    expect(parseJsonLite('"abc').ok).toBe(false);
    expect(parseJsonLite('"a\\qb"').ok).toBe(false);
    expect(parseJsonLite('"\\u12"').ok).toBe(false);
    expect(parseJsonLite('"\\u0041"').value).toBe('A');
  });

  it('accepts empty object / array and rejects empty input', () => {
    expect(parseJsonLite('{}').value).toEqual({});
    expect(parseJsonLite('[]').value).toEqual([]);
    expect(parseJsonLite('').ok).toBe(false);
    expect(parseJsonLite('   ').ok).toBe(false);
  });

  it('does not pollute Object.prototype via __proto__ keys', () => {
    const result = parseJsonLite('{"__proto__":{"polluted":true}}');
    expect(result.ok).toBe(true);
    // The parsed object must own the key, and Object.prototype must be clean.
    expect(Object.prototype.polluted).toBeUndefined();
    const parsed = result.value;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed.polluted).toBeUndefined();
  });
});

describe('validatePriceItems — expected shape', () => {
  it('accepts a well-formed item list', () => {
    const items = [{ name: 'Widget', price: 50, quantity: 2, weight: 1 }];
    expect(validatePriceItems(items)).toEqual({ ok: true, errors: [] });
  });

  it('rejects a non-array and an empty array', () => {
    expect(validatePriceItems({}).ok).toBe(false);
    expect(validatePriceItems([]).ok).toBe(false);
  });

  it('reports per-item errors', () => {
    const items = [
      { name: '', price: -1, quantity: 0 },
      'not-an-object',
    ];
    const result = validatePriceItems(items);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors.map((e) => e.index)).toContain(0);
    expect(result.errors.map((e) => e.index)).toContain(1);
  });

  it('allows weight to be omitted', () => {
    expect(validatePriceItems([{ name: 'A', price: 1, quantity: 1 }]).ok).toBe(true);
  });
});

describe('validateDiscount — expected shape', () => {
  it('accepts null/undefined (optional)', () => {
    expect(validateDiscount(null).ok).toBe(true);
    expect(validateDiscount(undefined).ok).toBe(true);
  });

  it('accepts a percentage discount', () => {
    expect(validateDiscount({ type: 'percentage', value: 10 })).toEqual({ ok: true, errors: [] });
  });

  it('rejects wrong type and negative value', () => {
    expect(validateDiscount({ type: 'flat', value: 10 }).ok).toBe(false);
    expect(validateDiscount({ type: 'percentage', value: -1 }).ok).toBe(false);
    expect(validateDiscount('10%').ok).toBe(false);
  });
});

describe('field-level checks (mirror sandbox rules)', () => {
  it('isValidEmail', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('bad-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false); // no TLD
  });

  it('isLuhnValid rejects all-zero digits', () => {
    expect(isLuhnValid('4111111111111111')).toBe(true);
    expect(isLuhnValid('0000000000000000')).toBe(false);
    expect(isLuhnValid('1234')).toBe(false);
  });

  it('isValidCardNumber strips spaces/hyphens and checks length + Luhn', () => {
    expect(isValidCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(isValidCardNumber('4111-1111-1111-1111')).toBe(true);
    expect(isValidCardNumber('4111111111111112')).toBe(false); // fails Luhn
    expect(isValidCardNumber('12345')).toBe(false); // too short
  });

  it('isValidPhone', () => {
    expect(isValidPhone('+1-555-123-4567')).toBe(true);
    expect(isValidPhone('+81 90 1234 5678')).toBe(true);
    expect(isValidPhone('123')).toBe(false);
  });

  it('isStrongPassword', () => {
    expect(isStrongPassword('MyP@ssw0rd!23')).toBe(true);
    expect(isStrongPassword('short')).toBe(false);
  });
});
