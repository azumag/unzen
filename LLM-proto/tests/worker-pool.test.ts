import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WorkerPool } from '../src/worker-pool.js';
import { workerId, WorkerTier, WorkerStatus } from '../src/types.js';
import type { WorkerRegistration } from '../src/protocol.js';

function makeRegistration(
  id: string,
  tier: WorkerTier = WorkerTier.TIER_3,
  vramMB: number = 4096,
): WorkerRegistration {
  return { workerId: workerId(id), tier, vramMB };
}

describe('WorkerPool', () => {
  let pool: WorkerPool;

  beforeEach(() => {
    pool = new WorkerPool();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should start empty', () => {
    expect(pool.size).toBe(0);
    expect(pool.idleCount).toBe(0);
  });

  describe('register', () => {
    it('should add a worker and return its info', () => {
      const reg = makeRegistration('w1', WorkerTier.TIER_2, 8192);
      const info = pool.register(reg);

      expect(info.id).toBe(workerId('w1'));
      expect(info.tier).toBe(WorkerTier.TIER_2);
      expect(info.vramMB).toBe(8192);
      expect(info.status).toBe(WorkerStatus.IDLE);
      expect(pool.size).toBe(1);
    });

    it('should register multiple workers', () => {
      pool.register(makeRegistration('w1'));
      pool.register(makeRegistration('w2'));
      pool.register(makeRegistration('w3'));

      expect(pool.size).toBe(3);
      expect(pool.idleCount).toBe(3);
    });
  });

  describe('unregister', () => {
    it('should remove a worker and return true', () => {
      pool.register(makeRegistration('w1'));
      expect(pool.unregister(workerId('w1'))).toBe(true);
      expect(pool.size).toBe(0);
    });

    it('should return false for unknown worker', () => {
      expect(pool.unregister(workerId('unknown'))).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('should update heartbeat timestamp', () => {
      pool.register(makeRegistration('w1'));
      const before = pool.get(workerId('w1'))!.lastHeartbeat;
      vi.advanceTimersByTime(5000);

      expect(pool.heartbeat(workerId('w1'))).toBe(true);
      const worker = pool.get(workerId('w1'));
      expect(worker?.lastHeartbeat).toBe(before + 5000);
    });

    it('should return false for unknown worker', () => {
      expect(pool.heartbeat(workerId('unknown'))).toBe(false);
    });

    it('should reconnect a disconnected worker', () => {
      pool.register(makeRegistration('w1'));
      pool.markDisconnected(workerId('w1'));
      expect(pool.get(workerId('w1'))?.status).toBe(WorkerStatus.DISCONNECTED);

      pool.heartbeat(workerId('w1'));
      expect(pool.get(workerId('w1'))?.status).toBe(WorkerStatus.IDLE);
    });
  });

  describe('getAvailableWorker', () => {
    it('should return null when no workers are registered', () => {
      expect(pool.getAvailableWorker(2100)).toBeNull();
    });

    it('should return null when no worker has enough VRAM', () => {
      pool.register(makeRegistration('w1', WorkerTier.TIER_3, 1024));
      expect(pool.getAvailableWorker(2100)).toBeNull();
    });

    it('should return null when all workers are busy', () => {
      pool.register(makeRegistration('w1'));
      pool.markBusy(workerId('w1'), 0);
      expect(pool.getAvailableWorker(2100)).toBeNull();
    });

    it('should return an idle worker with sufficient VRAM', () => {
      pool.register(makeRegistration('w1', WorkerTier.TIER_3, 4096));
      const worker = pool.getAvailableWorker(2100);
      expect(worker?.id).toBe(workerId('w1'));
    });

    it('should prefer Tier 1 over Tier 2 over Tier 3', () => {
      pool.register(makeRegistration('w3', WorkerTier.TIER_3, 4096));
      pool.register(makeRegistration('w1', WorkerTier.TIER_1, 4096));
      pool.register(makeRegistration('w2', WorkerTier.TIER_2, 4096));

      const worker = pool.getAvailableWorker(2100);
      expect(worker?.id).toBe(workerId('w1'));
    });

    it('should prefer more VRAM within the same tier', () => {
      pool.register(makeRegistration('w-small', WorkerTier.TIER_2, 4096));
      pool.register(makeRegistration('w-large', WorkerTier.TIER_2, 8192));

      const worker = pool.getAvailableWorker(2100);
      expect(worker?.id).toBe(workerId('w-large'));
    });

    it('should skip disconnected workers', () => {
      pool.register(makeRegistration('w1', WorkerTier.TIER_1, 8192));
      pool.register(makeRegistration('w2', WorkerTier.TIER_3, 4096));
      pool.markDisconnected(workerId('w1'));

      const worker = pool.getAvailableWorker(2100);
      expect(worker?.id).toBe(workerId('w2'));
    });
  });

  describe('markBusy / markIdle', () => {
    it('should transition worker between busy and idle', () => {
      pool.register(makeRegistration('w1'));

      pool.markBusy(workerId('w1'), 3);
      expect(pool.get(workerId('w1'))?.status).toBe(WorkerStatus.BUSY);
      expect(pool.get(workerId('w1'))?.currentSegment).toBe(3);
      expect(pool.idleCount).toBe(0);

      pool.markIdle(workerId('w1'));
      expect(pool.get(workerId('w1'))?.status).toBe(WorkerStatus.IDLE);
      expect(pool.get(workerId('w1'))?.currentSegment).toBeUndefined();
      expect(pool.idleCount).toBe(1);
    });
  });

  describe('getTimedOutWorkers', () => {
    it('should find workers whose heartbeat has expired', () => {
      pool.register(makeRegistration('w1'));
      pool.register(makeRegistration('w2'));

      vi.advanceTimersByTime(20_000);
      // w2 sends a heartbeat, w1 does not
      pool.heartbeat(workerId('w2'));

      const timedOut = pool.getTimedOutWorkers(15_000);
      expect(timedOut).toHaveLength(1);
      expect(timedOut[0].id).toBe(workerId('w1'));
    });

    it('should not include already-disconnected workers', () => {
      pool.register(makeRegistration('w1'));
      pool.markDisconnected(workerId('w1'));

      vi.advanceTimersByTime(20_000);
      expect(pool.getTimedOutWorkers(15_000)).toHaveLength(0);
    });
  });
});
