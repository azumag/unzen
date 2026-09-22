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

// Diagnostics describe one execution. Keep malformed runtime containers from
// making the demo allocate or iterate an attacker-sized synthetic attempt list.
const MAX_RENDERED_DIAGNOSTIC_ATTEMPTS = 1024;

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
 * Classify an array without leaking the native TypeError thrown for a revoked
 * Proxy. `null` means the classification itself could not be performed.
 */
function classifyArray(value) {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

function safeAttempt(index) {
  return {
    index: index + 1,
    kind: 'browser',
    outcome: 'unknown',
    durationMs: null,
    errorCode: null,
  };
}

/** Snapshot one caller-owned attempt. A bad entry never poisons its siblings. */
function snapshotAttempt(attempt, index) {
  if (
    attempt === null
    || (typeof attempt !== 'object' && typeof attempt !== 'function')
  ) {
    return safeAttempt(index);
  }

  let kind;
  let outcome;
  let durationMs;
  let errorCode;
  try {
    kind = attempt.kind;
    outcome = attempt.outcome;
    durationMs = attempt.durationMs;
    errorCode = attempt.errorCode;
  } catch {
    return safeAttempt(index);
  }

  return {
    index: index + 1,
    kind: kind === 'server' ? 'server' : 'browser',
    outcome:
      outcome === 'succeeded' || outcome === 'failed' || outcome === 'cancelled'
        ? outcome
        : 'unknown',
    durationMs:
      typeof durationMs === 'number' && Number.isFinite(durationMs)
        ? durationMs
        : null,
    errorCode: typeof errorCode === 'string' ? errorCode : null,
  };
}

/**
 * Snapshot an attempts array by length/index without invoking caller map or
 * iteration hooks. `null` means the array container itself is unreadable.
 */
function snapshotAttempts(attempts) {
  if (classifyArray(attempts) !== true) return null;

  let length;
  try {
    length = attempts.length;
  } catch {
    return null;
  }
  if (
    typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
    || length > MAX_RENDERED_DIAGNOSTIC_ATTEMPTS
  ) {
    return null;
  }

  const normalized = new Array(length);
  for (let index = 0; index < length; index += 1) {
    let attempt;
    try {
      attempt = attempts[index];
    } catch {
      normalized[index] = safeAttempt(index);
      continue;
    }
    normalized[index] = snapshotAttempt(attempt, index);
  }
  return normalized;
}

/**
 * Capture all fields that validation/rendering will use exactly once. Returning
 * an owned projection keeps summarizeDiagnostics() from validating one set of
 * accessor values and rendering a later set.
 */
function snapshotExecutionDiagnostics(value) {
  if (value === null || typeof value !== 'object') return null;
  if (classifyArray(value) !== false) return null;

  let executionId;
  let finalRoute;
  let fallbackUsed;
  let attempts;
  let totalDurationMs;
  let manifestCache;
  try {
    executionId = value.executionId;
    finalRoute = value.finalRoute;
    fallbackUsed = value.fallbackUsed;
    attempts = value.attempts;
    totalDurationMs = value.totalDurationMs;
    manifestCache = value.manifestCache;
  } catch {
    return null;
  }

  if (typeof executionId !== 'string' || executionId.length === 0) return null;
  if (finalRoute != null && finalRoute !== 'browser' && finalRoute !== 'server') return null;
  if (typeof fallbackUsed !== 'boolean') return null;
  if (typeof totalDurationMs !== 'number' || !Number.isFinite(totalDurationMs)) return null;
  if (manifestCache !== 'hit' && manifestCache !== 'miss' && manifestCache !== 'unknown') {
    return null;
  }

  const normalizedAttempts = snapshotAttempts(attempts);
  if (normalizedAttempts === null) return null;

  return {
    executionId,
    finalRoute: finalRoute ?? null,
    fallbackUsed,
    attempts: normalizedAttempts,
    totalDurationMs,
    manifestCache,
  };
}

/**
 * Runtime schema check for the ExecutionDiagnostics shape
 * ({ executionId, finalRoute?, fallbackUsed, attempts[], totalDurationMs,
 *   manifestCache }).
 */
export function isExecutionDiagnostics(value) {
  return snapshotExecutionDiagnostics(value) !== null;
}

/**
 * Normalize the attempts array into a safe, display-ready list.
 * Each entry is sanitized independently so one malformed attempt never breaks
 * the whole chain.
 */
export function normalizeAttempts(attempts) {
  return snapshotAttempts(attempts) ?? [];
}

/**
 * Produce a safe summary of the diagnostics, or null when the diagnostics are
 * missing/malformed — the UI renders "unknown" in that case and does not crash.
 */
export function summarizeDiagnostics(diagnostics) {
  const snapshot = snapshotExecutionDiagnostics(diagnostics);
  if (snapshot === null) return null;
  return {
    finalRoute: snapshot.finalRoute,
    fallbackUsed: snapshot.fallbackUsed,
    totalDurationMs: snapshot.totalDurationMs,
    manifestCache: snapshot.manifestCache,
    attempts: snapshot.attempts,
  };
}
