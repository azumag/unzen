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
    list.push(attempt);
    this.attempts.set(requestId, list);
  }

  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[] {
    return this.attempts.get(requestId) ?? [];
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
    if (patch.finishedAt !== undefined) attempt.finishedAt = patch.finishedAt;
    if (patch.outcome !== undefined) attempt.outcome = patch.outcome;
    if (patch.errorCode !== undefined) attempt.errorCode = patch.errorCode;
  }

  // --- lease ---

  putLease(lease: Lease): void {
    this.activeLeases.set(lease.requestId, lease);
  }

  getActiveLease(requestId: InferenceRequestId): Lease | undefined {
    return this.activeLeases.get(requestId);
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
    return [...this.activeLeases.values()];
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
    return this.results.get(requestId);
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
    this.results.set(requestId, result);
    record.stage = 'completed';
    record.completedAt = Date.now();
    return 'committed';
  }

  // --- cancellation ---

  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void {
    this.cancellations.set(requestId, record);
  }

  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined {
    return this.cancellations.get(requestId);
  }

  // --- recovery ownership ---

  getRecoveryOwnership(requestId: InferenceRequestId): RecoveryOwnership | undefined {
    return this.recoveryOwnerships.get(requestId);
  }

  claimRecoveryOwnership(
    ownership: RecoveryOwnership,
    now: number,
  ): RecoveryOwnershipClaim {
    const existing = this.recoveryOwnerships.get(ownership.requestId);
    if (existing && existing.ownerId !== ownership.ownerId && now < existing.expiresAt) {
      return 'owned-by-peer';
    }
    this.recoveryOwnerships.set(ownership.requestId, ownership);
    return existing?.ownerId === ownership.ownerId ? 'renewed' : 'claimed';
  }

  releaseRecoveryOwnership(requestId: InferenceRequestId, ownerId: string): boolean {
    const existing = this.recoveryOwnerships.get(requestId);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.recoveryOwnerships.delete(requestId);
    return true;
  }

  // --- streaming cursor ---

  putStreamCursor(cursor: StreamCursor): void {
    this.streamCursors.set(cursor.requestId, cursor);
  }

  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined {
    return this.streamCursors.get(requestId);
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
