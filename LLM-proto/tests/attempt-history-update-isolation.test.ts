import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import {
  InMemoryRepository,
  type AttemptPatch,
  type DurableRepository,
} from '../src/durable-repository.js';
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
    workerId: workerId('attempt-update-isolation-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 1,
    startedAt: 20_000,
  };
}

describe('attempt-history update isolation', () => {
  it.each(repositories())('%s captures every caller-owned patch field exactly once before mutation', (_name, repo) => {
    const attempt = plainAttempt();
    repo.appendAttempt(attempt.requestId, attempt);

    const reads = { finishedAt: 0, outcome: 0, errorCode: 0 };
    const target = {} as AttemptPatch;
    Object.defineProperties(target, {
      finishedAt: {
        enumerable: true,
        get() {
          reads.finishedAt += 1;
          return reads.finishedAt === 1 ? 20_500 : 1;
        },
      },
      outcome: {
        enumerable: true,
        get() {
          reads.outcome += 1;
          return reads.outcome === 1 ? 'failed' : 'cancelled';
        },
      },
      errorCode: {
        enumerable: true,
        get() {
          reads.errorCode += 1;
          return reads.errorCode === 1 ? ErrorCode.RuntimeTransient : ErrorCode.InvalidInput;
        },
      },
    });
    const patch = new Proxy(target, {
      ownKeys() {
        throw new Error('attempt patch must not be enumerated');
      },
    });

    repo.updateAttempt(attempt.requestId, attempt.attemptId, patch);

    expect(reads).toEqual({ finishedAt: 1, outcome: 1, errorCode: 1 });
    expect(repo.listAttempts(attempt.requestId)[0]).toEqual({
      ...attempt,
      finishedAt: 20_500,
      outcome: 'failed',
      errorCode: ErrorCode.RuntimeTransient,
    });
  });

  it.each(repositories())('%s leaves the stored attempt unchanged when a later patch getter throws', (_name, repo) => {
    const attempt = plainAttempt();
    const expected = { ...attempt };
    repo.appendAttempt(attempt.requestId, attempt);

    const reads = { finishedAt: 0, outcome: 0, errorCode: 0 };
    const patch = {} as AttemptPatch;
    Object.defineProperties(patch, {
      finishedAt: {
        get() {
          reads.finishedAt += 1;
          return 20_500;
        },
      },
      outcome: {
        get() {
          reads.outcome += 1;
          throw new Error('patch capture failed');
        },
      },
      errorCode: {
        get() {
          reads.errorCode += 1;
          return ErrorCode.RuntimeTransient;
        },
      },
    });

    expect(() => repo.updateAttempt(attempt.requestId, attempt.attemptId, patch))
      .toThrow('patch capture failed');
    expect(reads).toEqual({ finishedAt: 1, outcome: 1, errorCode: 0 });
    expect(repo.listAttempts(attempt.requestId)).toEqual([expected]);
  });

  it.each(repositories())('%s does not evaluate patch getters when the target attempt is unknown', (_name, repo) => {
    const attempt = plainAttempt();
    repo.appendAttempt(attempt.requestId, attempt);

    const reads = { finishedAt: 0, outcome: 0, errorCode: 0 };
    const patch = {} as AttemptPatch;
    for (const field of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(patch, field, {
        get() {
          reads[field] += 1;
          throw new Error(`unexpected ${field} read`);
        },
      });
    }

    expect(() => repo.updateAttempt(attempt.requestId, generateAttemptId(), patch)).not.toThrow();
    expect(reads).toEqual({ finishedAt: 0, outcome: 0, errorCode: 0 });
    expect(repo.listAttempts(attempt.requestId)).toEqual([attempt]);
  });

  it.each(repositories())('%s preserves undefined-as-no-op partial patch semantics', (_name, repo) => {
    const attempt: AttemptRecord = {
      ...plainAttempt(),
      finishedAt: 20_100,
      outcome: 'completed',
      errorCode: ErrorCode.InvalidInput,
    };
    repo.appendAttempt(attempt.requestId, attempt);

    const patch = {
      finishedAt: undefined,
      outcome: 'failed',
      errorCode: undefined,
    } as unknown as AttemptPatch;
    repo.updateAttempt(attempt.requestId, attempt.attemptId, patch);

    expect(repo.listAttempts(attempt.requestId)[0]).toEqual({
      ...attempt,
      outcome: 'failed',
    });
  });
});
