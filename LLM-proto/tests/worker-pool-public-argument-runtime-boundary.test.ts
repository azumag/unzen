import { describe, expect, it } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerStatus, WorkerTier } from '../src/types.js';

function hostileNumericValue(counter: { count: number }): object {
  const fail = () => {
    counter.count += 1;
    throw new Error('coercion hook must not run');
  };
  return {
    [Symbol.toPrimitive]: fail,
    valueOf: fail,
    toString: fail,
  };
}

function poolWithWorker(): WorkerPool {
  const pool = new WorkerPool();
  pool.register({
    workerId: workerId('worker-a'),
    tier: WorkerTier.TIER_1,
    vramMB: 4096,
  });
  return pool;
}

describe('WorkerPool public numeric argument runtime boundary', () => {
  it('does not coerce a hostile requiredVramMB value or mutate routing state', () => {
    const coercions = { count: 0 };
    const pool = poolWithWorker();
    const before = pool.get(workerId('worker-a'));

    expect(() => pool.getAvailableWorker(
      hostileNumericValue(coercions) as unknown as number,
    )).toThrow('requiredVramMB must be a positive finite number; found unknown');

    expect(coercions.count).toBe(0);
    expect(pool.size).toBe(1);
    expect(pool.idleCount).toBe(1);
    expect(pool.get(workerId('worker-a'))).toBe(before);
    expect(before?.status).toBe(WorkerStatus.IDLE);
  });

  it('does not coerce a hostile timeoutMs value or mutate liveness state', () => {
    const coercions = { count: 0 };
    const pool = poolWithWorker();
    const worker = pool.get(workerId('worker-a'));
    const heartbeatBefore = worker?.lastHeartbeat;

    expect(() => pool.getTimedOutWorkers(
      hostileNumericValue(coercions) as unknown as number,
    )).toThrow('timeoutMs must be a positive finite number; found unknown');

    expect(coercions.count).toBe(0);
    expect(pool.get(workerId('worker-a'))?.lastHeartbeat).toBe(heartbeatBefore);
    expect(pool.get(workerId('worker-a'))?.status).toBe(WorkerStatus.IDLE);
  });

  it('does not coerce a hostile segmentIndex value before busy-state mutation', () => {
    const coercions = { count: 0 };
    const pool = poolWithWorker();

    expect(() => pool.markBusy(
      workerId('worker-a'),
      hostileNumericValue(coercions) as unknown as number,
    )).toThrow('segmentIndex must be a non-negative safe integer; found unknown');

    expect(coercions.count).toBe(0);
    expect(pool.get(workerId('worker-a'))).toMatchObject({
      status: WorkerStatus.IDLE,
      currentSegment: undefined,
    });
  });

  it('preserves useful primitive diagnostics', () => {
    const pool = new WorkerPool();

    expect(() => pool.getAvailableWorker(Number.NaN))
      .toThrow('requiredVramMB must be a positive finite number; found NaN');
    expect(() => pool.getTimedOutWorkers(0))
      .toThrow('timeoutMs must be a positive finite number; found 0');
    expect(() => pool.markBusy(workerId('missing-worker'), -1))
      .toThrow('segmentIndex must be a non-negative safe integer; found -1');
  });
});
