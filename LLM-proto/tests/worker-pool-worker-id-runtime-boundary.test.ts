import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerStatus, WorkerTier, type WorkerId } from '../src/types.js';

function populatedPool(): { pool: WorkerPool; id: WorkerId } {
  const pool = new WorkerPool();
  const id = workerId('worker-valid');
  pool.register({ workerId: id, tier: WorkerTier.TIER_2, vramMB: 4096 });
  return { pool, id };
}

const malformedIds: unknown[] = ['', '   ', 42, Symbol('worker')];

describe('WorkerPool worker-id runtime boundary', () => {
  it.each(malformedIds)(
    'rejects malformed worker identity %s in public lookup/mutation methods',
    (rawId) => {
      const { pool, id } = populatedPool();
      const malformed = rawId as WorkerId;

      expect(() => pool.unregister(malformed)).toThrow(/workerId must be a non-empty string/);
      expect(() => pool.heartbeat(malformed)).toThrow(/workerId must be a non-empty string/);
      expect(() => pool.markBusy(malformed, 1)).toThrow(/workerId must be a non-empty string/);
      expect(() => pool.markIdle(malformed)).toThrow(/workerId must be a non-empty string/);
      expect(() => pool.markDisconnected(malformed)).toThrow(/workerId must be a non-empty string/);
      expect(() => pool.get(malformed)).toThrow(/workerId must be a non-empty string/);

      expect(pool.size).toBe(1);
      expect(pool.get(id)?.status).toBe(WorkerStatus.IDLE);
      expect(pool.get(id)?.currentSegment).toBeUndefined();
    },
  );

  it('preserves markBusy segment-index validation ordering', () => {
    const pool = new WorkerPool();

    expect(() => pool.markBusy('   ' as WorkerId, -1)).toThrow(
      /segmentIndex must be a non-negative safe integer/,
    );
  });

  it('preserves valid unknown-worker no-op/false/undefined semantics', () => {
    const pool = new WorkerPool();
    const unknown = workerId('unknown-worker');

    expect(pool.unregister(unknown)).toBe(false);
    expect(pool.heartbeat(unknown)).toBe(false);
    expect(() => pool.markBusy(unknown, 1)).not.toThrow();
    expect(() => pool.markIdle(unknown)).not.toThrow();
    expect(() => pool.markDisconnected(unknown)).not.toThrow();
    expect(pool.get(unknown)).toBeUndefined();
  });

  it('keeps valid registered-worker lifecycle behavior unchanged', () => {
    const { pool, id } = populatedPool();

    pool.markBusy(id, 2);
    expect(pool.get(id)?.status).toBe(WorkerStatus.BUSY);
    expect(pool.get(id)?.currentSegment).toBe(2);

    pool.markIdle(id);
    expect(pool.get(id)?.status).toBe(WorkerStatus.IDLE);
    expect(pool.get(id)?.currentSegment).toBeUndefined();

    pool.markDisconnected(id);
    expect(pool.get(id)?.status).toBe(WorkerStatus.DISCONNECTED);
    expect(pool.heartbeat(id)).toBe(true);
    expect(pool.get(id)?.status).toBe(WorkerStatus.IDLE);

    expect(pool.unregister(id)).toBe(true);
    expect(pool.get(id)).toBeUndefined();
  });
});
