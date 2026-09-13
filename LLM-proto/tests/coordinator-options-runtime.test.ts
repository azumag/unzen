import { describe, expect, it, vi } from 'vitest';
import { Coordinator, type CoordinatorOptions } from '../src/coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type { SegmentExecutor } from '../src/pipeline.js';

const executor: SegmentExecutor = {
  execute: vi.fn(async () => {
    throw new Error('executor must not run during coordinator construction');
  }),
};

function construct(options?: Partial<CoordinatorOptions>): Coordinator {
  return new Coordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    options,
  );
}

describe('Coordinator runtime option envelope', () => {
  it('keeps fixture manifests opt-in with a strict boolean gate', () => {
    expect(() => construct({ allowFixtureManifest: true })).not.toThrow();
    expect(() => construct({ allowFixtureManifest: false })).toThrow(/fixture|production/i);
    expect(() => construct()).toThrow(/fixture|production/i);

    expect(() => construct({
      allowFixtureManifest: 'false' as unknown as boolean,
    })).toThrow(/allowFixtureManifest must be a boolean/i);
  });

  it('rejects malformed top-level option containers before manifest validation', () => {
    const malformed: readonly unknown[] = [null, [], 'options', 1, Symbol('options')];

    for (const candidate of malformed) {
      expect(() => construct(candidate as Partial<CoordinatorOptions>)).toThrow(
        /options must be a non-null, non-array object/i,
      );
    }
  });

  it.each([
    ['heartbeatIntervalMs', Symbol('interval')],
    ['heartbeatIntervalMs', Number.NaN],
    ['heartbeatIntervalMs', Number.POSITIVE_INFINITY],
    ['heartbeatIntervalMs', Number.NEGATIVE_INFINITY],
    ['heartbeatIntervalMs', -1],
    ['heartbeatTimeoutMs', Symbol('heartbeat-timeout')],
    ['heartbeatTimeoutMs', Number.NaN],
    ['heartbeatTimeoutMs', Number.POSITIVE_INFINITY],
    ['heartbeatTimeoutMs', Number.NEGATIVE_INFINITY],
    ['heartbeatTimeoutMs', -1],
    ['segmentTimeoutMs', Symbol('segment-timeout')],
    ['segmentTimeoutMs', Number.NaN],
    ['segmentTimeoutMs', Number.POSITIVE_INFINITY],
    ['segmentTimeoutMs', Number.NEGATIVE_INFINITY],
    ['segmentTimeoutMs', -1],
    ['retryDelayMs', Symbol('retry-delay')],
    ['retryDelayMs', Number.NaN],
    ['retryDelayMs', Number.POSITIVE_INFINITY],
    ['retryDelayMs', Number.NEGATIVE_INFINITY],
    ['retryDelayMs', -1],
  ] as const)(
    'rejects malformed %s=%s before manifest validation',
    (field, value) => {
      const options = {
        allowFixtureManifest: true,
        [field]: value,
      } as unknown as Partial<CoordinatorOptions>;
      expect(() => construct(options)).toThrow(
        new RegExp(`${field} must be a non-negative finite number`, 'i'),
      );
    },
  );

  it('rejects malformed maxRetries and totalSegments before manifest validation', () => {
    const malformed: readonly unknown[] = [
      Symbol('value'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
    ];

    for (const value of malformed) {
      expect(() => construct({
        allowFixtureManifest: true,
        maxRetries: value as number,
      })).toThrow(/maxRetries must be a non-negative safe integer/i);

      expect(() => construct({
        allowFixtureManifest: true,
        totalSegments: value as number,
      })).toThrow(/totalSegments must be a non-negative safe integer/i);
    }
  });

  it('preserves existing defaults and explicit zero control values', () => {
    expect(() => construct({
      allowFixtureManifest: true,
      totalSegments: 1,
    })).not.toThrow();

    expect(() => construct({
      allowFixtureManifest: true,
      totalSegments: 1,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    })).not.toThrow();
  });
});
