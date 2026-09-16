import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import { generateRequestId, idempotencyKey, type IdempotencyKey } from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { WorkerTier, type InferenceRequestId, workerId } from '../src/types.js';
import type { RequestRecord } from '../src/durable-types.js';

const neverExecutor: DurableSegmentExecutor = {
  async execute() {
    throw new Error('executor should not run');
  },
};

function failedRecord(requestId: InferenceRequestId): RequestRecord {
  return {
    requestId,
    prompt: 'existing request',
    stage: 'failed',
    createdAt: Date.now(),
    completedAt: Date.now(),
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: 'fixture-manifest',
    retryCount: 0,
    lastErrorCode: ErrorCode.RuntimeTransient,
    lastError: 'existing failure',
  };
}

function coordinator(repo: InMemoryRepository, executor = neverExecutor): DurableCoordinator {
  return new DurableCoordinator(
    executor,
    createFixtureModelManifest({ totalSegments: 1 }),
    { allowFixtureManifest: true, maxRetries: 0, retryDelayMs: 0 },
    repo,
  );
}

function countingSignal(options?: {
  readonly throwOnAdd?: boolean;
  readonly throwOnRemove?: boolean;
}): {
  readonly signal: AbortSignal;
  readonly added: () => number;
  readonly removed: () => number;
} {
  let added = 0;
  let removed = 0;
  const signal = {
    aborted: false,
    addEventListener(type: string) {
      if (type !== 'abort') return;
      added += 1;
      if (options?.throwOnAdd) throw new Error('add failed');
    },
    removeEventListener(type: string) {
      if (type !== 'abort') return;
      removed += 1;
      if (options?.throwOnRemove) throw new Error('remove failed');
    },
  } as unknown as AbortSignal;
  return { signal, added: () => added, removed: () => removed };
}

describe('DurableCoordinator caller AbortSignal lifecycle', () => {
  it('contains subscription failure before idempotency or request mutation', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    const caller = countingSignal({ throwOnAdd: true });
    const key = idempotencyKey('signal-subscribe-failure');

    let thrown: unknown;
    try {
      coord.submit('prompt', { idempotencyKey: key, signal: caller.signal });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnzenError);
    expect((thrown as UnzenError).code).toBe(ErrorCode.ProtocolViolation);
    expect((thrown as Error).message).toBe('submission signal could not be subscribed');
    expect(caller.added()).toBe(1);
    expect(caller.removed()).toBe(1);
    expect(repo.getIdempotencyMapping(key)).toBeUndefined();
    expect(repo.listRequests()).toEqual([]);
    expect(coord.activeRequestCount).toBe(0);
  });

  it('contains a post-subscription signal state failure before durable mutation', () => {
    const repo = new InMemoryRepository();
    const coord = coordinator(repo);
    let abortedReads = 0;
    let added = 0;
    let removed = 0;
    const signal = {
      get aborted() {
        abortedReads += 1;
        if (abortedReads > 1) throw new Error('aborted getter changed');
        return false;
      },
      addEventListener(type: string) {
        if (type === 'abort') added += 1;
      },
      removeEventListener(type: string) {
        if (type === 'abort') removed += 1;
      },
    } as unknown as AbortSignal;
    const key = idempotencyKey('signal-state-failure');

    expect(() => coord.submit('prompt', { idempotencyKey: key, signal })).toThrow(
      'submission signal state could not be read after subscription',
    );
    expect(abortedReads).toBe(2);
    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(repo.getIdempotencyMapping(key)).toBeUndefined();
    expect(repo.listRequests()).toEqual([]);
    expect(coord.activeRequestCount).toBe(0);
  });

  it('does not attach a caller signal on the existing-idempotency fast path', async () => {
    const repo = new InMemoryRepository();
    const requestId = generateRequestId();
    const key = idempotencyKey('existing-fast-path');
    repo.createRequest(failedRecord(requestId));
    expect(repo.putIdempotencyMapping(key, requestId)).toBe(true);
    const coord = coordinator(repo);
    const caller = countingSignal();

    const submission = coord.submit('duplicate prompt', {
      idempotencyKey: key,
      signal: caller.signal,
    });

    expect(submission.requestId).toBe(requestId);
    expect(caller.added()).toBe(0);
    expect(caller.removed()).toBe(0);
    await submission.result.catch(() => undefined);
    expect(coord.activeRequestCount).toBe(0);
  });

  it('drops a speculative caller listener immediately when idempotency binding loses a race', async () => {
    const existingRequestId = generateRequestId();
    const key = idempotencyKey('concurrent-winner');

    class ConcurrentWinnerRepository extends InMemoryRepository {
      override putIdempotencyMapping(
        candidateKey: IdempotencyKey,
        _candidateRequestId: InferenceRequestId,
      ): boolean {
        if (candidateKey === key) {
          super.putIdempotencyMapping(candidateKey, existingRequestId);
          return false;
        }
        return super.putIdempotencyMapping(candidateKey, _candidateRequestId);
      }
    }

    const repo = new ConcurrentWinnerRepository();
    repo.createRequest(failedRecord(existingRequestId));
    const coord = coordinator(repo);
    const caller = countingSignal();

    const submission = coord.submit('losing prompt', {
      idempotencyKey: key,
      signal: caller.signal,
    });

    expect(submission.requestId).toBe(existingRequestId);
    expect(caller.added()).toBe(1);
    expect(caller.removed()).toBe(1);
    expect(repo.listRequests()).toHaveLength(1);
    await submission.result.catch(() => undefined);
    expect(coord.activeRequestCount).toBe(0);
  });

  it('treats caller listener removal as best-effort after a successful request', async () => {
    const repo = new InMemoryRepository();
    const executor: DurableSegmentExecutor = {
      async execute(_workerId, assignment) {
        return {
          identity: assignment,
          output: { tokens: [7], text: 'ok' },
          processingTimeMs: 1,
        };
      },
    };
    const coord = coordinator(repo, executor);
    coord.registerWorker(
      { workerId: workerId('signal-cleanup-worker'), tier: WorkerTier.TIER_2, vramMB: 8_192 },
      'signal-cleanup-connection',
    );
    const caller = countingSignal({ throwOnRemove: true });

    const submission = coord.submit('successful prompt', { signal: caller.signal });
    await expect(submission.result).resolves.toMatchObject({ text: 'ok', tokens: [7] });

    expect(caller.added()).toBe(1);
    expect(caller.removed()).toBe(1);
    expect(coord.activeRequestCount).toBe(0);
    expect(repo.getRequest(submission.requestId)?.stage).toBe('completed');
  });
});
