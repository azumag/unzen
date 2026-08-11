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

const MOONBIT_WEBASSEMBLY_COMPATIBILITY_MESSAGE =
  "MoonBit module is incompatible with this browser's WebAssembly runtime "
  + '(wasm-gc is required; String APIs also require JS String Builtins)';

/**
 * Raised when the current WebAssembly runtime cannot compile a MoonBit module
 * with the features that module needs.
 *
 * This stays internal to the MoonBit executor boundary: the main-thread and
 * worker executors convert it to their stable runtime-error contracts.
 */
export class MoonBitCompatibilityError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MoonBitCompatibilityError';
  }
}

export function normalizeMoonBitImportedStringConstants(
  value: unknown,
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
  if (
    typeof WebAssembly === 'undefined'
    || typeof WebAssembly.validate !== 'function'
  ) {
    return false;
  }
  const validate = WebAssembly.validate as unknown as (
    source: BufferSource,
    options: MoonBitCompileOptions,
  ) => boolean;
  try {
    return validate(bytes, createMoonBitCompileOptions(importedStringConstants));
  } catch {
    return false;
  }
}

/**
 * Verify that JS String Builtins compile options were actually applied.
 *
 * Older runtimes may accept and silently ignore the second argument to
 * `WebAssembly.compile`. The compile then succeeds, but the reserved imports
 * remain in the module and instantiation fails later with an engine-specific
 * LinkError. Inspecting the compiled module turns that ambiguity into one
 * stable compatibility error.
 */
export function assertMoonBitCompileOptionsResolved(
  module: WebAssembly.Module,
  importedStringConstants: MoonBitImportedStringConstants,
): void {
  let descriptors: WebAssembly.ModuleImportDescriptor[];
  try {
    descriptors = WebAssembly.Module.imports(module);
  } catch (error) {
    throw new MoonBitCompatibilityError(
      MOONBIT_WEBASSEMBLY_COMPATIBILITY_MESSAGE,
      error,
    );
  }

  const unresolvedNamespaces = new Set<string>();
  for (const descriptor of descriptors) {
    if (
      descriptor.module === 'wasm:js-string'
      || (
        importedStringConstants !== null
        && descriptor.module === importedStringConstants
      )
    ) {
      unresolvedNamespaces.add(descriptor.module);
    }
  }

  if (unresolvedNamespaces.size > 0) {
    const namespaces = [...unresolvedNamespaces]
      .sort()
      .map((namespace) => JSON.stringify(namespace))
      .join(', ');
    throw new MoonBitCompatibilityError(
      'MoonBit String interop is unsupported by this browser: '
      + `WebAssembly compile options left reserved import namespaces unresolved (${namespaces})`,
    );
  }
}

export async function compileMoonBitModule(
  bytes: BufferSource,
  importedStringConstants: MoonBitImportedStringConstants,
): Promise<WebAssembly.Module> {
  if (
    typeof WebAssembly === 'undefined'
    || typeof WebAssembly.compile !== 'function'
  ) {
    throw new MoonBitCompatibilityError(MOONBIT_WEBASSEMBLY_COMPATIBILITY_MESSAGE);
  }
  const compile = WebAssembly.compile as unknown as (
    source: BufferSource,
    options: MoonBitCompileOptions,
  ) => Promise<WebAssembly.Module>;
  let module: WebAssembly.Module;
  try {
    module = await compile(bytes, createMoonBitCompileOptions(importedStringConstants));
  } catch (error) {
    throw new MoonBitCompatibilityError(
      MOONBIT_WEBASSEMBLY_COMPATIBILITY_MESSAGE,
      error,
    );
  }
  assertMoonBitCompileOptionsResolved(module, importedStringConstants);
  return module;
}
