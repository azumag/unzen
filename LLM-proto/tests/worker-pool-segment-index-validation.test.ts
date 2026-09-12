import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';

describe('WorkerPool busy segment index validation', () => {
  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    '1' as unknown as number,
    null as unknown as number,
    Symbol('segment') as unknown as number,
  ])('rejects malformed segment index %s before mutating worker state', (segmentIndex) => {
    const pool = new WorkerPool();
    const id = workerId('worker-a');
    pool.register({ workerId: id, tier: WorkerTier.TIER_2, vramMB: 4096 });

    expect(() => pool.markBusy(id, segmentIndex)).toThrow(
      /segmentIndex must be a non-negative safe integer/,
    );
    expect(pool.get(id)?.status).toBe(WorkerStatus.IDLE);
    expect(pool.get(id)?.currentSegment).toBeUndefined();
  });

  it('preserves valid busy-state behavior and unknown-worker no-op semantics', () => {
    const pool = new WorkerPool();
    const id = workerId('worker-a');
    pool.register({ workerId: id, tier: WorkerTier.TIER_2, vramMB: 4096 });

    expect(() => pool.markBusy(workerId('unknown'), 4)).not.toThrow();
    pool.markBusy(id, 4);

    expect(pool.get(id)?.status).toBe(WorkerStatus.BUSY);
    expect(pool.get(id)?.currentSegment).toBe(4);
  });
});
