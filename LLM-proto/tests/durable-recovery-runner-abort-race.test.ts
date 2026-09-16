import { describe, expect, it, vi } from 'vitest';
import { runDurableRecovery } from '../src/durable-recovery-runner.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { generateRequestId } from '../src/ids.js';
import type { RequestRecord } from '../src/durable-types.js';

const MANIFEST = 'manifest-recovery-abort-race';
const START = 100_000;

function seedQueued(repo: InMemoryRepository): RequestRecord {
  const record: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'recover abort race',
    stage: 'queued',
    createdAt: START,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: MANIFEST,
    retryCount: 0,
  };
  repo.createRequest(record);
  return record;
}

function abortDuringSubscriptionSignal(): {
  readonly signal: AbortSignal;
  readonly addCount: () => number;
  readonly removeCount: () => number;
} {
  let aborted = false;
  let addCount = 0;
  let removeCount = 0;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type: string) {
      if (type !== 'abort') return;
      addCount += 1;
      // Model the signal flipping after the caller's first `.aborted` check
      // but before the newly-added listener becomes active. A real AbortSignal
      // does not replay an already-dispatched abort event to a late listener.
      aborted = true;
    },
    removeEventListener(type: string) {
      if (type === 'abort') removeCount += 1;
    },
  } as unknown as AbortSignal;

  return {
    signal,
    addCount: () => addCount,
    removeCount: () => removeCount,
  };
}

describe('durable recovery AbortSignal subscription races', () => {
  it('rejects a bounded wait immediately when abort wins listener registration', async () => {
    vi.useFakeTimers();
    try {
      const repo = new InMemoryRepository();
      const record = seedQueued(repo);
      repo.claimRecoveryOwnership({
        requestId: record.requestId,
        ownerId: 'peer-owner',
        claimedAt: START,
        expiresAt: START + 1_000,
      }, START);
      const race = abortDuringSubscriptionSignal();
      let outcome = 'pending';

      const pending = runDurableRecovery(repo, record.requestId, {
        ownerId: 'local-owner',
        ownershipTtlMs: 1_000,
        ownershipRenewIntervalMs: 500,
        pollIntervalMs: 250,
        maxRetries: 2,
        manifestDigest: MANIFEST,
        now: () => START,
        signal: race.signal,
        onResume: async () => {
          throw new Error('must not resume while peer ownership is active');
        },
      });
      pending.then(
        () => { outcome = 'resolved'; },
        (error: unknown) => {
          outcome = error instanceof Error ? error.name : String(error);
        },
      );

      await Promise.resolve();
      await Promise.resolve();

      expect(outcome).toBe('AbortError');
      expect(vi.getTimerCount()).toBe(0);
      expect(race.addCount()).toBe(1);
      expect(race.removeCount()).toBe(1);
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards an abort that wins while the resume listener is being registered', async () => {
    const repo = new InMemoryRepository();
    const record = seedQueued(repo);
    const race = abortDuringSubscriptionSignal();
    let observedAbort = false;

    const result = await runDurableRecovery(repo, record.requestId, {
      ownerId: 'resume-owner',
      ownershipTtlMs: 1_000,
      ownershipRenewIntervalMs: 500,
      pollIntervalMs: 25,
      maxRetries: 2,
      manifestDigest: MANIFEST,
      now: () => START,
      signal: race.signal,
      onResume: async (context) => {
        observedAbort = context.signal.aborted;
      },
    });

    expect(result.kind).toBe('resumed');
    expect(observedAbort).toBe(true);
    expect(race.addCount()).toBe(1);
    expect(race.removeCount()).toBe(1);
    expect(repo.getRecoveryOwnership(record.requestId)).toBeUndefined();
  });
});
