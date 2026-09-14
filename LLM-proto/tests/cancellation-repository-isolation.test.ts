import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { CancellationRecord } from '../src/durable-types.js';

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

function plainCancellation(): CancellationRecord {
  return {
    requestId: generateRequestId(),
    requestedAt: 30_000,
    deadlineMs: 5_000,
  };
}

describe('cancellation repository isolation', () => {
  it.each(repositories())('%s captures caller-owned fields exactly once without enumeration', (_name, repo) => {
    const values: CancellationRecord = {
      ...plainCancellation(),
      acknowledgedAt: 30_250,
    };
    const reads = { requestId: 0, requestedAt: 0, deadlineMs: 0, acknowledgedAt: 0 };
    const target = {} as CancellationRecord;
    for (const field of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(target, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads[field] += 1;
          return values[field];
        },
      });
    }
    const record = new Proxy(target, {
      ownKeys() {
        throw new Error('cancellation record must not be enumerated');
      },
    });

    repo.putCancellation(values.requestId, record);

    expect(reads).toEqual({ requestId: 1, requestedAt: 1, deadlineMs: 1, acknowledgedAt: 1 });
    expect(repo.getCancellation(values.requestId)).toEqual(values);
  });

  it.each(repositories())('%s preserves optional acknowledgement presence while detaching', (_name, repo) => {
    const record = plainCancellation();
    Object.defineProperty(record, 'acknowledgedAt', {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    repo.putCancellation(record.requestId, record);
    const stored = repo.getCancellation(record.requestId)!;

    expect(Object.prototype.hasOwnProperty.call(stored, 'acknowledgedAt')).toBe(true);
    expect(stored.acknowledgedAt).toBeUndefined();
  });

  it.each(repositories())('%s detaches retained caller and read-result references', (_name, repo) => {
    const record = plainCancellation();
    const expected = { ...record };
    repo.putCancellation(record.requestId, record);

    Object.assign(record, {
      requestId: generateRequestId(),
      requestedAt: 1,
      deadlineMs: 1,
      acknowledgedAt: 2,
    });
    expect(repo.getCancellation(expected.requestId)).toEqual(expected);

    const read = repo.getCancellation(expected.requestId)!;
    Object.assign(read, { requestedAt: 3, deadlineMs: 4, acknowledgedAt: 5 });
    expect(repo.getCancellation(expected.requestId)).toEqual(expected);
  });

  it.each(repositories())('%s persists acknowledgement only after the detached record is explicitly written back', (_name, repo) => {
    const record = plainCancellation();
    repo.putCancellation(record.requestId, record);

    const detached = repo.getCancellation(record.requestId)!;
    detached.acknowledgedAt = 30_500;
    expect(repo.getCancellation(record.requestId)?.acknowledgedAt).toBeUndefined();

    repo.putCancellation(record.requestId, detached);
    expect(repo.getCancellation(record.requestId)).toEqual({
      ...record,
      acknowledgedAt: 30_500,
    });
  });
});
