import { describe, expect, it } from 'vitest';
import { runDurableRecovery } from '../src/durable-recovery-runner.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import {
  InMemoryRepository,
  type DurableRepository,
} from '../src/durable-repository.js';
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

const MANIFEST = 'manifest-recovery-runner';
const START = 100_000;

function seed(
  repo: DurableRepository,
  stage: RequestRecord['stage'],
  overrides: Partial<RequestRecord> = {},
): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recover runner',
    stage,
    createdAt: START,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
    ...overrides,
  };
  repo.createRequest(record);
  return record;
}

function lease(record: RequestRecord, expiresAt: number): Lease {
  return {
    requestId: record.requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('recovery-runner-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: record.currentSegment,
    modelManifestDigest: MANIFEST,
    issuedAt: START,
    expiresAt,
  };
}

function runnerOptions(
  ownerId: string,
  clock: { now: number },
  onResume: Parameters<typeof runDurableRecovery>[2]['onResume'],
  waits: number[],
) {
  return {
    ownerId,
    ownershipTtlMs: 1_000,
    ownershipRenewIntervalMs: 500,
    pollIntervalMs: 25,
    maxRetries: 2,
    manifestDigest: MANIFEST,
    now: () => clock.now,
    sleep: async (ms: number) => {
      waits.push(ms);
      clock.now += ms;
    },
    onResume,
  };
}

describe('durable recovery runner', () => {
  it('bounds active-owner waiting by lease expiry, then resumes exactly once', async () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running');
    repo.putLease(lease(record, START + 100));
    const clock = { now: START };
    const waits: number[] = [];
    let resumes = 0;

    const result = await runDurableRecovery(
      repo,
      record.requestId,
      runnerOptions('recovery-a', clock, async (context) => {
        resumes += 1;
        expect(context.segmentIndex).toBe(0);
        expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
        expect(repo.getActiveLease(record.requestId)).toBeUndefined();
        expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('recovery-a');
      }, waits),
    );

    expect(result.kind).toBe('resumed');
    expect(resumes).toBe(1);
    expect(waits).toEqual([25, 25, 25, 25]);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });

  it('bounds peer-recovery waiting by ownership expiry', async () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'queued');
    repo.claimRecoveryOwnership({
      requestId: record.requestId,
      ownerId: 'peer-owner',
      claimedAt: START,
      expiresAt: START + 60,
    }, START);
    const clock = { now: START };
    const waits: number[] = [];
    let resumes = 0;

    await runDurableRecovery(
      repo,
      record.requestId,
      runnerOptions('recovery-b', clock, async () => {
        resumes += 1;
        expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('recovery-b');
      }, waits),
    );

    expect(resumes).toBe(1);
    expect(waits).toEqual([25, 25, 10]);
    expect(clock.now).toBe(START + 60);
  });

  it('uses the original request deadline to terminalize while a live lease remains', async () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running', { timeoutMs: 40 });
    repo.putLease(lease(record, START + 1_000));
    const clock = { now: START };
    const waits: number[] = [];
    let resumed = false;

    const result = await runDurableRecovery(
      repo,
      record.requestId,
      runnerOptions('recovery-deadline', clock, async () => {
        resumed = true;
      }, waits),
    );

    expect(result).toEqual({ kind: 'terminal', stage: 'failed' });
    expect(resumed).toBe(false);
    expect(waits).toEqual([25, 15]);
    expect(repo.getRequest(record.requestId)?.lastErrorCode).toBe('deadline-exceeded');
    expect(repo.getActiveLease(record.requestId)).toBeUndefined();
  });

  it('keeps recovery ownership visible through resume handoff with clone-on-access storage', async () => {
    const repo = new DurableObjectRepository(new CloneOnAccessKv());
    const record = seed(repo, 'queued');
    const clock = { now: START };
    const waits: number[] = [];
    let observedOwner: string | undefined;

    const result = await runDurableRecovery(
      repo,
      record.requestId,
      runnerOptions('do-recovery-owner', clock, async () => {
        observedOwner = repo.getRecoveryOwnership(record.requestId)?.ownerId;
      }, waits),
    );

    expect(result.kind).toBe('resumed');
    expect(observedOwner).toBe('do-recovery-owner');
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });

  it('propagates caller abort while waiting instead of polling indefinitely', async () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running');
    repo.putLease(lease(record, START + 10_000));
    const controller = new AbortController();
    const clock = { now: START };

    await expect(runDurableRecovery(repo, record.requestId, {
      ownerId: 'abort-owner',
      ownershipTtlMs: 1_000,
      ownershipRenewIntervalMs: 500,
      pollIntervalMs: 25,
      maxRetries: 2,
      manifestDigest: MANIFEST,
      now: () => clock.now,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new DOMException('AbortError', 'AbortError');
      },
      onResume: async () => {
        throw new Error('must not resume');
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
