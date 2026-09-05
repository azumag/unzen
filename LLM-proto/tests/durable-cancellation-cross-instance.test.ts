import { describe, expect, it } from 'vitest';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import {
  InMemoryRepository,
  type DurableRepository,
} from '../src/durable-repository.js';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { ErrorCode, UnzenCancelledError, UnzenError } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
} from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import type {
  ExecutionResult,
  ResultIdentity,
} from '../src/durable-types.js';

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

const manifest = createFixtureModelManifest({ totalSegments: 1 });

const inertExecutor: DurableSegmentExecutor = {
  execute: async () => {
    throw new Error('executor should not be called by seeded cancellation tests');
  },
};

function coordinator(repo: DurableRepository, executor: DurableSegmentExecutor = inertExecutor) {
  return new DurableCoordinator(
    executor,
    manifest,
    {
      allowFixtureManifest: true,
      maxRetries: 0,
      retryDelayMs: 0,
      segmentTimeoutMs: 10_000,
    },
    repo,
  );
}

function seedQueued(repo: DurableRepository) {
  const requestId = generateRequestId();
  repo.createRequest({
    requestId,
    prompt: 'cancel me',
    stage: 'accepted',
    createdAt: Date.now(),
    currentSegment: 0,
    totalSegments: 1,
    manifestDigest: manifest.manifestDigest,
    retryCount: 0,
  });
  expect(repo.transitionStage(requestId, 'accepted', 'queued')).toBe(true);
  return requestId;
}

function seedRunning(repo: DurableRepository, owner: DurableCoordinator) {
  const worker = workerId(`cancel-worker-${Math.random().toString(16).slice(2)}`);
  const registration = owner.registerWorker(
    { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 16_384 },
    `connection-${Math.random().toString(16).slice(2)}`,
  );
  const requestId = seedQueued(repo);
  expect(repo.transitionStage(requestId, 'queued', 'leased')).toBe(true);
  expect(repo.transitionStage(requestId, 'leased', 'running')).toBe(true);
  const attemptId = generateAttemptId();
  const leaseId = generateLeaseId();
  const now = Date.now();
  repo.appendAttempt(requestId, {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
    startedAt: now,
  });
  repo.putLease({
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
    modelManifestDigest: manifest.manifestDigest,
    issuedAt: now,
    expiresAt: now + 60_000,
  });
  const identity: ResultIdentity = {
    requestId,
    attemptId,
    leaseId,
    workerId: worker,
    workerGeneration: registration.generation,
    segmentIndex: 0,
  };
  return { requestId, identity };
}

function finalResult(identity: ResultIdentity): ExecutionResult {
  return {
    identity,
    output: { tokens: [7], text: 'late completion' },
    processingTimeMs: 1,
  };
}

describe('DurableCoordinator cross-instance cancellation', () => {
  it('cancels a queued durable request immediately when no owner or lease exists', () => {
    const repo = new InMemoryRepository();
    const cancelCoordinator = coordinator(repo);
    const requestId = seedQueued(repo);

    const ack = cancelCoordinator.cancel(requestId);

    expect(ack).toMatchObject({
      acknowledged: true,
      disposition: 'cancelled',
    });
    expect(repo.getRequest(requestId)?.stage).toBe('cancelled');
    expect(repo.getCancellation(requestId)?.acknowledgedAt).toBeDefined();
    expect(repo.getActiveLease(requestId)).toBeUndefined();
  });

  it('terminalizes a running request but does not fake stop acknowledgement without the owner', async () => {
    const repo = new InMemoryRepository();
    const owner = coordinator(repo);
    const canceller = coordinator(repo);
    const { requestId, identity } = seedRunning(repo, owner);

    const first = canceller.cancel(requestId);
    expect(first).toMatchObject({
      acknowledged: false,
      disposition: 'pending-stop',
    });
    expect(repo.getRequest(requestId)?.stage).toBe('cancelled');
    expect(repo.getActiveLease(requestId)).toBeUndefined();
    expect(repo.listAttempts(requestId)[0]).toMatchObject({
      outcome: 'cancelled',
      errorCode: ErrorCode.UserCancellation,
    });
    expect(repo.getCancellation(requestId)?.acknowledgedAt).toBeUndefined();

    const repeated = canceller.cancel(requestId);
    expect(repeated).toMatchObject({
      acknowledged: false,
      disposition: 'already-cancelled',
    });
    expect(repo.getCancellation(requestId)?.acknowledgedAt).toBeUndefined();

    const late = await owner.handleWorkerResult(finalResult(identity));
    expect(late.kind).toBe('cancelled');
    expect(repo.getResult(requestId)).toBeUndefined();
    expect(repo.getRequest(requestId)?.stage).toBe('cancelled');
  });

  it('local cancellation acknowledges only after the owning execution settles', async () => {
    const repo = new InMemoryRepository();
    let seenSignal: AbortSignal | undefined;
    const blockingExecutor: DurableSegmentExecutor = {
      execute: async (_worker, _assignment, options) => {
        const signal = options?.signal;
        seenSignal = signal;
        if (!signal) throw new Error('missing abort signal');
        return await new Promise<ExecutionResult>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException('AbortError', 'AbortError'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('AbortError', 'AbortError')),
            { once: true },
          );
        });
      },
    };
    const owner = coordinator(repo, blockingExecutor);
    owner.registerWorker(
      { workerId: workerId('local-cancel-worker'), tier: WorkerTier.TIER_3, vramMB: 16_384 },
      'local-cancel-connection',
    );

    const submission = owner.submit('local cancel');
    await Promise.resolve();
    await Promise.resolve();
    expect(seenSignal).toBeDefined();

    const ack = submission.cancel();
    expect(ack).toMatchObject({
      acknowledged: false,
      disposition: 'pending-stop',
    });
    expect(seenSignal?.aborted).toBe(true);
    await expect(submission.result).rejects.toThrow(UnzenCancelledError);
    expect(repo.getRequest(submission.requestId)?.stage).toBe('cancelled');
    expect(repo.getCancellation(submission.requestId)?.acknowledgedAt).toBeDefined();
  });

  it('does not overwrite completed results and returns a structured terminal disposition', () => {
    const repo = new InMemoryRepository();
    const cancelCoordinator = coordinator(repo);
    const requestId = seedQueued(repo);
    expect(repo.transitionStage(requestId, 'queued', 'leased')).toBe(true);
    expect(repo.transitionStage(requestId, 'leased', 'running')).toBe(true);
    expect(repo.commitCompletion(requestId, 'running', {
      requestId,
      tokens: [1],
      text: 'already done',
      totalTimeMs: 1,
      segmentsCompleted: 1,
    })).toBe('committed');

    const ack = cancelCoordinator.cancel(requestId);

    expect(ack).toMatchObject({
      acknowledged: true,
      disposition: 'already-completed',
    });
    expect(repo.getResult(requestId)?.text).toBe('already done');
    expect(repo.getRequest(requestId)?.stage).toBe('completed');
    expect(repo.getCancellation(requestId)).toBeUndefined();
  });

  it('throws RequestNotFound instead of creating a cancellation for an unknown request', () => {
    const repo = new InMemoryRepository();
    const cancelCoordinator = coordinator(repo);
    const unknown = generateRequestId();

    try {
      cancelCoordinator.cancel(unknown);
      throw new Error('expected cancel to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(UnzenError);
      expect((error as UnzenError).code).toBe(ErrorCode.RequestNotFound);
    }
    expect(repo.getCancellation(unknown)).toBeUndefined();
  });

  it('persists cross-instance cancellation with clone-on-access Durable Object storage', async () => {
    const storage = new CloneOnAccessKv();
    const repo1 = new DurableObjectRepository(storage);
    const owner = coordinator(repo1);
    const { requestId, identity } = seedRunning(repo1, owner);

    const repo2 = new DurableObjectRepository(storage);
    const canceller = coordinator(repo2);
    const ack = canceller.cancel(requestId);
    expect(ack).toMatchObject({
      acknowledged: false,
      disposition: 'pending-stop',
    });

    const repo3 = new DurableObjectRepository(storage);
    expect(repo3.getRequest(requestId)?.stage).toBe('cancelled');
    expect(repo3.getActiveLease(requestId)).toBeUndefined();
    expect(repo3.getCancellation(requestId)?.acknowledgedAt).toBeUndefined();
    expect(repo3.listAttempts(requestId)[0]?.outcome).toBe('cancelled');

    const late = await owner.handleWorkerResult(finalResult(identity));
    expect(late.kind).toBe('cancelled');
    expect(new DurableObjectRepository(storage).getResult(requestId)).toBeUndefined();
  });
});
