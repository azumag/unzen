import { describe, expect, it } from 'vitest';
import { SpanRouter } from '../src/span-router.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier, type SegmentConfig } from '../src/types.js';

describe('SpanRouter segment array membership ownership', () => {
  it('captures later segment references before validating earlier segment fields', () => {
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('wide'), tier: WorkerTier.TIER_2, vramMB: 200 });

    const stableSecond: SegmentConfig = {
      index: 1,
      layerStart: 4,
      layerEnd: 7,
      modelWeightHash: '2'.repeat(64),
      estimatedVramMB: 100,
    };
    const alteredSecond: SegmentConfig = {
      ...stableSecond,
      estimatedVramMB: 10_000,
    };

    const segments: unknown[] = [];
    const first = {
      get index() {
        segments[1] = alteredSecond;
        return 0;
      },
      layerStart: 0,
      layerEnd: 3,
      modelWeightHash: '1'.repeat(64),
      estimatedVramMB: 100,
    };
    segments.push(first, stableSecond);

    const router = new SpanRouter(
      segments as unknown as readonly SegmentConfig[],
      pool,
    );

    expect(segments[1]).toBe(alteredSecond);
    expect(router.computeRoute()).toEqual([
      { workerId: workerId('wide'), startSegment: 0, endSegment: 1 },
    ]);
  });
});
