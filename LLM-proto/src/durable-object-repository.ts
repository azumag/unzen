/**
 * Cloudflare Durable Object storage adapter for the durable Coordinator.
 *
 * Issue #103 deliberately kept DurableRepository synchronous. SQLite-backed
 * Durable Objects expose a synchronous KV API at `ctx.storage.kv`, which lets
 * us preserve that contract while moving request/lease/checkpoint/result state
 * out of process memory.
 *
 * The adapter is intentionally typed against the small structural surface it
 * needs instead of importing `cloudflare:workers`, so the transport-agnostic
 * LLM prototype remains runnable under Node/Vitest. In a Worker, construct it
 * with `new DurableObjectRepository(this.ctx.storage.kv)` from a SQLite-backed
 * Durable Object.
 */

import type {
  AttemptPatch,
  CheckpointStoreResult,
  CompletionCommit,
  DurableRepository,
} from './durable-repository.js';
import type { AttemptId, IdempotencyKey, LeaseId } from './ids.js';
import type { InferenceRequestId, InferenceResult, WorkerId } from './types.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import type {
  AttemptRecord,
  CancellationRecord,
  Lease,
  RequestRecord,
  StreamCursor,
  WorkerRecord,
} from './durable-types.js';

/**
 * Structural subset of the SQLite-backed Durable Object synchronous KV API.
 * `ctx.storage.kv` satisfies this shape.
 */
export interface DurableObjectSyncKvStorage {
  get<T = unknown>(key: string): T | undefined;
  put<T = unknown>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T = unknown>(options?: {
    readonly prefix?: string;
    readonly start?: string;
    readonly startAfter?: string;
    readonly end?: string;
    readonly reverse?: boolean;
    readonly limit?: number;
  }): Iterable<[string, T]>;
}

const PREFIX = {
  request: 'request:',
  idempotency: 'idempotency:',
  attempts: 'attempts:',
  lease: 'lease:',
  leaseIndex: 'lease-index:',
  checkpoint: 'checkpoint:',
  result: 'result:',
  cancellation: 'cancellation:',
  cursor: 'cursor:',
  worker: 'worker:',
} as const;

function part(value: string | number): string {
  return encodeURIComponent(String(value));
}

function requestKey(requestId: InferenceRequestId): string {
  return `${PREFIX.request}${part(requestId)}`;
}

function idempotencyKey(key: IdempotencyKey): string {
  return `${PREFIX.idempotency}${part(key)}`;
}

function attemptsKey(requestId: InferenceRequestId): string {
  return `${PREFIX.attempts}${part(requestId)}`;
}

function leaseKey(requestId: InferenceRequestId): string {
  return `${PREFIX.lease}${part(requestId)}`;
}

function leaseIndexKey(leaseId: LeaseId): string {
  return `${PREFIX.leaseIndex}${part(leaseId)}`;
}

function checkpointPrefix(requestId?: InferenceRequestId): string {
  return requestId === undefined
    ? PREFIX.checkpoint
    : `${PREFIX.checkpoint}${part(requestId)}:`;
}

function checkpointKey(requestId: InferenceRequestId, segmentIndex: number): string {
  return `${checkpointPrefix(requestId)}${part(segmentIndex)}`;
}

function resultKey(requestId: InferenceRequestId): string {
  return `${PREFIX.result}${part(requestId)}`;
}

function cancellationKey(requestId: InferenceRequestId): string {
  return `${PREFIX.cancellation}${part(requestId)}`;
}

function cursorKey(requestId: InferenceRequestId): string {
  return `${PREFIX.cursor}${part(requestId)}`;
}

function workerKey(workerId: WorkerId): string {
  return `${PREFIX.worker}${part(workerId)}`;
}

/**
 * DurableRepository backed by one SQLite Durable Object's synchronous KV
 * storage. The containing Durable Object is the coordination atom; callers
 * should shard by a stable Coordinator key rather than route every workload to
 * one global singleton.
 *
 * A small write-through Proxy is used for RequestRecord and WorkerRecord.
 * Existing #103 code historically mutates those records after `get*()` (the
 * in-memory repository returns live references). Durable Object reads return
 * structured-cloned values, so without this compatibility layer those changes
 * would silently disappear on restart. Every top-level mutation is persisted
 * synchronously before control returns to the caller.
 */
export class DurableObjectRepository implements DurableRepository {
  constructor(private readonly storage: DurableObjectSyncKvStorage) {}

  private mutableRecord<T extends object>(key: string, value: T | undefined): T | undefined {
    if (value === undefined) return undefined;
    const storage = this.storage;
    return new Proxy(value, {
      set(target, property, next): boolean {
        const ok = Reflect.set(target, property, next);
        if (ok) storage.put(key, target);
        return ok;
      },
      deleteProperty(target, property): boolean {
        const ok = Reflect.deleteProperty(target, property);
        if (ok) storage.put(key, target);
        return ok;
      },
    });
  }

  private listValues<T>(prefix: string): T[] {
    return [...this.storage.list<T>({ prefix })].map(([, value]) => value);
  }

  private listMutableValues<T extends object>(prefix: string): T[] {
    return [...this.storage.list<T>({ prefix })].map(([key, value]) =>
      this.mutableRecord(key, value)!,
    );
  }

  // --- request state ---

  createRequest(record: RequestRecord): void {
    this.storage.put(requestKey(record.requestId), record);
  }

  getRequest(requestId: InferenceRequestId): RequestRecord | undefined {
    const key = requestKey(requestId);
    return this.mutableRecord(key, this.storage.get<RequestRecord>(key));
  }

  listRequests(): readonly RequestRecord[] {
    return this.listMutableValues<RequestRecord>(PREFIX.request);
  }

  transitionStage(
    requestId: InferenceRequestId,
    expected: RequestRecord['stage'],
    next: RequestRecord['stage'],
  ): boolean {
    const key = requestKey(requestId);
    const record = this.storage.get<RequestRecord>(key);
    if (!record || record.stage !== expected) return false;
    record.stage = next;
    this.storage.put(key, record);
    return true;
  }

  // --- idempotency ---

  getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined {
    return this.storage.get<InferenceRequestId>(idempotencyKey(key));
  }

  putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean {
    const storageKey = idempotencyKey(key);
    const existing = this.storage.get<InferenceRequestId>(storageKey);
    if (existing !== undefined && existing !== requestId) return false;
    this.storage.put(storageKey, requestId);
    return true;
  }

  // --- attempt history ---

  appendAttempt(requestId: InferenceRequestId, attempt: AttemptRecord): void {
    const key = attemptsKey(requestId);
    const attempts = this.storage.get<AttemptRecord[]>(key) ?? [];
    attempts.push(attempt);
    this.storage.put(key, attempts);
  }

  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[] {
    return this.storage.get<AttemptRecord[]>(attemptsKey(requestId)) ?? [];
  }

  updateAttempt(
    requestId: InferenceRequestId,
    attemptId: AttemptId,
    patch: AttemptPatch,
  ): void {
    const key = attemptsKey(requestId);
    const attempts = this.storage.get<AttemptRecord[]>(key);
    if (!attempts) return;
    const attempt = attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!attempt) return;
    if (patch.finishedAt !== undefined) attempt.finishedAt = patch.finishedAt;
    if (patch.outcome !== undefined) attempt.outcome = patch.outcome;
    if (patch.errorCode !== undefined) attempt.errorCode = patch.errorCode;
    this.storage.put(key, attempts);
  }

  // --- lease ---

  putLease(lease: Lease): void {
    const activeKey = leaseKey(lease.requestId);
    const previous = this.storage.get<Lease>(activeKey);
    if (previous && previous.leaseId !== lease.leaseId) {
      this.storage.delete(leaseIndexKey(previous.leaseId));
    }
    this.storage.put(activeKey, lease);
    this.storage.put(leaseIndexKey(lease.leaseId), lease.requestId);
  }

  getActiveLease(requestId: InferenceRequestId): Lease | undefined {
    return this.storage.get<Lease>(leaseKey(requestId));
  }

  deleteLease(leaseId: LeaseId): void {
    const indexKey = leaseIndexKey(leaseId);
    const requestId = this.storage.get<InferenceRequestId>(indexKey);
    if (requestId === undefined) return;
    const activeKey = leaseKey(requestId);
    const lease = this.storage.get<Lease>(activeKey);
    if (lease?.leaseId === leaseId) this.storage.delete(activeKey);
    this.storage.delete(indexKey);
  }

  listActiveLeases(): readonly Lease[] {
    return this.listValues<Lease>(PREFIX.lease);
  }

  // --- checkpoint ---

  putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const key = checkpointKey(envelope.requestId, envelope.segmentIndex);
    const existing = this.storage.get<CheckpointEnvelope>(key);
    if (existing) {
      if (existing.payloadDigest === envelope.payloadDigest) return 'unchanged';
      return 'conflict';
    }
    this.storage.put(key, envelope);
    return 'stored';
  }

  getCheckpoint(
    requestId: InferenceRequestId,
    segmentIndex: number,
  ): CheckpointEnvelope | undefined {
    return this.storage.get<CheckpointEnvelope>(checkpointKey(requestId, segmentIndex));
  }

  deleteCheckpoint(requestId: InferenceRequestId, segmentIndex: number): void {
    this.storage.delete(checkpointKey(requestId, segmentIndex));
  }

  deleteCheckpointsForRequest(requestId: InferenceRequestId): void {
    for (const [key] of this.storage.list({ prefix: checkpointPrefix(requestId) })) {
      this.storage.delete(key);
    }
  }

  listCheckpoints(requestId: InferenceRequestId): readonly CheckpointEnvelope[] {
    return this.listValues<CheckpointEnvelope>(checkpointPrefix(requestId));
  }

  allCheckpoints(): readonly CheckpointEnvelope[] {
    return this.listValues<CheckpointEnvelope>(PREFIX.checkpoint);
  }

  collectExpiredCheckpoints(now: number): readonly CheckpointEnvelope[] {
    const expired: CheckpointEnvelope[] = [];
    for (const [key, envelope] of this.storage.list<CheckpointEnvelope>({
      prefix: PREFIX.checkpoint,
    })) {
      if (now >= envelope.createdAt + envelope.ttlMs) {
        expired.push(envelope);
        this.storage.delete(key);
      }
    }
    return expired;
  }

  // --- completion / result ---

  getResult(requestId: InferenceRequestId): InferenceResult | undefined {
    return this.storage.get<InferenceResult>(resultKey(requestId));
  }

  commitCompletion(
    requestId: InferenceRequestId,
    expectedStage: RequestRecord['stage'],
    result: InferenceResult,
  ): CompletionCommit {
    const requestStorageKey = requestKey(requestId);
    const resultStorageKey = resultKey(requestId);
    const existing = this.storage.get<InferenceResult>(resultStorageKey);
    if (existing !== undefined) return 'duplicate';

    const record = this.storage.get<RequestRecord>(requestStorageKey);
    if (!record || record.stage !== expectedStage) return 'conflict';

    record.stage = 'completed';
    record.completedAt = Date.now();
    // Synchronous SQLite-backed DO KV operations contain no await boundary;
    // the runtime can commit these writes together before the event completes.
    this.storage.put(resultStorageKey, result);
    this.storage.put(requestStorageKey, record);
    return 'committed';
  }

  // --- cancellation ---

  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void {
    this.storage.put(cancellationKey(requestId), record);
  }

  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined {
    return this.storage.get<CancellationRecord>(cancellationKey(requestId));
  }

  // --- streaming cursor ---

  putStreamCursor(cursor: StreamCursor): void {
    this.storage.put(cursorKey(cursor.requestId), cursor);
  }

  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined {
    return this.storage.get<StreamCursor>(cursorKey(requestId));
  }

  // --- worker registration / generation ---

  putWorker(record: WorkerRecord): void {
    this.storage.put(workerKey(record.workerId), record);
  }

  getWorker(workerId: WorkerId): WorkerRecord | undefined {
    const key = workerKey(workerId);
    return this.mutableRecord(key, this.storage.get<WorkerRecord>(key));
  }

  deleteWorker(workerId: WorkerId): void {
    this.storage.delete(workerKey(workerId));
  }

  listWorkers(): readonly WorkerRecord[] {
    return this.listMutableValues<WorkerRecord>(PREFIX.worker);
  }
}
