/**
 * Tests for the worker registry generation policy (issue #103 deliverable 9).
 *
 * A worker generation is issued per transport connection / auth session.
 * Re-registration of the same workerId must revoke the old generation
 * (reclaiming its leases) rather than silently overwriting; heartbeats must
 * never revive a revoked generation; reconnect = new generation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkerRegistry, UnknownWorkerError, StaleGenerationError } from '../src/worker-registry.js';
import { generateWorkerGeneration } from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import { WorkerStage } from '../src/durable-types.js';
import type { WorkerRecord } from '../src/durable-types.js';
import { InMemoryRepository } from '../src/durable-repository.js';

function registration(id: string, tier: WorkerTier = WorkerTier.TIER_3, vramMB = 4096) {
  return { workerId: workerId(id), tier, vramMB };
}

describe('WorkerRegistry', () => {
  let registry: WorkerRegistry;
  let repo: InMemoryRepository;

  beforeEach(() => {
    repo = new InMemoryRepository();
    registry = new WorkerRegistry(repo);
  });

  it('registers a new worker with a fresh generation', () => {
    const outcome = registry.register(registration('w1'), 'conn-1');
    expect(outcome.kind).toBe('created');
    expect(outcome.generation).toMatch(/-gen/);
    const record = registry.get(workerId('w1'));
    expect(record?.stage).toBe(WorkerStage.Idle);
    expect(record?.connectionId).toBe('conn-1');
  });

  it('same workerId + same connection keeps the generation (capability refresh)', () => {
    const first = registry.register(registration('w1', WorkerTier.TIER_3, 4096), 'conn-1');
    const second = registry.register(registration('w1', WorkerTier.TIER_3, 8192), 'conn-1');
    expect(second.kind).toBe('updated');
    expect(second.generation).toBe(first.generation);
    expect(registry.get(workerId('w1'))?.vramMB).toBe(8192);
  });

  it('re-registration on a new connection revokes the old generation (reconnect)', () => {
    const first = registry.register(registration('w1'), 'conn-1');
    const second = registry.register(registration('w1'), 'conn-2');
    expect(second.kind).toBe('reconnected');
    expect(second.previousGeneration).toBe(first.generation);
    expect(second.generation).not.toBe(first.generation);
    // Old generation is explicitly revoked, not silently overwritten.
    const record = registry.get(workerId('w1'));
    expect(record?.generation).toBe(second.generation);
    expect(record?.revokedAt).toBeUndefined();
    // The previous generation's record is retained but marked revoked so its
    // leases can be reclaimed and late results traced to it.
    const revoked = registry.getByGeneration(first.generation);
    expect(revoked?.stage).toBe(WorkerStage.Revoked);
    expect(revoked?.revokedAt).toBeDefined();
  });

  it('heartbeat from an unknown worker is a structured error', () => {
    expect(() => registry.heartbeat(workerId('ghost'), generateWorkerGeneration()))
      .toThrow(UnknownWorkerError);
  });

  it('stale-generation heartbeat throws and does NOT revive', () => {
    const first = registry.register(registration('w1'), 'conn-1');
    registry.markDisconnected(workerId('w1'), first.generation);
    expect(registry.get(workerId('w1'))?.stage).toBe(WorkerStage.Disconnected);

    // A heartbeat carrying a stale generation must not revive the worker.
    expect(() => registry.heartbeat(workerId('w1'), generateWorkerGeneration()))
      .toThrow(StaleGenerationError);
    expect(registry.get(workerId('w1'))?.stage).toBe(WorkerStage.Disconnected);
  });

  it('heartbeat against a revoked generation throws and never revives', () => {
    const first = registry.register(registration('w1'), 'conn-1');
    registry.register(registration('w1'), 'conn-2'); // revokes generation 1
    // Find the revoked generation record state: register overwrote the map.
    // Re-registering on conn-2 replaced conn-1's generation entirely, so a
    // heartbeat for the old generation is now stale.
    expect(() => registry.heartbeat(workerId('w1'), first.generation))
      .toThrow(StaleGenerationError);
  });

  it('a valid-generation heartbeat revives a disconnected (non-revoked) worker', () => {
    const first = registry.register(registration('w1'), 'conn-1');
    registry.markDisconnected(workerId('w1'), first.generation);
    const before = registry.get(workerId('w1'))?.lastHeartbeat;
    const t0 = Date.now();
    registry.heartbeat(workerId('w1'), first.generation);
    const record = registry.get(workerId('w1'));
    expect(record?.stage).toBe(WorkerStage.Idle);
    expect(record?.lastHeartbeat).toBeGreaterThanOrEqual(before ?? t0);
  });

  it('getAvailableWorker prefers tier, then VRAM, and skips unhealthy workers', () => {
    registry.register(registration('t3', WorkerTier.TIER_3, 4096), 'c3');
    registry.register(registration('t1', WorkerTier.TIER_1, 4096), 'c1');
    registry.register(registration('t2', WorkerTier.TIER_2, 8192), 'c2');
    const best = registry.getAvailableWorker(2100);
    expect(best?.workerId).toBe(workerId('t1'));

    registry.markDisconnected(workerId('t1'), registry.get(workerId('t1'))!.generation);
    const next = registry.getAvailableWorker(2100);
    expect(next?.workerId).toBe(workerId('t2'));
  });

  it('returns undefined when no worker has enough VRAM or all are busy', () => {
    registry.register(registration('low', WorkerTier.TIER_3, 1024), 'c1');
    expect(registry.getAvailableWorker(2100)).toBeUndefined();
    registry.register(registration('big', WorkerTier.TIER_3, 8192), 'c2');
    const gen = registry.get(workerId('big'))!.generation;
    registry.markBusy(workerId('big'), gen, 0);
    expect(registry.getAvailableWorker(2100)).toBeUndefined();
  });

  it('markDisconnected ignores stale generations', () => {
    const first = registry.register(registration('w1'), 'conn-1');
    const staleGen = generateWorkerGeneration();
    registry.markDisconnected(workerId('w1'), staleGen);
    expect(registry.get(workerId('w1'))?.stage).toBe(WorkerStage.Idle);
    registry.markDisconnected(workerId('w1'), first.generation);
    expect(registry.get(workerId('w1'))?.stage).toBe(WorkerStage.Disconnected);
  });

  it('listTimedOut returns workers past the heartbeat timeout', () => {
    registry.register(registration('w1'), 'conn-1');
    registry.register(registration('w2'), 'conn-2');
    const now = Date.now();
    const record = registry.get(workerId('w2'))!;
    repo.putWorker({ ...record, lastHeartbeat: now - 20_000 });
    const timedOut = registry.listTimedOut(15_000, now);
    expect(timedOut.map((w) => w.workerId)).toEqual([workerId('w2')]);
  });

  it('persists through the repository (restart survival)', () => {
    registry.register(registration('w1'), 'conn-1');
    const fresh = new WorkerRegistry(repo);
    expect(fresh.get(workerId('w1'))?.workerId).toBe(workerId('w1'));
  });

  it('WorkerStage values cover the storage enum', () => {
    // Guards against a staging typo silently changing registry semantics.
    expect(WorkerStage.Idle).toBe('idle');
    expect(WorkerStage.Busy).toBe('busy');
    expect(WorkerStage.Disconnected).toBe('disconnected');
    expect(WorkerStage.Revoked).toBe('revoked');
  });
});
