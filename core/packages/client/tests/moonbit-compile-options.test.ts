import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertMoonBitCompileOptionsResolved,
  compileMoonBitModule,
  createMoonBitCompileOptions,
  MoonBitCompatibilityError,
  normalizeMoonBitImportedStringConstants,
} from '../src/moonbit-compile-options';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const interopBytes = readFileSync(join(fixtureDir, 'interop.wasm'));

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

  it('verifies that reserved String imports were resolved by compile options', async () => {
    const rawModule = await WebAssembly.compile(interopBytes);
    expect(() => assertMoonBitCompileOptionsResolved(rawModule, '_'))
      .toThrow(MoonBitCompatibilityError);
    expect(() => assertMoonBitCompileOptionsResolved(rawModule, '_'))
      .toThrow('reserved import namespaces unresolved ("_", "wasm:js-string")');

    const compiled = await compileMoonBitModule(interopBytes, '_');
    expect(() => assertMoonBitCompileOptionsResolved(compiled, '_')).not.toThrow();
    expect(WebAssembly.Module.imports(compiled)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: '_' }),
        expect.objectContaining({ module: 'wasm:js-string' }),
      ]),
    );
  });

  it('detects runtimes that silently ignore JS String Builtins compile options', async () => {
    const originalCompile = WebAssembly.compile;
    (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = (
      bytes: BufferSource,
    ) => originalCompile(bytes);

    try {
      await expect(compileMoonBitModule(interopBytes, '_')).rejects.toThrow(
        'MoonBit String interop is unsupported by this browser',
      );
    } finally {
      (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = originalCompile;
    }
  });

  it('normalizes native compile failures into a compatibility error with the cause', async () => {
    const originalCompile = WebAssembly.compile;
    const nativeError = new WebAssembly.CompileError('wasm-gc is unavailable');
    (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = async () => {
      throw nativeError;
    };

    try {
      const error = await compileMoonBitModule(interopBytes, '_').catch((reason) => reason);
      expect(error).toBeInstanceOf(MoonBitCompatibilityError);
      expect(error.message).toContain("incompatible with this browser's WebAssembly runtime");
      expect(error.cause).toBe(nativeError);
    } finally {
      (WebAssembly as unknown as { compile: typeof WebAssembly.compile }).compile = originalCompile;
    }
  });
});
