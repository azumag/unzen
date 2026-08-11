/**
 * Shared scalar validation for MoonBit wasm-gc executors.
 *
 * Strings work via the MoonBit JS String Builtins. Arrays are handled by the
 * separate explicit ABI bridge; this module defines the legacy/no-ABI scalar
 * contract. Note: numeric exports still accept strings via WebAssembly's
 * implicit ToNumber conversion (e.g. fibonacci("10") → 55).
 */
export function isSupportedScalar(value: unknown): boolean {
  return (
    typeof value === 'number'
    || typeof value === 'boolean'
    || typeof value === 'bigint'
    || typeof value === 'string'
  );
}

/**
 * Build a type-specific error message for an unsupported argument.
 *
 * `prefix` is the executor's supported-types sentence (without punctuation);
 * the suffix distinguishes null/undefined (a coercion hazard, not an ABI
 * boundary) from arrays/objects (rejected at the wasm-gc boundary) and other
 * unsupported scalars such as function/symbol.
 */
export function describeMoonbitArgError(prefix: string, arg: unknown): string {
  const type = typeof arg;
  const isNull = arg === null;
  const isArray = Array.isArray(arg);
  if (isNull || type === 'undefined') {
    return `${prefix} (got ${isNull ? 'null' : 'undefined'})`;
  }
  if (isArray || type === 'object') {
    return `${prefix}; arrays and objects cannot cross the wasm-gc boundary `
      + `(got ${isArray ? 'array' : 'object'})`;
  }
  return `${prefix} (got ${type})`;
}
