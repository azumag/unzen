/** Validate and normalize a route prefix used by client HTTP components. */
export function normalizeUnzenEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('endpoint must be a non-empty string');
  }
  return value.trim().replace(/\/+$/, '');
}
