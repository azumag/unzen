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
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { ErrorCode, UnzenError } from '../src/errors.js';
import {
  generateAttemptId,
  generateLeaseId,
  generateRequestId,
  generateWorkerGeneration,
  idempotencyKey,
} from '../src/ids.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import type {
  ExecutionAssignment,
  ExecutionResult,
  RequestRecord,
  ResultIdentity,
} from '../src/durable-types.js';
import { workerId, WorkerTier } from '../src/types.js';

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

function coordinator(
  repo: DurableRepository,
  manifest: ReturnType<typeof createFixtureModelManifest>,
  executor: DurableSegmentExecutor,
  maxRetries = 1,
) {
  return new DurableCoordinator(
    executor,
    manifest,
    {
      allowFixtureManifest: true,
      maxRetries,
      retryDelayMs: 0,
      segmentTimeoutMs: 5_000,
      leaseTtlMs: 100,
      recoveryOwnershipTtlMs: 1_000,
      recoveryOwnershipRenewIntervalMs: 250,
      recoveryPollIntervalMs: 5,
    },
    repo,
  );
}

function seed(
  repo: DurableRepository,
  manifest: ReturnType<typeof createFixtureModelManifest>,
  stage: RequestRecord['stage'],
  overrides: Partial<RequestRecord> = {},
) {
  const request: RequestRecord = {
    requestId: generateRequestId(),
    prompt: 'persisted prompt',
    stage,
    createdAt: Date.now() - 100,
    currentSegment: 0,
    totalSegments: manifest.segments.length,
    manifestDigest: manifest.manifestDigest,
    retryCount: 0,
    ...overrides,
  };
  repo.createRequest(request);
  return request;
}

function finalExecutor(calls: ExecutionAssignment[]): DurableSegmentExecutor {
  return {
    async execute(_workerId, assignment): Promise<ExecutionResult> {
      calls.push(assignment);
      const identity: ResultIdentity = {
        requestId: assignment.requestId,
        attemptId: assignment.attemptId,
        leaseId: assignment.leaseId,
        workerId: assignment.workerId,
        workerGeneration: assignment.workerGeneration,
        segmentIndex: assignment.segmentIndex,
      };
      return {
        identity,
        output: { tokens: [42], text: 'recovered' },
        processingTimeMs: 1,
      };
    },
  };
}

function registerIdleWorker(coord: DurableCoordinator, suffix: string) {
  coord.registerWorker(
    { workerId: workerId(`recovery-worker-${suffix}`), tier: WorkerTier.TIER_3, vramMB: 16_384 },
    `recovery-connection-${suffix}`,
  );
}

describe('DurableCoordinator restart recovery', () => {
  it('idempotent replay actively recovers a persisted queued request', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const key = idempotencyKey('restart-replay');
    const request = seed(repo, manifest, 'queued', { idempotencyKey: key });
    expect(repo.putIdempotencyMapping(key, request.requestId)).toBe(true);
    const calls: ExecutionAssignment[] = [];
    const recovered = coordinator(repo, manifest, finalExecutor(calls));
    registerIdleWorker(recovered, 'replay');

    const submission = recovered.submit('same logical request', { idempotencyKey: 'restart-replay' });
    const result = await submission.result;

    expect(submission.requestId).toBe(request.requestId);
    expect(result.text).toBe('recovered');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.requestId).toBe(request.requestId);
    expect(repo.getRequest(request.requestId)?.stage).toBe('completed');
  });

  it('startup scan recovers persisted requests with clone-on-access Durable Object storage', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new DurableObjectRepository(new CloneOnAccessKv());
    const request = seed(repo, manifest, 'queued');
    const calls: ExecutionAssignment[] = [];
    const recovered = coordinator(repo, manifest, finalExecutor(calls));
    registerIdleWorker(recovered, 'do');

    const submissions = recovered.recoverPendingRequests();
    expect(submissions.map((entry) => entry.requestId)).toContain(request.requestId);
    const target = submissions.find((entry) => entry.requestId === request.requestId)!;
    await expect(target.result).resolves.toMatchObject({ text: 'recovered' });

    expect(calls).toHaveLength(1);
    expect(repo.getRequest(request.requestId)?.stage).toBe('completed');
  });

  it('reclaims an expired persisted lease and does not wait forever', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const request = seed(repo, manifest, 'running');
    repo.putLease({
      requestId: request.requestId,
      attemptId: generateAttemptId(),
      leaseId: generateLeaseId(),
      workerId: workerId('dead-worker'),
      workerGeneration: generateWorkerGeneration(),
      segmentIndex: 0,
      modelManifestDigest: manifest.manifestDigest,
      issuedAt: Date.now() - 1_000,
      expiresAt: Date.now() - 1,
    });
    const calls: ExecutionAssignment[] = [];
    const recovered = coordinator(repo, manifest, finalExecutor(calls));
    registerIdleWorker(recovered, 'expired-lease');

    const [submission] = recovered.recoverPendingRequests();
    await expect(submission!.result).resolves.toMatchObject({ text: 'recovered' });

    expect(calls).toHaveLength(1);
    expect(repo.getRequest(request.requestId)?.stage).toBe('completed');
  });

  it('resumes from the persisted continuation checkpoint without rerunning segment 0', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 2 });
    const repo = new InMemoryRepository();
    const request = seed(repo, manifest, 'queued', { currentSegment: 1 });
    const checkpoint = await createCheckpointEnvelope({
      requestId: request.requestId,
      attemptId: generateAttemptId(),
      segmentIndex: 0,
      workerId: workerId('old-segment-0-worker'),
      workerGeneration: generateWorkerGeneration(),
      modelManifestDigest: manifest.manifestDigest,
      formatVersion: manifest.checkpointFormat,
      payload: new Uint8Array([1, 2, 3]),
      ttlMs: 60_000,
    });
    expect(repo.putCheckpoint(checkpoint)).toBe('stored');
    const calls: ExecutionAssignment[] = [];
    const recovered = coordinator(repo, manifest, finalExecutor(calls));
    registerIdleWorker(recovered, 'continuation');

    const [submission] = recovered.recoverPendingRequests();
    await expect(submission!.result).resolves.toMatchObject({ text: 'recovered' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.segmentIndex).toBe(1);
    expect(calls[0]?.checkpoint?.payloadDigest).toBe(checkpoint.payloadDigest);
  });

  it('serializes two reconstructed Coordinators so the persisted request executes once', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const request = seed(repo, manifest, 'queued');
    const calls: ExecutionAssignment[] = [];
    const executor = finalExecutor(calls);
    const first = coordinator(repo, manifest, executor);
    registerIdleWorker(first, 'shared');
    const second = coordinator(repo, manifest, executor);

    const firstSubmission = first.recoverPendingRequests()[0]!;
    const secondSubmission = second.recoverPendingRequests()[0]!;
    const [a, b] = await Promise.all([firstSubmission.result, secondSubmission.result]);

    expect(a.text).toBe('recovered');
    expect(b.text).toBe('recovered');
    expect(calls).toHaveLength(1);
    expect(repo.getRequest(request.requestId)?.stage).toBe('completed');
  });

  it('preserves the persisted retry budget after restart', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const request = seed(repo, manifest, 'retry-wait', { retryCount: 1 });
    let calls = 0;
    const executor: DurableSegmentExecutor = {
      async execute() {
        calls += 1;
        throw new UnzenError('transient after restart', ErrorCode.RuntimeTransient);
      },
    };
    const recovered = coordinator(repo, manifest, executor, 1);
    registerIdleWorker(recovered, 'retry-budget');

    const [submission] = recovered.recoverPendingRequests();
    await expect(submission!.result).rejects.toMatchObject({ code: ErrorCode.RuntimeTransient });

    expect(calls).toBe(1);
    expect(repo.getRequest(request.requestId)?.retryCount).toBe(1);
    expect(repo.getRequest(request.requestId)?.stage).toBe('failed');
  });

  it('terminalizes an already elapsed original deadline without executing', async () => {
    const manifest = createFixtureModelManifest({ totalSegments: 1 });
    const repo = new InMemoryRepository();
    const request = seed(repo, manifest, 'queued', {
      createdAt: Date.now() - 1_000,
      timeoutMs: 10,
    });
    const calls: ExecutionAssignment[] = [];
    const recovered = coordinator(repo, manifest, finalExecutor(calls));
    registerIdleWorker(recovered, 'deadline');

    const [submission] = recovered.recoverPendingRequests();
    await expect(submission!.result).rejects.toMatchObject({ code: ErrorCode.DeadlineExceeded });

    expect(calls).toHaveLength(0);
    expect(repo.getRequest(request.requestId)?.stage).toBe('failed');
  });
});
