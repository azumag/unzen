import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { StreamCursor } from '../src/durable-types.js';

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

function plainCursor(): StreamCursor {
  return {
    requestId: generateRequestId(),
    lastCommittedSegment: -1,
    totalSegments: 4,
    updatedAt: 1_000,
  };
}

describe('stream cursor repository isolation', () => {
  it.each(repositories())('%s captures caller-owned fields exactly once without enumeration', (_name, repo) => {
    const values = plainCursor();
    const reads: Record<keyof StreamCursor, number> = {
      requestId: 0,
      lastCommittedSegment: 0,
      totalSegments: 0,
      updatedAt: 0,
    };
    const target = {} as StreamCursor;
    for (const field of Object.keys(reads) as Array<keyof StreamCursor>) {
      Object.defineProperty(target, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads[field] += 1;
          if (reads[field] > 1) throw new Error(`${String(field)} read more than once`);
          return values[field];
        },
      });
    }
    const cursor = new Proxy(target, {
      ownKeys() {
        throw new Error('stream cursor must not be enumerated');
      },
    });

    repo.putStreamCursor(cursor);

    expect(reads).toEqual({
      requestId: 1,
      lastCommittedSegment: 1,
      totalSegments: 1,
      updatedAt: 1,
    });
    expect(repo.getStreamCursor(values.requestId)).toEqual(values);
  });

  it.each(repositories())('%s detaches retained caller and read-result references', (_name, repo) => {
    const cursor = plainCursor();
    const expected = { ...cursor };
    repo.putStreamCursor(cursor);

    Object.assign(cursor, {
      requestId: generateRequestId(),
      lastCommittedSegment: 3,
      totalSegments: 99,
      updatedAt: 9_999,
    });
    expect(repo.getStreamCursor(expected.requestId)).toEqual(expected);

    const read = repo.getStreamCursor(expected.requestId)!;
    Object.assign(read, {
      lastCommittedSegment: 2,
      totalSegments: 8,
      updatedAt: 8_888,
    });
    expect(repo.getStreamCursor(expected.requestId)).toEqual(expected);
  });

  it.each(repositories())('%s advances progress only after an explicit put', (_name, repo) => {
    const cursor = plainCursor();
    repo.putStreamCursor(cursor);

    const detached = repo.getStreamCursor(cursor.requestId)!;
    Object.assign(detached, {
      lastCommittedSegment: 1,
      updatedAt: 2_000,
    });

    expect(repo.getStreamCursor(cursor.requestId)).toEqual(cursor);

    repo.putStreamCursor(detached);
    expect(repo.getStreamCursor(cursor.requestId)).toEqual({
      ...cursor,
      lastCommittedSegment: 1,
      updatedAt: 2_000,
    });
  });
});
