import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import type { RequestRecord, WorkerRecord } from '../src/durable-types.js';
import { WorkerStage } from '../src/durable-types.js';
import {
  generateRequestId,
  generateWorkerGeneration,
  idempotencyKey,
} from '../src/ids.js';
import { ErrorCode } from '../src/errors.js';
import { workerId, WorkerTier } from '../src/types.js';

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

function requestRecord(): RequestRecord {
  return {
    requestId: generateRequestId(),
    prompt: 'write isolation',
    stage: 'accepted',
    idempotencyKey: idempotencyKey('request-worker-write-isolation'),
    createdAt: 10,
    startedAt: 11,
    completedAt: 12,
    currentSegment: 1,
    totalSegments: 3,
    manifestDigest: 'a'.repeat(64),
    retryCount: 2,
    lastErrorCode: ErrorCode.RuntimeTransient,
    lastError: 'transient',
    timeoutMs: 5_000,
  };
}

function workerRecord(): WorkerRecord {
  return {
    workerId: workerId('write-worker'),
    generation: generateWorkerGeneration(),
    connectionId: 'conn-write-worker',
    tier: WorkerTier.TIER_3,
    vramMB: 8192,
    stage: WorkerStage.Idle,
    lastHeartbeat: 20,
    registeredAt: 10,
    revokedAt: 30,
    currentSegment: 1,
  };
}

function accessorRecord<T extends object>(values: T): { record: T; reads: Record<keyof T, number> } {
  const fields = Object.keys(values) as Array<keyof T>;
  const reads = Object.fromEntries(fields.map((field) => [field, 0])) as Record<keyof T, number>;
  const target = {} as T;
  for (const field of fields) {
    Object.defineProperty(target, field, {
      configurable: true,
      enumerable: true,
      get() {
        reads[field] += 1;
        if (reads[field] > 1) throw new Error(`${String(field)} read more than once`);
        return values[field];
      },
    });
  }
  return {
    record: new Proxy(target, {
      ownKeys() {
        throw new Error('record must not be enumerated');
      },
    }),
    reads,
  };
}

function plainRequest(record: RequestRecord) {
  return {
    requestId: record.requestId,
    prompt: record.prompt,
    stage: record.stage,
    idempotencyKey: record.idempotencyKey,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    currentSegment: record.currentSegment,
    totalSegments: record.totalSegments,
    manifestDigest: record.manifestDigest,
    retryCount: record.retryCount,
    lastErrorCode: record.lastErrorCode,
    lastError: record.lastError,
    timeoutMs: record.timeoutMs,
  };
}

function plainWorker(record: WorkerRecord) {
  return {
    workerId: record.workerId,
    generation: record.generation,
    connectionId: record.connectionId,
    tier: record.tier,
    vramMB: record.vramMB,
    stage: record.stage,
    lastHeartbeat: record.lastHeartbeat,
    registeredAt: record.registeredAt,
    revokedAt: record.revokedAt,
    currentSegment: record.currentSegment,
  };
}

describe('request and worker repository write isolation', () => {
  it.each(repositories())('%s captures request fields once and keys storage from the owned snapshot', (_name, repo) => {
    const values = requestRecord();
    const { record, reads } = accessorRecord(values);

    repo.createRequest(record);

    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
    expect(plainRequest(repo.getRequest(values.requestId)!)).toEqual(plainRequest(values));
    expect(repo.listRequests()).toHaveLength(1);
  });

  it.each(repositories())('%s detaches the request writer while preserving mutable read compatibility', (_name, repo) => {
    const input = requestRecord();
    const requestId = input.requestId;
    const expected = plainRequest(input);
    repo.createRequest(input);

    const mutableInput = input as unknown as {
      requestId: RequestRecord['requestId'];
      prompt: string;
      stage: RequestRecord['stage'];
      retryCount: number;
      lastError?: string;
    };
    mutableInput.requestId = generateRequestId();
    mutableInput.prompt = 'mutated outside repository';
    mutableInput.stage = 'failed';
    mutableInput.retryCount = 99;
    mutableInput.lastError = 'writer mutation';

    expect(plainRequest(repo.getRequest(requestId)!)).toEqual(expected);
    expect(repo.getRequest(mutableInput.requestId)).toBeUndefined();

    const active = repo.getRequest(requestId)!;
    active.stage = 'queued';
    active.retryCount = 3;
    active.lastError = 'explicit mutable read';
    expect(repo.getRequest(requestId)).toMatchObject({
      stage: 'queued',
      retryCount: 3,
      lastError: 'explicit mutable read',
    });
  });

  it.each(repositories())('%s captures worker fields once and keys storage from the owned snapshot', (_name, repo) => {
    const values = workerRecord();
    const { record, reads } = accessorRecord(values);

    repo.putWorker(record);

    expect(Object.values(reads).every((count) => count === 1)).toBe(true);
    expect(plainWorker(repo.getWorker(values.workerId)!)).toEqual(plainWorker(values));
    expect(repo.listWorkers()).toHaveLength(1);
  });

  it.each(repositories())('%s detaches the worker writer while preserving mutable read compatibility', (_name, repo) => {
    const input = workerRecord();
    const originalWorkerId = input.workerId;
    const expected = plainWorker(input);
    repo.putWorker(input);

    const mutableInput = input as unknown as {
      workerId: WorkerRecord['workerId'];
      connectionId: string;
      stage: WorkerRecord['stage'];
      lastHeartbeat: number;
      currentSegment?: number;
    };
    mutableInput.workerId = workerId('mutated-writer');
    mutableInput.connectionId = 'mutated-connection';
    mutableInput.stage = WorkerStage.Disconnected;
    mutableInput.lastHeartbeat = 999;
    mutableInput.currentSegment = 7;

    expect(plainWorker(repo.getWorker(originalWorkerId)!)).toEqual(expected);
    expect(repo.getWorker(mutableInput.workerId)).toBeUndefined();

    const active = repo.getWorker(originalWorkerId)!;
    active.stage = WorkerStage.Busy;
    active.lastHeartbeat = 42;
    active.currentSegment = 2;
    expect(repo.getWorker(originalWorkerId)).toMatchObject({
      stage: WorkerStage.Busy,
      lastHeartbeat: 42,
      currentSegment: 2,
    });
  });
});
