/**
 * Worker registry with connection-generation policy (issue #103 deliverable 9).
 *
 * A worker generation is issued per transport connection / auth session.
 * Policies enforced here:
 *   - Re-registration of the same workerId on a NEW connection revokes the old
 *     generation (so its leases can be reclaimed) instead of silently
 *     overwriting the record; the old generation is recorded as revoked.
 *   - Re-registration on the SAME connection is a capability refresh and keeps
 *     the generation.
 *   - Heartbeats alone never revive a revoked generation, and a stale
 *     generation is rejected with a structured error rather than a silent
 *     no-op. A valid-generation heartbeat may revive a merely-disconnected
 *     (heartbeat-timed-out) worker whose leases were already reclaimed
 *     independently.
 *   - Reconnect after a disconnect is a NEW generation with capability
 *     validation (the coordinator re-checks the manifest requirements).
 *
 * State mutations from unknown workers / stale generations throw structured
 * errors (see errors.ts) so callers can surface them instead of swallowing.
 */

import { ErrorCode, UnzenError } from './errors.js';
import { generateWorkerGeneration } from './ids.js';
import type { WorkerGeneration } from './ids.js';
import { WorkerTier } from './types.js';
import type { WorkerId } from './types.js';
import type { WorkerRecord, WorkerStage } from './durable-types.js';
import { WorkerStage as WorkerStageValue } from './durable-types.js';

/** The worker-storage boundary a registry needs (a DurableRepository subset). */
export interface WorkerRepository {
  putWorker(record: WorkerRecord): void;
  getWorker(workerId: WorkerId): WorkerRecord | undefined;
  deleteWorker(workerId: WorkerId): void;
  listWorkers(): readonly WorkerRecord[];
}

export type RegisterWorkerOutcome =
  | { readonly kind: 'created'; readonly generation: WorkerGeneration }
  | { readonly kind: 'updated'; readonly generation: WorkerGeneration }
  | {
      readonly kind: 'reconnected';
      readonly previousGeneration: WorkerGeneration;
      readonly generation: WorkerGeneration;
    };

interface ValidatedWorkerRegistration {
  readonly workerId: WorkerId;
  readonly tier: WorkerTier;
  readonly vramMB: number;
}

/** Structured error: state mutation from an unknown worker. */
export class UnknownWorkerError extends UnzenError {
  constructor(workerId: WorkerId) {
    super(`Unknown worker: ${workerId}`, ErrorCode.UnknownWorker);
    this.name = 'UnknownWorkerError';
  }
}

/** Structured error: state mutation carrying a stale/revoked generation. */
export class StaleGenerationError extends UnzenError {
  constructor(workerId: WorkerId) {
    super(`Stale or revoked generation for worker ${workerId}`, ErrorCode.StaleGeneration);
    this.name = 'StaleGenerationError';
  }
}

export class WorkerRegistry {
  /** Revoked generations indexed for lookup and lease reclaim. */
  private readonly revokedGenerations = new Map<WorkerGeneration, WorkerRecord>();

  constructor(private readonly store: WorkerRepository) {}

  register(
    registration: { readonly workerId: WorkerId; readonly tier: WorkerTier; readonly vramMB: number },
    connectionId: string,
    now = Date.now(),
  ): RegisterWorkerOutcome {
    const validatedRegistration = this.snapshotValidRegistration(registration, connectionId);
    this.assertValidAbsoluteTime(now, 'registration');

    const existing = this.store.getWorker(validatedRegistration.workerId);

    // Same connection re-registers (e.g. capability refresh): keep the
    // generation so a network hiccup does not churn generations.
    if (existing && existing.connectionId === connectionId) {
      const updated: WorkerRecord = {
        ...existing,
        tier: validatedRegistration.tier,
        vramMB: validatedRegistration.vramMB,
        stage: existing.stage === WorkerStageValue.Revoked ? WorkerStageValue.Idle : existing.stage,
      };
      this.store.putWorker(updated);
      return { kind: 'updated', generation: existing.generation };
    }

    // Different connection for the same workerId: this is a reconnect. Revoke
    // the old generation (its leases will be reclaimed by the coordinator) and
    // issue a new generation — never a silent overwrite.
    if (existing) {
      this.revoke(existing, now);
      const record = this.buildRecord(validatedRegistration, connectionId, now);
      this.store.putWorker(record);
      return {
        kind: 'reconnected',
        previousGeneration: existing.generation,
        generation: record.generation,
      };
    }

    const record = this.buildRecord(validatedRegistration, connectionId, now);
    this.store.putWorker(record);
    return { kind: 'created', generation: record.generation };
  }

  /**
   * Process a heartbeat. Throws UnknownWorkerError / StaleGenerationError for
   * unknown workers or stale/revoked generations — never a silent no-op — and
   * never revives a revoked generation.
   */
  heartbeat(workerId: WorkerId, generation: WorkerGeneration, now = Date.now()): void {
    this.assertValidHeartbeatIdentity(workerId, generation);
    this.assertValidAbsoluteTime(now, 'heartbeat');
    const record = this.store.getWorker(workerId);
    if (!record) throw new UnknownWorkerError(workerId);
    if (generation !== record.generation) throw new StaleGenerationError(workerId);
    record.lastHeartbeat = now;
    if (record.stage === WorkerStageValue.Disconnected) {
      record.stage = WorkerStageValue.Idle;
    }
  }

  /** Mark a worker disconnected, only for the current generation. */
  markDisconnected(workerId: WorkerId, generation: WorkerGeneration): void {
    this.assertValidStateMutationIdentity(workerId, generation);
    const record = this.store.getWorker(workerId);
    if (!record || generation !== record.generation) return;
    record.stage = WorkerStageValue.Disconnected;
    record.currentSegment = undefined;
  }

  markBusy(workerId: WorkerId, generation: WorkerGeneration, segmentIndex: number): void {
    this.assertValidStateMutationIdentity(workerId, generation);
    this.assertValidSegmentIndex(segmentIndex);
    const record = this.store.getWorker(workerId);
    if (!record || generation !== record.generation) return;
    record.stage = WorkerStageValue.Busy;
    record.currentSegment = segmentIndex;
  }

  markIdle(workerId: WorkerId, generation: WorkerGeneration): void {
    this.assertValidStateMutationIdentity(workerId, generation);
    const record = this.store.getWorker(workerId);
    if (!record || generation !== record.generation) return;
    record.stage = WorkerStageValue.Idle;
    record.currentSegment = undefined;
  }

  /**
   * Select the best available idle worker meeting the VRAM requirement.
   * Priority: lower tier (more stable) first, then more VRAM — mirroring the
   * legacy WorkerPool selection so behavior stays consistent.
   */
  getAvailableWorker(requiredVramMB: number): WorkerRecord | undefined {
    this.assertValidVramRequirement(requiredVramMB);

    let best: WorkerRecord | undefined;
    for (const worker of this.store.listWorkers()) {
      if (worker.stage !== WorkerStageValue.Idle) continue;
      if (worker.vramMB < requiredVramMB) continue;
      if (!best) {
        best = worker;
        continue;
      }
      if (worker.tier < best.tier || (worker.tier === best.tier && worker.vramMB > best.vramMB)) {
        best = worker;
      }
    }
    return best;
  }

  /** Workers whose heartbeat is older than `timeoutMs` (excludes revoked). */
  listTimedOut(timeoutMs: number, now = Date.now()): readonly WorkerRecord[] {
    this.assertValidHeartbeatTimeout(timeoutMs);
    this.assertValidAbsoluteTime(now, 'liveness');

    const timedOut: WorkerRecord[] = [];
    for (const worker of this.store.listWorkers()) {
      if (worker.stage === WorkerStageValue.Revoked) continue;
      if (now - worker.lastHeartbeat > timeoutMs) timedOut.push(worker);
    }
    return timedOut;
  }

  /** Revoke a generation: mark revoked, record it, and remove from active set. */
  revokeGeneration(workerId: WorkerId, generation: WorkerGeneration, now = Date.now()): void {
    this.assertValidRevocationIdentity(workerId, generation);
    this.assertValidAbsoluteTime(now, 'revocation');
    const record = this.store.getWorker(workerId);
    if (record && record.generation === generation) {
      this.revoke(record, now);
    } else {
      // Revoking a generation that is no longer current: keep it recorded so
      // late results can still be traced to a revoked generation.
      const revoked = this.revokedGenerations.get(generation);
      if (revoked) this.revokedGenerations.delete(generation);
      this.revokedGenerations.set(generation, {
        workerId,
        generation,
        connectionId: revoked?.connectionId ?? 'unknown',
        tier: revoked?.tier ?? WorkerTier.TIER_3,
        vramMB: revoked?.vramMB ?? 0,
        stage: WorkerStageValue.Revoked,
        lastHeartbeat: revoked?.lastHeartbeat ?? now,
        registeredAt: revoked?.registeredAt ?? now,
        revokedAt: now,
      });
    }
  }

  /** Look up a record by generation (current or revoked). */
  getByGeneration(generation: WorkerGeneration): WorkerRecord | undefined {
    this.assertValidGenerationLookup(generation);
    for (const worker of this.store.listWorkers()) {
      if (worker.generation === generation) return worker;
    }
    const revoked = this.revokedGenerations.get(generation);
    return revoked === undefined ? undefined : { ...revoked };
  }

  get(workerId: WorkerId): WorkerRecord | undefined {
    this.assertValidLookupIdentity(workerId);
    return this.store.getWorker(workerId);
  }

  get size(): number {
    return this.store.listWorkers().length;
  }

  get idleCount(): number {
    return this.store.listWorkers().filter((w) => w.stage === WorkerStageValue.Idle).length;
  }

  /**
   * Validate and detach the runtime registration envelope before any durable
   * state or generation ownership can change. TypeScript types do not protect
   * decoded WebSocket / JSON payloads or direct runtime callers.
   */
  private snapshotValidRegistration(
    registration: { readonly workerId: WorkerId; readonly tier: WorkerTier; readonly vramMB: number },
    connectionId: string,
  ): ValidatedWorkerRegistration {
    let isArray = false;
    if (typeof registration === 'object' && registration !== null) {
      try {
        isArray = Array.isArray(registration);
      } catch {
        throw new Error('worker registration must be a non-null object');
      }
    }
    if (typeof registration !== 'object' || registration === null || isArray) {
      throw new Error('worker registration must be a non-null object');
    }

    const runtimeRegistration = registration as unknown as Record<string, unknown>;
    const workerIdValue = readRegistrationField(runtimeRegistration, 'workerId');
    if (typeof workerIdValue !== 'string' || workerIdValue.trim().length === 0) {
      throw new Error('workerId must be a non-empty string');
    }

    const tierValue = readRegistrationField(runtimeRegistration, 'tier');
    if (
      tierValue !== WorkerTier.TIER_1 &&
      tierValue !== WorkerTier.TIER_2 &&
      tierValue !== WorkerTier.TIER_3
    ) {
      throw new Error(
        `worker tier must be 1, 2, or 3; found ${describeRegistrationValue(tierValue)}`,
      );
    }

    const vramMBValue = readRegistrationField(runtimeRegistration, 'vramMB');
    if (
      typeof vramMBValue !== 'number' ||
      !Number.isFinite(vramMBValue) ||
      vramMBValue <= 0
    ) {
      throw new Error(
        `worker vramMB must be a positive finite number; found ${describeRegistrationValue(vramMBValue)}`,
      );
    }

    if (typeof connectionId !== 'string' || connectionId.trim().length === 0) {
      throw new Error('connectionId must be a non-empty string');
    }

    return Object.freeze({
      workerId: workerIdValue as WorkerId,
      tier: tierValue,
      vramMB: vramMBValue,
    });
  }

  /** Validate heartbeat identity before lookup or structured diagnostic interpolation. */
  private assertValidHeartbeatIdentity(workerId: unknown, generation: unknown): void {
    if (typeof workerId !== 'string' || workerId.trim().length === 0) {
      throw new UnzenError(
        'worker heartbeat workerId must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
    if (typeof generation !== 'string' || generation.trim().length === 0) {
      throw new UnzenError(
        'worker heartbeat generation must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
  }

  /** Validate lookup identity before active-worker repository access. */
  private assertValidLookupIdentity(workerId: unknown): void {
    if (typeof workerId !== 'string' || workerId.trim().length === 0) {
      throw new UnzenError(
        'worker lookup workerId must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
  }

  /** Validate generation lookup identity before active-worker enumeration or archive access. */
  private assertValidGenerationLookup(generation: unknown): void {
    if (typeof generation !== 'string' || generation.trim().length === 0) {
      throw new UnzenError(
        'worker generation lookup must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
  }

  /** Validate worker state-transition identity before active-worker repository access. */
  private assertValidStateMutationIdentity(workerId: unknown, generation: unknown): void {
    if (typeof workerId !== 'string' || workerId.trim().length === 0) {
      throw new UnzenError(
        'worker state mutation workerId must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
    if (typeof generation !== 'string' || generation.trim().length === 0) {
      throw new UnzenError(
        'worker state mutation generation must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
  }

  /** Validate revocation identity before active lookup or revoked-generation archive mutation. */
  private assertValidRevocationIdentity(workerId: unknown, generation: unknown): void {
    if (typeof workerId !== 'string' || workerId.trim().length === 0) {
      throw new UnzenError(
        'worker revocation workerId must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
    if (typeof generation !== 'string' || generation.trim().length === 0) {
      throw new UnzenError(
        'worker revocation generation must be a non-empty string',
        ErrorCode.ProtocolViolation,
      );
    }
  }

  /** Fail closed before malformed absolute time can enter state or liveness arithmetic. */
  private assertValidAbsoluteTime(now: number, operation: string): void {
    if (!Number.isFinite(now) || now < 0) {
      throw new Error(
        `${operation} now must be a non-negative finite number; found ${String(now)}`,
      );
    }
  }

  /** Fail closed before JavaScript comparison semantics can turn NaN into a routing match. */
  private assertValidVramRequirement(requiredVramMB: number): void {
    if (!Number.isFinite(requiredVramMB) || requiredVramMB <= 0) {
      throw new Error(
        `requiredVramMB must be a positive finite number; found ${String(requiredVramMB)}`,
      );
    }
  }

  /** Fail closed before malformed timeout arithmetic can corrupt liveness decisions. */
  private assertValidHeartbeatTimeout(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        `timeoutMs must be a positive finite number; found ${String(timeoutMs)}`,
      );
    }
  }

  /** Keep the durable busy-state cursor within the model's non-negative segment domain. */
  private assertValidSegmentIndex(segmentIndex: number): void {
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
      throw new Error(
        `segmentIndex must be a non-negative safe integer; found ${String(segmentIndex)}`,
      );
    }
  }

  private buildRecord(
    registration: ValidatedWorkerRegistration,
    connectionId: string,
    now: number,
  ): WorkerRecord {
    return {
      workerId: registration.workerId,
      generation: generateWorkerGeneration(),
      connectionId,
      tier: registration.tier,
      vramMB: registration.vramMB,
      stage: WorkerStageValue.Idle,
      lastHeartbeat: now,
      registeredAt: now,
    };
  }

  private revoke(record: WorkerRecord, now: number): void {
    record.stage = WorkerStageValue.Revoked;
    record.revokedAt = now;
    // DurableObjectRepository returns write-through proxies for active worker
    // records. Never retain that proxy after the active key is deleted/reused
    // by a replacement generation: an archived mutation could otherwise write
    // through to the new generation at the same worker key.
    this.revokedGenerations.set(record.generation, { ...record });
    this.store.deleteWorker(record.workerId);
  }
}

function readRegistrationField(
  registration: Record<string, unknown>,
  field: 'workerId' | 'tier' | 'vramMB',
): unknown {
  try {
    return registration[field];
  } catch {
    throw new Error(`worker registration ${field} could not be read`);
  }
}

function describeRegistrationValue(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function') return 'unknown';
  try {
    return String(value);
  } catch {
    return 'unknown';
  }
}
