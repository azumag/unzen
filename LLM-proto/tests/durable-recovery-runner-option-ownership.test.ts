import { describe, expect, it } from 'vitest';
import {
  runDurableRecovery,
  type DurableRecoveryRunnerOptions,
} from '../src/durable-recovery-runner.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import type { Lease, RequestRecord } from '../src/durable-types.js';
import { workerId } from '../src/types.js';

const START = 125_000;
const MANIFEST = 'manifest-recovery-runner-option-ownership';

function seed(repo: InMemoryRepository, stage: RequestRecord['stage']): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'runner option ownership',
    stage,
    createdAt: START - 1_000,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

function liveLease(record: RequestRecord, expiresAt: number): Lease {
  return {
    requestId: record.requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('runner-owned-options-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: record.currentSegment,
    modelManifestDigest: MANIFEST,
    issuedAt: START - 10,
    expiresAt,
  };
}

function changingGetter<T>(
  target: Record<string, unknown>,
  reads: Record<string, number>,
  key: string,
  first: T,
  later: T,
): void {
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      const count = reads[key] ?? 0;
      reads[key] = count + 1;
      return count === 0 ? first : later;
    },
  });
}

describe('durable recovery runner option ownership', () => {
  it('reads each consumed runner option once and releases with the captured owner', async () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'queued');
    const reads: Record<string, number> = {};
    const source: Record<string, unknown> = {};
    let resumes = 0;

    changingGetter(source, reads, 'ownerId', 'owner-a', 'owner-b');
    changingGetter(source, reads, 'ownershipTtlMs', 1_000, 1);
    changingGetter(source, reads, 'ownershipRenewIntervalMs', 500, 1);
    changingGetter(source, reads, 'pollIntervalMs', 25, 999);
    changingGetter(source, reads, 'maxRetries', 2, 0);
    changingGetter(source, reads, 'manifestDigest', MANIFEST, 'changed-manifest');
    changingGetter(source, reads, 'now', () => START, () => START + 1_000_000);
    changingGetter(source, reads, 'sleep', async () => {}, async () => { throw new Error('changed sleep'); });
    changingGetter(source, reads, 'signal', undefined, new AbortController().signal);
    changingGetter(source, reads, 'onResume', async () => {
      resumes += 1;
      expect(repo.getRecoveryOwnership(record.requestId)?.ownerId).toBe('owner-a');
    }, async () => { throw new Error('changed resume callback'); });

    const result = await runDurableRecovery(
      repo,
      record.requestId,
      source as unknown as DurableRecoveryRunnerOptions,
    );

    expect(result.kind).toBe('resumed');
    expect(resumes).toBe(1);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(reads).toEqual({
      ownerId: 1,
      ownershipTtlMs: 1,
      ownershipRenewIntervalMs: 1,
      pollIntervalMs: 1,
      maxRetries: 1,
      manifestDigest: 1,
      now: 1,
      sleep: 1,
      signal: 1,
      onResume: 1,
    });
  });

  it('keeps one owner and poll cadence across repeated async wait iterations', async () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running');
    repo.putLease(liveLease(record, START + 100));
    const clock = { now: START };
    const waits: number[] = [];
    const reads: Record<string, number> = {};
    const source: Record<string, unknown> = {};
    let observedResumeOwner: string | undefined;

    changingGetter(source, reads, 'ownerId', 'stable-owner', 'changed-owner');
    changingGetter(source, reads, 'ownershipTtlMs', 1_000, 1);
    changingGetter(source, reads, 'ownershipRenewIntervalMs', 500, 1);
    changingGetter(source, reads, 'pollIntervalMs', 25, 1_000);
    changingGetter(source, reads, 'maxRetries', 2, 0);
    changingGetter(source, reads, 'manifestDigest', MANIFEST, 'changed-manifest');
    changingGetter(source, reads, 'now', () => clock.now, () => START + 9_000_000);
    changingGetter(source, reads, 'sleep', async (ms: number) => {
      waits.push(ms);
      clock.now += ms;
    }, async () => { throw new Error('changed sleep'); });
    changingGetter(source, reads, 'signal', undefined, new AbortController().signal);
    changingGetter(source, reads, 'onResume', async () => {
      observedResumeOwner = repo.getRecoveryOwnership(record.requestId)?.ownerId;
    }, async () => { throw new Error('changed resume callback'); });

    const result = await runDurableRecovery(
      repo,
      record.requestId,
      source as unknown as DurableRecoveryRunnerOptions,
    );

    expect(result.kind).toBe('resumed');
    expect(waits).toEqual([25, 25, 25, 25]);
    expect(observedResumeOwner).toBe('stable-owner');
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(reads.ownerId).toBe(1);
    expect(reads.pollIntervalMs).toBe(1);
  });
});
