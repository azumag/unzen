import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import type { AttemptRecord, CancellationRecord } from '../src/durable-types.js';
import { workerId, type InferenceRequestId } from '../src/types.js';

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

function attemptFor(requestId: InferenceRequestId): AttemptRecord {
  return {
    requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('route-identity-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 1,
    startedAt: 10_000,
  };
}

function cancellationFor(requestId: InferenceRequestId): CancellationRecord {
  return {
    requestId,
    requestedAt: 20_000,
    deadlineMs: 5_000,
  };
}

function expectProtocolViolation(run: () => void): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(UnzenError);
  expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
}

describe('repository route identity fences', () => {
  it.each(repositories())('%s rejects attempt route/record mismatches without mutation', (_name, repo) => {
    const routeRequestId = generateRequestId();
    const recordRequestId = generateRequestId();
    const attempt = attemptFor(recordRequestId);

    expectProtocolViolation(() => repo.appendAttempt(routeRequestId, attempt));

    expect(repo.listAttempts(routeRequestId)).toEqual([]);
    expect(repo.listAttempts(recordRequestId)).toEqual([]);

    repo.appendAttempt(recordRequestId, attempt);
    expect(repo.listAttempts(recordRequestId)).toEqual([attempt]);
  });

  it.each(repositories())('%s binds attempt persistence to the one captured requestId', (_name, repo) => {
    const routeRequestId = generateRequestId();
    const changedRequestId = generateRequestId();
    const target = attemptFor(routeRequestId);
    let requestIdReads = 0;
    Object.defineProperty(target, 'requestId', {
      enumerable: true,
      configurable: true,
      get() {
        requestIdReads += 1;
        return requestIdReads === 1 ? routeRequestId : changedRequestId;
      },
    });
    const attempt = new Proxy(target, {
      ownKeys() {
        throw new Error('attempt must not be enumerated');
      },
    });

    repo.appendAttempt(routeRequestId, attempt);

    expect(requestIdReads).toBe(1);
    expect(repo.listAttempts(routeRequestId)).toHaveLength(1);
    expect(repo.listAttempts(routeRequestId)[0]?.requestId).toBe(routeRequestId);
    expect(repo.listAttempts(changedRequestId)).toEqual([]);
  });

  it.each(repositories())('%s rejects cancellation route/record mismatches without mutation', (_name, repo) => {
    const routeRequestId = generateRequestId();
    const recordRequestId = generateRequestId();
    const cancellation = cancellationFor(recordRequestId);

    expectProtocolViolation(() => repo.putCancellation(routeRequestId, cancellation));

    expect(repo.getCancellation(routeRequestId)).toBeUndefined();
    expect(repo.getCancellation(recordRequestId)).toBeUndefined();

    repo.putCancellation(recordRequestId, cancellation);
    expect(repo.getCancellation(recordRequestId)).toEqual(cancellation);
  });

  it.each(repositories())('%s binds cancellation persistence to the one captured requestId', (_name, repo) => {
    const routeRequestId = generateRequestId();
    const changedRequestId = generateRequestId();
    const target = cancellationFor(routeRequestId);
    let requestIdReads = 0;
    Object.defineProperty(target, 'requestId', {
      enumerable: true,
      configurable: true,
      get() {
        requestIdReads += 1;
        return requestIdReads === 1 ? routeRequestId : changedRequestId;
      },
    });
    const cancellation = new Proxy(target, {
      ownKeys() {
        throw new Error('cancellation must not be enumerated');
      },
    });

    repo.putCancellation(routeRequestId, cancellation);

    expect(requestIdReads).toBe(1);
    expect(repo.getCancellation(routeRequestId)?.requestId).toBe(routeRequestId);
    expect(repo.getCancellation(changedRequestId)).toBeUndefined();
  });
});