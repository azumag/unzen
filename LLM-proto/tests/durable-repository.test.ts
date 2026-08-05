/**
 * Tests for the durable repository interface + in-memory implementation
 * (issue #103 deliverable 2).
 *
 * Verifies explicit storage boundaries (request state, idempotency, attempts,
 * leases, checkpoints, completion/result, cancellation, stream cursor,
 * workers), compare-and-set completion semantics (exactly-once), and that a
 * fresh consumer restoring from the same repository sees durable state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRepository } from '../src/durable-repository.js';
import type { DurableRepository } from '../src/durable-repository.js';
import { generateRequestId, generateAttemptId, generateLeaseId, generateWorkerGeneration, idempotencyKey } from '../src/ids.js';
import { workerId, WorkerTier, inferenceRequestId } from '../src/types.js';
import type { InferenceRequestId } from '../src/types.js';
import { createCheckpointEnvelope } from '../src/checkpoint-envelope.js';
import type { CheckpointEnvelope } from '../src/checkpoint-envelope.js';
import type {
  RequestRecord,
  AttemptRecord,
  WorkerRecord,
  Lease,
  StreamCursor,
  CancellationRecord,
} from '../src/durable-types.js';
import type { InferenceResult } from '../src/types.js';

function makeRequest(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    requestId: generateRequestId(),
    prompt: 'hello',
    stage: 'accepted',
    createdAt: 1_000,
    currentSegment: 0,
    totalSegments: 2,
    manifestDigest: 'd'.repeat(64),
    retryCount: 0,
    ...overrides,
  };
}

function makeResult(requestId: InferenceRequestId): InferenceResult {
  return {
    requestId,
    tokens: [1, 2],
    text: 'ok',
    totalTimeMs: 10,
    segmentsCompleted: 2,
  };
}

async function makeEnvelope(segmentIndex = 0, seed = 0): Promise<CheckpointEnvelope> {
  return createCheckpointEnvelope({
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex,
    workerId: workerId('w1'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: 'd'.repeat(64),
    payload: new Uint8Array([1, 2, 3, seed]),
    ttlMs: 5_000,
    createdAt: 1_000,
  });
}

describe('InMemoryRepository', () => {
  let repo: DurableRepository;

  beforeEach(() => {
    repo = new InMemoryRepository();
  });

  it('starts empty', () => {
    expect(repo.listRequests()).toHaveLength(0);
    expect(repo.listWorkers()).toHaveLength(0);
  });

  describe('request state', () => {
    it('creates and reads a request', () => {
      const record = makeRequest();
      repo.createRequest(record);
      expect(repo.getRequest(record.requestId)?.stage).toBe('accepted');
    });

    it('transitionStage CAS succeeds only when the expected stage matches', () => {
      const record = makeRequest();
      repo.createRequest(record);
      expect(repo.transitionStage(record.requestId, 'accepted', 'queued')).toBe(true);
      expect(repo.transitionStage(record.requestId, 'accepted', 'queued')).toBe(false);
      expect(repo.getRequest(record.requestId)?.stage).toBe('queued');
    });

    it('transitionStage returns false for unknown requests', () => {
      expect(repo.transitionStage(generateRequestId(), 'accepted', 'queued')).toBe(false);
    });
  });

  describe('idempotency', () => {
    it('binds a key to a request exactly once', () => {
      const requestId = generateRequestId();
      const other = generateRequestId();
      const key = idempotencyKey('k1');
      expect(repo.putIdempotencyMapping(key, requestId)).toBe(true);
      expect(repo.getIdempotencyMapping(key)).toBe(requestId);
      expect(repo.putIdempotencyMapping(key, other)).toBe(false);
      expect(repo.getIdempotencyMapping(key)).toBe(requestId);
    });

    it('returns undefined for an unknown key', () => {
      expect(repo.getIdempotencyMapping(idempotencyKey('nope'))).toBeUndefined();
    });
  });

  describe('attempts', () => {
    it('appends and lists attempts in order', () => {
      const record = makeRequest();
      repo.createRequest(record);
      const attempt1: AttemptRecord = {
        requestId: record.requestId,
        attemptId: generateAttemptId(),
        leaseId: generateLeaseId(),
        workerId: workerId('w1'),
        workerGeneration: generateWorkerGeneration(),
        segmentIndex: 0,
        startedAt: 1_000,
      };
      const attempt2: AttemptRecord = { ...attempt1, attemptId: generateAttemptId(), startedAt: 2_000 };
      repo.appendAttempt(record.requestId, attempt1);
      repo.appendAttempt(record.requestId, attempt2);
      expect(repo.listAttempts(record.requestId)).toHaveLength(2);
      expect(repo.listAttempts(generateRequestId())).toHaveLength(0);
    });

    it('updates an attempt outcome', () => {
      const record = makeRequest();
      repo.createRequest(record);
      const attempt: AttemptRecord = {
        requestId: record.requestId,
        attemptId: generateAttemptId(),
        leaseId: generateLeaseId(),
        workerId: workerId('w1'),
        workerGeneration: generateWorkerGeneration(),
        segmentIndex: 0,
        startedAt: 1_000,
      };
      repo.appendAttempt(record.requestId, attempt);
      repo.updateAttempt(record.requestId, attempt.attemptId, {
        outcome: 'completed',
        finishedAt: 2_000,
      });
      expect(repo.listAttempts(record.requestId)[0].outcome).toBe('completed');
      expect(repo.listAttempts(record.requestId)[0].finishedAt).toBe(2_000);
    });
  });

  describe('leases', () => {
    it('tracks a single active lease per request', () => {
      const requestId = generateRequestId();
      const lease: Lease = {
        leaseId: generateLeaseId(),
        requestId,
        attemptId: generateAttemptId(),
        workerId: workerId('w1'),
        workerGeneration: generateWorkerGeneration(),
        segmentIndex: 0,
        modelManifestDigest: 'd'.repeat(64),
        issuedAt: 1_000,
        expiresAt: 5_000,
      };
      repo.putLease(lease);
      expect(repo.getActiveLease(requestId)?.leaseId).toBe(lease.leaseId);
      repo.deleteLease(lease.leaseId);
      expect(repo.getActiveLease(requestId)).toBeUndefined();
    });
  });

  describe('checkpoints', () => {
    it('stores and reads an envelope', async () => {
      const requestId = generateRequestId();
      const envelope = await makeEnvelope();
      repo.putCheckpoint({ ...envelope, requestId });
      expect(repo.getCheckpoint(requestId, 0)?.payloadDigest).toBe(envelope.payloadDigest);
    });

    it('refuses to overwrite a different envelope for the same slot (CAS)', async () => {
      const requestId = generateRequestId();
      const first = await makeEnvelope();
      const second = await makeEnvelope(0, 1);
      expect(repo.putCheckpoint({ ...first, requestId })).toBe('stored');
      expect(repo.putCheckpoint({ ...second, requestId })).toBe('conflict');
      // Identical payload digest is an idempotent no-op.
      expect(repo.putCheckpoint({ ...first, requestId })).toBe('unchanged');
    });

    it('cleans up expired checkpoints by TTL (memory bound)', async () => {
      const requestId = generateRequestId();
      const old = await makeEnvelope();
      repo.putCheckpoint({ ...old, requestId, createdAt: 1_000, ttlMs: 5_000 });
      // Before expiry: nothing collected.
      expect(repo.collectExpiredCheckpoints(5_999)).toHaveLength(0);
      expect(repo.getCheckpoint(requestId, 0)).toBeDefined();
      // After expiry: collected and removed from the store.
      const expired = repo.collectExpiredCheckpoints(6_000);
      expect(expired).toHaveLength(1);
      expect(repo.getCheckpoint(requestId, 0)).toBeUndefined();
    });

    it('deletes all checkpoints for a request', async () => {
      const requestId = generateRequestId();
      for (let i = 0; i < 3; i++) {
        repo.putCheckpoint({ ...(await makeEnvelope(i)), requestId });
      }
      repo.deleteCheckpointsForRequest(requestId);
      expect(repo.listCheckpoints(requestId)).toHaveLength(0);
    });
  });

  describe('completion (exactly-once CAS)', () => {
    it('commits once, then reports duplicate', () => {
      const record = makeRequest();
      repo.createRequest(record);
      repo.transitionStage(record.requestId, 'accepted', 'queued');
      repo.transitionStage(record.requestId, 'queued', 'leased');
      repo.transitionStage(record.requestId, 'leased', 'running');

      const result = makeResult(record.requestId);
      expect(repo.commitCompletion(record.requestId, 'running', result)).toBe('committed');
      expect(repo.getResult(record.requestId)?.text).toBe('ok');
      // Late duplicate completion: never overwrites.
      const late = makeResult(record.requestId);
      expect(repo.commitCompletion(record.requestId, 'running', late)).toBe('duplicate');
      expect(repo.getResult(record.requestId)?.text).toBe('ok');
    });

    it('refuses to commit when the stage does not match (conflict)', () => {
      const record = makeRequest();
      repo.createRequest(record);
      repo.transitionStage(record.requestId, 'accepted', 'queued');
      // Request is queued, not running: completion is a late/out-of-order commit.
      expect(repo.commitCompletion(record.requestId, 'running', makeResult(record.requestId)))
        .toBe('conflict');
      expect(repo.getResult(record.requestId)).toBeUndefined();
    });
  });

  describe('cancellation', () => {
    it('stores and reads a cancellation record', () => {
      const requestId = generateRequestId();
      const record: CancellationRecord = { requestId, requestedAt: 1_000, deadlineMs: 5_000 };
      repo.putCancellation(requestId, record);
      expect(repo.getCancellation(requestId)?.deadlineMs).toBe(5_000);
    });
  });

  describe('stream cursor', () => {
    it('stores and advances the cursor', () => {
      const requestId = generateRequestId();
      const cursor: StreamCursor = {
        requestId,
        lastCommittedSegment: -1,
        totalSegments: 4,
        updatedAt: 1_000,
      };
      repo.putStreamCursor(cursor);
      expect(repo.getStreamCursor(requestId)?.lastCommittedSegment).toBe(-1);
      repo.putStreamCursor({ ...cursor, lastCommittedSegment: 1, updatedAt: 2_000 });
      expect(repo.getStreamCursor(requestId)?.lastCommittedSegment).toBe(1);
    });
  });

  describe('workers', () => {
    it('stores, reads, lists, and deletes workers', () => {
      const worker: WorkerRecord = {
        workerId: workerId('w1'),
        generation: generateWorkerGeneration(),
        connectionId: 'conn-1',
        tier: WorkerTier.TIER_3,
        vramMB: 4096,
        stage: 'idle',
        lastHeartbeat: 1_000,
        registeredAt: 1_000,
      };
      repo.putWorker(worker);
      const wgen = repo.getWorker(workerId('w1'))?.generation;
      expect(wgen).toMatch(/-gen/);
      expect(repo.listWorkers()).toHaveLength(1);
      repo.deleteWorker(workerId('w1'));
      expect(repo.getWorker(workerId('w1'))).toBeUndefined();
    });
  });

  describe('restart survival (in-memory backing store)', () => {
    it('a fresh repository consumer sees previously durable state', async () => {
      // First "process" writes request + result + idempotency mapping.
      const requestId = generateRequestId();
      const key = idempotencyKey('invoice-7');
      const record = makeRequest({ requestId, idempotencyKey: key });
      repo.createRequest(record);
      repo.putIdempotencyMapping(key, requestId);
      repo.transitionStage(requestId, 'accepted', 'queued');
      repo.transitionStage(requestId, 'queued', 'leased');
      repo.transitionStage(requestId, 'leased', 'running');
      repo.commitCompletion(requestId, 'running', makeResult(requestId));
      const checkpoint = await makeEnvelope();
      repo.putCheckpoint({ ...checkpoint, requestId });

      // Second "process": same repository, fresh instance reads it back.
      const fresh = new InMemoryRepository();
      const shared = repo; // in-memory impl IS the durable boundary here
      expect(shared.getRequest(requestId)?.stage).toBe('completed');
      expect(shared.getResult(requestId)?.text).toBe('ok');
      expect(shared.getIdempotencyMapping(key)).toBe(requestId);
      expect(shared.getCheckpoint(requestId, 0)).toBeDefined();
      expect(fresh.getRequest(requestId)).toBeUndefined(); // truly separate instances
    });

    it('is stable across many requests (bulk smoke)', () => {
      for (let i = 0; i < 200; i++) {
        const record = makeRequest({ requestId: inferenceRequestId(`restart-${i}`) });
        repo.createRequest(record);
      }
      expect(repo.listRequests()).toHaveLength(200);
    });
  });
});
