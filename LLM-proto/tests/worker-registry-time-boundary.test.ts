import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { WorkerStage } from '../src/durable-types.js';
import { generateWorkerGeneration } from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import { WorkerRegistry } from '../src/worker-registry.js';

class ReferenceKv implements DurableObjectSyncKvStorage {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  put<T = unknown>(key: string, value: T): void {
    this.values.set(key, value);
  }

  delete(key: string): boolean {
    return this.values.delete(key);
  }

  list<T = unknown>(options: {
    readonly prefix?: string;
    readonly start?: string;
    readonly startAfter?: string;
    readonly end?: string;
    readonly reverse?: boolean;
    readonly limit?: number;
  } = {}): Iterable<[string, T]> {
    let entries = [...this.values.entries()]
      .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
      .filter(([key]) => options.start === undefined || key >= options.start)
      .filter(([key]) => options.startAfter === undefined || key > options.startAfter)
      .filter(([key]) => options.end === undefined || key < options.end)
      .sort(([a], [b]) => a.localeCompare(b));
    if (options.reverse) entries = entries.reverse();
    if (options.limit !== undefined) entries = entries.slice(0, options.limit);
    return entries.map(([key, value]) => [key, value as T]);
  }
}

function repositories(): Array<[string, DurableRepository]> {
  return [
    ['in-memory', new InMemoryRepository()],
    ['durable-object-reference-storage', new DurableObjectRepository(new ReferenceKv())],
  ];
}

const invalidTimes = [Number.NaN, Number.POSITIVE_INFINITY, -1] as const;

function registration(id: string) {
  return {
    workerId: workerId(id),
    tier: WorkerTier.TIER_2,
    vramMB: 8192,
  };
}

describe('WorkerRegistry absolute-time runtime boundary', () => {
  it.each(repositories())('%s rejects invalid registration time before durable state and accepts zero', (_name, repo) => {
    const registry = new WorkerRegistry(repo);
    const input = registration('time-register-worker');

    for (const now of invalidTimes) {
      expect(() => registry.register(input, 'connection-a', now)).toThrow(/non-negative finite number/);
      expect(repo.getWorker(input.workerId)).toBeUndefined();
    }

    const created = registry.register(input, 'connection-a', 0);
    expect(created.kind).toBe('created');
    expect(repo.getWorker(input.workerId)).toMatchObject({
      registeredAt: 0,
      lastHeartbeat: 0,
    });
  });

  it.each(repositories())('%s rejects invalid heartbeat time without persisting or reviving state', (_name, repo) => {
    const registry = new WorkerRegistry(repo);
    const input = registration('time-heartbeat-worker');
    const created = registry.register(input, 'connection-a', 10);
    registry.markDisconnected(input.workerId, created.generation);

    for (const now of invalidTimes) {
      expect(() => registry.heartbeat(input.workerId, created.generation, now)).toThrow(
        /non-negative finite number/,
      );
      expect(repo.getWorker(input.workerId)).toMatchObject({
        stage: WorkerStage.Disconnected,
        lastHeartbeat: 10,
      });
    }

    registry.heartbeat(input.workerId, created.generation, 0);
    expect(repo.getWorker(input.workerId)).toMatchObject({
      stage: WorkerStage.Idle,
      lastHeartbeat: 0,
    });
  });

  it.each(repositories())('%s rejects invalid liveness evaluation time before enumeration semantics can fail open', (_name, repo) => {
    const registry = new WorkerRegistry(repo);
    const input = registration('time-liveness-worker');
    registry.register(input, 'connection-a', 0);

    for (const now of invalidTimes) {
      expect(() => registry.listTimedOut(1_000, now)).toThrow(/non-negative finite number/);
    }
    expect(registry.listTimedOut(1_000, 0)).toEqual([]);
  });

  it.each(repositories())('%s rejects invalid revocation time before active/archive mutation', (_name, repo) => {
    const registry = new WorkerRegistry(repo);
    const input = registration('time-revoke-worker');
    const created = registry.register(input, 'connection-a', 10);

    for (const now of invalidTimes) {
      expect(() => registry.revokeGeneration(input.workerId, created.generation, now)).toThrow(
        /non-negative finite number/,
      );
      expect(repo.getWorker(input.workerId)).toMatchObject({
        generation: created.generation,
        stage: WorkerStage.Idle,
        registeredAt: 10,
      });
      expect(registry.getByGeneration(created.generation)?.revokedAt).toBeUndefined();
    }

    const staleGeneration = generateWorkerGeneration();
    expect(() => registry.revokeGeneration(workerId('missing-time-worker'), staleGeneration, Number.NaN)).toThrow(
      /non-negative finite number/,
    );
    expect(registry.getByGeneration(staleGeneration)).toBeUndefined();

    registry.revokeGeneration(input.workerId, created.generation, 20);
    expect(repo.getWorker(input.workerId)).toBeUndefined();
    expect(registry.getByGeneration(created.generation)).toMatchObject({
      registeredAt: 10,
      revokedAt: 20,
      stage: WorkerStage.Revoked,
    });
  });
});
