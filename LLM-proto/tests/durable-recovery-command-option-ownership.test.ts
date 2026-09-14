import { describe, expect, it } from 'vitest';
import {
  beginDurableRecovery,
  type DurableRecoveryCommandOptions,
} from '../src/durable-recovery-command.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
} from '../src/ids.js';
import type { Lease, RequestRecord } from '../src/durable-types.js';
import { workerId } from '../src/types.js';

const NOW = 75_000;
const MANIFEST = 'manifest-recovery-option-ownership';

function seed(
  repo: InMemoryRepository,
  stage: RequestRecord['stage'] = 'queued',
): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recover option ownership',
    stage,
    createdAt: NOW - 1_000,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

function liveLease(record: RequestRecord): Lease {
  return {
    requestId: record.requestId,
    attemptId: generateAttemptId(),
    leaseId: generateLeaseId(),
    workerId: workerId('live-recovery-worker'),
    workerGeneration: generateWorkerGeneration(),
    segmentIndex: record.currentSegment,
    modelManifestDigest: MANIFEST,
    issuedAt: NOW - 100,
    expiresAt: NOW + 10_000,
  };
}

function getterBackedOptions(
  values: Readonly<Record<keyof DurableRecoveryCommandOptions, readonly [unknown, unknown]>>,
): {
  readonly options: DurableRecoveryCommandOptions;
  readonly reads: Record<keyof DurableRecoveryCommandOptions, number>;
} {
  const reads: Record<keyof DurableRecoveryCommandOptions, number> = {
    ownerId: 0,
    now: 0,
    ownershipTtlMs: 0,
    maxRetries: 0,
    manifestDigest: 0,
  };
  const source: Record<string, unknown> = {};

  for (const key of Object.keys(reads) as Array<keyof DurableRecoveryCommandOptions>) {
    Object.defineProperty(source, key, {
      enumerable: true,
      configurable: true,
      get() {
        const readIndex = reads[key]++;
        return values[key][Math.min(readIndex, 1)];
      },
    });
  }

  return {
    options: source as unknown as DurableRecoveryCommandOptions,
    reads,
  };
}

describe('durable recovery command option ownership', () => {
  it('uses one owned option snapshot for ownership and planning', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo);
    const { options, reads } = getterBackedOptions({
      ownerId: ['owner-a', 'owner-b'],
      now: [NOW, NOW + 100_000],
      ownershipTtlMs: [1_000, 0],
      maxRetries: [2, 0],
      manifestDigest: [MANIFEST, 'changed-manifest'],
    });

    const result = beginDurableRecovery(repo, record.requestId, options);

    expect(result.kind).toBe('resume-claimed');
    if (result.kind !== 'resume-claimed') throw new Error('expected resume claim');
    expect(result.ownership).toMatchObject({
      ownerId: 'owner-a',
      claimedAt: NOW,
      expiresAt: NOW + 1_000,
    });
    expect(repo.getRecoveryOwnership(record.requestId)).toMatchObject({
      ownerId: 'owner-a',
      claimedAt: NOW,
      expiresAt: NOW + 1_000,
    });
    expect(reads).toEqual({
      ownerId: 1,
      now: 1,
      ownershipTtlMs: 1,
      maxRetries: 1,
      manifestDigest: 1,
    });
  });

  it('releases a wait-active-owner claim with the same captured owner id', () => {
    const repo = new InMemoryRepository();
    const record = seed(repo, 'running');
    repo.putLease(liveLease(record));
    const { options, reads } = getterBackedOptions({
      ownerId: ['owner-a', 'owner-b'],
      now: [NOW, NOW],
      ownershipTtlMs: [1_000, 1_000],
      maxRetries: [2, 2],
      manifestDigest: [MANIFEST, MANIFEST],
    });

    const result = beginDurableRecovery(repo, record.requestId, options);

    expect(result.kind).toBe('wait-active-owner');
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
    expect(reads.ownerId).toBe(1);
    expect(reads.now).toBe(1);
  });

  it('preserves missing and terminal short-circuits without reading options', () => {
    const repo = new InMemoryRepository();
    const hostile = {} as DurableRecoveryCommandOptions;
    for (const key of ['ownerId', 'now', 'ownershipTtlMs', 'maxRetries', 'manifestDigest'] as const) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`unexpected option read: ${key}`);
        },
      });
    }

    expect(beginDurableRecovery(repo, generateRequestId(), hostile)).toEqual({ kind: 'missing' });

    const completed = seed(repo, 'completed');
    expect(beginDurableRecovery(repo, completed.requestId, hostile)).toEqual({
      kind: 'terminal',
      stage: 'completed',
    });
  });
});
