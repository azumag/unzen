import { describe, expect, it } from 'vitest';
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

  it('rejects non-array segment input before routing', () => {
    expect(() => new SpanRouter(
      { 0: makeMutableSegments()[0], length: 1 } as unknown as readonly SegmentConfig[],
      new WorkerPool(),
    )).toThrow(/SpanRouter segments must be an array/);
  });
});
