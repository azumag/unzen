/**
 * Unit tests for the typed diagnostics renderer (public/demo-diagnostics.js).
 *
 * Verifies issue #104 requirements:
 * - error categories are derived from stable codes (not message parsing),
 * - missing/malformed diagnostics are detected at runtime and normalized to
 *   "unknown" without crashing,
 * - the attempt chain is sanitized entry by entry.
 */

import { describe, it, expect } from 'vitest';
import {
  ErrorCategory,
  classifyError,
  isExecutionDiagnostics,
  normalizeAttempts,
  summarizeDiagnostics,
} from '../public/demo-diagnostics.js';

function validDiagnostics(overrides = {}) {
  return {
    executionId: 'exec-7',
    finalRoute: 'browser',
    fallbackUsed: false,
    attempts: [{ kind: 'browser', startedAt: 0, durationMs: 12, outcome: 'succeeded' }],
    totalDurationMs: 40,
    manifestCache: 'miss',
    ...overrides,
  };
}

describe('classifyError — error codes, never message strings', () => {
  const cases = [
    ['input_error', ErrorCategory.INPUT],
    ['cancelled', ErrorCategory.CANCELLED],
    ['manifest_fetch_failed', ErrorCategory.NETWORK],
    ['code_fetch_failed', ErrorCategory.NETWORK],
    ['browser_runtime_failed', ErrorCategory.RUNTIME],
    ['function_failed', ErrorCategory.FUNCTION],
    ['server_fallback_failed', ErrorCategory.SERVER],
  ];
  for (const [code, expected] of cases) {
    it(`classifies ${code} → ${expected}`, () => {
      expect(classifyError(code)).toBe(expected);
    });
  }

  it('classifies unknown/missing codes as unknown without throwing', () => {
    expect(classifyError('bogus_code')).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(undefined)).toBe(ErrorCategory.UNKNOWN);
    expect(classifyError(null)).toBe(ErrorCategory.UNKNOWN);
  });
});

describe('isExecutionDiagnostics — runtime schema check', () => {
  it('accepts a well-formed diagnostics object', () => {
    expect(isExecutionDiagnostics(validDiagnostics())).toBe(true);
  });

  it('rejects null, primitives, and arrays', () => {
    expect(isExecutionDiagnostics(null)).toBe(false);
    expect(isExecutionDiagnostics(undefined)).toBe(false);
    expect(isExecutionDiagnostics('diag')).toBe(false);
    expect(isExecutionDiagnostics(42)).toBe(false);
    expect(isExecutionDiagnostics([])).toBe(false);
  });

  it('rejects malformed shapes field by field', () => {
    expect(isExecutionDiagnostics(validDiagnostics({ executionId: 7 }))).toBe(false);
    expect(isExecutionDiagnostics(validDiagnostics({ finalRoute: 'moon' }))).toBe(false);
    expect(isExecutionDiagnostics(validDiagnostics({ fallbackUsed: 'yes' }))).toBe(false);
    expect(isExecutionDiagnostics(validDiagnostics({ attempts: {} }))).toBe(false);
    expect(isExecutionDiagnostics(validDiagnostics({ totalDurationMs: 'fast' }))).toBe(false);
    expect(isExecutionDiagnostics(validDiagnostics({ manifestCache: 'maybe' }))).toBe(false);
  });

  it('accepts an absent finalRoute (nothing attempted yet)', () => {
    expect(isExecutionDiagnostics(validDiagnostics({ finalRoute: undefined }))).toBe(true);
  });
});

describe('normalizeAttempts — sanitized attempt chain', () => {
  it('normalizes each entry and ignores malformed ones safely', () => {
    const attempts = [
      { kind: 'browser', startedAt: 0, durationMs: 10, outcome: 'failed', errorCode: 'browser_runtime_failed' },
      { kind: 'server', startedAt: 10, durationMs: 20, outcome: 'succeeded' },
      'garbage',
      null,
    ];
    const normalized = normalizeAttempts(attempts);
    expect(normalized).toHaveLength(4);
    expect(normalized[0]).toEqual({ index: 1, kind: 'browser', outcome: 'failed', durationMs: 10, errorCode: 'browser_runtime_failed' });
    expect(normalized[1]).toEqual({ index: 2, kind: 'server', outcome: 'succeeded', durationMs: 20, errorCode: null });
    // Malformed entries become a safe "unknown" rather than crashing.
    expect(normalized[2]).toEqual({ index: 3, kind: 'browser', outcome: 'unknown', durationMs: null, errorCode: null });
    expect(normalized[3].kind).toBe('browser');
  });

  it('returns [] for a non-array', () => {
    expect(normalizeAttempts(undefined)).toEqual([]);
    expect(normalizeAttempts('x')).toEqual([]);
  });
});

describe('summarizeDiagnostics — typed rendering source', () => {
  it('returns a safe summary for valid diagnostics', () => {
    const summary = summarizeDiagnostics(validDiagnostics());
    expect(summary).toEqual({
      finalRoute: 'browser',
      fallbackUsed: false,
      totalDurationMs: 40,
      manifestCache: 'miss',
      attempts: [{ index: 1, kind: 'browser', outcome: 'succeeded', durationMs: 12, errorCode: null }],
    });
  });

  it('returns null for malformed/missing diagnostics (UI renders "unknown")', () => {
    expect(summarizeDiagnostics(undefined)).toBeNull();
    expect(summarizeDiagnostics(null)).toBeNull();
    expect(summarizeDiagnostics({ executionId: 'x' })).toBeNull();
  });
});
