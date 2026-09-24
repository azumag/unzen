export const BROWSER_RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Keep the browser execution namespace aligned with the local Coordinator's
 * safeRunId() contract. Do not normalize: a rejected query must stay rejected
 * rather than being silently mapped onto another run namespace.
 */
export function validateBrowserRunId(runId) {
  if (typeof runId !== 'string' || !BROWSER_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`browser run ID is invalid: ${String(runId)}`);
  }
  return runId;
}
