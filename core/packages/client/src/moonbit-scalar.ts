/**
 * Shared scalar validation for MoonBit wasm-gc executors.
 *
 * Strings work via the MoonBit JS String Builtins; arrays/objects do NOT
 * (plain JS arrays are rejected at the wasm boundary, and wasm-gc arrays
 * return as unreadable opaque handles). Note: numeric exports still accept
 * strings via WebAssembly's implicit ToNumber conversion (e.g.
 * fibonacci("10") → 55); the executors validate only that values are scalars,
 * not per-export ABI types.
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
