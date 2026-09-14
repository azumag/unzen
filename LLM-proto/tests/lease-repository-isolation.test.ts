import { describe, expect, it } from 'vitest';
import { beginDurableRecovery } from '../src/durable-recovery-command.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { InMemoryRepository, type DurableRepository } from '../src/durable-repository.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import type { Lease, RequestRecord } from '../src/durable-types.js';
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

const NOW = 90_000;
const MANIFEST = 'lease-repository-isolation';

function repositories(): Array<[string, DurableRepository]> {
  return [
    ['in-memory', new InMemoryRepository()],
    ['durable-object-reference-storage', new DurableObjectRepository(new ReferenceKv())],
  ];
}

function plainLease(requestId = generateRequestId()): Lease {
  return {
    leaseId: generateLeaseId(),
    requestId,
    attemptId: generateAttemptId(),
    workerId: workerId('lease-isolation-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: 0,
    modelManifestDigest: MANIFEST,
    issuedAt: NOW - 100,
    expiresAt: NOW + 10_000,
  };
}

function seedRunning(repo: DurableRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'lease repository isolation',
    stage: 'running',
    createdAt: NOW - 1_000,
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

describe('active lease repository isolation', () => {
  it.each(repositories())('%s captures all caller-owned lease fields exactly once', (_name, repo) => {
    const values = plainLease();
    const reads = {
      leaseId: 0,
      requestId: 0,
      attemptId: 0,
      workerId: 0,
      workerGeneration: 0,
      segmentIndex: 0,
      modelManifestDigest: 0,
      issuedAt: 0,
      expiresAt: 0,
    };
    const lease = Object.fromEntries(
      Object.keys(reads).map((field) => [field, undefined]),
    ) as unknown as Lease;
    for (const field of Object.keys(reads) as Array<keyof typeof reads>) {
      Object.defineProperty(lease, field, {
        enumerable: true,
        get() {
          reads[field] += 1;
          return values[field as keyof Lease];
        },
      });
    }

    repo.putLease(lease);
    expect(reads).toEqual({
      leaseId: 1,
      requestId: 1,
      attemptId: 1,
      workerId: 1,
      workerGeneration: 1,
      segmentIndex: 1,
      modelManifestDigest: 1,
      issuedAt: 1,
      expiresAt: 1,
    });
    expect(repo.getActiveLease(values.requestId)).toEqual(values);
  });

  it.each(repositories())('%s detaches retained caller, get, and list lease references', (_name, repo) => {
    const lease = plainLease();
    const expected = { ...lease };
    repo.putLease(lease);

    Object.assign(lease, { expiresAt: 1, modelManifestDigest: 'caller-mutated' });
    expect(repo.getActiveLease(expected.requestId)).toEqual(expected);

    const read = repo.getActiveLease(expected.requestId)!;
    Object.assign(read, { expiresAt: 2, workerId: workerId('read-mutated') });
    expect(repo.getActiveLease(expected.requestId)).toEqual(expected);

    const listed = repo.listActiveLeases()[0]!;
    Object.assign(listed, { expiresAt: 3, segmentIndex: 99 });
    expect(repo.getActiveLease(expected.requestId)).toEqual(expected);
  });

  it.each(repositories())('%s keeps wait-active-owner lease detached from persisted state', (_name, repo) => {
    const record = seedRunning(repo);
    const lease = plainLease(record.requestId);
    repo.putLease(lease);

    const result = beginDurableRecovery(repo, record.requestId, {
      ownerId: 'recovery-owner',
      now: NOW,
      ownershipTtlMs: 1_000,
      maxRetries: 0,
      manifestDigest: MANIFEST,
    });

    expect(result.kind).toBe('wait-active-owner');
    if (result.kind !== 'wait-active-owner') throw new Error('expected live execution owner');

    Object.assign(result.lease, {
      expiresAt: 1,
      leaseId: generateLeaseId(),
      modelManifestDigest: 'consumer-mutated',
    });

    expect(repo.getActiveLease(record.requestId)).toEqual(lease);
  });
});
