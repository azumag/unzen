import { describe, expect, it } from 'vitest';
import {
  createMoonBitCompileOptions,
  normalizeMoonBitImportedStringConstants,
} from '../src/moonbit-compile-options';

describe('MoonBit compile options', () => {
  it('defaults imported string constants to the MoonBit `_` namespace', () => {
    expect(normalizeMoonBitImportedStringConstants(undefined)).toBe('_');
    expect(createMoonBitCompileOptions('_')).toEqual({
      builtins: ['js-string'],
      importedStringConstants: '_',
    });
  });

  it('supports a custom namespace or omitting imported string constants', () => {
    expect(createMoonBitCompileOptions('unzen:strings')).toEqual({
      builtins: ['js-string'],
      importedStringConstants: 'unzen:strings',
    });
    expect(createMoonBitCompileOptions(null)).toEqual({
      builtins: ['js-string'],
    });
  });

  it('rejects invalid JavaScript option values at construction time', () => {
    expect(() => normalizeMoonBitImportedStringConstants(42 as never)).toThrow(TypeError);
  });
});
