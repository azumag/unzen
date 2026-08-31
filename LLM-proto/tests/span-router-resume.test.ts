import { describe, expect, it } from 'vitest';
import { SpanRouter } from '../src/span-router.js';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier } from '../src/types.js';
import { makeSegments } from './test-helpers.js';

describe('SpanRouter suffix routing', () => {
  it('routes only the suffix after a durable checkpoint boundary', () => {
    const pool = new WorkerPool();
    pool.register({ workerId: workerId('worker-a'), tier: WorkerTier.TIER_2, vramMB: 4_200 });
    pool.register({ workerId: workerId('worker-b'), tier: WorkerTier.TIER_2, vramMB: 4_200 });

    const route = new SpanRouter(makeSegments(6), pool).computeRoute(2);

    expect(route).toEqual([
      { workerId: workerId('worker-a'), startSegment: 2, endSegment: 3 },
      { workerId: workerId('worker-b'), startSegment: 4, endSegment: 5 },
    ]);
  });

  it('returns an empty route when every segment is already complete', () => {
    expect(new SpanRouter(makeSegments(3), new WorkerPool()).computeRoute(3)).toEqual([]);
  });

  it.each([-1, 1.5, 4])('rejects invalid start segment %s', (startSegment) => {
    expect(() => new SpanRouter(makeSegments(3), new WorkerPool()).computeRoute(startSegment))
      .toThrow(/startSegment/);
  });
});
