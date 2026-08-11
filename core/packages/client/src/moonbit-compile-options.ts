/**
 * Shared WebAssembly compile options for MoonBit wasm-gc modules.
 *
 * MoonBit's `imported-string-constants` setting chooses the WebAssembly
 * module namespace that holds string literals. The executor must pass the
 * same namespace to `WebAssembly.compile`; otherwise those imports remain
 * unresolved. `null` deliberately omits the option for modules that do not
 * use imported string constants.
 */

export type MoonBitImportedStringConstants = string | null;

export const DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS = '_';

export interface MoonBitCompileOptions {
  readonly builtins: readonly ['js-string'];
  readonly importedStringConstants?: string;
}

export function normalizeMoonBitImportedStringConstants(
  value: MoonBitImportedStringConstants | undefined,
): MoonBitImportedStringConstants {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new TypeError('importedStringConstants must be a string, null, or undefined');
  }
  return value === undefined ? DEFAULT_MOONBIT_IMPORTED_STRING_CONSTANTS : value;
}

export function createMoonBitCompileOptions(
  importedStringConstants: MoonBitImportedStringConstants,
): MoonBitCompileOptions {
  const builtins = ['js-string'] as const;
  return importedStringConstants === null
    ? { builtins }
    : { builtins, importedStringConstants };
}

export function validateMoonBitModule(
  bytes: BufferSource,
  importedStringConstants: MoonBitImportedStringConstants,
): boolean {
  const validate = WebAssembly.validate as unknown as (
    source: BufferSource,
    options: MoonBitCompileOptions,
  ) => boolean;
  return validate(bytes, createMoonBitCompileOptions(importedStringConstants));
}

export async function compileMoonBitModule(
  bytes: BufferSource,
  importedStringConstants: MoonBitImportedStringConstants,
): Promise<WebAssembly.Module> {
  const compile = WebAssembly.compile as unknown as (
    source: BufferSource,
    options: MoonBitCompileOptions,
  ) => Promise<WebAssembly.Module>;
  return compile(bytes, createMoonBitCompileOptions(importedStringConstants));
}
