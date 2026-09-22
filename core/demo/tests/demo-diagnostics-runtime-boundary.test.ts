import { describe, expect, it } from 'vitest';
import {
  isExecutionDiagnostics,
  normalizeAttempts,
  summarizeDiagnostics,
} from '../public/demo-diagnostics.js';

function validDiagnostics(overrides = {}) {
  return {
    executionId: 'exec-boundary',
    finalRoute: 'browser',
    fallbackUsed: false,
    attempts: [{ kind: 'browser', durationMs: 12, outcome: 'succeeded' }],
    totalDurationMs: 40,
    manifestCache: 'miss',
    ...overrides,
  };
}

describe('demo diagnostics runtime boundary', () => {
  it('fails closed on a revoked diagnostics root', () => {
    const { proxy, revoke } = Proxy.revocable(validDiagnostics(), {});
    revoke();

    expect(() => isExecutionDiagnostics(proxy)).not.toThrow();
    expect(isExecutionDiagnostics(proxy)).toBe(false);
    expect(summarizeDiagnostics(proxy)).toBeNull();
  });

  it('fails closed when a diagnostics field getter throws', () => {
    const diagnostics = validDiagnostics();
    Object.defineProperty(diagnostics, 'fallbackUsed', {
      get() {
        throw new Error('hostile getter');
      },
    });

    expect(isExecutionDiagnostics(diagnostics)).toBe(false);
    expect(summarizeDiagnostics(diagnostics)).toBeNull();
  });

  it('fails closed on a revoked attempts container', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    const diagnostics = validDiagnostics({ attempts: proxy });

    expect(isExecutionDiagnostics(diagnostics)).toBe(false);
    expect(summarizeDiagnostics(diagnostics)).toBeNull();
    expect(normalizeAttempts(proxy)).toEqual([]);
  });

  it('fails closed when attempts length cannot be read', () => {
    const attempts = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('hostile length');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(isExecutionDiagnostics(validDiagnostics({ attempts }))).toBe(false);
    expect(normalizeAttempts(attempts)).toEqual([]);
  });

  it('rejects a synthetic oversized attempts length before allocation or iteration', () => {
    let indexReads = 0;
    const attempts = new Proxy([], {
      get(target, property, receiver) {
        if (property === 'length') return 10_000;
        if (typeof property === 'string' && /^\d+$/.test(property)) indexReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });

    expect(isExecutionDiagnostics(validDiagnostics({ attempts }))).toBe(false);
    expect(normalizeAttempts(attempts)).toEqual([]);
    expect(indexReads).toBe(0);
  });

  it('does not invoke caller map or iterator hooks while normalizing attempts', () => {
    const calls: string[] = [];
    const attempts = [{ kind: 'server', durationMs: 4, outcome: 'failed' }];
    Object.defineProperty(attempts, 'map', {
      value() {
        calls.push('map');
        throw new Error('caller map must not run');
      },
    });
    Object.defineProperty(attempts, Symbol.iterator, {
      value() {
        calls.push('iterator');
        throw new Error('caller iterator must not run');
      },
    });

    expect(normalizeAttempts(attempts)).toEqual([
      { index: 1, kind: 'server', outcome: 'failed', durationMs: 4, errorCode: null },
    ]);
    expect(calls).toEqual([]);
  });

  it('sanitizes a throwing numeric-index trap without dropping sibling attempts', () => {
    const attempts = new Proxy([
      { kind: 'server', durationMs: 1, outcome: 'succeeded' },
      { kind: 'browser', durationMs: 2, outcome: 'failed' },
    ], {
      get(target, property, receiver) {
        if (property === '0') throw new Error('hostile index');
        return Reflect.get(target, property, receiver);
      },
    });

    expect(normalizeAttempts(attempts)).toEqual([
      { index: 1, kind: 'browser', outcome: 'unknown', durationMs: null, errorCode: null },
      { index: 2, kind: 'browser', outcome: 'failed', durationMs: 2, errorCode: null },
    ]);
  });

  it('sanitizes an attempt whose property getter throws', () => {
    const attempt = {
      get kind() {
        throw new Error('hostile attempt');
      },
    };

    expect(normalizeAttempts([attempt])).toEqual([
      { index: 1, kind: 'browser', outcome: 'unknown', durationMs: null, errorCode: null },
    ]);
  });

  it('reads diagnostics fields once for one summary operation', () => {
    const reads = new Map<string, number>();
    const source: Record<string, unknown> = validDiagnostics();
    const diagnostics = {};
    for (const field of [
      'executionId',
      'finalRoute',
      'fallbackUsed',
      'attempts',
      'totalDurationMs',
      'manifestCache',
    ]) {
      Object.defineProperty(diagnostics, field, {
        enumerable: true,
        get() {
          reads.set(field, (reads.get(field) ?? 0) + 1);
          return source[field];
        },
      });
    }

    expect(summarizeDiagnostics(diagnostics)).toEqual({
      finalRoute: 'browser',
      fallbackUsed: false,
      totalDurationMs: 40,
      manifestCache: 'miss',
      attempts: [
        { index: 1, kind: 'browser', outcome: 'succeeded', durationMs: 12, errorCode: null },
      ],
    });
    expect(Object.fromEntries(reads)).toEqual({
      executionId: 1,
      finalRoute: 1,
      fallbackUsed: 1,
      attempts: 1,
      totalDurationMs: 1,
      manifestCache: 1,
    });
  });
});
