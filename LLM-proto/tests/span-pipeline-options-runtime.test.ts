import { describe, expect, it, vi } from 'vitest';
import type { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import { CheckpointStore } from '../src/checkpoint.js';
import {
  SpanPipeline,
  type SpanExecutor,
  type SpanPipelineOptions,
} from '../src/span-pipeline.js';
import { WorkerPool } from '../src/worker-pool.js';

const executor: SpanExecutor = {
  execute: vi.fn(async () => {
    throw new Error('executor must not run during option preflight');
  }),
};

function construct(options?: Partial<SpanPipelineOptions>): SpanPipeline {
  return new SpanPipeline(
    [],
    new WorkerPool(),
    new CheckpointStore(),
    executor,
    options,
  );
}

function readOptions(pipeline: SpanPipeline): SpanPipelineOptions {
  return (pipeline as unknown as { readonly options: SpanPipelineOptions }).options;
}

describe('SpanPipeline runtime option envelope', () => {
  it('accepts defaults and preserves explicit zero retry/timeout/delay semantics', () => {
    expect(readOptions(construct())).toEqual({
      maxRetries: 2,
      perSegmentTimeoutMs: 10_000,
      retryDelayMs: 1_000,
    });
    expect(readOptions(construct({
      maxRetries: 0,
      perSegmentTimeoutMs: 0,
      retryDelayMs: 0,
    }))).toEqual({
      maxRetries: 0,
      perSegmentTimeoutMs: 0,
      retryDelayMs: 0,
    });
    expect(readOptions(construct({
      maxRetries: 5,
      perSegmentTimeoutMs: 12_345,
      retryDelayMs: 67,
    }))).toEqual({
      maxRetries: 5,
      perSegmentTimeoutMs: 12_345,
      retryDelayMs: 67,
    });
  });

  it('reads declared fields once without enumerating unrelated caller properties', () => {
    const assertCompatibleSegments = vi.fn();
    const ledger = { assertCompatibleSegments } as unknown as ArtifactResidencyLedger;
    const reads = {
      maxRetries: 0,
      perSegmentTimeoutMs: 0,
      retryDelayMs: 0,
      artifactResidencyLedger: 0,
    };
    const target = Object.defineProperties({}, {
      maxRetries: {
        enumerable: true,
        get: () => {
          reads.maxRetries += 1;
          return reads.maxRetries === 1 ? 5 : -1;
        },
      },
      perSegmentTimeoutMs: {
        enumerable: true,
        get: () => {
          reads.perSegmentTimeoutMs += 1;
          return reads.perSegmentTimeoutMs === 1 ? 12_345 : Number.NaN;
        },
      },
      retryDelayMs: {
        enumerable: true,
        get: () => {
          reads.retryDelayMs += 1;
          return reads.retryDelayMs === 1 ? 67 : Number.NEGATIVE_INFINITY;
        },
      },
      artifactResidencyLedger: {
        enumerable: true,
        get: () => {
          reads.artifactResidencyLedger += 1;
          if (reads.artifactResidencyLedger === 1) return ledger;
          throw new Error('residency ledger must not be read twice');
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
    }) as Partial<SpanPipelineOptions>;

    const resolved = readOptions(construct(options));
    expect(resolved).toEqual({
      maxRetries: 5,
      perSegmentTimeoutMs: 12_345,
      retryDelayMs: 67,
      artifactResidencyLedger: ledger,
    });
    expect(resolved.artifactResidencyLedger).toBe(ledger);
    expect(reads).toEqual({
      maxRetries: 1,
      perSegmentTimeoutMs: 1,
      retryDelayMs: 1,
      artifactResidencyLedger: 1,
    });
    expect(assertCompatibleSegments).toHaveBeenCalledOnce();
    expect(assertCompatibleSegments).toHaveBeenCalledWith([]);
  });

  it('preserves spread-era defaults for inherited and non-enumerable declared fields', () => {
    let inheritedReads = 0;
    const inheritedLedger = {
      assertCompatibleSegments: vi.fn(),
    } as unknown as ArtifactResidencyLedger;
    const prototype = Object.defineProperties({}, {
      maxRetries: {
        enumerable: true,
        get: () => {
          inheritedReads += 1;
          return 9;
        },
      },
      artifactResidencyLedger: {
        enumerable: true,
        get: () => {
          inheritedReads += 1;
          return inheritedLedger;
        },
      },
    });
    const options = Object.create(prototype) as Partial<SpanPipelineOptions>;
    Object.defineProperty(options, 'perSegmentTimeoutMs', {
      enumerable: false,
      value: 12_345,
    });

    expect(readOptions(construct(options))).toEqual({
      maxRetries: 2,
      perSegmentTimeoutMs: 10_000,
      retryDelayMs: 1_000,
    });
    expect(inheritedReads).toBe(0);
    expect(inheritedLedger.assertCompatibleSegments).not.toHaveBeenCalled();
  });

  it('does not read artifact residency dependency when numeric validation fails', () => {
    let ledgerReads = 0;
    const options = Object.defineProperties({}, {
      maxRetries: {
        enumerable: true,
        value: -1,
      },
      artifactResidencyLedger: {
        enumerable: true,
        get: () => {
          ledgerReads += 1;
          throw new Error('ledger getter must not run for an invalid numeric envelope');
        },
      },
    }) as Partial<SpanPipelineOptions>;

    expect(() => construct(options)).toThrow(/maxRetries must be a non-negative safe integer/i);
    expect(ledgerReads).toBe(0);
  });

  it('rejects malformed top-level option containers', () => {
    const malformed: readonly unknown[] = [null, [], 'options', 1, Symbol('options')];

    for (const candidate of malformed) {
      expect(() => construct(candidate as Partial<SpanPipelineOptions>)).toThrow(
        /options must be a non-null, non-array object/i,
      );
    }
  });

  it('rejects malformed maxRetries values before dependency side effects', () => {
    const malformed: readonly unknown[] = [
      Symbol('retries'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      1.5,
    ];

    for (const value of malformed) {
      const assertCompatibleSegments = vi.fn();
      const ledger = { assertCompatibleSegments } as unknown as ArtifactResidencyLedger;
      expect(() => construct({
        artifactResidencyLedger: ledger,
        maxRetries: value as number,
      })).toThrow(/maxRetries must be a non-negative safe integer/i);
      expect(assertCompatibleSegments).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['perSegmentTimeoutMs', Symbol('timeout')],
    ['perSegmentTimeoutMs', Number.NaN],
    ['perSegmentTimeoutMs', Number.POSITIVE_INFINITY],
    ['perSegmentTimeoutMs', Number.NEGATIVE_INFINITY],
    ['perSegmentTimeoutMs', -1],
    ['retryDelayMs', Symbol('delay')],
    ['retryDelayMs', Number.NaN],
    ['retryDelayMs', Number.POSITIVE_INFINITY],
    ['retryDelayMs', Number.NEGATIVE_INFINITY],
    ['retryDelayMs', -1],
  ] as const)(
    'rejects malformed %s=%s before residency checks',
    (field, value) => {
      const assertCompatibleSegments = vi.fn();
      const ledger = { assertCompatibleSegments } as unknown as ArtifactResidencyLedger;
      const options = {
        artifactResidencyLedger: ledger,
        [field]: value,
      } as unknown as Partial<SpanPipelineOptions>;

      expect(() => construct(options)).toThrow(new RegExp(`${field} must be a non-negative finite number`, 'i'));
      expect(assertCompatibleSegments).not.toHaveBeenCalled();
    },
  );

  it('runs artifact compatibility only after the numeric envelope is validated', () => {
    const assertCompatibleSegments = vi.fn();
    const ledger = { assertCompatibleSegments } as unknown as ArtifactResidencyLedger;

    expect(() => construct({
      maxRetries: 0,
      perSegmentTimeoutMs: 0,
      retryDelayMs: 0,
      artifactResidencyLedger: ledger,
    })).not.toThrow();
    expect(assertCompatibleSegments).toHaveBeenCalledOnce();
    expect(assertCompatibleSegments).toHaveBeenCalledWith([]);
  });
});
