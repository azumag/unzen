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
  workerId,
  type WorkerId,
  type WorkerInfo,
  WorkerStatus,
  WorkerTier,
} from './types.js';
import type { WorkerRegistration } from './protocol.js';

export class WorkerPool {
  private readonly workers = new Map<WorkerId, WorkerInfo>();
  private readonly workerViews = new WeakMap<WorkerInfo, WorkerInfo>();

  /** Register a new worker. Returns a guarded live WorkerInfo view. */
  register(registration: WorkerRegistration): WorkerInfo {
    const validated = this.validateRegistration(registration);

    const info: WorkerInfo = {
      id: validated.workerId,
      tier: validated.tier,
      vramMB: validated.vramMB,
      status: WorkerStatus.IDLE,
      lastHeartbeat: Date.now(),
    };
    this.workers.set(validated.workerId, info);
    return this.viewOf(info);
  }

  /** Remove a worker from the pool. Returns true if the worker existed. */
  unregister(id: WorkerId): boolean {
    return this.workers.delete(workerId(id));
  }

  /** Update heartbeat timestamp. Returns false if worker is unknown. */
  heartbeat(id: WorkerId): boolean {
    const stableId = workerId(id);
    const worker = this.workers.get(stableId);
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

    return best ? this.viewOf(best) : null;
  }

  /** Mark a worker as busy processing a specific segment. */
  markBusy(id: WorkerId, segmentIndex: number): void {
    this.assertValidSegmentIndex(segmentIndex);
    const stableId = workerId(id);
    const worker = this.workers.get(stableId);
    if (!worker) return;
    worker.status = WorkerStatus.BUSY;
    worker.currentSegment = segmentIndex;
  }

  /** Mark a worker as idle (segment completed or reassigned). */
  markIdle(id: WorkerId): void {
    const stableId = workerId(id);
    const worker = this.workers.get(stableId);
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
        timedOut.push(this.viewOf(worker));
      }
    }
    return timedOut;
  }

  /** Mark a worker as disconnected (heartbeat timeout). */
  markDisconnected(id: WorkerId): void {
    const stableId = workerId(id);
    const worker = this.workers.get(stableId);
    if (!worker) return;
    worker.status = WorkerStatus.DISCONNECTED;
    worker.currentSegment = undefined;
  }

  /** Get a guarded live worker view by ID. */
  get(id: WorkerId): WorkerInfo | undefined {
    const worker = this.workers.get(workerId(id));
    return worker ? this.viewOf(worker) : undefined;
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

  /** Iterate over guarded live worker views. Used by SpanRouter for routing decisions. */
  *allWorkers(): IterableIterator<WorkerInfo> {
    for (const worker of this.workers.values()) {
      yield this.viewOf(worker);
    }
  }

  /**
   * Keep routing identity/capability fields behind a runtime fence while
   * retaining validated live-write compatibility for operational fields.
   *
   * The view is cached per stored record so repeated reads preserve object
   * identity. Re-registration installs a fresh stored record and therefore a
   * fresh view; retained views from the old record cannot mutate its replacement.
   */
  private viewOf(worker: WorkerInfo): WorkerInfo {
    const existing = this.workerViews.get(worker);
    if (existing) return existing;

    const view = new Proxy(worker, {
      set(target, property, value): boolean {
        WorkerPool.assertMutableViewProperty(property);
        WorkerPool.assertValidOperationalViewValue(property, value);
        return Reflect.set(target, property, value);
      },
      deleteProperty(target, property): boolean {
        WorkerPool.assertMutableViewProperty(property);
        WorkerPool.assertDeletableOperationalViewProperty(property);
        return Reflect.deleteProperty(target, property);
      },
      defineProperty(target, property, descriptor): boolean {
        WorkerPool.assertMutableViewProperty(property);
        WorkerPool.assertValidOperationalViewDescriptor(property, descriptor);
        return Reflect.defineProperty(target, property, descriptor);
      },
    });
    this.workerViews.set(worker, view);
    return view;
  }

  /** Fail closed before a public live view can spoof routing identity/capacity. */
  private static assertMutableViewProperty(property: PropertyKey): void {
    if (property !== 'id' && property !== 'tier' && property !== 'vramMB') return;
    throw new Error(`WorkerPool protected field ${String(property)} is immutable`);
  }

  /** Validate operational live writes before they can corrupt routing/liveness state. */
  private static assertValidOperationalViewValue(property: PropertyKey, value: unknown): void {
    if (property === 'status') {
      if (
        value !== WorkerStatus.IDLE &&
        value !== WorkerStatus.BUSY &&
        value !== WorkerStatus.DISCONNECTED
      ) {
        throw new Error('WorkerPool status must be a valid WorkerStatus');
      }
      return;
    }

    if (property === 'lastHeartbeat') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('WorkerPool lastHeartbeat must be a non-negative finite number');
      }
      return;
    }

    if (property === 'currentSegment') {
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
        throw new Error('WorkerPool currentSegment must be undefined or a non-negative safe integer');
      }
    }
  }

  /** Required liveness/routing fields cannot disappear through a live view. */
  private static assertDeletableOperationalViewProperty(property: PropertyKey): void {
    if (property !== 'status' && property !== 'lastHeartbeat') return;
    throw new Error(`WorkerPool required field ${String(property)} cannot be deleted`);
  }

  /**
   * Prevent descriptor-based validation bypasses or locks on operational state.
   * Existing ordinary data-property attributes may be retained by omitting them.
   */
  private static assertValidOperationalViewDescriptor(
    property: PropertyKey,
    descriptor: PropertyDescriptor,
  ): void {
    if (property !== 'status' && property !== 'lastHeartbeat' && property !== 'currentSegment') {
      return;
    }

    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error(`WorkerPool operational field ${String(property)} cannot be an accessor`);
    }
    if (descriptor.writable === false || descriptor.configurable === false) {
      throw new Error(`WorkerPool operational field ${String(property)} must remain mutable`);
    }
    if (descriptor.enumerable === false) {
      throw new Error(`WorkerPool operational field ${String(property)} must remain enumerable`);
    }
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      WorkerPool.assertValidOperationalViewValue(property, descriptor.value);
    }
  }

  /**
   * Fail closed at the legacy wire-protocol boundary before a worker can affect
   * routing state. TypeScript types do not protect runtime WebSocket payloads.
   * Capture each declared field once so validation and committed routing state
   * are bound to the same caller-observed values.
   */
  private validateRegistration(registration: WorkerRegistration): WorkerRegistration {
    if (
      typeof registration !== 'object' ||
      registration === null ||
      Array.isArray(registration)
    ) {
      throw new Error('worker registration must be a non-null object');
    }

    const rawWorkerId: unknown = registration.workerId;
    if (typeof rawWorkerId !== 'string' || rawWorkerId.trim().length === 0) {
      throw new Error('workerId must be a non-empty string');
    }
    const stableWorkerId = workerId(rawWorkerId);

    const tier: unknown = registration.tier;
    if (
      tier !== WorkerTier.TIER_1 &&
      tier !== WorkerTier.TIER_2 &&
      tier !== WorkerTier.TIER_3
    ) {
      throw new Error(`worker tier must be 1, 2, or 3; found ${String(tier)}`);
    }

    const vramMB: unknown = registration.vramMB;
    if (typeof vramMB !== 'number' || !Number.isFinite(vramMB) || vramMB <= 0) {
      throw new Error(
        `worker vramMB must be a positive finite number; found ${String(vramMB)}`,
      );
    }

    return Object.freeze({
      workerId: stableWorkerId,
      tier,
      vramMB,
    });
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
