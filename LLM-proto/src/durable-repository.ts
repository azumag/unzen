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
 * explicit keys and mutates one key; a production storage adapter can back
 * each boundary independently while preserving the same repository contract.
 */

import { ErrorCode, UnzenError } from './errors.js';
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

/** Capture one repository-owned recovery ownership snapshot. */
export function snapshotRecoveryOwnership(ownership: RecoveryOwnership): RecoveryOwnership {
  const requestId = ownership.requestId;
  const ownerId = ownership.ownerId;
  const claimedAt = ownership.claimedAt;
  const expiresAt = ownership.expiresAt;
  return { requestId, ownerId, claimedAt, expiresAt };
}

/** Capture one repository-owned active lease snapshot. */
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

/** Capture an attempt-history record without enumerating the caller object. */
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

/** Capture cancellation state without retaining the caller object. */
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

/** Fail closed when a route key disagrees with the captured record identity. */
export function assertRepositoryRequestRouteIdentity(
  routeRequestId: InferenceRequestId,
  recordRequestId: InferenceRequestId,
  recordKind: 'attempt' | 'cancellation' | 'result',
): void {
  if (routeRequestId === recordRequestId) return;
  throw new UnzenError(
    `repository ${recordKind} requestId does not match route requestId`,
    ErrorCode.ProtocolViolation,
  );
}

/** Mutable record families whose operational fields remain write-through. */
export type MutableRepositoryRecordKind = 'request' | 'worker';

/**
 * Keep immutable request specification, durable worker identity, and worker
 * routing trust inputs protected even where #103 requires mutable operational
 * repository reads.
 */
export function assertMutableRepositoryIdentityProperty(
  recordKind: MutableRepositoryRecordKind,
  property: PropertyKey,
): void {
  const immutable = recordKind === 'request'
    ? property === 'requestId' ||
      property === 'prompt' ||
      property === 'idempotencyKey' ||
      property === 'createdAt' ||
      property === 'totalSegments' ||
      property === 'manifestDigest' ||
      property === 'timeoutMs'
    : property === 'workerId' ||
      property === 'generation' ||
      property === 'connectionId' ||
      property === 'tier' ||
      property === 'vramMB';
  if (!immutable) return;
  throw new UnzenError(
    `repository ${recordKind} protected field ${String(property)} is immutable`,
    ErrorCode.ProtocolViolation,
  );
}

/** Wrap one repository-owned mutable record while fencing protected fields. */
function mutableRepositoryRecord<T extends object>(
  record: T,
  recordKind: MutableRepositoryRecordKind,
): T {
  return new Proxy(record, {
    set(target, property, value): boolean {
      assertMutableRepositoryIdentityProperty(recordKind, property);
      return Reflect.set(target, property, value);
    },
    deleteProperty(target, property): boolean {
      assertMutableRepositoryIdentityProperty(recordKind, property);
      return Reflect.deleteProperty(target, property);
    },
    defineProperty(target, property, descriptor): boolean {
      assertMutableRepositoryIdentityProperty(recordKind, property);
      return Reflect.defineProperty(target, property, descriptor);
    },
  });
}

/** Capture streaming progress without retaining the caller object. */
export function snapshotStreamCursor(cursor: StreamCursor): StreamCursor {
  const requestId = cursor.requestId;
  const lastCommittedSegment = cursor.lastCommittedSegment;
  const totalSegments = cursor.totalSegments;
  const updatedAt = cursor.updatedAt;
  return { requestId, lastCommittedSegment, totalSegments, updatedAt };
}

/** Capture a committed inference result and detach its token array. */
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

/** Capture one newly created request before repository ownership changes. */
export function snapshotRequestRecord(record: RequestRecord): RequestRecord {
  const requestId = record.requestId;
  const prompt = record.prompt;
  const stage = record.stage;
  const createdAt = record.createdAt;
  const currentSegment = record.currentSegment;
  const totalSegments = record.totalSegments;
  const manifestDigest = record.manifestDigest;
  const retryCount = record.retryCount;
  const owned: RequestRecord = {
    requestId,
    prompt,
    stage,
    createdAt,
    currentSegment,
    totalSegments,
    manifestDigest,
    retryCount,
  };
  for (const field of [
    'idempotencyKey',
    'startedAt',
    'completedAt',
    'lastErrorCode',
    'lastError',
    'timeoutMs',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    Object.defineProperty(owned, field, {
      value: record[field],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return owned;
}

/** Capture one worker record before repository ownership changes. */
export function snapshotWorkerRecord(record: WorkerRecord): WorkerRecord {
  const workerId = record.workerId;
  const generation = record.generation;
  const connectionId = record.connectionId;
  const tier = record.tier;
  const vramMB = record.vramMB;
  const stage = record.stage;
  const lastHeartbeat = record.lastHeartbeat;
  const registeredAt = record.registeredAt;
  const owned: WorkerRecord = {
    workerId,
    generation,
    connectionId,
    tier,
    vramMB,
    stage,
    lastHeartbeat,
    registeredAt,
  };
  for (const field of ['revokedAt', 'currentSegment'] as const) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    Object.defineProperty(owned, field, {
      value: record[field],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return owned;
}

/** Store-key fields captured before a checkpoint slot is classified. */
export interface CheckpointStoreIdentity {
  readonly requestId: InferenceRequestId;
  readonly segmentIndex: number;
  readonly payloadDigest: string;
}

/** Capture only checkpoint fields needed to classify a slot. */
export function captureCheckpointStoreIdentity(
  envelope: CheckpointEnvelope,
): CheckpointStoreIdentity {
  const requestId = envelope.requestId;
  const segmentIndex = envelope.segmentIndex;
  const payloadDigest = envelope.payloadDigest;
  return { requestId, segmentIndex, payloadDigest };
}

/** Capture one repository-owned checkpoint snapshot. */
export function snapshotCheckpointEnvelope(
  envelope: CheckpointEnvelope,
  identity: CheckpointStoreIdentity = captureCheckpointStoreIdentity(envelope),
): CheckpointEnvelope {
  const attemptId = envelope.attemptId;
  const workerId = envelope.workerId;
  const workerGeneration = envelope.workerGeneration;
  const modelManifestDigest = envelope.modelManifestDigest;
  const formatVersion = envelope.formatVersion;
  const payloadLength = envelope.payloadLength;
  const createdAt = envelope.createdAt;
  const ttlMs = envelope.ttlMs;
  const previousCheckpointDigest = envelope.previousCheckpointDigest;
  const sourcePayload = envelope.payload;
  const byteLength = sourcePayload.byteLength;
  const payload = new Uint8Array(byteLength);
  for (let index = 0; index < byteLength; index += 1) payload[index] = sourcePayload[index]!;
  return {
    requestId: identity.requestId,
    attemptId,
    segmentIndex: identity.segmentIndex,
    workerId,
    workerGeneration,
    modelManifestDigest,
    formatVersion,
    payloadLength,
    payloadDigest: identity.payloadDigest,
    createdAt,
    ttlMs,
    previousCheckpointDigest,
    payload,
  };
}

export type RecoveryOwnershipClaim = 'claimed' | 'renewed' | 'owned-by-peer';

export interface AttemptPatch {
  readonly finishedAt?: number;
  readonly outcome?: AttemptOutcome;
  readonly errorCode?: ErrorCode;
}

export interface DurableRepository {
  createRequest(record: RequestRecord): void;
  getRequest(requestId: InferenceRequestId): RequestRecord | undefined;
  listRequests(): readonly RequestRecord[];
  transitionStage(requestId: InferenceRequestId, expected: RequestStage, next: RequestStage): boolean;

  getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined;
  putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean;

  appendAttempt(requestId: InferenceRequestId, attempt: AttemptRecord): void;
  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[];
  updateAttempt(requestId: InferenceRequestId, attemptId: AttemptId, patch: AttemptPatch): void;

  putLease(lease: Lease): void;
  getActiveLease(requestId: InferenceRequestId): Lease | undefined;
  deleteLease(leaseId: LeaseId): void;
  listActiveLeases(): readonly Lease[];

  putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult;
  getCheckpoint(requestId: InferenceRequestId, segmentIndex: number): CheckpointEnvelope | undefined;
  deleteCheckpoint(requestId: InferenceRequestId, segmentIndex: number): void;
  deleteCheckpointsForRequest(requestId: InferenceRequestId): void;
  listCheckpoints(requestId: InferenceRequestId): readonly CheckpointEnvelope[];
  allCheckpoints(): readonly CheckpointEnvelope[];
  collectExpiredCheckpoints(now: number): readonly CheckpointEnvelope[];

  getResult(requestId: InferenceRequestId): InferenceResult | undefined;
  commitCompletion(requestId: InferenceRequestId, expectedStage: RequestStage, result: InferenceResult): CompletionCommit;

  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void;
  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined;

  getRecoveryOwnership(requestId: InferenceRequestId): RecoveryOwnership | undefined;
  claimRecoveryOwnership(ownership: RecoveryOwnership, now: number): RecoveryOwnershipClaim;
  releaseRecoveryOwnership(requestId: InferenceRequestId, ownerId: string): boolean;

  putStreamCursor(cursor: StreamCursor): void;
  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined;

  putWorker(record: WorkerRecord): void;
  getWorker(workerId: WorkerId): WorkerRecord | undefined;
  deleteWorker(workerId: WorkerId): void;
  listWorkers(): readonly WorkerRecord[];
}

export class InMemoryRepository implements DurableRepository {
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

  private static checkpointKey(requestId: InferenceRequestId, segmentIndex: number): string {
    return `${requestId}:${segmentIndex}`;
  }

  createRequest(record: RequestRecord): void {
    const owned = snapshotRequestRecord(record);
    this.requestRecords.set(owned.requestId, owned);
  }

  getRequest(requestId: InferenceRequestId): RequestRecord | undefined {
    const record = this.requestRecords.get(requestId);
    return record === undefined ? undefined : mutableRepositoryRecord(record, 'request');
  }

  listRequests(): readonly RequestRecord[] {
    return [...this.requestRecords.values()].map((record) => mutableRepositoryRecord(record, 'request'));
  }

  transitionStage(requestId: InferenceRequestId, expected: RequestStage, next: RequestStage): boolean {
    const record = this.requestRecords.get(requestId);
    if (!record || record.stage !== expected) return false;
    record.stage = next;
    return true;
  }

  getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined {
    return this.idempotencyMappings.get(key);
  }

  putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean {
    const existing = this.idempotencyMappings.get(key);
    if (existing !== undefined && existing !== requestId) return false;
    this.idempotencyMappings.set(key, requestId);
    return true;
  }

  appendAttempt(requestId: InferenceRequestId, attempt: AttemptRecord): void {
    const owned = snapshotAttemptRecord(attempt);
    assertRepositoryRequestRouteIdentity(requestId, owned.requestId, 'attempt');
    const list = this.attempts.get(owned.requestId) ?? [];
    list.push(owned);
    this.attempts.set(owned.requestId, list);
  }

  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[] {
    return (this.attempts.get(requestId) ?? []).map(snapshotAttemptRecord);
  }

  updateAttempt(requestId: InferenceRequestId, attemptId: AttemptId, patch: AttemptPatch): void {
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

  putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const identity = captureCheckpointStoreIdentity(envelope);
    const key = InMemoryRepository.checkpointKey(identity.requestId, identity.segmentIndex);
    const existing = this.checkpoints.get(key);
    if (existing) return existing.payloadDigest === identity.payloadDigest ? 'unchanged' : 'conflict';
    this.checkpoints.set(key, snapshotCheckpointEnvelope(envelope, identity));
    return 'stored';
  }

  getCheckpoint(requestId: InferenceRequestId, segmentIndex: number): CheckpointEnvelope | undefined {
    const envelope = this.checkpoints.get(InMemoryRepository.checkpointKey(requestId, segmentIndex));
    return envelope === undefined ? undefined : snapshotCheckpointEnvelope(envelope);
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
    return [...this.checkpoints.values()]
      .filter((envelope) => envelope.requestId === requestId)
      .map((envelope) => snapshotCheckpointEnvelope(envelope));
  }

  allCheckpoints(): readonly CheckpointEnvelope[] {
    return [...this.checkpoints.values()].map((envelope) => snapshotCheckpointEnvelope(envelope));
  }

  collectExpiredCheckpoints(now: number): readonly CheckpointEnvelope[] {
    const expired: CheckpointEnvelope[] = [];
    for (const [key, envelope] of [...this.checkpoints]) {
      if (now >= envelope.createdAt + envelope.ttlMs) {
        expired.push(snapshotCheckpointEnvelope(envelope));
        this.checkpoints.delete(key);
      }
    }
    return expired;
  }

  getResult(requestId: InferenceRequestId): InferenceResult | undefined {
    const result = this.results.get(requestId);
    return result === undefined ? undefined : snapshotInferenceResult(result);
  }

  commitCompletion(requestId: InferenceRequestId, expectedStage: RequestStage, result: InferenceResult): CompletionCommit {
    const record = this.requestRecords.get(requestId);
    if (this.results.has(requestId)) return 'duplicate';
    if (!record || record.stage !== expectedStage) return 'conflict';
    const ownedResult = snapshotInferenceResult(result);
    assertRepositoryRequestRouteIdentity(requestId, ownedResult.requestId, 'result');
    this.results.set(requestId, ownedResult);
    record.stage = 'completed';
    record.completedAt = Date.now();
    return 'committed';
  }

  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void {
    const owned = snapshotCancellationRecord(record);
    assertRepositoryRequestRouteIdentity(requestId, owned.requestId, 'cancellation');
    this.cancellations.set(owned.requestId, owned);
  }

  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined {
    const record = this.cancellations.get(requestId);
    return record === undefined ? undefined : snapshotCancellationRecord(record);
  }

  getRecoveryOwnership(requestId: InferenceRequestId): RecoveryOwnership | undefined {
    const ownership = this.recoveryOwnerships.get(requestId);
    return ownership === undefined ? undefined : snapshotRecoveryOwnership(ownership);
  }

  claimRecoveryOwnership(ownership: RecoveryOwnership, now: number): RecoveryOwnershipClaim {
    const owned = snapshotRecoveryOwnership(ownership);
    const existing = this.recoveryOwnerships.get(owned.requestId);
    if (existing && existing.ownerId !== owned.ownerId && now < existing.expiresAt) return 'owned-by-peer';
    this.recoveryOwnerships.set(owned.requestId, owned);
    return existing?.ownerId === owned.ownerId ? 'renewed' : 'claimed';
  }

  releaseRecoveryOwnership(requestId: InferenceRequestId, ownerId: string): boolean {
    const existing = this.recoveryOwnerships.get(requestId);
    if (!existing || existing.ownerId !== ownerId) return false;
    this.recoveryOwnerships.delete(requestId);
    return true;
  }

  putStreamCursor(cursor: StreamCursor): void {
    const owned = snapshotStreamCursor(cursor);
    this.streamCursors.set(owned.requestId, owned);
  }

  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined {
    const cursor = this.streamCursors.get(requestId);
    return cursor === undefined ? undefined : snapshotStreamCursor(cursor);
  }

  putWorker(record: WorkerRecord): void {
    const owned = snapshotWorkerRecord(record);
    this.workers.set(owned.workerId, owned);
  }

  getWorker(workerId: WorkerId): WorkerRecord | undefined {
    const record = this.workers.get(workerId);
    return record === undefined ? undefined : mutableRepositoryRecord(record, 'worker');
  }

  deleteWorker(workerId: WorkerId): void {
    this.workers.delete(workerId);
  }

  listWorkers(): readonly WorkerRecord[] {
    return [...this.workers.values()].map((record) => mutableRepositoryRecord(record, 'worker'));
  }
}
