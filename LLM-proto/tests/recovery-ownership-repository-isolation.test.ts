import { describe, expect, it } from 'vitest';
import { beginDurableRecovery } from '../src/durable-recovery-command.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import {
  InMemoryRepository,
  type DurableRepository,
  type RecoveryOwnership,
} from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';

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

  list<T = unknown>(options: { readonly prefix?: string } = {}): Iterable<[string, T]> {
    return [...this.values.entries()]
      .filter(([key]) => options.prefix === undefined || key.startsWith(options.prefix))
      .map(([key, value]) => [key, value as T]);
  }
}

const NOW = 80_000;
const MANIFEST = 'recovery-ownership-isolation';

function repositories(): Array<[string, DurableRepository]> {
  return [
    ['in-memory', new InMemoryRepository()],
    ['durable-object-reference-storage', new DurableObjectRepository(new ReferenceKv())],
  ];
}

function seed(repo: DurableRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recovery ownership isolation',
    stage: 'queued',
    createdAt: NOW - 100,
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

describe('recovery ownership repository isolation', () => {
  it.each(repositories())('%s captures caller-owned fields once and detaches reads', (_name, repo) => {
    const requestId = generateRequestId();
    const reads = { requestId: 0, ownerId: 0, claimedAt: 0, expiresAt: 0 };
    const values = {
      requestId,
      ownerId: 'owner-a',
      claimedAt: NOW,
      expiresAt: NOW + 1_000,
    };
    const ownership = {
      get requestId() {
        reads.requestId += 1;
        return values.requestId;
      },
      get ownerId() {
        reads.ownerId += 1;
        return values.ownerId;
      },
      get claimedAt() {
        reads.claimedAt += 1;
        return values.claimedAt;
      },
      get expiresAt() {
        reads.expiresAt += 1;
        return values.expiresAt;
      },
    } as RecoveryOwnership;

    expect(repo.claimRecoveryOwnership(ownership, NOW)).toBe('claimed');
    expect(reads).toEqual({ requestId: 1, ownerId: 1, claimedAt: 1, expiresAt: 1 });

    values.ownerId = 'caller-mutated';
    values.claimedAt = NOW + 5_000;
    values.expiresAt = NOW + 6_000;

    const firstRead = repo.getRecoveryOwnership(requestId);
    expect(firstRead).toEqual({
      requestId,
      ownerId: 'owner-a',
      claimedAt: NOW,
      expiresAt: NOW + 1_000,
    });

    Object.assign(firstRead!, {
      ownerId: 'read-mutated',
      claimedAt: 1,
      expiresAt: 2,
    });

    expect(repo.getRecoveryOwnership(requestId)).toEqual({
      requestId,
      ownerId: 'owner-a',
      claimedAt: NOW,
      expiresAt: NOW + 1_000,
    });
  });

  it.each(repositories())('%s keeps resume-claimed ownership detached from persisted state', (_name, repo) => {
    const record = seed(repo);
    const result = beginDurableRecovery(repo, record.requestId, {
      ownerId: 'recovery-owner',
      now: NOW,
      ownershipTtlMs: 1_000,
      maxRetries: 0,
      manifestDigest: MANIFEST,
    });

    expect(result.kind).toBe('resume-claimed');
    if (result.kind !== 'resume-claimed') throw new Error('expected recovery claim');

    Object.assign(result.ownership, {
      ownerId: 'consumer-mutated',
      claimedAt: 1,
      expiresAt: 2,
    });

    expect(repo.getRecoveryOwnership(record.requestId)).toEqual({
      requestId: record.requestId,
      ownerId: 'recovery-owner',
      claimedAt: NOW,
      expiresAt: NOW + 1_000,
    });
  });
});
