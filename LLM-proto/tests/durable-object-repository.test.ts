import { describe, expect, it } from 'vitest';
import {
  DurableObjectRepository,
  type DurableObjectSyncKvStorage,
} from '../src/durable-object-repository.js';
import {
  DurableCoordinator,
  type DurableSegmentExecutor,
} from '../src/durable-coordinator.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { WorkerId } from '../src/types.js';
import type {
  ExecutionAssignment,
  ExecutionResult,
  ResultIdentity,
} from '../src/durable-types.js';

/**
 * Simulates Durable Object storage semantics: values are structured-cloned on
 * both write and read. Mutating a value returned by `get()` therefore does NOT
 * affect storage unless the repository explicitly writes it back (or its
 * write-through compatibility proxy does so).
 */
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

function coordinatorExecutor(
  totalSegments: number,
  manifestDigest: string,
  calls: ExecutionAssignment[],
): DurableSegmentExecutor {
  return {
    execute: async (_workerId: WorkerId, assignment: ExecutionAssignment): Promise<ExecutionResult> => {
      calls.push(assignment);
      const identity: ResultIdentity = {
        requestId: assignment.requestId,
        attemptId: assignment.attemptId,
        leaseId: assignment.leaseId,
        workerId: assignment.workerId,
        workerGeneration: assignment.workerGeneration,
        segmentIndex: assignment.segmentIndex,
      };
      const final = assignment.segmentIndex === totalSegments - 1;
      const checkpoint = final ? undefined : await createCheckpointEnvelope({
        requestId: identity.requestId,
        attemptId: identity.attemptId,
        segmentIndex: identity.segmentIndex,
        workerId: identity.workerId,
        workerGeneration: identity.workerGeneration,
        modelManifestDigest: manifestDigest,
        formatVersion: 'float16',
        payload: new Uint8Array([identity.segmentIndex + 1, 42]),
        ttlMs: 60_000,
        previousCheckpointDigest: assignment.checkpoint?.payloadDigest,
      });
      return {
        identity,
        checkpoint,
        output: final ? { tokens: [1, 2, 3], text: 'persisted' } : undefined,
        processingTimeMs: 1,
      };
    },
  };
}

describe('DurableObjectRepository', () => {
  it('survives a fresh repository/coordinator instance without double execution', async () => {
    const storage = new CloneOnAccessKv();
    const manifest = createFixtureModelManifest({ totalSegments: 2 });
    const firstCalls: ExecutionAssignment[] = [];
    const repo1 = new DurableObjectRepository(storage);
    const coordinator1 = new DurableCoordinator(
      coordinatorExecutor(2, manifest.manifestDigest, firstCalls),
      manifest,
      { allowFixtureManifest: true, retryDelayMs: 0 },
      repo1,
    );

    const worker = workerId('durable-worker');
    const registration = coordinator1.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 16_384 },
      'connection-a',
    );
    coordinator1.workerHeartbeat(worker, registration.generation);
    const persistedHeartbeat = repo1.getWorker(worker)!.lastHeartbeat;

    const first = coordinator1.submit('hello', { idempotencyKey: 'durable-request-1' });
    await expect(first.result).resolves.toMatchObject({ text: 'persisted' });
    expect(firstCalls).toHaveLength(2);

    // Simulate a Durable Object eviction/restart: no repository/coordinator
    // instance is reused, only the underlying persisted storage survives.
    const secondCalls: ExecutionAssignment[] = [];
    const repo2 = new DurableObjectRepository(storage);
    const coordinator2 = new DurableCoordinator(
      coordinatorExecutor(2, manifest.manifestDigest, secondCalls),
      manifest,
      { allowFixtureManifest: true, retryDelayMs: 0 },
      repo2,
    );

    const status = coordinator2.getStatus(first.requestId);
    expect(status?.stage).toBe('completed');
    expect(status?.startedAt).toBeDefined();
    expect(status?.currentSegment).toBe(1);
    expect(status?.attempts).toHaveLength(2);
    expect(coordinator2.getResult(first.requestId)?.text).toBe('persisted');
    expect(repo2.getWorker(worker)?.lastHeartbeat).toBe(persistedHeartbeat);

    // The persisted idempotency mapping points at the original request and a
    // replay on the fresh instance must not call its executor.
    const replay = coordinator2.submit('hello', { idempotencyKey: 'durable-request-1' });
    expect(replay.requestId).toBe(first.requestId);
    await expect(replay.result).resolves.toMatchObject({ text: 'persisted' });
    expect(secondCalls).toHaveLength(0);
  });

  it('persists top-level mutations returned from request/worker reads', () => {
    const storage = new CloneOnAccessKv();
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const calls: ExecutionAssignment[] = [];
    const repo1 = new DurableObjectRepository(storage);
    const coordinator = new DurableCoordinator(
      coordinatorExecutor(1, manifest.manifestDigest, calls),
      manifest,
      { allowFixtureManifest: true },
      repo1,
    );

    const worker = workerId('mutable-worker');
    const registration = coordinator.registerWorker(
      { workerId: worker, tier: WorkerTier.TIER_3, vramMB: 16_384 },
      'connection-b',
    );
    coordinator.workerHeartbeat(worker, registration.generation);

    const loaded = repo1.getWorker(worker)!;
    loaded.currentSegment = 7;
    loaded.lastHeartbeat = 20;

    const repo2 = new DurableObjectRepository(storage);
    expect(repo2.getWorker(worker)).toMatchObject({
      currentSegment: 7,
      lastHeartbeat: 20,
    });
  });

  it('does not let a stale record mutation roll a terminal transition back', async () => {
    const storage = new CloneOnAccessKv();
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo1 = new DurableObjectRepository(storage);
    const failingExecutor: DurableSegmentExecutor = {
      execute: async () => {
        throw new UnzenError('invalid prompt', ErrorCode.InvalidInput);
      },
    };
    const coordinator = new DurableCoordinator(
      failingExecutor,
      manifest,
      { allowFixtureManifest: true, maxRetries: 0 },
      repo1,
    );
    coordinator.registerWorker(
      { workerId: workerId('failing-worker'), tier: WorkerTier.TIER_3, vramMB: 16_384 },
      'connection-c',
    );

    const submission = coordinator.submit('bad input');
    await expect(submission.result).rejects.toThrow('invalid prompt');

    // finalizeStage performs a CAS transition and then records error/timing on
    // a previously read record. The write-through proxy must merge those fields
    // into the latest stored stage instead of writing the stale stage back.
    const repo2 = new DurableObjectRepository(storage);
    expect(repo2.getRequest(submission.requestId)).toMatchObject({
      stage: 'failed',
      lastErrorCode: ErrorCode.InvalidInput,
      lastError: 'invalid prompt',
    });
    expect(repo2.getRequest(submission.requestId)?.completedAt).toBeDefined();
  });
});
