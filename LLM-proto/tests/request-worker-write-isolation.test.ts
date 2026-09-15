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

function expectProtocolViolation(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code: ErrorCode.ProtocolViolation });
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

  it.each(repositories())('%s rejects request identity mutations from get/list while preserving operational writes', (_name, repo) => {
    const input = requestRecord();
    const requestId = input.requestId;
    const changedRequestId = generateRequestId();
    repo.createRequest(input);

    const direct = repo.getRequest(requestId)!;
    const listed = repo.listRequests()[0]!;
    for (const read of [direct, listed]) {
      expectProtocolViolation(() => Reflect.set(read, 'requestId', changedRequestId));
      expectProtocolViolation(() => Reflect.deleteProperty(read, 'requestId'));
      expectProtocolViolation(() => Reflect.defineProperty(read, 'requestId', {
        value: changedRequestId,
        configurable: true,
        enumerable: true,
        writable: true,
      }));
      expect(read.requestId).toBe(requestId);
    }

    direct.stage = 'queued';
    listed.retryCount = 7;
    expect(repo.getRequest(requestId)).toMatchObject({
      requestId,
      stage: 'queued',
      retryCount: 7,
    });
    expect(repo.getRequest(changedRequestId)).toBeUndefined();
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

  it.each(repositories())('%s rejects worker identity mutations from get/list and preserves generation fencing', (_name, repo) => {
    const input = workerRecord();
    const originalWorkerId = input.workerId;
    const originalGeneration = input.generation;
    const originalConnectionId = input.connectionId;
    const changedWorkerId = workerId('changed-read-worker');
    const changedGeneration = generateWorkerGeneration();
    repo.putWorker(input);

    const direct = repo.getWorker(originalWorkerId)!;
    const listed = repo.listWorkers()[0]!;
    for (const read of [direct, listed]) {
      for (const [property, value] of [
        ['workerId', changedWorkerId],
        ['generation', changedGeneration],
        ['connectionId', 'changed-read-connection'],
      ] as const) {
        expectProtocolViolation(() => Reflect.set(read, property, value));
        expectProtocolViolation(() => Reflect.deleteProperty(read, property));
        expectProtocolViolation(() => Reflect.defineProperty(read, property, {
          value,
          configurable: true,
          enumerable: true,
          writable: true,
        }));
      }
      expect(read.workerId).toBe(originalWorkerId);
      expect(read.generation).toBe(originalGeneration);
      expect(read.connectionId).toBe(originalConnectionId);
    }

    direct.stage = WorkerStage.Busy;
    listed.lastHeartbeat = 42;
    expect(repo.getWorker(originalWorkerId)).toMatchObject({
      workerId: originalWorkerId,
      generation: originalGeneration,
      connectionId: originalConnectionId,
      stage: WorkerStage.Busy,
      lastHeartbeat: 42,
    });
    expect(repo.getWorker(changedWorkerId)).toBeUndefined();

    const stale = repo.getWorker(originalWorkerId)!;
    const replacementGeneration = generateWorkerGeneration();
    repo.putWorker({
      ...repo.getWorker(originalWorkerId)!,
      generation: replacementGeneration,
      connectionId: 'replacement-connection',
      stage: WorkerStage.Idle,
    });
    stale.stage = WorkerStage.Disconnected;
    expect(repo.getWorker(originalWorkerId)).toMatchObject({
      generation: replacementGeneration,
      connectionId: 'replacement-connection',
      stage: WorkerStage.Idle,
    });
  });

  it.each(repositories())('%s cannot spoof reconnect identity through a retained mutable worker read', (_name, repo) => {
    const registry = new WorkerRegistry(repo);
    const id = workerId('connection-identity-worker');
    const registration = { workerId: id, tier: WorkerTier.TIER_3, vramMB: 8192 };

    const first = registry.register(registration, 'connection-a', 100);
    expect(first.kind).toBe('created');
    const retained = repo.getWorker(id)!;
    expectProtocolViolation(() => Reflect.set(retained, 'connectionId', 'connection-b'));
    expect(retained.connectionId).toBe('connection-a');

    const reconnect = registry.register(registration, 'connection-b', 200);
    expect(reconnect.kind).toBe('reconnected');
    if (reconnect.kind !== 'reconnected') throw new Error('expected reconnect');
    expect(reconnect.previousGeneration).toBe(first.generation);
    expect(reconnect.generation).not.toBe(first.generation);
    expect(repo.getWorker(id)).toMatchObject({
      connectionId: 'connection-b',
      generation: reconnect.generation,
    });

    const refresh = registry.register(registration, 'connection-b', 300);
    expect(refresh.kind).toBe('updated');
    expect(refresh.generation).toBe(reconnect.generation);
  });
});
