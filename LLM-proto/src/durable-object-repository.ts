/**
 * Persistent DurableRepository adapter for Cloudflare Durable Objects.
 *
 * SQLite-backed Durable Objects expose synchronous KV at `ctx.storage.kv`.
 * Keeping this adapter structural (rather than importing `cloudflare:workers`)
 * preserves the Node/Vitest prototype while allowing the production runtime to
 * pass `this.ctx.storage.kv` directly.
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

/** Structural subset implemented by SQLite Durable Object `ctx.storage.kv`. */
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

const P = {
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

const part = (value: string | number) => encodeURIComponent(String(value));
const requestKey = (id: InferenceRequestId) => `${P.request}${part(id)}`;
const idempotencyStorageKey = (key: IdempotencyKey) => `${P.idempotency}${part(key)}`;
const attemptsKey = (id: InferenceRequestId) => `${P.attempts}${part(id)}`;
const leaseKey = (id: InferenceRequestId) => `${P.lease}${part(id)}`;
const leaseIndexKey = (id: LeaseId) => `${P.leaseIndex}${part(id)}`;
const checkpointPrefix = (id?: InferenceRequestId) =>
  id === undefined ? P.checkpoint : `${P.checkpoint}${part(id)}:`;
const checkpointKey = (id: InferenceRequestId, segment: number) =>
  `${checkpointPrefix(id)}${part(segment)}`;
const resultKey = (id: InferenceRequestId) => `${P.result}${part(id)}`;
const cancellationKey = (id: InferenceRequestId) => `${P.cancellation}${part(id)}`;
const cursorKey = (id: InferenceRequestId) => `${P.cursor}${part(id)}`;
const workerKey = (id: WorkerId) => `${P.worker}${part(id)}`;

/**
 * Storage for one Coordinator coordination shard.
 *
 * Do not route every Unzen request to one global Durable Object. The caller is
 * responsible for deterministic sharding (for example tenant/model/routing
 * shard) so all state that must share idempotency and leases reaches the same
 * object without creating a global bottleneck.
 */
export class DurableObjectRepository implements DurableRepository {
  constructor(private readonly storage: DurableObjectSyncKvStorage) {}

  /**
   * Compatibility for the existing #103 contract, which mutates request and
   * worker records returned by `get*()`/`list*()`.
   *
   * Durable Object reads are cloned, unlike InMemoryRepository's live object
   * references. A naive write-through proxy would also be unsafe: a stage CAS
   * may update storage after this object was read, then a later error/timing
   * mutation on the stale object could overwrite the new stage. Therefore each
   * property write re-reads the latest stored value and merges only that
   * property before persisting it.
   */
  private mutableRecord<T extends object>(key: string, value: T | undefined): T | undefined {
    if (value === undefined) return undefined;
    const storage = this.storage;
    return new Proxy(value, {
      set(target, property, next): boolean {
        const ok = Reflect.set(target, property, next);
        if (!ok) return false;
        const latest = storage.get<T>(key) ?? target;
        Reflect.set(latest, property, next);
        storage.put(key, latest);
        return true;
      },
      deleteProperty(target, property): boolean {
        const ok = Reflect.deleteProperty(target, property);
        if (!ok) return false;
        const latest = storage.get<T>(key) ?? target;
        Reflect.deleteProperty(latest, property);
        storage.put(key, latest);
        return true;
      },
    });
  }

  private listValues<T>(prefix: string): T[] {
    return [...this.storage.list<T>({ prefix })].map(([, value]) => value);
  }

  private listMutable<T extends object>(prefix: string): T[] {
    return [...this.storage.list<T>({ prefix })].map(([key, value]) =>
      this.mutableRecord(key, value)!,
    );
  }

  // request state
  createRequest(record: RequestRecord): void {
    this.storage.put(requestKey(record.requestId), record);
  }

  getRequest(requestId: InferenceRequestId): RequestRecord | undefined {
    const key = requestKey(requestId);
    return this.mutableRecord(key, this.storage.get<RequestRecord>(key));
  }

  listRequests(): readonly RequestRecord[] {
    return this.listMutable<RequestRecord>(P.request);
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

  // idempotency
  getIdempotencyMapping(key: IdempotencyKey): InferenceRequestId | undefined {
    return this.storage.get<InferenceRequestId>(idempotencyStorageKey(key));
  }

  putIdempotencyMapping(key: IdempotencyKey, requestId: InferenceRequestId): boolean {
    const storageKey = idempotencyStorageKey(key);
    const existing = this.storage.get<InferenceRequestId>(storageKey);
    if (existing !== undefined && existing !== requestId) return false;
    this.storage.put(storageKey, requestId);
    return true;
  }

  // attempt history
  appendAttempt(requestId: InferenceRequestId, attempt: AttemptRecord): void {
    const key = attemptsKey(requestId);
    const attempts = this.storage.get<AttemptRecord[]>(key) ?? [];
    attempts.push(attempt);
    this.storage.put(key, attempts);
  }

  listAttempts(requestId: InferenceRequestId): readonly AttemptRecord[] {
    return this.storage.get<AttemptRecord[]>(attemptsKey(requestId)) ?? [];
  }

  updateAttempt(requestId: InferenceRequestId, attemptId: AttemptId, patch: AttemptPatch): void {
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

  // leases
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
    const index = leaseIndexKey(leaseId);
    const requestId = this.storage.get<InferenceRequestId>(index);
    if (requestId === undefined) return;
    const activeKey = leaseKey(requestId);
    const active = this.storage.get<Lease>(activeKey);
    if (active?.leaseId === leaseId) this.storage.delete(activeKey);
    this.storage.delete(index);
  }

  listActiveLeases(): readonly Lease[] {
    return this.listValues<Lease>(P.lease);
  }

  // checkpoints
  putCheckpoint(envelope: CheckpointEnvelope): CheckpointStoreResult {
    const key = checkpointKey(envelope.requestId, envelope.segmentIndex);
    const existing = this.storage.get<CheckpointEnvelope>(key);
    if (existing) {
      return existing.payloadDigest === envelope.payloadDigest ? 'unchanged' : 'conflict';
    }
    this.storage.put(key, envelope);
    return 'stored';
  }

  getCheckpoint(requestId: InferenceRequestId, segmentIndex: number): CheckpointEnvelope | undefined {
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
    return this.listValues<CheckpointEnvelope>(P.checkpoint);
  }

  collectExpiredCheckpoints(now: number): readonly CheckpointEnvelope[] {
    const expired: CheckpointEnvelope[] = [];
    for (const [key, envelope] of this.storage.list<CheckpointEnvelope>({ prefix: P.checkpoint })) {
      if (now >= envelope.createdAt + envelope.ttlMs) {
        expired.push(envelope);
        this.storage.delete(key);
      }
    }
    return expired;
  }

  // completion/result
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
    if (this.storage.get<InferenceResult>(resultStorageKey) !== undefined) return 'duplicate';

    const record = this.storage.get<RequestRecord>(requestStorageKey);
    if (!record || record.stage !== expectedStage) return 'conflict';

    record.stage = 'completed';
    record.completedAt = Date.now();
    // Both operations are synchronous and have no await boundary inside the DO.
    this.storage.put(resultStorageKey, result);
    this.storage.put(requestStorageKey, record);
    return 'committed';
  }

  // cancellation
  putCancellation(requestId: InferenceRequestId, record: CancellationRecord): void {
    this.storage.put(cancellationKey(requestId), record);
  }

  getCancellation(requestId: InferenceRequestId): CancellationRecord | undefined {
    return this.storage.get<CancellationRecord>(cancellationKey(requestId));
  }

  // stream cursor
  putStreamCursor(cursor: StreamCursor): void {
    this.storage.put(cursorKey(cursor.requestId), cursor);
  }

  getStreamCursor(requestId: InferenceRequestId): StreamCursor | undefined {
    return this.storage.get<StreamCursor>(cursorKey(requestId));
  }

  // worker registration/generation
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
    return this.listMutable<WorkerRecord>(P.worker);
  }
}
