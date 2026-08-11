/** Default number of settled MoonBit modules retained by each cache layer. */
export const DEFAULT_MAX_MOONBIT_CACHED_MODULES = 4;

/** Normalize the public MoonBit cache-count option. Zero disables retention. */
export function normalizeMoonBitCacheLimit(value: unknown): number {
  const normalized = value === undefined
    ? DEFAULT_MAX_MOONBIT_CACHED_MODULES
    : value;
  if (
    typeof normalized !== 'number'
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError('maxCachedModules must be a non-negative safe integer');
  }
  return normalized;
}
