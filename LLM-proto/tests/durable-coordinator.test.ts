/**
 * Tests for the durable Coordinator (issue #103).
 *
 * Covers the acceptance criteria:
 *   - id/status/idempotency survive process restart (fresh instance on the
 *     same repository)
 *   - same idempotency key does not double-execute
 *   - timeout / cancel delivers AbortSignal to the underlying executor
 *   - task-specific error does not disconnect a healthy worker
 *   - heartbeat loss / protocol violation reflected in worker health
 *   - result with mismatched identity not committed
 *   - checkpoint from another request or model revision not saved
 *   - late/duplicate completion from a pre-retry generation does not overwrite
 *   - same workerId re-registration / stale heartbeat does not blur leases
 *   - checkpoints do not remain in memory forever (TTL cleanup)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DurableCoordinator } from '../src/durable-coordinator.js';
import type { DurableSegmentExecutor } from '../src/durable-coordinator.js';
import { InMemoryRepository } from '../src/durable-repository.js';
import { createFixtureModelManifest } from '../src/model-manifest-fixtures.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import type { CheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { ErrorCode, UnzenError, UnzenCancelledError } from '../src/errors.js';
import { generateRequestId, generateAttemptId, generateLeaseId, generateWorkerGeneration, idempotencyKey } from '../src/ids.js';
import { workerId, WorkerTier } from '../src/types.js';
import type { WorkerId } from '../src/types.js';
import { WorkerStage } from '../src/durable-types.js';
import type { ExecutionAssignment, ExecutionResult, ResultIdentity } from '../src/durable-types.js';

// --- helpers ---

function makeOptions(overrides = {}) {
  return {
    heartbeatTimeoutMs: 1_000,
    heartbeatIntervalMs: 100,
    retryDelayMs: 0,
    segmentTimeoutMs: 50_000,
    leaseTtlMs: 60_000,
    checkpointTtlMs: 60_000,
    checkpointCleanupIntervalMs: 1_000,
    cancelAckDeadlineMs: 5_000,
    maxRetries: 2,
    allowFixtureManifest: true,
    ...overrides,
  };
}

interface MockExecutorHandle {
  executor: DurableSegmentExecutor;
  calls: Array<{ workerId: WorkerId; assignment: ExecutionAssignment; signal?: AbortSignal }>;
}

/**
 * Mock executor that echoes the assignment identity and produces valid
 * checkpoint envelopes for intermediate segments.
 */
function createMockExecutor(
  totalSegments: number,
  manifestDigest: string,
  behavior: {
    hang?: boolean;
    failAlwaysWith?: unknown;
    failOnceWith?: unknown;
  } = {},
): MockExecutorHandle {
  const calls: MockExecutorHandle['calls'] = [];
  let failuresUsed = 0;
  const executor: DurableSegmentExecutor = {
    execute: async (workerId, assignment, options) => {
      calls.push({ workerId, assignment, signal: options?.signal });
      if (behavior.hang) return new Promise(() => {});
      if (behavior.failAlwaysWith !== undefined) throw behavior.failAlwaysWith;
      if (behavior.failOnceWith !== undefined && failuresUsed === 0) {
        failuresUsed++;
        throw behavior.failOnceWith;
      }
      const isFinal = assignment.segmentIndex === totalSegments - 1;
      const identity: ResultIdentity = {
        requestId: assignment.requestId,
        attemptId: assignment.attemptId,
        leaseId: assignment.leaseId,
        workerId: assignment.workerId,
        workerGeneration: assignment.workerGeneration,
        segmentIndex: assignment.segmentIndex,
      };
      const checkpoint = isFinal ? undefined : await createCheckpointEnvelope({
        requestId: identity.requestId,
        attemptId: identity.attemptId,
        segmentIndex: identity.segmentIndex,
        workerId: identity.workerId,
        workerGeneration: identity.workerGeneration,
        modelManifestDigest: manifestDigest,
        formatVersion: 'float16',
        payload: new Uint8Array([identity.segmentIndex + 1, 0]),
        ttlMs: 60_000,
        previousCheckpointDigest: assignment.checkpoint?.payloadDigest,
      });
      return {
        identity,
        checkpoint,
        output: isFinal ? { tokens: [1, 2], text: 'ok' } : undefined,
        processingTimeMs: 5,
      };
    },
  };
  return { executor, calls };
}

/** Build a checkpoint envelope for push-model tests with tamper options. */
async function buildEnvelope(
  identity: ResultIdentity,
  manifestDigest: string,
  opts: {
    tamper?: 'payload' | 'request' | 'revision' | 'expired';
  } = {},
): Promise<CheckpointEnvelope> {
  const base = await createCheckpointEnvelope({
    requestId: identity.requestId,
    attemptId: identity.attemptId,
    segmentIndex: identity.segmentIndex,
    workerId: identity.workerId,
    workerGeneration: identity.workerGeneration,
    modelManifestDigest: manifestDigest,
    formatVersion: 'float16',
    payload: new Uint8Array([7, 7]),
    ttlMs: 60_000,
  });
  if (opts.tamper === 'payload') return { ...base, payload: new Uint8Array([9, 9]) };
  if (opts.tamper === 'request') return { ...base, requestId: generateRequestId() };
  if (opts.tamper === 'revision') return { ...base, modelManifestDigest: 'f'.repeat(64) };
  if (opts.tamper === 'expired') return { ...base, createdAt: Date.now() - 120_000 };
  return base;
}

async function buildResult(
  identity: ResultIdentity,
  manifestDigest: string,
  opts: { final?: boolean; checkpoint?: CheckpointEnvelope } = {},
): Promise<ExecutionResult> {
  return {
    identity,
    checkpoint: opts.checkpoint,
    output: opts.final ? { tokens: [1, 2], text: 'ok' } : undefined,
    processingTimeMs: 3,
  };
}

// --- suite ---

describe('DurableCoordinator', () => {
  const totalSegments = 2;
  let manifest: ReturnType<typeof createFixtureModelManifest>;
  let repo: InMemoryRepository;
  let coord: DurableCoordinator;

  function createCoordinator(executor: DurableSegmentExecutor, repository = repo, options = {}) {
    return new DurableCoordinator(
      executor,
      manifest,
      makeOptions(options),
      repository,
    );
  }

  function registerWorkers(count = 1, vramMB = 8192) {
    for (let i = 0; i < count; i++) {
      coord.registerWorker(
        { workerId: workerId(`w${i}`), tier: WorkerTier.TIER_3, vramMB },
        `conn-${i}`,
      );
    }
  }

  beforeEach(() => {
    manifest = createFixtureModelManifest({ totalSegments });
    repo = new InMemoryRepository();
  });

  afterEach(() => {
    coord?.stopHeartbeatMonitor();
    coord?.stopCheckpointCleanup();
    vi.useRealTimers();
  });

  describe('submission and lookup', () => {
    it('completes a full inference pipeline through the durable path', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers();

      const submission = coord.submit('hello');
      const result = await submission.result;

      expect(result.text).toBe('ok');
      expect(result.segmentsCompleted).toBe(totalSegments);
      expect(calls.length).toBe(totalSegments);
      // Each assignment carried the full identity + manifest digest.
      for (const call of calls) {
        expect(call.assignment.attemptId).toMatch(/-att/);
        expect(call.assignment.leaseId).toMatch(/-lea/);
        expect(call.assignment.workerGeneration).toMatch(/-gen/);
        expect(call.assignment.modelManifestDigest).toBe(manifest.manifestDigest);
      }
    });

    it('exposes status and result lookup', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers();

      const submission = coord.submit('hi');
      await submission.result;

      const status = coord.getStatus(submission.requestId);
      expect(status?.stage).toBe('completed');
      expect(status?.attempts).toHaveLength(totalSegments);
      expect(status?.attempts[0].outcome).toBe('completed');
      expect(status?.completedAt).toBeGreaterThanOrEqual(status?.startedAt ?? 0);
      expect(coord.getResult(submission.requestId)?.text).toBe('ok');
    });

    it('records retries in the observability fields', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, {
        failOnceWith: new UnzenError('WebGPU context lost', ErrorCode.RuntimeTransient),
      });
      coord = createCoordinator(executor);
      registerWorkers(2);

      const submission = coord.submit('hi');
      await submission.result;

      const status = coord.getStatus(submission.requestId);
      expect(status?.stage).toBe('completed');
      expect(status?.retryCount).toBe(1);
      expect(status?.attempts.length).toBe(totalSegments + 1);
    });
  });

  describe('idempotency', () => {
    it('the same idempotency key does not double-execute', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers();

      const first = coord.submit('hi', { idempotencyKey: 'invoice-1' });
      await first.result;
      const callsAfterFirst = calls.length;

      const second = coord.submit('hi', { idempotencyKey: 'invoice-1' });
      expect(second.requestId).toBe(first.requestId);
      const secondResult = await second.result;
      expect(secondResult.text).toBe('ok');
      expect(calls.length).toBe(callsAfterFirst);
    });

    it('different idempotency keys run independently', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers(2);

      const a = coord.submit('a', { idempotencyKey: 'k-a' });
      const b = coord.submit('b', { idempotencyKey: 'k-b' });
      void a; void b;
      await Promise.all([a.result, b.result]);
      expect(a.requestId).not.toBe(b.requestId);
      expect(calls.length).toBe(totalSegments * 2);
    });
  });

  describe('restart survival', () => {
    it('request id/status/idempotency survive process restart', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers();

      const first = coord.submit('hi', { idempotencyKey: 'durable-1' });
      await first.result;

      // A "fresh process" creates a NEW coordinator over the SAME repository.
      const { executor: executor2, calls: calls2 } = createMockExecutor(totalSegments, manifest.manifestDigest);
      const coord2 = createCoordinator(executor2);

      const status = coord2.getStatus(first.requestId);
      expect(status?.stage).toBe('completed');
      expect(coord2.getResult(first.requestId)?.text).toBe('ok');

      // Re-submitting the same idempotency key returns the SAME request and
      // never re-executes on the fresh instance.
      const replay = coord2.submit('hi', { idempotencyKey: 'durable-1' });
      expect(replay.requestId).toBe(first.requestId);
      await expect(replay.result).resolves.toMatchObject({ text: 'ok' });
      expect(calls2.length).toBe(0);
    });
  });

  describe('cancellation / timeout', () => {
    it('a segment timeout delivers an aborted AbortSignal to the executor', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, { hang: true });
      coord = createCoordinator(executor, repo, {
        segmentTimeoutMs: 100,
        maxRetries: 0,
      });
      registerWorkers();

      const submission = coord.submit('hi');
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.length).toBe(1);
      const signal = calls[0].signal!;
      expect(signal.aborted).toBe(false);

      const assertion = expect(submission.result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      expect(signal.aborted).toBe(true);
      await assertion;
      expect(coord.getStatus(submission.requestId)?.stage).toBe('failed');
    });

    it('caller AbortSignal propagates to the executor and cancels', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, { hang: true });
      coord = createCoordinator(executor, repo, { maxRetries: 0 });
      registerWorkers();

      const controller = new AbortController();
      const submission = coord.submit('hi', { signal: controller.signal });
      await vi.advanceTimersByTimeAsync(0);
      const signal = calls[0].signal!;
      expect(signal.aborted).toBe(false);

      controller.abort();
      expect(signal.aborted).toBe(true);
      await expect(submission.result).rejects.toThrow(UnzenCancelledError);
      expect(coord.getStatus(submission.requestId)?.stage).toBe('cancelled');
    });

    it('Coordinator cancel() aborts the executor and records cancellation', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, { hang: true });
      coord = createCoordinator(executor, repo, { maxRetries: 0 });
      registerWorkers();

      const submission = coord.submit('hi');
      await vi.advanceTimersByTimeAsync(0);
      const signal = calls[0].signal!;

      const ack = coord.cancel(submission.requestId);
      expect(ack.acknowledged).toBe(false);
      expect(signal.aborted).toBe(true);
      await expect(submission.result).rejects.toThrow(UnzenCancelledError);
      expect(coord.getStatus(submission.requestId)?.stage).toBe('cancelled');
      expect(repo.getCancellation(submission.requestId)?.requestedAt).toBeDefined();
    });

    it('request deadline aborts and fails with deadline-exceeded', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, { hang: true });
      coord = createCoordinator(executor, repo, {
        segmentTimeoutMs: 100_000,
        maxRetries: 0,
      });
      registerWorkers();

      const submission = coord.submit('hi', { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(0);
      const signal = calls[0].signal!;
      const assertion = expect(submission.result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      expect(signal.aborted).toBe(true);
      await assertion;
      const status = coord.getStatus(submission.requestId);
      expect(status?.stage).toBe('failed');
      expect(status?.lastErrorCode).toBe(ErrorCode.DeadlineExceeded);
    });
  });

  describe('worker health', () => {
    it('a task-specific error does not disconnect a healthy worker', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, {
        failOnceWith: new UnzenError('bad input', ErrorCode.InvalidInput),
      });
      coord = createCoordinator(executor);
      registerWorkers(1);

      const failing = coord.submit('bad');
      await expect(failing.result).rejects.toThrow();
      expect(coord.getStatus(failing.requestId)?.stage).toBe('failed');
      // The worker stays idle/healthy after a task-level failure.
      expect(repo.getWorker(workerId('w0'))?.stage).toBe(WorkerStage.Idle);

      // The same healthy worker can serve the next request.
      const next = coord.submit('good');
      await expect(next.result).resolves.toMatchObject({ text: 'ok' });
    });

    it('heartbeat loss is reflected in worker health', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor, repo, {
        heartbeatTimeoutMs: 1_000,
        heartbeatIntervalMs: 100,
      });
      registerWorkers();
      expect(coord.idleWorkerCount).toBe(1);

      coord.startHeartbeatMonitor();
      await vi.advanceTimersByTimeAsync(1_100);

      expect(repo.getWorker(workerId('w0'))?.stage).toBe(WorkerStage.Disconnected);
      expect(coord.idleWorkerCount).toBe(0);
      coord.stopHeartbeatMonitor();
    });

    it('a stale heartbeat throws and does not revive a disconnected worker', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const outcome = coord.registerWorker(
        { workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 },
        'conn-0',
      );
      expect(outcome.kind).toBe('created');

      coord.workerHeartbeat(workerId('w0'), outcome.generation); // accepted
      expect(() => coord.workerHeartbeat(workerId('w0'), generateWorkerGeneration()))
        .toThrow(/stale/i);
    });
  });

  /** Manually place a request into `running` with an active lease. */
  function placeRunning(requestId, workerIdArg: WorkerId, generation: string, segmentIndex = 0) {
    const record = repo.getRequest(requestId)!;
    repo.transitionStage(requestId, record.stage, 'queued');
    repo.transitionStage(requestId, 'queued', 'leased');
    repo.transitionStage(requestId, 'leased', 'running');
    const attemptId = generateAttemptId();
    const leaseId = generateLeaseId();
    repo.putLease({
      leaseId,
      requestId,
      attemptId,
      workerId: workerIdArg,
      workerGeneration: generation as never,
      segmentIndex,
      modelManifestDigest: manifest.manifestDigest,
      issuedAt: 0,
      expiresAt: Date.now() + 60_000,
    });
    return { requestId, attemptId, leaseId, workerId: workerIdArg, workerGeneration: generation, segmentIndex };
  }

  async function identityFrom(requestId, workerIdArg: WorkerId, generation: string): Promise<ResultIdentity> {
    const active = repo.getActiveLease(requestId)!;
    return {
      requestId,
      attemptId: active.attemptId,
      leaseId: active.leaseId,
      workerId: workerIdArg,
      workerGeneration: generation as never,
      segmentIndex: active.segmentIndex,
    };
  }

  describe('identity matching at the Coordinator boundary', () => {

    it('does not commit a result with a mismatched identity field', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const reg = coord.registerWorker({ workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 }, 'c0');

      const requestId = generateRequestId();
      repo.createRequest({
        requestId,
        prompt: 'hi',
        stage: 'accepted',
        createdAt: Date.now(),
        currentSegment: 0,
        totalSegments,
        manifestDigest: manifest.manifestDigest,
        retryCount: 0,
      });
      const placed = placeRunning(requestId, workerId('w0'), reg.generation);
      const good = await identityFrom(requestId, workerId('w0'), reg.generation);

      const wrongWorker = await buildResult(
        { ...good, workerId: workerId('w9') },
        manifest.manifestDigest,
        { final: true },
      );
      expect((await coord.handleWorkerResult(wrongWorker)).kind).toBe('identity-mismatch');
      expect(repo.getResult(requestId)).toBeUndefined();

      const wrongAttempt = await buildResult(
        { ...good, attemptId: generateAttemptId() },
        manifest.manifestDigest,
        { final: true },
      );
      expect((await coord.handleWorkerResult(wrongAttempt)).kind).toBe('identity-mismatch');
      expect(repo.getResult(requestId)).toBeUndefined();

      const wrongSegment = await buildResult(
        { ...good, segmentIndex: 1 },
        manifest.manifestDigest,
        { final: true },
      );
      expect((await coord.handleWorkerResult(wrongSegment)).kind).toBe('identity-mismatch');
      expect(repo.getResult(requestId)).toBeUndefined();
      void placed;
    });

    it('commits a result whose identity matches the active lease exactly', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const reg = coord.registerWorker({ workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 }, 'c0');

      const requestId = generateRequestId();
      repo.createRequest({
        requestId,
        prompt: 'hi',
        stage: 'accepted',
        createdAt: Date.now(),
        currentSegment: 0,
        totalSegments,
        manifestDigest: manifest.manifestDigest,
        retryCount: 0,
      });
      placeRunning(requestId, workerId('w0'), reg.generation, 1);
      const good = await identityFrom(requestId, workerId('w0'), reg.generation);
      const result = await buildResult(good, manifest.manifestDigest, { final: true });

      expect((await coord.handleWorkerResult(result)).kind).toBe('accepted');
      expect(repo.getResult(requestId)?.text).toBe('ok');
      expect(repo.getRequest(requestId)?.stage).toBe('completed');
    });

    it('a late duplicate completion does not overwrite the committed result', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers();

      const submission = coord.submit('hi');
      await submission.result;
      const committed = repo.getResult(submission.requestId)!;
      const oldAttemptIdentity: ResultIdentity = {
        requestId: submission.requestId,
        attemptId: calls[0].assignment.attemptId,
        leaseId: calls[0].assignment.leaseId,
        workerId: calls[0].assignment.workerId,
        workerGeneration: calls[0].assignment.workerGeneration,
        segmentIndex: 0,
      };
      const late = await buildResult(oldAttemptIdentity, manifest.manifestDigest, { final: true });
      expect((await coord.handleWorkerResult(late)).kind).toBe('identity-mismatch');
      expect(repo.getResult(submission.requestId)).toBe(committed);
      expect(coord.getSuppressions(submission.requestId).length).toBeGreaterThan(0);
    });
  });

  describe('checkpoint integrity', () => {
    it('a checkpoint from another request is not saved or relayed', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const reg = coord.registerWorker({ workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 }, 'c0');

      const requestId = generateRequestId();
      repo.createRequest({
        requestId,
        prompt: 'hi',
        stage: 'accepted',
        createdAt: Date.now(),
        currentSegment: 0,
        totalSegments,
        manifestDigest: manifest.manifestDigest,
        retryCount: 0,
      });
      placeRunning(requestId, workerId('w0'), reg.generation);
      const good = await identityFrom(requestId, workerId('w0'), reg.generation);
      const envelope = await buildEnvelope(good, manifest.manifestDigest, { tamper: 'request' });
      const result = await buildResult(good, manifest.manifestDigest, { checkpoint: envelope });

      expect((await coord.handleWorkerResult(result)).kind).toBe('checkpoint-rejected');
      expect(repo.getCheckpoint(requestId, 0)).toBeUndefined();
    });

    it('a checkpoint from a different model revision is not saved', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const reg = coord.registerWorker({ workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 }, 'c0');

      const requestId = generateRequestId();
      repo.createRequest({
        requestId,
        prompt: 'hi',
        stage: 'accepted',
        createdAt: Date.now(),
        currentSegment: 0,
        totalSegments,
        manifestDigest: manifest.manifestDigest,
        retryCount: 0,
      });
      placeRunning(requestId, workerId('w0'), reg.generation);
      const good = await identityFrom(requestId, workerId('w0'), reg.generation);
      const envelope = await buildEnvelope(good, manifest.manifestDigest, { tamper: 'revision' });
      const result = await buildResult(good, manifest.manifestDigest, { checkpoint: envelope });

      expect((await coord.handleWorkerResult(result)).kind).toBe('checkpoint-rejected');
      expect(repo.getCheckpoint(requestId, 0)).toBeUndefined();
    });

    it('a tampered checkpoint payload is rejected and the worker is isolated', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const reg = coord.registerWorker({ workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 }, 'c0');

      const requestId = generateRequestId();
      repo.createRequest({
        requestId,
        prompt: 'hi',
        stage: 'accepted',
        createdAt: Date.now(),
        currentSegment: 0,
        totalSegments,
        manifestDigest: manifest.manifestDigest,
        retryCount: 0,
      });
      placeRunning(requestId, workerId('w0'), reg.generation);
      const good = await identityFrom(requestId, workerId('w0'), reg.generation);
      const envelope = await buildEnvelope(good, manifest.manifestDigest, { tamper: 'payload' });
      const result = await buildResult(good, manifest.manifestDigest, { checkpoint: envelope });

      expect((await coord.handleWorkerResult(result)).kind).toBe('checkpoint-rejected');
      expect(repo.getCheckpoint(requestId, 0)).toBeUndefined();
      // The protocol violation is reflected in worker health (isolated).
      expect(repo.getWorker(workerId('w0'))).toBeUndefined();
    });

    it('a valid checkpoint from the matching run is stored', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      const reg = coord.registerWorker({ workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 }, 'c0');

      const requestId = generateRequestId();
      repo.createRequest({
        requestId,
        prompt: 'hi',
        stage: 'accepted',
        createdAt: Date.now(),
        currentSegment: 0,
        totalSegments,
        manifestDigest: manifest.manifestDigest,
        retryCount: 0,
      });
      placeRunning(requestId, workerId('w0'), reg.generation);
      const good = await identityFrom(requestId, workerId('w0'), reg.generation);
      const envelope = await buildEnvelope(good, manifest.manifestDigest);
      const result = await buildResult(good, manifest.manifestDigest, { checkpoint: envelope });

      expect((await coord.handleWorkerResult(result)).kind).toBe('accepted');
      expect(repo.getCheckpoint(requestId, 0)?.payloadDigest).toBe(envelope.payloadDigest);
    });

    it('checkpoints are cleaned up after completion (no memory leak)', async () => {
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor);
      registerWorkers();
      const submission = coord.submit('hi');
      await submission.result;
      expect(coord.checkpointCount).toBe(0);
    });

    it('checkpoints do not remain in memory forever (TTL cleanup)', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest);
      coord = createCoordinator(executor, repo, {
        checkpointTtlMs: 1_000,
        checkpointCleanupIntervalMs: 1_000,
      });
      registerWorkers();

      // Simulate an abandoned checkpoint that predates the run.
      const requestId = generateRequestId();
      const envelope = await buildEnvelope(
        {
          requestId,
          attemptId: generateAttemptId(),
          leaseId: generateLeaseId(),
          workerId: workerId('w0'),
          workerGeneration: generateWorkerGeneration(),
          segmentIndex: 0,
        },
        manifest.manifestDigest,
        { tamper: 'expired' },
      );
      repo.putCheckpoint(envelope);
      expect(repo.getCheckpoint(requestId, 0)).toBeDefined();

      coord.startCheckpointCleanup();
      await vi.advanceTimersByTimeAsync(1_000);
      coord.stopCheckpointCleanup();

      expect(repo.getCheckpoint(requestId, 0)).toBeUndefined();
    });
  });

  describe('worker re-registration / generation', () => {
    it('re-registration on a new connection revokes the old generation and its leases', async () => {
      vi.useFakeTimers();
      const { executor, calls } = createMockExecutor(totalSegments, manifest.manifestDigest, { hang: true });
      coord = createCoordinator(executor, repo, { segmentTimeoutMs: 100_000, maxRetries: 0 });
      const first = coord.registerWorker(
        { workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 },
        'conn-1',
      );
      expect(first.kind).toBe('created');

      const submission = coord.submit('hi');
      await vi.advanceTimersByTimeAsync(0);
      // w0 holds the active lease for the running attempt.
      const activeBefore = repo.getActiveLease(submission.requestId);
      expect(activeBefore?.workerGeneration).toBe(first.generation);

      // Reconnect on a NEW connection: old generation revoked + lease reclaimed.
      const second = coord.registerWorker(
        { workerId: workerId('w0'), tier: WorkerTier.TIER_3, vramMB: 8192 },
        'conn-2',
      );
      expect(second.kind).toBe('reconnected');
      expect(second.previousGeneration).toBe(first.generation);
      expect(repo.getActiveLease(submission.requestId)).toBeUndefined();

      // A late result from the revoked generation is suppressed.
      const late = await buildResult(
        {
          requestId: submission.requestId,
          attemptId: activeBefore!.attemptId,
          leaseId: activeBefore!.leaseId,
          workerId: workerId('w0'),
          workerGeneration: first.generation as never,
          segmentIndex: 0,
        },
        manifest.manifestDigest,
        { final: true },
      );
      expect((await coord.handleWorkerResult(late)).kind).toBe('identity-mismatch');
      expect(repo.getResult(submission.requestId)).toBeUndefined();

      // Heartbeat from the revoked generation is a structured error.
      expect(() => coord.workerHeartbeat(workerId('w0'), first.generation))
        .toThrow(/stale/i);
      vi.useRealTimers();
    });
  });
});
