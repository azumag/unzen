/**
 * Durable repository: interface + in-memory implementation (issue #103).
 *
 * The issue requires explicit storage boundaries per responsibility so a
 * production storage adapter can back each one independently:
 *
 *   request state        → requestRecords
 *   idempotency          → idempotencyMappings
 *   attempt history      → attempts
 *   worker/generation    → workers
 *   lease                → activeLeases (one per request)
 *   checkpoint metadata  → checkpoints (envelope with payload locator)
 *   streaming cursor     → streamCursors
 *   completion/result    → results
 *   cancellation state   → cancellations
 *   recovery ownership   → recoveryOwnerships
 *
 * Every mutating operation is single-key atomic. Completion is committed via
 * compare-and-set (`commitCompletion`): a late or duplicate completion is
 * either ignored (`duplicate`) or rejected (`conflict`) and never overwrites
 * the committed result — this is the "committed exactly once" requirement.
 *
 * The interface is deliberately Durable-Object shaped: each method takes
 * explicit keys and mutates one key; a production adapter would put request
 * state, leases, and results on a per-request Durable Object and keep the
 * worker registry on a per-worker object, with compare-and-set delegated to
 * transactional storage. This in-memory implementation is the reference
 * behavior and the test double for the acceptance suite.
 */

import type { ErrorCode } from './errors.js';
import type { AttemptId, IdempotencyKey, LeaseId } from './ids.js';
import type { RequestStage } from './request-state-machine.js';
import type { WorkerId, InferenceRequestId, InferenceResult } from './types.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import type {
  AttemptOutcome,
  AttemptRecord,
  CancellationRecord,
  Lease,
  RequestRecord,
  StreamCursor,
  WorkerRecord,
} from './durable-types.js';

/** Result of a compare-and-set completion commit. */
export type CompletionCommit = 'committed' | 'duplicate' | 'conflict';

/** Result of storing a checkpoint envelope into its (request, segment) slot. */
export type CheckpointStoreResult = 'stored' | 'unchanged' | 'conflict';

/**
 * Short-lived ownership claim used while a reconstructed Coordinator applies a
 * durable recovery decision. It is intentionally separate from worker leases:
 * a recovery owner may exist before any execution worker is selected.
 */
export interface RecoveryOwnership {
  readonly requestId: InferenceRequestId;
  readonly ownerId: string;
  readonly claimedAt: number;
  readonly expiresAt: number;
}

/**
 * Capture a recovery ownership record without enumerating the caller object.
 *
 * Runtime callers can bypass TypeScript readonly fields with accessors or
 * Proxies, so repository adapters own one plain record before comparing or
 * persisting it and return detached records on reads.
 */
export function snapshotRecoveryOwnership(ownership: RecoveryOwnership): RecoveryOwnership {
  const requestId = ownership.requestId;
  const ownerId = ownership.ownerId;
  const claimedAt = ownership.claimedAt;
  const expiresAt = ownership.expiresAt;
  return { requestId, ownerId, claimedAt, expiresAt };
}

/**
 * Capture the complete active-lease identity without enumerating the caller
 * object. Repository adapters persist and return only these plain snapshots so
 * retained caller/read references cannot mutate lease identity or expiry.
 */
export function snapshotLease(lease: Lease): Lease {
  const leaseId = lease.leaseId;
  const requestId = lease.requestId;
  const attemptId = lease.attemptId;
  const workerId = lease.workerId;
  const workerGeneration = lease.workerGeneration;
  const segmentIndex = lease.segmentIndex;
  const modelManifestDigest = lease.modelManifestDigest;
  const issuedAt = lease.issuedAt;
  const expiresAt = lease.expiresAt;
  return {
    leaseId,
    requestId,
    attemptId,
    workerId,
    workerGeneration,
    segmentIndex,
    modelManifestDigest,
    issuedAt,
    expiresAt,
  };
}

/**
 * Capture an attempt-history record in declared-field order without enumerating
 * the caller object. Optional fields retain their own-property presence so a
 * detached read is observably equivalent to the persisted record, including a
 * hostile runtime value that explicitly owns an `undefined` optional field.
 */
export function snapshotAttemptRecord(attempt: AttemptRecord): AttemptRecord {
  const requestId = attempt.requestId;
  const attemptId = attempt.attemptId;
  const leaseId = attempt.leaseId;
  const workerId = attempt.workerId;
  const workerGeneration = attempt.workerGeneration;
  const segmentIndex = attempt.segmentIndex;
  const startedAt = attempt.startedAt;
  const owned: AttemptRecord = {
    requestId,
    attemptId,
    leaseId,
    workerId,
    workerGeneration,
    segmentIndex,
    startedAt,
  };

  for (const field of ['finishedAt', 'outcome', 'errorCode'] as const) {
    if (!Object.prototype.hasOwnProperty.call(attempt, field)) continue;
    Object.defineProperty(owned, field, {
      value: attempt[field],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return owned;
}

/**
 * Capture cancellation state without retaining or enumerating the caller
 * object. Optional acknowledgement presence is preserved across detached
 * repository writes and reads.
 */
export function snapshotCancellationRecord(record: CancellationRecord): CancellationRecord {
  const requestId = record.requestId;
  const requestedAt = record.requestedAt;
  const deadlineMs = record.deadlineMs;
  const owned: CancellationRecord = { requestId, requestedAt, deadlineMs };
  if (Object.prototype.hasOwnProperty.call(record, 'acknowledgedAt')) {
    Object.defineProperty(owned, 'acknowledgedAt', {
      value: record.acknowledgedAt,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return owned;
}

/**
 * Capture streaming progress without retaining or enumerating the caller
 * object. Persisted and returned cursor records are plain detached snapshots so
 * retained runtime references cannot advance or rewrite progress implicitly.
 */
export function snapshotStreamCursor(cursor: StreamCursor): StreamCursor {
  const requestId = cursor.requestId;
  const lastCommittedSegment = cursor.lastCommittedSegment;
  const totalSegments = cursor.totalSegments;
  const updatedAt = cursor.updatedAt;
  return { requestId, lastCommittedSegment, totalSegments, updatedAt };
}

/**
 * Capture a committed inference result without retaining or enumerating the
 * caller object. Tokens are copied by index so hostile runtime arrays cannot
 * alter the persisted output through iteration hooks or retained references.
 */
export function snapshotInferenceResult(result: InferenceResult): InferenceResult {
  const requestId = result.requestId;
  const sourceTokens = result.tokens;
  const tokenCount = sourceTokens.length;
  const tokens = new Array<number>(tokenCount);
  for (let index = 0; index < tokenCount; index += 1) {
    tokens[index] = sourceTokens[index]!;
  }
  const text = result.text;
  const totalTimeMs = result.totalTimeMs;
  const segmentsCompleted = result.segmentsCompleted;
  return { requestId, tokens, text, totalTimeMs, segmentsCompleted };
}

export type RecoveryOwnershipClaim = 'claimed' | 'renewed' | 'owned-by-peer';

/** Patchable fields of an attempt record (append-only otherwise). */
export interface AttemptPatch {
  readonly finishedAt?: number;
  readonly outcome?: AttemptOutcome;
  readonly errorCode?: ErrorCode;
}

export interface DurableRepository {
  // --- request state ---
  createRequest(record: RequestRecord): void;
  getRequest(requestId: InferenceRequestId): RequestRecord | undefined;
  listRequests(): readonly RequestRecord[];
  /** Compare-and-set stage transition. False when `expected` does not match. */
  transitionStage(
    requestId: InferenceRequestId,
    expected: RequestStage,
    next: RequestStage,
  ): boolean;

  // --- idempotency ---
  getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined;
  /** Atomically bind key→request. False when already bound to another request. */
  putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean;

  // --- attempt history ---
  appendAttempt(requestId: InferenceRequestId, attempt: AttemptRecord): void;
  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[];
  updateAttempt(
    requestId: InferenceRequestId,
    attemptId: AttemptId,
    patch: AttemptPatch,
  ): void;

  // --- lease ---
  putLease(lease: Lease): void;
  /** The single active lease for a request, if any. */
  getActiveLease(requestId: InferenceRequestId): Lease | undefined;
  deleteLease(leaseId: LeaseId): void;
  /** All currently active leases (for generation-wide lease reclaim). */
  listActiveLeases(): readonly Lease[];

  // --- checkpoint ---
  putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult;
  getCheckpoint(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): CheckpointEnvelope | undefined;
  deleteCheckpoint(requestId: InferenceRequestId, segmentIndex: number): void;
  deleteCheckpointsForRequest(requestId: InferenceRequestId): void;
  listCheckpoints(requestId: InferenceRequestId): readonly CheckpointEnvelope[];
  /** All stored checkpoints across requests (for global memory bounds). */
  allCheckpoints(): readonly CheckpointEnvelope[];
  /** Remove and return every expired checkpoint (TTL cleanup / memory bound). */
  collectExpiredCheckpoints(now: number): readonly CheckpointEnvelope[];

  // --- completion / result ---
  getResult(requestId: InferenceRequestId): InferenceResult | undefined;
  /** Exactly-once commit: only when stage matches and no result exists yet. */
  commitCompletion(
    requestId: InferenceRequestId,
    expectedStage: RequestStage,
    result: InferenceResult,
  ): CompletionCommit;

  // --- cancellation ---
  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void;
  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined;

  // --- recovery ownership ---
  getRecoveryOwnership(requestId: InferenceRequestId): RecoveryOwnership | undefined;
  /**
   * Acquire/renew one request's recovery command ownership. A live peer claim
   * is never overwritten; an expired claim may be replaced atomically.
   */
  claimRecoveryOwnership(ownership: RecoveryOwnership, now: number): RecoveryOwnershipClaim;
  /** Compare-and-delete release. False when another owner currently holds it. */
  releaseRecoveryOwnership(requestId: InferenceRequestId, ownerId: string): boolean;

  // --- streaming cursor ---
  putStreamCursor(cursor: StreamCursor): void;
  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined;

  // --- worker registration / generation ---
  putWorker(record: WorkerRecord): void;
  getWorker(workerId: WorkerId): WorkerRecord | undefined;
  deleteWorker(workerId: WorkerId): void;
  listWorkers(): readonly WorkerRecord[];
}

export class InMemoryRepository implements DurableRepository {
  // Each storage boundary is a dedicated map (the "buckets" a production
  // adapter would distribute across Durable Objects / KV / R2).
  private readonly requestRecords = new Map<InferenceRequestId, RequestRecord>();
  private readonly idempotencyMappings = new Map<IdempotencyKey, InferenceRequestId>();
  private readonly attempts = new Map<InferenceRequestId, AttemptRecord[]>();
  private readonly activeLeases = new Map<InferenceRequestId, Lease>();
  private readonly checkpoints = new Map<string, CheckpointEnvelope>();
  private readonly results = new Map<InferenceRequestId, InferenceResult>();
  private readonly cancellations = new Map<InferenceRequestId, CancellationRecord>();
  private readonly recoveryOwnerships = new Map<InferenceRequestId, RecoveryOwnership>();
  private readonly streamCursors = new Map<InferenceRequestId, StreamCursor>();
  private readonly workers = new Map<WorkerId, WorkerRecord>();

  private static checkpointKey(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): string {
    return `${requestId}:${segmentIndex}`;
  }

  // --- request state ---

  createRequest(record: RequestRecord): void {
    this.requestRecords.set(record.requestId, record);
  }

  getRequest(requestId: InferenceRequestId): RequestRecord | undefined {
    return this.requestRecords.get(requestId);
  }

  listRequests(): readonly RequestRecord[] {
    return [...this.requestRecords.values()];
  }

  transitionStage(
    requestId: InferenceRequestId,
    expected: RequestStage,
    next: RequestStage,
  ): boolean {
    const record = this.requestRecords.get(requestId);
    if (!record || record.stage !== expected) return false;
    record.stage = next;
    return true;
  }

  // --- idempotency ---

  getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined {
    return this.idempotencyMappings.get(key);
  }

  putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean {
    const existing = this.idempotencyMappings.get(key);
    if (existing !== undefined && existing !== requestId) return false;
    this.idempotencyMappings.set(key, requestId);
    return true;
  }

  // --- attempt history ---

  appendAttempt(requestId: InferenceRequestId, attempt: AttemptRecord): void {
    const list = this.attempts.get(requestId) ?? [];
    list.push(snapshotAttemptRecord(attempt));
    this.attempts.set(requestId, list);
  }

  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[] {
    return (this.attempts.get(requestId) ?? []).map(snapshotAttemptRecord);
  }

  updateAttempt(
    requestId: InferenceRequestId,
    attemptId: AttemptId,
    patch: AttemptPatch,
  ): void {
    const list = this.attempts.get(requestId);
    if (!list) return;
    const attempt = list.find((candidate) => candidate.attemptId === attemptId);
    if (!attempt) return;

    const finishedAt = patch.finishedAt;
    const outcome = patch.outcome;
    const errorCode = patch.errorCode;

    if (finishedAt !== undefined) attempt.finishedAt = finishedAt;
    if (outcome !== undefined) attempt.outcome = outcome;
    if (errorCode !== undefined) attempt.errorCode = errorCode;
  }

  // --- lease ---

  putLease(lease: Lease): void {
    const owned = snapshotLease(lease);
    this.activeLeases.set(owned.requestId, owned);
  }

  getActiveLease(requestId: InferenceRequestId): Lease | undefined {
    const lease = this.activeLeases.get(requestId);
    return lease === undefined ? undefined : snapshotLease(lease);
  }

  deleteLease(leaseId: LeaseId): void {
    for (const [requestId, lease] of this.activeLeases) {
      if (lease.leaseId === leaseId) {
        this.activeLeases.delete(requestId);
        return;
      }
    }
  }

  listActiveLeases(): readonly Lease[] {
    return [...this.activeLeases.values()].map(snapshotLease);
  }

  // --- checkpoint ---

  putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const key = InMemoryRepository.checkpointKey(
      envelope.requestId,
      envelope.segmentIndex,
    );
    const existing = this.checkpoints.get(key);
    if (existing) {
      if (existing.payloadDigest === envelope.payloadDigest) return 'unchanged';
      return 'conflict';
    }
    this.checkpoints.set(key, envelope);
    return 'stored';
  }

  getCheckpoint(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): CheckpointEnvelope | undefined {
    return this.checkpoints.get(InMemoryRepository.checkpointKey(requestId, segmentIndex));
  }

  deleteCheckpoint(requestId: InferenceRequestId, segmentIndex: number): void {
    this.checkpoints.delete(InMemoryRepository.checkpointKey(requestId, segmentIndex));
  }

  deleteCheckpointsForRequest(requestId: InferenceRequestId): void {
    for (const key of [...this.checkpoints.keys()]) {
      if (key.startsWith(`${requestId}:`)) this.checkpoints.delete(key);
    }
  }

  listCheckpoints(requestId: InferenceRequestId): readonly CheckpointEnvelope[] {
    return [...this.checkpoints.values()].filter(
      (envelope) => envelope.requestId === requestId,
    );
  }

  allCheckpoints(): readonly CheckpointEnvelope[] {
    return [...this.checkpoints.values()];
  }

  collectExpiredCheckpoints(now: number): readonly CheckpointEnvelope[] {
    const expired: CheckpointEnvelope[] = [];
    for (const [key, envelope] of [...this.checkpoints]) {
      if (now >= envelope.createdAt + envelope.ttlMs) {
        expired.push(envelope);
        this.checkpoints.delete(key);
      }
    }
    return expired;
  }

  // --- completion / result ---

  getResult(requestId: InferenceRequestId): InferenceResult | undefined {
    const result = this.results.get(requestId);
    return result === undefined ? undefined : snapshotInferenceResult(result);
  }

  commitCompletion(
    requestId: InferenceRequestId,
    expectedStage: RequestStage,
    result: InferenceResult,
  ): CompletionCommit {
    const record = this.requestRecords.get(requestId);
    // A duplicate completion (result already committed) is recorded but never
    // overwrites — the issue demands idempotent handling only when the payload
    // matches, and a result that differs must be surfaced as a violation.
    if (this.results.has(requestId)) return 'duplicate';
    if (!record || record.stage !== expectedStage) return 'conflict';
    this.results.set(requestId, snapshotInferenceResult(result));
    record.stage = 'completed';
    record.completedAt = Date.now();
    return 'committed';
  }

  // --- cancellation ---

  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void {
    this.cancellations.set(requestId, snapshotCancellationRecord(record));
  }

  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined {
    const record = this.cancellations.get(requestId);
    return record === undefined ? undefined : snapshotCancellationRecord(record);
  }

  // --- recovery ownership ---

  getRecoveryOwnership(requestId: InferenceRequestId): RecoveryOwnership | undefined {
    const ownership = this.recoveryOwnerships.get(requestId);
    return ownership === undefined ? undefined : snapshotRecoveryOwnership(ownership);
  }

  claimRecoveryOwnership(
    ownership: RecoveryOwnership,
    now: number,
  ): RecoveryOwnershipClaim {
    const owned = snapshotRecoveryOwnership(ownership);
    const existing = this.recoveryOwnerships.get(owned.requestId);
    if (existing && existing.ownerId !== owned.ownerId && now < existing.expiresAt) {
      return 'owned-by-peer';
    }
    this.recoveryOwnerships.set(owned.requestId, owned);
    return existing?.ownerId === owned.ownerId ? 'renewed' : 'claimed';
  }

  releaseRecoveryOwnership(requestId: InferenceRequestId, ownerId: string): boolean {
    const existing = this.recoveryOwnerships.get(requestId);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.recoveryOwnerships.delete(requestId);
    return true;
  }

  // --- streaming cursor ---

  putStreamCursor(cursor: StreamCursor): void {
    const owned = snapshotStreamCursor(cursor);
    this.streamCursors.set(owned.requestId, owned);
  }

  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined {
    const cursor = this.streamCursors.get(requestId);
    return cursor === undefined ? undefined : snapshotStreamCursor(cursor);
  }

  // --- worker registration / generation ---

  putWorker(record: WorkerRecord): void {
    this.workers.set(record.workerId, record);
  }

  getWorker(workerId: WorkerId): WorkerRecord | undefined {
    return this.workers.get(workerId);
  }

  deleteWorker(workerId: WorkerId): void {
    this.workers.delete(workerId);
  }

  listWorkers(): readonly WorkerRecord[] {
    return [...this.workers.values()];
  }
}
