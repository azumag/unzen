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

function readOptions(coordinator: Coordinator): CoordinatorOptions {
  return (coordinator as unknown as { readonly options: CoordinatorOptions }).options;
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

  it('captures declared own-enumerable fields once without enumerating unrelated properties', () => {
    const reads = {
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
      totalSegments: 0,
      allowFixtureManifest: 0,
    };
    const first = {
      heartbeatIntervalMs: 11,
      heartbeatTimeoutMs: 22,
      maxRetries: 3,
      segmentTimeoutMs: 44,
      retryDelayMs: 55,
      totalSegments: 1,
      allowFixtureManifest: true,
    } satisfies CoordinatorOptions;
    const second = {
      heartbeatIntervalMs: Number.NaN,
      heartbeatTimeoutMs: -1,
      maxRetries: 1.5,
      segmentTimeoutMs: Number.POSITIVE_INFINITY,
      retryDelayMs: Number.NEGATIVE_INFINITY,
      totalSegments: 2,
      allowFixtureManifest: false,
    } satisfies CoordinatorOptions;
    const target = Object.defineProperties({}, {
      ...Object.fromEntries(
        (Object.keys(first) as Array<keyof typeof first>).map((field) => [
          field,
          {
            enumerable: true,
            configurable: true,
            get: () => {
              reads[field] += 1;
              return reads[field] === 1 ? first[field] : second[field];
            },
          },
        ]),
      ),
      unrelated: {
        enumerable: true,
        configurable: true,
        get: () => {
          throw new Error('unrelated getter must not run');
        },
      },
    });
    const options = new Proxy(target, {
      ownKeys: () => {
        throw new Error('caller options must not be enumerated');
      },
    }) as Partial<CoordinatorOptions>;

    expect(readOptions(construct(options))).toEqual(first);
    expect(reads).toEqual({
      heartbeatIntervalMs: 1,
      heartbeatTimeoutMs: 1,
      maxRetries: 1,
      segmentTimeoutMs: 1,
      retryDelayMs: 1,
      totalSegments: 1,
      allowFixtureManifest: 1,
    });
  });

  it('preserves spread-era behavior for inherited and non-enumerable declared fields', () => {
    let inheritedReads = 0;
    const prototype = Object.defineProperties({}, {
      maxRetries: {
        enumerable: true,
        get: () => {
          inheritedReads += 1;
          return 9;
        },
      },
      totalSegments: {
        enumerable: true,
        get: () => {
          inheritedReads += 1;
          return 99;
        },
      },
    });
    const options = Object.create(prototype) as Partial<CoordinatorOptions>;
    Object.defineProperties(options, {
      allowFixtureManifest: {
        enumerable: true,
        value: true,
      },
      heartbeatIntervalMs: {
        enumerable: false,
        value: 123,
      },
    });

    const resolved = readOptions(construct(options));
    expect(resolved).toEqual({
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 15_000,
      maxRetries: 2,
      segmentTimeoutMs: 30_000,
      retryDelayMs: 1_000,
      allowFixtureManifest: true,
    });
    expect(Object.hasOwn(resolved, 'totalSegments')).toBe(false);
    expect(inheritedReads).toBe(0);
  });

  it('ignores inherited fixture opt-in without invoking its getter', () => {
    let reads = 0;
    const prototype = Object.defineProperty({}, 'allowFixtureManifest', {
      enumerable: true,
      get: () => {
        reads += 1;
        return true;
      },
    });
    const options = Object.create(prototype) as Partial<CoordinatorOptions>;

    expect(() => construct(options)).toThrow(/fixture|production/i);
    expect(reads).toBe(0);
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
    expect(readOptions(construct({
      allowFixtureManifest: true,
      totalSegments: 1,
    }))).toEqual({
      heartbeatIntervalMs: 5_000,
      heartbeatTimeoutMs: 15_000,
      maxRetries: 2,
      segmentTimeoutMs: 30_000,
      retryDelayMs: 1_000,
      totalSegments: 1,
      allowFixtureManifest: true,
    });

    expect(readOptions(construct({
      allowFixtureManifest: true,
      totalSegments: 1,
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    }))).toEqual({
      heartbeatIntervalMs: 0,
      heartbeatTimeoutMs: 0,
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
      totalSegments: 1,
      allowFixtureManifest: true,
    });
  });
});
