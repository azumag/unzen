import { describe, expect, it } from 'vitest';
import type { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import {
  AdaptiveChunkDispatcher,
  type AdaptiveChunkDispatcherOptions,
} from '../src/adaptive-chunk-dispatcher.js';
import type { SegmentConfig } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

function construct(options: unknown): () => AdaptiveChunkDispatcher {
  return () => new AdaptiveChunkDispatcher(options as AdaptiveChunkDispatcherOptions);
}

function malformedSegment(
  mutate: (segment: Record<string, unknown>) => void,
): readonly SegmentConfig[] {
  const segments = makeSegments(1);
  mutate(segments[0] as unknown as Record<string, unknown>);
  return segments;
}

describe('AdaptiveChunkDispatcher segment runtime envelope', () => {
  it.each([
    null,
    undefined,
    42,
    'segments',
    true,
    Symbol('options'),
    [],
    () => undefined,
  ])('rejects malformed top-level options before field access', (options) => {
    expect(construct(options)).toThrow(/options must be a non-null object/);
  });

  it.each([
    null,
    undefined,
    42,
    'segments',
    true,
    Symbol('segments'),
    {},
  ])('rejects a non-array segments container', (segments) => {
    expect(construct({ segments })).toThrow(/segments must be an array/);
  });

  it('preserves the existing non-empty segment requirement', () => {
    expect(construct({ segments: [] })).toThrow(/requires at least one segment/);
  });

  it('captures options.segments exactly once before container validation', () => {
    const segments = makeSegments(2);
    let reads = 0;
    const options = Object.defineProperty({}, 'segments', {
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? segments : [];
      },
    });

    expect(construct(options)).not.toThrow();
    expect(reads).toBe(1);
  });

  it('captures top-level membership before reading any segment fields', () => {
    const segments = makeSegments(2);
    const firstSegment = segments[0] as unknown as Record<string, unknown>;
    let indexReads = 0;
    Object.defineProperty(firstSegment, 'index', {
      configurable: true,
      get() {
        indexReads += 1;
        (segments as unknown as unknown[])[1] = {
          index: 'mutated-after-membership-capture',
        };
        return 0;
      },
    });

    expect(construct({ segments })).not.toThrow();
    expect(indexReads).toBeGreaterThan(0);
  });

  it.each([
    [[null], /segment 0 must be an object/],
    [[[]], /segment 0 must be an object/],
    [[Symbol('segment')], /segment 0 must be an object/],
    [
      malformedSegment((segment) => { segment.index = '0'; }),
      /segment index must be a non-negative safe integer/,
    ],
    [
      malformedSegment((segment) => { segment.index = Number.MAX_SAFE_INTEGER + 1; }),
      /segment index must be a non-negative safe integer/,
    ],
    [
      malformedSegment((segment) => { segment.index = -1; }),
      /segment index must be a non-negative safe integer/,
    ],
    [
      malformedSegment((segment) => { segment.layerStart = '0'; }),
      /layerStart must be a non-negative safe integer/,
    ],
    [
      malformedSegment((segment) => { segment.layerStart = Number.MAX_SAFE_INTEGER + 1; }),
      /layerStart must be a non-negative safe integer/,
    ],
    [
      malformedSegment((segment) => { segment.layerEnd = '7'; }),
      /layerEnd must be a safe integer greater than or equal to layerStart/,
    ],
    [
      malformedSegment((segment) => { segment.layerEnd = Number.MAX_SAFE_INTEGER + 1; }),
      /layerEnd must be a safe integer greater than or equal to layerStart/,
    ],
    [
      malformedSegment((segment) => { segment.layerEnd = -1; }),
      /layerEnd must be a safe integer greater than or equal to layerStart/,
    ],
    [
      malformedSegment((segment) => { segment.modelWeightHash = Symbol('hash'); }),
      /modelWeightHash must be a non-empty string/,
    ],
    [
      malformedSegment((segment) => { segment.modelWeightHash = '   '; }),
      /modelWeightHash must be a non-empty string/,
    ],
    [
      malformedSegment((segment) => { segment.estimatedVramMB = '2100'; }),
      /estimatedVramMB must be a positive finite number/,
    ],
    [
      malformedSegment((segment) => { segment.estimatedVramMB = Number.NaN; }),
      /estimatedVramMB must be a positive finite number/,
    ],
    [
      malformedSegment((segment) => { segment.estimatedVramMB = Number.POSITIVE_INFINITY; }),
      /estimatedVramMB must be a positive finite number/,
    ],
    [
      malformedSegment((segment) => { segment.estimatedVramMB = 0; }),
      /estimatedVramMB must be a positive finite number/,
    ],
  ] as const)('rejects malformed segment values deterministically', (segments, expected) => {
    expect(construct({ segments })).toThrow(expected);
  });

  it('requires array-order indexes without coercing values', () => {
    const segments = makeSegments(2);
    segments[1] = { ...segments[1], index: 0 };
    expect(construct({ segments })).toThrow(/expected 1, found 0/);
  });

  it('requires adjacent layer ranges to be contiguous', () => {
    const segments = makeSegments(2);
    segments[1] = {
      ...segments[1],
      layerStart: 9,
      layerEnd: 16,
    };
    expect(construct({ segments })).toThrow(/layer ranges must be contiguous/);
  });

  it('validates malformed segments before manifest-backed compatibility checks', () => {
    let compatibilityChecks = 0;
    const ledger = {
      assertCompatibleSegments: () => {
        compatibilityChecks += 1;
      },
    } as unknown as ArtifactResidencyLedger;
    const segments = malformedSegment((segment) => {
      segment.modelWeightHash = Symbol('unsafe-hash');
    });

    expect(construct({
      segments,
      artifactResidencyLedger: ledger,
    })).toThrow(/modelWeightHash must be a non-empty string/);
    expect(compatibilityChecks).toBe(0);
  });

  it('keeps legacy prototype hash syntax valid', () => {
    expect(construct({ segments: makeSegments(2) })).not.toThrow();
  });
});
