import { describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  Pipeline,
  type PipelineOptions,
  type SegmentExecutor,
} from '../src/pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';

function makeExecutor() {
  return {
    execute: vi.fn(async () => {
      throw new Error('executor must not run during option preflight');
    }),
  } satisfies SegmentExecutor;
}

function construct(
  options?: Partial<PipelineOptions>,
  executor: SegmentExecutor = makeExecutor(),
): Pipeline {
  return new Pipeline(
    [],
    new WorkerPool(),
    new CheckpointStore(),
    executor,
    options,
  );
}

function readOptions(pipeline: Pipeline): PipelineOptions {
  return (pipeline as unknown as { readonly options: PipelineOptions }).options;
}

describe('Pipeline runtime option envelope', () => {
  it('accepts defaults and preserves explicit zero retry/timeout/delay semantics', () => {
    expect(readOptions(construct())).toEqual({
      maxRetries: 2,
      segmentTimeoutMs: 30_000,
      retryDelayMs: 1_000,
    });
    expect(readOptions(construct({
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    }))).toEqual({
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    });
    expect(readOptions(construct({
      maxRetries: 4,
      segmentTimeoutMs: 12_345,
      retryDelayMs: 67,
    }))).toEqual({
      maxRetries: 4,
      segmentTimeoutMs: 12_345,
      retryDelayMs: 67,
    });
  });

  it('reads declared fields once without enumerating unrelated caller properties', () => {
    const reads = {
      maxRetries: 0,
      segmentTimeoutMs: 0,
      retryDelayMs: 0,
    };
    const target = Object.defineProperties({}, {
      maxRetries: {
        enumerable: true,
        get: () => {
          reads.maxRetries += 1;
          return reads.maxRetries === 1 ? 4 : -1;
        },
      },
      segmentTimeoutMs: {
        enumerable: true,
        get: () => {
          reads.segmentTimeoutMs += 1;
          return reads.segmentTimeoutMs === 1 ? 12_345 : Number.NaN;
        },
      },
      retryDelayMs: {
        enumerable: true,
        get: () => {
          reads.retryDelayMs += 1;
          return reads.retryDelayMs === 1 ? 67 : Number.NEGATIVE_INFINITY;
        },
      },
      unrelated: {
        enumerable: true,
        get: () => {
          throw new Error('unrelated getter must not run');
        },
      },
    });
    const options = new Proxy(target, {
      ownKeys: () => {
        throw new Error('caller options must not be enumerated');
      },
    }) as Partial<PipelineOptions>;

    expect(readOptions(construct(options))).toEqual({
      maxRetries: 4,
      segmentTimeoutMs: 12_345,
      retryDelayMs: 67,
    });
    expect(reads).toEqual({
      maxRetries: 1,
      segmentTimeoutMs: 1,
      retryDelayMs: 1,
    });
  });

  it('rejects malformed top-level option containers before executor work', () => {
    const malformed: readonly unknown[] = [null, [], 'options', 1, Symbol('options')];

    for (const candidate of malformed) {
      const executor = makeExecutor();
      expect(() => construct(candidate as Partial<PipelineOptions>, executor)).toThrow(
        /options must be a non-null, non-array object/i,
      );
      expect(executor.execute).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed maxRetries values before executor work', () => {
    const malformed: readonly unknown[] = [
      Symbol('retries'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
    ];

    for (const value of malformed) {
      const executor = makeExecutor();
      expect(() => construct({ maxRetries: value as number }, executor)).toThrow(
        /maxRetries must be a non-negative safe integer/i,
      );
      expect(executor.execute).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['segmentTimeoutMs', Symbol('timeout')],
    ['segmentTimeoutMs', Number.NaN],
    ['segmentTimeoutMs', Number.POSITIVE_INFINITY],
    ['segmentTimeoutMs', Number.NEGATIVE_INFINITY],
    ['segmentTimeoutMs', -1],
    ['retryDelayMs', Symbol('delay')],
    ['retryDelayMs', Number.NaN],
    ['retryDelayMs', Number.POSITIVE_INFINITY],
    ['retryDelayMs', Number.NEGATIVE_INFINITY],
    ['retryDelayMs', -1],
  ] as const)(
    'rejects malformed %s=%s before executor work',
    (field, value) => {
      const executor = makeExecutor();
      const options = { [field]: value } as unknown as Partial<PipelineOptions>;

      expect(() => construct(options, executor)).toThrow(
        new RegExp(`${field} must be a non-negative finite number`, 'i'),
      );
      expect(executor.execute).not.toHaveBeenCalled();
    },
  );
});
