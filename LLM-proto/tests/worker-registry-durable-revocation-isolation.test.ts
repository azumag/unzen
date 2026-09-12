import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { WorkerRegistry } from '../src/worker-registry.js';
import { WorkerStage } from '../src/durable-types.js';
import { workerId, WorkerTier } from '../src/types.js';

/** Mimic Durable Object synchronous KV structured-clone semantics. */
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

describe('WorkerRegistry durable revocation isolation', () => {
  it('does not let a revoked generation snapshot mutate its replacement worker', () => {
    const storage = new CloneOnAccessKv();
    const repository = new DurableObjectRepository(storage);
    const registry = new WorkerRegistry(repository);
    const id = workerId('generation-isolation');

    const first = registry.register(
      { workerId: id, tier: WorkerTier.TIER_3, vramMB: 4_096 },
      'connection-a',
      100,
    );
    const second = registry.register(
      { workerId: id, tier: WorkerTier.TIER_1, vramMB: 8_192 },
      'connection-b',
      200,
    );

    const archived = registry.getByGeneration(first.generation);
    expect(archived).toMatchObject({
      generation: first.generation,
      connectionId: 'connection-a',
      stage: WorkerStage.Revoked,
      lastHeartbeat: 100,
      revokedAt: 200,
    });

    // A revoked-generation lookup is historical data. Mutating the returned
    // object must neither write through to the replacement generation's reused
    // worker key nor alter the registry's archived copy.
    archived!.stage = WorkerStage.Disconnected;
    archived!.lastHeartbeat = 1;

    const freshRepository = new DurableObjectRepository(storage);
    expect(freshRepository.getWorker(id)).toMatchObject({
      generation: second.generation,
      connectionId: 'connection-b',
      tier: WorkerTier.TIER_1,
      vramMB: 8_192,
      stage: WorkerStage.Idle,
      lastHeartbeat: 200,
    });

    expect(registry.getByGeneration(first.generation)).toMatchObject({
      generation: first.generation,
      stage: WorkerStage.Revoked,
      lastHeartbeat: 100,
      revokedAt: 200,
    });
  });
});
