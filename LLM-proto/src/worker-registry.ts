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
    const existing = this.store.getWorker(registration.workerId);

    // Same connection re-registers (e.g. capability refresh): keep the
    // generation so a network hiccup does not churn generations.
    if (existing && existing.connectionId === connectionId) {
      const updated: WorkerRecord = {
        ...existing,
        tier: registration.tier,
        vramMB: registration.vramMB,
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
      const record = this.buildRecord(registration, connectionId, now);
      this.store.putWorker(record);
      return {
        kind: 'reconnected',
        previousGeneration: existing.generation,
        generation: record.generation,
      };
    }

    const record = this.buildRecord(registration, connectionId, now);
    this.store.putWorker(record);
    return { kind: 'created', generation: record.generation };
  }

  /**
   * Process a heartbeat. Throws UnknownWorkerError / StaleGenerationError for
   * unknown workers or stale/revoked generations — never a silent no-op — and
   * never revives a revoked generation.
   */
  heartbeat(workerId: WorkerId, generation: WorkerGeneration, now = Date.now()): void {
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
    const record = this.store.getWorker(workerId);
    if (!record || generation !== record.generation) return;
    record.stage = WorkerStageValue.Disconnected;
    record.currentSegment = undefined;
  }

  markBusy(workerId: WorkerId, generation: WorkerGeneration, segmentIndex: number): void {
    const record = this.store.getWorker(workerId);
    if (!record || generation !== record.generation) return;
    record.stage = WorkerStageValue.Busy;
    record.currentSegment = segmentIndex;
  }

  markIdle(workerId: WorkerId, generation: WorkerGeneration): void {
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
    const timedOut: WorkerRecord[] = [];
    for (const worker of this.store.listWorkers()) {
      if (worker.stage === WorkerStageValue.Revoked) continue;
      if (now - worker.lastHeartbeat > timeoutMs) timedOut.push(worker);
    }
    return timedOut;
  }

  /** Revoke a generation: mark revoked, record it, and remove from active set. */
  revokeGeneration(workerId: WorkerId, generation: WorkerGeneration, now = Date.now()): void {
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
    for (const worker of this.store.listWorkers()) {
      if (worker.generation === generation) return worker;
    }
    return this.revokedGenerations.get(generation);
  }

  get(workerId: WorkerId): WorkerRecord | undefined {
    return this.store.getWorker(workerId);
  }

  get size(): number {
    return this.store.listWorkers().length;
  }

  get idleCount(): number {
    return this.store.listWorkers().filter((w) => w.stage === WorkerStageValue.Idle).length;
  }

  private buildRecord(
    registration: { workerId: WorkerId; tier: WorkerTier; vramMB: number },
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
    this.revokedGenerations.set(record.generation, record);
    this.store.deleteWorker(record.workerId);
  }
}
