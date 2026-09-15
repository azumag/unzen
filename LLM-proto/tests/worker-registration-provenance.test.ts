import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { ErrorCode } from '../src/errors.js';
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

function expectProtocolViolation(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: ErrorCode.ProtocolViolation });
}

describe('worker registration provenance isolation', () => {
  it.each(repositories())('%s rejects registeredAt mutations from direct/list reads before reconnect archival', (_name, repo) => {
    const registry = new WorkerRegistry(repo);
    const id = workerId('registration-provenance-worker');
    const registration = {
      workerId: id,
      tier: WorkerTier.TIER_2,
      vramMB: 8192,
    };

    const first = registry.register(registration, 'connection-a', 100);
    expect(first.kind).toBe('created');

    const direct = repo.getWorker(id)!;
    const listed = repo.listWorkers()[0]!;
    for (const read of [direct, listed]) {
      expectProtocolViolation(() => Reflect.set(read, 'registeredAt', 999));
      expectProtocolViolation(() => Reflect.deleteProperty(read, 'registeredAt'));
      expectProtocolViolation(() => Reflect.defineProperty(read, 'registeredAt', {
        value: 999,
        configurable: true,
        enumerable: true,
        writable: true,
      }));
      expect(read.registeredAt).toBe(100);
    }

    direct.lastHeartbeat = 150;
    expect(repo.getWorker(id)?.lastHeartbeat).toBe(150);

    const reconnect = registry.register(registration, 'connection-b', 200);
    expect(reconnect.kind).toBe('reconnected');
    if (reconnect.kind !== 'reconnected') throw new Error('expected reconnect');

    expect(registry.getByGeneration(first.generation)).toMatchObject({
      workerId: id,
      generation: first.generation,
      connectionId: 'connection-a',
      registeredAt: 100,
      lastHeartbeat: 150,
      revokedAt: 200,
    });
    expect(repo.getWorker(id)).toMatchObject({
      generation: reconnect.generation,
      connectionId: 'connection-b',
      registeredAt: 200,
    });
  });
});
