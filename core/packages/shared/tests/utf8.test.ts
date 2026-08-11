import { describe, expect, it } from 'vitest';
import { exceedsUtf8ByteLength, utf8ByteLength } from '../src/utf8';

describe('UTF-8 byte length', () => {
  it.each([
    ['ASCII', 5],
    ['\u00e9', 2],
    ['\u6f22', 3],
    ['\ud83d\ude00', 4],
    ['\ud800', 3],
  ])('counts %j as %i bytes', (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
  });

  it('can stop once a caller-provided maximum is exceeded', () => {
    expect(exceedsUtf8ByteLength('\u00e9\u00e9', 3)).toBe(true);
    expect(exceedsUtf8ByteLength('\u00e9\u00e9', 4)).toBe(false);
  });
});
