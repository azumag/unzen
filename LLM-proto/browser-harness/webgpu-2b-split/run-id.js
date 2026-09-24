export const BROWSER_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Keep the browser execution namespace aligned with the local Coordinator's
 * safeRunId() contract. Do not normalize: a rejected query must stay rejected
 * rather than being silently mapped onto another run namespace.
 */
export function validateBrowserRunId(runId) {
  if (typeof runId !== 'string' || !BROWSER_RUN_ID_PATTERN.test(runId)) {
    // Avoid invoking caller-controlled string coercion while reporting an
    // invalid programmatic value. URL-derived values are strings, but this
    // helper is also imported directly by contract tests/other modules.
    throw new Error('browser run ID is invalid');
  }
  return runId;
}
