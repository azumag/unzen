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

describe('SpanPipeline runtime option envelope', () => {
  it('accepts defaults and preserves explicit zero retry/timeout/delay semantics', () => {
    expect(() => construct()).not.toThrow();
    expect(() => construct({
      maxRetries: 0,
      perSegmentTimeoutMs: 0,
      retryDelayMs: 0,
    })).not.toThrow();
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
