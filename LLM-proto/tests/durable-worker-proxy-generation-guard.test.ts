import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { WorkerRegistry } from '../src/worker-registry.js';
import { WorkerStage } from '../src/durable-types.js';
import { workerId, WorkerTier } from '../src/types.js';

class CloneOnAccessKv implements DurableObjectSyncKvStorage {
  private readonly values = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  put<T = unknown>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
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
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries = entries.reverse();
    if (options.limit !== undefined) entries = entries.slice(0, options.limit);
    return entries.map(([key, value]) => [key, structuredClone(value) as T]);
  }
}

function setup(id = 'worker-proxy') {
  const storage = new CloneOnAccessKv();
  const repository = new DurableObjectRepository(storage);
  const registry = new WorkerRegistry(repository);
  const worker = workerId(id);
  return { storage, repository, registry, worker };
}

describe('DurableObjectRepository worker proxy generation guard', () => {
  it('preserves write-through mutations for the current generation', () => {
    const { storage, repository, registry, worker } = setup();
    const registration = registry.register(
      { workerId: worker, tier: WorkerTier.TIER_2, vramMB: 4_096 },
      'connection-a',
      100,
    );

    const current = repository.getWorker(worker)!;
    current.stage = WorkerStage.Busy;
    current.lastHeartbeat = 150;

    expect(new DurableObjectRepository(storage).getWorker(worker)).toMatchObject({
      generation: registration.generation,
      stage: WorkerStage.Busy,
      lastHeartbeat: 150,
    });
  });

  it('does not let a stale getWorker proxy mutate a replacement generation', () => {
    const { storage, repository, registry, worker } = setup();
    const first = registry.register(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 4_096 },
      'connection-a',
      100,
    );
    const stale = repository.getWorker(worker)!;
    const second = registry.register(
      { workerId: worker, tier: WorkerTier.TIER_1, vramMB: 8_192 },
      'connection-b',
      200,
    );
    expect(second.generation).not.toBe(first.generation);

    stale.stage = WorkerStage.Disconnected;
    stale.lastHeartbeat = 1;

    expect(new DurableObjectRepository(storage).getWorker(worker)).toMatchObject({
      generation: second.generation,
      connectionId: 'connection-b',
      tier: WorkerTier.TIER_1,
      vramMB: 8_192,
      stage: WorkerStage.Idle,
      lastHeartbeat: 200,
    });
  });

  it('does not let a stale listWorkers proxy mutate a replacement generation', () => {
    const { storage, repository, registry, worker } = setup('listed-worker');
    registry.register(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 4_096 },
      'connection-a',
      100,
    );
    const stale = repository.listWorkers()[0]!;
    const second = registry.register(
      { workerId: worker, tier: WorkerTier.TIER_2, vramMB: 6_144 },
      'connection-b',
      200,
    );

    stale.stage = WorkerStage.Disconnected;
    stale.lastHeartbeat = 2;

    expect(new DurableObjectRepository(storage).getWorker(worker)).toMatchObject({
      generation: second.generation,
      connectionId: 'connection-b',
      tier: WorkerTier.TIER_2,
      vramMB: 6_144,
      stage: WorkerStage.Idle,
      lastHeartbeat: 200,
    });
  });

  it('does not let a stale worker proxy resurrect a deleted worker key', () => {
    const { storage, repository, registry, worker } = setup('deleted-worker');
    registry.register(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 4_096 },
      'connection-a',
      100,
    );
    const stale = repository.getWorker(worker)!;

    repository.deleteWorker(worker);
    stale.stage = WorkerStage.Busy;
    stale.lastHeartbeat = 999;

    expect(new DurableObjectRepository(storage).getWorker(worker)).toBeUndefined();
  });
});
