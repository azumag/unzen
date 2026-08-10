/**
 * demo-diagnostics.js — typed diagnostics handling for the demo UI.
 *
 * The demo receives ExecutionDiagnostics (issue #105) from
 * executeWithDiagnostics(). The shape crosses a process boundary (SDK bundle →
 * demo code) and could be missing/malformed at runtime, so before the UI
 * renders anything it must validate the shape and never crash on bad input —
 * a malformed diagnostics object renders as "unknown".
 *
 * Error copy/visuals are driven by stable error *codes* (ExecutionErrorCode),
 * never by parsing message strings. This module classifies a code into one of
 * the demo's error categories.
 *
 * Pure module: importable from both demo.js (browser) and vitest tests.
 */

export const ErrorCategory = Object.freeze({
  INPUT: 'input',
  FUNCTION: 'function',
  RUNTIME: 'runtime',
  SERVER: 'server',
  NETWORK: 'network',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

/**
 * Classify a stable error code into a demo error category.
 * 'input_error' is a demo-local code produced when validation rejects inputs
 * before any SDK call. All other codes are SDK ExecutionErrorCode values.
 * Unknown codes fall back to UNKNOWN — never throw.
 */
export function classifyError(code) {
  switch (code) {
    case 'input_error':
      return ErrorCategory.INPUT;
    case 'cancelled':
      return ErrorCategory.CANCELLED;
    case 'manifest_fetch_failed':
    case 'code_fetch_failed':
      return ErrorCategory.NETWORK;
    case 'browser_runtime_failed':
    case 'deadline_exceeded':
      return ErrorCategory.RUNTIME;
    case 'function_failed':
      return ErrorCategory.FUNCTION;
    case 'server_fallback_failed':
      return ErrorCategory.SERVER;
    case 'server_network_failed':
      return ErrorCategory.NETWORK;
    default:
      return ErrorCategory.UNKNOWN;
  }
}

/**
 * Runtime schema check for the ExecutionDiagnostics shape
 * ({ executionId, finalRoute?, fallbackUsed, attempts[], totalDurationMs,
 *   manifestCache }).
 */
export function isExecutionDiagnostics(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const d = value;
  if (typeof d.executionId !== 'string' || d.executionId.length === 0) return false;
  if (d.finalRoute != null && d.finalRoute !== 'browser' && d.finalRoute !== 'server') return false;
  if (typeof d.fallbackUsed !== 'boolean') return false;
  if (!Array.isArray(d.attempts)) return false;
  if (typeof d.totalDurationMs !== 'number' || !Number.isFinite(d.totalDurationMs)) return false;
  if (d.manifestCache !== 'hit' && d.manifestCache !== 'miss' && d.manifestCache !== 'unknown') {
    return false;
  }
  return true;
}

/**
 * Normalize the attempts array into a safe, display-ready list.
 * Each entry is sanitized independently so one malformed attempt never breaks
 * the whole chain.
 */
export function normalizeAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.map((attempt, index) => {
    const kind = attempt && attempt.kind === 'server' ? 'server' : 'browser';
    const outcome =
      attempt && (attempt.outcome === 'succeeded' || attempt.outcome === 'failed' || attempt.outcome === 'cancelled')
        ? attempt.outcome
        : 'unknown';
    return {
      index: index + 1,
      kind,
      outcome,
      durationMs:
        attempt && typeof attempt.durationMs === 'number' && Number.isFinite(attempt.durationMs)
          ? attempt.durationMs
          : null,
      errorCode: attempt && typeof attempt.errorCode === 'string' ? attempt.errorCode : null,
    };
  });
}

/**
 * Produce a safe summary of the diagnostics, or null when the diagnostics are
 * missing/malformed — the UI renders "unknown" in that case and does not crash.
 */
export function summarizeDiagnostics(diagnostics) {
  if (!isExecutionDiagnostics(diagnostics)) return null;
  return {
    finalRoute: diagnostics.finalRoute ?? null,
    fallbackUsed: diagnostics.fallbackUsed,
    totalDurationMs: diagnostics.totalDurationMs,
    manifestCache: diagnostics.manifestCache,
    attempts: normalizeAttempts(diagnostics.attempts),
  };
}
