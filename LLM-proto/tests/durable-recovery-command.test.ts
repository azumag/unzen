import { describe, expect, it } from 'vitest';
import {
  beginDurableRecovery,
  releaseDurableRecoveryOwnership,
} from '../src/durable-recovery-command.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import {
  InMemoryRepository,
  type DurableRepository,
} from '../src/durable-repository.js';
import { ErrorCode } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import type { Lease, RequestRecord } from '../src/durable-types.js';
import { workerId } from '../src/types.js';

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
      .sort(([a], [b]) => a.localeCompare(b));
    if (options.reverse) entries = entries.reverse();
    if (options.limit !== undefined) entries = entries.slice(0, options.limit);
    return entries.map(([key, value]) => [key, structuredClone(value) as T]);
  }
}

const MANIFEST = 'manifest-recovery-command';
const NOW = 50_000;

function seed(
  repo: DurableRepository,
  stage: RequestRecord['stage'] = 'queued',
  overrides: Partial<RequestRecord> = {},
): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recover command',
    stage,
    createdAt: NOW - 1_000,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
    ...overrides,
  };
  repo.createRequest(record);
  return record;
}

function expiredLease(record: RequestRecord): Lease {
  return {
    requestId: record.requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('recovery-expired-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: record.currentSegment,
    modelManifestDigest: MANIFEST,
    issuedAt: NOW - 2_000,
    expiresAt: NOW - 1,
  };
}

function options(ownerId: string, now = NOW) {
  return {
    ownerId,
    now,
    ownershipTtlMs: 1_000,
    maxRetries: 2,
    manifestDigest: MANIFEST,
  } as const;
}

function repositories(): Array<[string, DurableRepository]> {
  return [
    ['in-memory', new InMemoryRepository()],
    ['clone-on-access durable object', new DurableObjectRepository(new CloneOnAccessKv())],
  ];
}

describe('durable recovery command', () => {
  for (const [name, repo] of repositories()) {
    it(`${name}: serializes concurrent recovery ownership`, () => {
      const record = seed(repo);

      const first = beginDurableRecovery(repo, record.requestId, options('owner-a'));
      expect(first.kind).toBe('resume-claimed');
      expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('owner-a');

      const second = beginDurableRecovery(repo, record.requestId, options('owner-b'));
      expect(second.kind).toBe('owned-by-peer');
      if (second.kind === 'owned-by-peer') expect(second.ownership.ownerId).toBe('owner-a');

      expect(releaseDurableRecoveryOwnership(repo, record.requestId, 'owner-b')).toBe(false);
      expect(releaseDurableRecoveryOwnership(repo, record.requestId, 'owner-a')).toBe(true);

      const third = beginDurableRecovery(repo, record.requestId, options('owner-b'));
      expect(third.kind).toBe('resume-claimed');
    });
  }

  it('allows an expired recovery owner to be replaced', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo);
    expect(beginDurableRecovery(repo, record.requestId, options('owner-a', NOW)).kind).toBe('resume-claimed');

    const replacement = beginDurableRecovery(repo, record.requestId, options('owner-b', NOW + 1_001));
    expect(replacement.kind).toBe('resume-claimed');
    expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('owner-b');
  });

  it('reclaims the exact expired execution lease and normalizes running to queued', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running');
    const lease = expiredLease(record);
    repo.putLease(lease);

    const result = beginDurableRecovery(repo, record.requestId, options('recovery-owner'));

    expect(result.kind).toBe('resume-claimed');
    expect(repo.getActiveLease(record.requestId)).toBeUndefined();
    expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('recovery-owner');
  });

  it('waits for a live execution owner without retaining the recovery claim', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running');
    const lease = { ...expiredLease(record), expiresAt: NOW + 10_000 };
    repo.putLease(lease);

    const result = beginDurableRecovery(repo, record.requestId, options('recovery-owner'));

    expect(result.kind).toBe('wait-active-owner');
    expect(repo.getActiveLease(record.requestId)?.leaseId).toBe(lease.leaseId);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });

  it('terminalizes an elapsed absolute deadline instead of leaving a waiter polling forever', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'queued', {
      createdAt: NOW - 5_000,
      timeoutMs: 1_000,
    });

    const result = beginDurableRecovery(repo, record.requestId, options('recovery-owner'));

    expect(result).toEqual({ kind: 'terminal', stage: 'failed' });
    const failed = repo.getRequest(record.requestId);
    expect(failed?.stage).toBe('failed');
    expect(failed?.lastErrorCode).toBe(ErrorCode.DeadlineExceeded);
    expect(failed?.lastError).toContain('deadline elapsed');
    expect(failed?.completedAt).toBe(NOW);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });

  it('applies durable cancellation before resume and releases ownership', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'queued');
    repo.putCancellation(record.requestId, {
      requestId: record.requestId,
      requestedAt: NOW - 10,
      deadlineMs: 5_000,
    });

    const result = beginDurableRecovery(repo, record.requestId, options('recovery-owner'));

    expect(result).toEqual({ kind: 'terminal', stage: 'cancelled' });
    expect(repo.getRequest(record.requestId)?.stage).toBe('cancelled');
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });
});
