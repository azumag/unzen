import { describe, expect, it } from 'vitest';
import type { ArtifactResidencyLedger } from '../src/artifact-residency-ledger.js';
import { SpanRouter } from '../src/span-router.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier, type SegmentConfig } from '../src/types.js';

function makeMutableSegments(): SegmentConfig[] {
  return [
    {
      index: 0,
      layerStart: 0,
      layerEnd: 3,
      modelWeightHash: '1'.repeat(64),
      estimatedVramMB: 100,
    },
    {
      index: 1,
      layerStart: 4,
      layerEnd: 7,
      modelWeightHash: '2'.repeat(64),
      estimatedVramMB: 100,
    },
  ];
}

describe('SpanRouter segment ownership', () => {
  it('routes from the constructor-owned snapshot after caller mutation', () => {
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('wide'), tier: WorkerTier.TIER_2, vramMB: 200 });

    const segments = makeMutableSegments();
    const router = new SpanRouter(segments, pool);

    (segments[0] as { estimatedVramMB: number }).estimatedVramMB = 10_000;
    segments.push({
      index: 2,
      layerStart: 8,
      layerEnd: 11,
      modelWeightHash: '3'.repeat(64),
      estimatedVramMB: 100,
    });

    expect(router.computeRoute()).toEqual([
      { workerId: workerId('wide'), startSegment: 0, endSegment: 1 },
    ]);
  });

  it('captures each consumed field once before handing the owned snapshot to residency checks', () => {
    const fields = [
      'index',
      'layerStart',
      'layerEnd',
      'modelWeightHash',
      'estimatedVramMB',
    ] as const;
    const stable: SegmentConfig = {
      index: 0,
      layerStart: 0,
      layerEnd: 3,
      modelWeightHash: '1'.repeat(64),
      estimatedVramMB: 100,
    };
    const altered: SegmentConfig = {
      index: 99,
      layerStart: 40,
      layerEnd: 400,
      modelWeightHash: 'changed',
      estimatedVramMB: 10_000,
    };
    const reads = new Map<(typeof fields)[number], number>();
    const runtimeSegment: Record<string, unknown> = {};

    for (const field of fields) {
      Object.defineProperty(runtimeSegment, field, {
        enumerable: true,
        get() {
          const count = (reads.get(field) ?? 0) + 1;
          reads.set(field, count);
          return count === 1 ? stable[field] : altered[field];
        },
      });
    }

    let compatibleSegments: readonly SegmentConfig[] | undefined;
    const ledger = {
      assertCompatibleSegments(segments: readonly SegmentConfig[]) {
        compatibleSegments = segments;
      },
    } as unknown as ArtifactResidencyLedger;

    new SpanRouter(
      [runtimeSegment] as unknown as readonly SegmentConfig[],
      new WorkerPool(),
      ledger,
    );

    expect(compatibleSegments?.[0]).toEqual(stable);
    for (const field of fields) {
      expect(reads.get(field)).toBe(1);
    }
  });

  it('preserves fail-fast field ordering when an early captured field is invalid', () => {
    let indexReads = 0;
    let layerStartReads = 0;
    const runtimeSegment = {
      get index() {
        indexReads += 1;
        return -1;
      },
      get layerStart() {
        layerStartReads += 1;
        return 0;
      },
      layerEnd: 3,
      modelWeightHash: '1'.repeat(64),
      estimatedVramMB: 100,
    };

    expect(() => new SpanRouter(
      [runtimeSegment] as unknown as readonly SegmentConfig[],
      new WorkerPool(),
    )).toThrow(/SpanRouter segment index must be a non-negative safe integer/);
    expect(indexReads).toBe(1);
    expect(layerStartReads).toBe(0);
  });

  it('rejects non-array segment input before routing', () => {
    expect(() => new SpanRouter(
      { 0: makeMutableSegments()[0], length: 1 } as unknown as readonly SegmentConfig[],
      new WorkerPool(),
    )).toThrow(/SpanRouter segments must be an array/);
  });

  it.each([
    null,
    [],
    'segment',
    Symbol('segment'),
  ])('rejects malformed runtime segment containers before field access', (runtimeSegment) => {
    const segments = makeMutableSegments() as unknown[];
    segments[0] = runtimeSegment;

    expect(() => new SpanRouter(
      segments as unknown as readonly SegmentConfig[],
      new WorkerPool(),
    )).toThrow(/SpanRouter segment 0 must be an object/);
  });

  it.each([
    Symbol('bad-index'),
    '0',
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    -1,
  ])('rejects malformed runtime segment index %s without coercion', (runtimeIndex) => {
    const segments = makeMutableSegments();
    (segments[0] as { index: unknown }).index = runtimeIndex;

    expect(() => new SpanRouter(segments, new WorkerPool()))
      .toThrow(/SpanRouter segment index must be a non-negative safe integer/);
  });

  it.each([
    ['layerStart', Symbol('layer-start'), /layerStart must be a non-negative safe integer/],
    ['layerStart', -1, /layerStart must be a non-negative safe integer/],
    ['layerStart', Number.MAX_SAFE_INTEGER + 1, /layerStart must be a non-negative safe integer/],
    ['layerEnd', Symbol('layer-end'), /layerEnd must be a safe integer/],
    ['layerEnd', Number.MAX_SAFE_INTEGER + 1, /layerEnd must be a safe integer/],
  ] as const)(
    'rejects malformed runtime %s before routing',
    (field, runtimeValue, pattern) => {
      const segments = makeMutableSegments();
      (segments[0] as unknown as Record<string, unknown>)[field] = runtimeValue;

      expect(() => new SpanRouter(segments, new WorkerPool())).toThrow(pattern);
    },
  );

  it('rejects a reversed layer range', () => {
    const segments = makeMutableSegments();
    (segments[0] as { layerEnd: number }).layerEnd = -1;

    expect(() => new SpanRouter(segments, new WorkerPool()))
      .toThrow(/layerEnd must be a safe integer greater than or equal to layerStart/);
  });

  it('rejects non-contiguous layer ranges before route construction', () => {
    const segments = makeMutableSegments();
    (segments[1] as { layerStart: number }).layerStart = 5;

    expect(() => new SpanRouter(segments, new WorkerPool()))
      .toThrow(/layer ranges must be contiguous/);
  });

  it.each([
    '',
    '   ',
    7,
    Symbol('hash'),
  ])('rejects malformed runtime modelWeightHash %s without coercion', (runtimeHash) => {
    const segments = makeMutableSegments();
    (segments[0] as { modelWeightHash: unknown }).modelWeightHash = runtimeHash;

    expect(() => new SpanRouter(segments, new WorkerPool()))
      .toThrow(/modelWeightHash must be a non-empty string/);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '100',
    Symbol('vram'),
  ])('rejects malformed runtime estimatedVramMB %s without coercion', (runtimeVram) => {
    const segments = makeMutableSegments();
    (segments[0] as { estimatedVramMB: unknown }).estimatedVramMB = runtimeVram;

    expect(() => new SpanRouter(segments, new WorkerPool()))
      .toThrow(/estimatedVramMB must be a positive finite number/);
  });

  it('validates segment fields before manifest-backed residency compatibility checks', () => {
    const segments = makeMutableSegments();
    (segments[0] as { modelWeightHash: unknown }).modelWeightHash = Symbol('hash');
    let compatibilityChecked = false;
    const ledger = {
      assertCompatibleSegments: () => {
        compatibilityChecked = true;
      },
    } as unknown as ArtifactResidencyLedger;

    expect(() => new SpanRouter(segments, new WorkerPool(), ledger))
      .toThrow(/modelWeightHash must be a non-empty string/);
    expect(compatibilityChecked).toBe(false);
  });
});
