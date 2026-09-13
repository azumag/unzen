/**
 * WorkerPool: manages browser workers with tier-based priority selection.
 *
 * Workers are categorized into 3 tiers (PLAN.md 4.5.4):
 *   Tier 1: 24h devices (signage, kiosks) - highest priority
 *   Tier 2: Long-running (OBS, extensions, Electron)
 *   Tier 3: Normal web visitors - burst capacity
 *
 * Selection prioritizes lower-tier (more stable) workers first.
 * Heartbeat monitoring detects disconnected workers for cleanup.
 */

import {
  type WorkerId,
  type WorkerInfo,
  WorkerStatus,
  WorkerTier,
} from './types.js';
import type { WorkerRegistration } from './protocol.js';

export class WorkerPool {
  private readonly workers = new Map<WorkerId, WorkerInfo>();

  /** Register a new worker. Returns the created WorkerInfo. */
  register(registration: WorkerRegistration): WorkerInfo {
    this.assertValidRegistration(registration);

    const info: WorkerInfo = {
      id: registration.workerId,
      tier: registration.tier,
      vramMB: registration.vramMB,
      status: WorkerStatus.IDLE,
      lastHeartbeat: Date.now(),
    };
    this.workers.set(registration.workerId, info);
    return info;
  }

  /** Remove a worker from the pool. Returns true if the worker existed. */
  unregister(id: WorkerId): boolean {
    return this.workers.delete(id);
  }

  /** Update heartbeat timestamp. Returns false if worker is unknown. */
  heartbeat(id: WorkerId): boolean {
    const worker = this.workers.get(id);
    if (!worker) return false;
    worker.lastHeartbeat = Date.now();
    // Reconnect if previously marked as disconnected
    if (worker.status === WorkerStatus.DISCONNECTED) {
      worker.status = WorkerStatus.IDLE;
    }
    return true;
  }

  /**
   * Find the best available worker that meets VRAM requirements.
   * Selection priority: Tier 1 > Tier 2 > Tier 3, then by VRAM (descending).
   * Returns null if no suitable worker is available.
   */
  getAvailableWorker(requiredVramMB: number): WorkerInfo | null {
    this.assertValidVramRequirement(requiredVramMB);

    let best: WorkerInfo | null = null;

    for (const worker of this.workers.values()) {
      if (worker.status !== WorkerStatus.IDLE) continue;
      if (worker.vramMB < requiredVramMB) continue;

      if (!best) {
        best = worker;
        continue;
      }

      // Prefer lower tier (more stable)
      if (worker.tier < best.tier) {
        best = worker;
      } else if (worker.tier === best.tier && worker.vramMB > best.vramMB) {
        // Same tier: prefer more VRAM
        best = worker;
      }
    }

    return best;
  }

  /** Mark a worker as busy processing a specific segment. */
  markBusy(id: WorkerId, segmentIndex: number): void {
    this.assertValidSegmentIndex(segmentIndex);
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.status = WorkerStatus.BUSY;
    worker.currentSegment = segmentIndex;
  }

  /** Mark a worker as idle (segment completed or reassigned). */
  markIdle(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.status = WorkerStatus.IDLE;
    worker.currentSegment = undefined;
  }

  /**
   * Find workers whose heartbeat is older than the given timeout.
   * These should be marked disconnected and their segments reassigned.
   */
  getTimedOutWorkers(timeoutMs: number): WorkerInfo[] {
    this.assertValidHeartbeatTimeout(timeoutMs);

    const now = Date.now();
    const timedOut: WorkerInfo[] = [];
    for (const worker of this.workers.values()) {
      if (worker.status === WorkerStatus.DISCONNECTED) continue;
      if (now - worker.lastHeartbeat > timeoutMs) {
        timedOut.push(worker);
      }
    }
    return timedOut;
  }

  /** Mark a worker as disconnected (heartbeat timeout). */
  markDisconnected(id: WorkerId): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.status = WorkerStatus.DISCONNECTED;
    worker.currentSegment = undefined;
  }

  /** Get a worker by ID. */
  get(id: WorkerId): WorkerInfo | undefined {
    return this.workers.get(id);
  }

  /** Number of registered workers. */
  get size(): number {
    return this.workers.size;
  }

  /** Number of idle workers ready for assignment. */
  get idleCount(): number {
    let count = 0;
    for (const worker of this.workers.values()) {
      if (worker.status === WorkerStatus.IDLE) count++;
    }
    return count;
  }

  /** Iterate over all registered workers. Used by SpanRouter for routing decisions. */
  allWorkers(): IterableIterator<WorkerInfo> {
    return this.workers.values();
  }

  /**
   * Fail closed at the legacy wire-protocol boundary before a worker can affect
   * routing state. TypeScript types do not protect runtime WebSocket payloads.
   */
  private assertValidRegistration(registration: WorkerRegistration): void {
    if (
      typeof registration !== 'object' ||
      registration === null ||
      Array.isArray(registration)
    ) {
      throw new Error('worker registration must be a non-null object');
    }

    if (
      typeof registration.workerId !== 'string' ||
      registration.workerId.trim().length === 0
    ) {
      throw new Error('workerId must be a non-empty string');
    }

    if (
      registration.tier !== WorkerTier.TIER_1 &&
      registration.tier !== WorkerTier.TIER_2 &&
      registration.tier !== WorkerTier.TIER_3
    ) {
      throw new Error(`worker tier must be 1, 2, or 3; found ${String(registration.tier)}`);
    }

    if (!Number.isFinite(registration.vramMB) || registration.vramMB <= 0) {
      throw new Error(
        `worker vramMB must be a positive finite number; found ${String(registration.vramMB)}`,
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

  /** Keep the busy-state routing cursor within the model's non-negative segment domain. */
  private assertValidSegmentIndex(segmentIndex: number): void {
    if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0) {
      throw new Error(
        `segmentIndex must be a non-negative safe integer; found ${String(segmentIndex)}`,
      );
    }
  }
}
