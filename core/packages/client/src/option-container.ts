/**
 * Classify caller-owned option containers without leaking native revoked-Proxy
 * failures from Array.isArray(). Revoked proxies belong to the same public
 * validation bucket as arrays and non-object values.
 */
export function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}
