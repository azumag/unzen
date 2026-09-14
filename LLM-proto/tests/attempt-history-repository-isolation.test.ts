import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { ErrorCode } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import type { AttemptRecord } from '../src/durable-types.js';
import { workerId } from '../src/types.js';

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

function plainAttempt(): AttemptRecord {
  return {
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('attempt-isolation-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 2,
    startedAt: 10_000,
  };
}

describe('attempt-history repository isolation', () => {
  it.each(repositories())('%s captures caller-owned attempt fields exactly once without enumeration', (_name, repo) => {
    const values: AttemptRecord = {
      ...plainAttempt(),
      finishedAt: 10_250,
      outcome: 'failed',
      errorCode: ErrorCode.RuntimeTransient,
    };
    const fields = [
      'requestId',
      'attemptId',
      'leaseId',
      'workerId',
      'workerGeneration',
      'segmentIndex',
      'startedAt',
      'finishedAt',
      'outcome',
      'errorCode',
    ] as const;
    const reads = Object.fromEntries(fields.map((field) => [field, 0])) as Record<(typeof fields)[number], number>;
    const target = {} as AttemptRecord;
    for (const field of fields) {
      Object.defineProperty(target, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads[field] += 1;
          return values[field];
        },
      });
    }
    const attempt = new Proxy(target, {
      ownKeys() {
        throw new Error('attempt record must not be enumerated');
      },
    });

    repo.appendAttempt(values.requestId, attempt);

    expect(reads).toEqual(Object.fromEntries(fields.map((field) => [field, 1])));
    expect(repo.listAttempts(values.requestId)).toEqual([values]);
  });

  it.each(repositories())('%s preserves optional-field presence while detaching the record', (_name, repo) => {
    const attempt = plainAttempt();
    Object.defineProperty(attempt, 'finishedAt', {
      value: undefined,
      enumerable: true,
      configurable: true,
      writable: true,
    });

    repo.appendAttempt(attempt.requestId, attempt);
    const stored = repo.listAttempts(attempt.requestId)[0]!;

    expect(Object.prototype.hasOwnProperty.call(stored, 'finishedAt')).toBe(true);
    expect(stored.finishedAt).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(stored, 'outcome')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stored, 'errorCode')).toBe(false);
  });

  it.each(repositories())('%s detaches retained caller and list-result references', (_name, repo) => {
    const attempt = plainAttempt();
    const expected = { ...attempt };
    repo.appendAttempt(attempt.requestId, attempt);

    Object.assign(attempt, {
      workerId: workerId('caller-mutated'),
      segmentIndex: 99,
      startedAt: 1,
      outcome: 'failed' as const,
    });
    expect(repo.listAttempts(expected.requestId)).toEqual([expected]);

    const listed = repo.listAttempts(expected.requestId)[0]!;
    Object.assign(listed, {
      leaseId: generateLeaseId(),
      workerId: workerId('list-mutated'),
      finishedAt: 2,
      outcome: 'cancelled' as const,
    });
    expect(repo.listAttempts(expected.requestId)).toEqual([expected]);
  });

  it.each(repositories())('%s keeps updateAttempt as the explicit mutation path after detached reads', (_name, repo) => {
    const attempt = plainAttempt();
    repo.appendAttempt(attempt.requestId, attempt);

    const detached = repo.listAttempts(attempt.requestId)[0]!;
    Object.assign(detached, { outcome: 'cancelled' as const, finishedAt: 1 });
    expect(repo.listAttempts(attempt.requestId)[0]).toEqual(attempt);

    repo.updateAttempt(attempt.requestId, attempt.attemptId, {
      finishedAt: 10_500,
      outcome: 'failed',
      errorCode: ErrorCode.RuntimeTransient,
    });

    expect(repo.listAttempts(attempt.requestId)[0]).toEqual({
      ...attempt,
      finishedAt: 10_500,
      outcome: 'failed',
      errorCode: ErrorCode.RuntimeTransient,
    });
  });
});
