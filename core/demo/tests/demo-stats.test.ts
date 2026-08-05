/**
 * Unit tests for the session statistics model (public/demo-stats.js).
 *
 * Verifies issue #104's requirements:
 * - outcomes are counted in separate buckets (never conflated),
 * - averages keep separate sample sets for total / browser / server and carry
 *   a sample count,
 * - RESET clears everything,
 * - a fallback result is counted as fallback success (from diagnostics).
 */

import { describe, it, expect } from 'vitest';
import {
  createStats,
  reduceStats,
  average,
  StatKind,
  STAT_COUNT_KEYS,
  statKindForError,
} from '../public/demo-stats.js';

function diagnostics(overrides = {}) {
  return {
    executionId: 'exec-1',
    finalRoute: 'browser',
    fallbackUsed: false,
    attempts: [],
    totalDurationMs: 100,
    manifestCache: 'miss',
    ...overrides,
  };
}

describe('createStats', () => {
  it('starts with every count bucket at zero', () => {
    const stats = createStats();
    for (const key of STAT_COUNT_KEYS) {
      expect(stats.counts[key]).toBe(0);
    }
    expect(stats.cacheHits).toBe(0);
    expect(average(stats.totalDuration)).toBeNull();
  });
});

describe('statKindForError — error codes map to stat buckets', () => {
  const cases = [
    ['cancelled', StatKind.CANCELLED],
    ['manifest_fetch_failed', StatKind.NETWORK_ERROR],
    ['code_fetch_failed', StatKind.NETWORK_ERROR],
    ['browser_runtime_failed', StatKind.RUNTIME_ERROR],
    ['function_failed', StatKind.FUNCTION_ERROR],
    ['server_fallback_failed', StatKind.SERVER_ERROR],
    ['input_error', StatKind.INPUT_ERROR],
    ['made_up_code', StatKind.UNKNOWN],
  ];
  for (const [code, kind] of cases) {
    it(`classifies "${code}" → ${kind}`, () => {
      expect(statKindForError(code)).toBe(kind);
    });
  }
});

describe('reduceStats — OUTCOME counting', () => {
  it('counts a plain browser success', () => {
    let stats = createStats();
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.BROWSER_SUCCESS,
      diagnostics: diagnostics(),
    });
    expect(stats.counts[StatKind.BROWSER_SUCCESS]).toBe(1);
    expect(stats.counts[StatKind.FALLBACK_SUCCESS]).toBe(0);
    expect(stats.totalDuration.count).toBe(1);
    expect(stats.totalDuration.sum).toBe(100);
  });

  it('counts a fallback success when fallbackUsed is set', () => {
    let stats = createStats();
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.FALLBACK_SUCCESS,
      diagnostics: diagnostics({ fallbackUsed: true, finalRoute: 'server' }),
    });
    expect(stats.counts[StatKind.FALLBACK_SUCCESS]).toBe(1);
    expect(stats.counts[StatKind.BROWSER_SUCCESS]).toBe(0);
  });

  it('counts error kinds and cancelled separately', () => {
    let stats = createStats();
    stats = reduceStats(stats, { type: 'OUTCOME', kind: StatKind.FUNCTION_ERROR, diagnostics: null });
    stats = reduceStats(stats, { type: 'OUTCOME', kind: StatKind.CANCELLED, diagnostics: null });
    stats = reduceStats(stats, { type: 'OUTCOME', kind: StatKind.INPUT_ERROR, diagnostics: null });
    expect(stats.counts[StatKind.FUNCTION_ERROR]).toBe(1);
    expect(stats.counts[StatKind.CANCELLED]).toBe(1);
    expect(stats.counts[StatKind.INPUT_ERROR]).toBe(1);
    expect(stats.counts[StatKind.BROWSER_SUCCESS]).toBe(0);
  });

  it('counts a cache hit when manifestCache is hit', () => {
    let stats = createStats();
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.BROWSER_SUCCESS,
      diagnostics: diagnostics({ manifestCache: 'hit' }),
    });
    expect(stats.cacheHits).toBe(1);
  });

  it('does not count cache hits for a miss or for null diagnostics', () => {
    let stats = createStats();
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.BROWSER_SUCCESS,
      diagnostics: diagnostics({ manifestCache: 'miss' }),
    });
    stats = reduceStats(stats, { type: 'OUTCOME', kind: StatKind.INPUT_ERROR, diagnostics: null });
    expect(stats.cacheHits).toBe(0);
  });
});

describe('reduceStats — separate time samples', () => {
  it('keeps browser / server / total samples separate with counts', () => {
    let stats = createStats();
    const withAttempts = diagnostics({
      attempts: [
        { kind: 'browser', startedAt: 0, durationMs: 20, outcome: 'failed' },
        { kind: 'server', startedAt: 30, durationMs: 80, outcome: 'succeeded' },
      ],
    });
    stats = reduceStats(stats, { type: 'OUTCOME', kind: StatKind.FALLBACK_SUCCESS, diagnostics: withAttempts });

    expect(stats.totalDuration).toEqual({ sum: 100, count: 1 });
    expect(stats.browserDuration).toEqual({ sum: 20, count: 1 });
    expect(stats.serverDuration).toEqual({ sum: 80, count: 1 });

    expect(average(stats.browserDuration)).toBeCloseTo(20, 6);
    expect(average(stats.serverDuration)).toBeCloseTo(80, 6);
  });

  it('ignores malformed attempt entries instead of crashing', () => {
    let stats = createStats();
    const bad = diagnostics({
      attempts: [{ kind: 'browser', durationMs: 'not-a-number' }, { kind: 'server' }],
    });
    stats = reduceStats(stats, { type: 'OUTCOME', kind: StatKind.BROWSER_SUCCESS, diagnostics: bad });
    expect(stats.browserDuration).toEqual({ sum: 0, count: 0 });
    expect(stats.serverDuration).toEqual({ sum: 0, count: 0 });
    expect(stats.totalDuration.count).toBe(1);
  });

  it('counts samples across multiple runs (averages accumulate)', () => {
    let stats = createStats();
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.BROWSER_SUCCESS,
      diagnostics: diagnostics({ totalDurationMs: 10, attempts: [{ kind: 'browser', durationMs: 8, outcome: 'succeeded' }] }),
    });
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.BROWSER_SUCCESS,
      diagnostics: diagnostics({ totalDurationMs: 30, attempts: [{ kind: 'browser', durationMs: 24, outcome: 'succeeded' }] }),
    });
    expect(stats.totalDuration).toEqual({ sum: 40, count: 2 });
    expect(stats.browserDuration).toEqual({ sum: 32, count: 2 });
    expect(average(stats.totalDuration)).toBe(20);
    expect(average(stats.browserDuration)).toBe(16);
  });
});

describe('reduceStats — RESET', () => {
  it('RESET clears all counters and samples', () => {
    let stats = createStats();
    stats = reduceStats(stats, {
      type: 'OUTCOME',
      kind: StatKind.BROWSER_SUCCESS,
      diagnostics: diagnostics({ manifestCache: 'hit' }),
    });
    stats = reduceStats(stats, { type: 'RESET' });
    expect(stats).toEqual(createStats());
  });

  it('ignores unknown actions', () => {
    const stats = createStats();
    expect(reduceStats(stats, { type: 'NOPE' })).toEqual(stats);
  });
});
