/**
 * demo-stats.js — session statistics model for the demo page.
 *
 * Counts outcomes separately (issue #104): browser success, fallback success,
 * input error, function error, runtime error, server error, network error,
 * cancelled, cache hit, unknown. Averages keep separate sample sets for the
 * total wall time, the browser attempt, and the server attempt so the three
 * are never conflated, and each average carries its sample count.
 *
 * Values are session-local: nothing is persisted, and RESET clears everything.
 *
 * Pure module: importable from both demo.js (browser) and vitest tests.
 */

import { classifyError } from './demo-diagnostics.js';

/** Outcome buckets counted by the stats panel. */
export const StatKind = Object.freeze({
  BROWSER_SUCCESS: 'browser-success',
  FALLBACK_SUCCESS: 'fallback-success',
  INPUT_ERROR: 'input-error',
  FUNCTION_ERROR: 'function-error',
  RUNTIME_ERROR: 'runtime-error',
  SERVER_ERROR: 'server-error',
  NETWORK_ERROR: 'network-error',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

/** All count keys, used by the stats panel for ordering. */
export const STAT_COUNT_KEYS = Object.freeze([
  StatKind.BROWSER_SUCCESS,
  StatKind.FALLBACK_SUCCESS,
  StatKind.INPUT_ERROR,
  StatKind.FUNCTION_ERROR,
  StatKind.RUNTIME_ERROR,
  StatKind.SERVER_ERROR,
  StatKind.NETWORK_ERROR,
  StatKind.CANCELLED,
  StatKind.UNKNOWN,
]);

function createSample() {
  return { sum: 0, count: 0 };
}

/** Fresh, empty stats for a new session. */
export function createStats() {
  const counts = {};
  for (const key of STAT_COUNT_KEYS) counts[key] = 0;
  return {
    counts,
    cacheHits: 0,
    totalDuration: createSample(),
    browserDuration: createSample(),
    serverDuration: createSample(),
  };
}

/**
 * Map an SDK error code (or the demo-local 'input_error') to a StatKind.
 * Delegates classification to demo-diagnostics.classifyError.
 */
export function statKindForError(code) {
  const category = classifyError(code);
  switch (category) {
    case 'input': return StatKind.INPUT_ERROR;
    case 'cancelled': return StatKind.CANCELLED;
    case 'network': return StatKind.NETWORK_ERROR;
    case 'runtime': return StatKind.RUNTIME_ERROR;
    case 'function': return StatKind.FUNCTION_ERROR;
    case 'server': return StatKind.SERVER_ERROR;
    default: return StatKind.UNKNOWN;
  }
}

/**
 * Find the (first) attempt of a given kind inside diagnostics.attempts.
 * Returns undefined when the chain is absent or malformed.
 */
function findAttempt(attempts, kind) {
  if (!Array.isArray(attempts)) return undefined;
  return attempts.find((attempt) => attempt && attempt.kind === kind);
}

/**
 * Record one finished run in the stats.
 *
 * `outcome` = { kind, diagnostics? } where kind is a StatKind and diagnostics
 * is the ExecutionDiagnostics from the SDK (or null for validation errors that
 * never reached the SDK). Timing samples are collected only from the per-kind
 * attempt chain / total so browser vs server vs total stay separate; samples
 * are only taken from well-formed numeric values.
 */
export function reduceStats(stats, action) {
  if (action.type === 'RESET') return createStats();
  if (action.type !== 'OUTCOME') return stats;

  const next = {
    ...stats,
    counts: { ...stats.counts },
    totalDuration: { ...stats.totalDuration },
    browserDuration: { ...stats.browserDuration },
    serverDuration: { ...stats.serverDuration },
  };

  const kind = action.kind;
  if (kind === StatKind.BROWSER_SUCCESS || kind === StatKind.FALLBACK_SUCCESS) {
    const outcomeKind = action.diagnostics && action.diagnostics.fallbackUsed
      ? StatKind.FALLBACK_SUCCESS
      : StatKind.BROWSER_SUCCESS;
    next.counts[outcomeKind] = (next.counts[outcomeKind] || 0) + 1;
  } else {
    next.counts[kind] = (next.counts[kind] || 0) + 1;
  }

  const d = action.diagnostics;
  if (d) {
    if (d.manifestCache === 'hit') next.cacheHits += 1;

    if (typeof d.totalDurationMs === 'number' && Number.isFinite(d.totalDurationMs)) {
      next.totalDuration.sum += d.totalDurationMs;
      next.totalDuration.count += 1;
    }
    const browser = findAttempt(d.attempts, 'browser');
    if (browser && typeof browser.durationMs === 'number' && Number.isFinite(browser.durationMs)) {
      next.browserDuration.sum += browser.durationMs;
      next.browserDuration.count += 1;
    }
    const server = findAttempt(d.attempts, 'server');
    if (server && typeof server.durationMs === 'number' && Number.isFinite(server.durationMs)) {
      next.serverDuration.sum += server.durationMs;
      next.serverDuration.count += 1;
    }
  }

  return next;
}

/**
 * Mean of a sample accumulator, or null when no samples were recorded.
 * Null is rendered as "—" by the stats panel.
 */
export function average(sample) {
  if (!sample || sample.count === 0) return null;
  return sample.sum / sample.count;
}
