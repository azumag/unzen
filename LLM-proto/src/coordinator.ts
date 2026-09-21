/**
 * Coordinator: central orchestrator for distributed LLM inference.
 *
 * Responsibilities (PLAN.md 5.5):
 *   - Accept inference requests from API customers
 *   - Manage the worker pool (register, heartbeat, disconnect)
 *   - Route requests through the pipeline
 *   - Monitor worker health and trigger reassignment on failure
 *
 * Production deployment target: Cloudflare Workers (PLAN.md 5.6).
 * This implementation is transport-agnostic - WebSocket handling is external.
 */

import {
  type WorkerId,
  type InferenceRequestId,
  type InferenceRequest,
  type InferenceResult,
  type SegmentConfig,
  InferenceStatus,
  inferenceRequestId,
} from './types.js';
import type {
  WorkerRegistration,
  CoordinatorMessage,
} from './protocol.js';
import { WorkerPool } from './worker-pool.js';
import { CheckpointStore } from './checkpoint.js';
import { Pipeline, type SegmentExecutor } from './pipeline.js';
import {
  type SegmentedModelManifest,
  segmentConfigsFromManifest,
} from './model-manifest.js';
import { assertValidModelManifest } from './model-manifest-validator.js';
import { snapshotWorkerMessage } from './worker-message-boundary.js';
import { MAX_TIMER_DELAY_MS } from './pipeline-utils.js';

export interface CoordinatorOptions {
  /** Heartbeat check interval in ms (default: 5000). */
  readonly heartbeatIntervalMs: number;
  /** How long without heartbeat before marking a worker disconnected (default: 15000). */
  readonly heartbeatTimeoutMs: number;
  /** Max retry attempts per segment (default: 2). */
  readonly maxRetries: number;
  /** Segment execution timeout in ms (default: 30000). */
  readonly segmentTimeoutMs: number;
  /** Delay between retry attempts when no worker is available (ms). */
  readonly retryDelayMs: number;
  /**
   * Expected segment count. When provided it must match the validated
   * manifest's segment count, otherwise the Coordinator fails fast (default:
   * derived from the manifest).
   */
  readonly totalSegments?: number;
  /**
   * Test-only escape hatch that allows fixture-namespace manifests
   * (source: 'fixture'). Production code must never set this. Default: false.
   */
  readonly allowFixtureManifest?: boolean;
}

const DEFAULT_OPTIONS: CoordinatorOptions = {
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 15_000,
  maxRetries: 2,
  segmentTimeoutMs: 30_000,
  retryDelayMs: 1_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readOwnEnumerableOption<T extends object, K extends keyof T>(
  source: T | undefined,
  key: K,
): T[K] | undefined {
  if (source === undefined) return undefined;

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw new TypeError(`Coordinator option ${String(key)} could not be inspected`);
  }
  if (descriptor === undefined || descriptor.enumerable !== true) return undefined;

  try {
    return source[key];
  } catch {
    throw new TypeError(`Coordinator option ${String(key)} could not be read`);
  }
}

function resolveCoordinatorOptions(options: unknown): CoordinatorOptions {
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError('Coordinator options must be a non-null, non-array object');
  }

  // Runtime callers may supply decoded/asserted accessor or Proxy objects. Read
  // only declared own-enumerable fields, exactly once, so unknown properties are
  // never enumerated and validation is bound to the same owned values retained
  // by the Coordinator. Own/enumerable filtering preserves the previous spread
  // semantics for inherited and non-enumerable declared-name properties.
  const source = options as Partial<CoordinatorOptions> | undefined;
  const capturedHeartbeatIntervalMs = readOwnEnumerableOption(source, 'heartbeatIntervalMs');
  const capturedHeartbeatTimeoutMs = readOwnEnumerableOption(source, 'heartbeatTimeoutMs');
  const capturedMaxRetries = readOwnEnumerableOption(source, 'maxRetries');
  const capturedSegmentTimeoutMs = readOwnEnumerableOption(source, 'segmentTimeoutMs');
  const capturedRetryDelayMs = readOwnEnumerableOption(source, 'retryDelayMs');
  const capturedTotalSegments = readOwnEnumerableOption(source, 'totalSegments');
  const capturedAllowFixtureManifest = readOwnEnumerableOption(source, 'allowFixtureManifest');

  const heartbeatIntervalMs = capturedHeartbeatIntervalMs === undefined
    ? DEFAULT_OPTIONS.heartbeatIntervalMs
    : capturedHeartbeatIntervalMs;
  const heartbeatTimeoutMs = capturedHeartbeatTimeoutMs === undefined
    ? DEFAULT_OPTIONS.heartbeatTimeoutMs
    : capturedHeartbeatTimeoutMs;
  const maxRetries = capturedMaxRetries === undefined
    ? DEFAULT_OPTIONS.maxRetries
    : capturedMaxRetries;
  const segmentTimeoutMs = capturedSegmentTimeoutMs === undefined
    ? DEFAULT_OPTIONS.segmentTimeoutMs
    : capturedSegmentTimeoutMs;
  const retryDelayMs = capturedRetryDelayMs === undefined
    ? DEFAULT_OPTIONS.retryDelayMs
    : capturedRetryDelayMs;

  for (const [field, value] of [
    ['heartbeatIntervalMs', heartbeatIntervalMs],
    ['heartbeatTimeoutMs', heartbeatTimeoutMs],
    ['segmentTimeoutMs', segmentTimeoutMs],
    ['retryDelayMs', retryDelayMs],
  ] as const) {
    if (!isNonNegativeFiniteNumber(value)) {
      throw new TypeError(`Coordinator ${field} must be a non-negative finite number`);
    }
  }
  for (const [field, value] of [
    ['heartbeatIntervalMs', heartbeatIntervalMs],
    ['segmentTimeoutMs', segmentTimeoutMs],
    ['retryDelayMs', retryDelayMs],
  ] as const) {
    if (value > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`Coordinator ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`);
    }
  }
  if (!isNonNegativeSafeInteger(maxRetries)) {
    throw new TypeError('Coordinator maxRetries must be a non-negative safe integer');
  }
  if (capturedTotalSegments !== undefined && !isNonNegativeSafeInteger(capturedTotalSegments)) {
    throw new TypeError('Coordinator totalSegments must be a non-negative safe integer');
  }
  if (
    capturedAllowFixtureManifest !== undefined &&
    typeof capturedAllowFixtureManifest !== 'boolean'
  ) {
    throw new TypeError('Coordinator allowFixtureManifest must be a boolean');
  }

  return {
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    maxRetries,
    segmentTimeoutMs,
    retryDelayMs,
    ...(capturedTotalSegments === undefined ? {} : { totalSegments: capturedTotalSegments }),
    ...(capturedAllowFixtureManifest === undefined
      ? {}
      : { allowFixtureManifest: capturedAllowFixtureManifest }),
  };
}

export class Coordinator {
  private readonly workerPool: WorkerPool;
  private readonly checkpointStore: CheckpointStore;
  private readonly options: CoordinatorOptions;
  private readonly manifest: SegmentedModelManifest;
  private readonly segments: SegmentConfig[];
  private readonly segmentCountValue: number;
  private readonly activeRequests = new Map<InferenceRequestId, InferenceRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private requestCounter = 0;

  constructor(
    private readonly executor: SegmentExecutor,
    manifest: SegmentedModelManifest,
    options?: Partial<CoordinatorOptions>,
  ) {
    this.options = resolveCoordinatorOptions(options);

    // Fail fast at startup (issue #102): an invalid, placeholder-hash, or
    // non-production manifest must never drive an execution plan.
    const validated = assertValidModelManifest(manifest, {
      allowedSources: this.options.allowFixtureManifest ? undefined : ['production'],
    });
    this.manifest = validated;
    // SegmentConfig geometry now comes exclusively from the validated manifest.
    this.segments = segmentConfigsFromManifest(validated);
    this.segmentCountValue = this.segments.length;
    if (
      this.options.totalSegments !== undefined &&
      this.options.totalSegments !== this.segmentCountValue
    ) {
      throw new Error(
        `Coordinator options declare ${this.options.totalSegments} segments but the ` +
          `model manifest declares ${this.segmentCountValue}`,
      );
    }

    this.workerPool = new WorkerPool();
    this.checkpointStore = new CheckpointStore();
  }

  // --- Worker management ---

  /** Register a new browser worker. */
  registerWorker(registration: WorkerRegistration): void {
    this.workerPool.register(registration);
  }

  /** Process a heartbeat from a worker. */
  workerHeartbeat(workerId: WorkerId): boolean {
    return this.workerPool.heartbeat(workerId);
  }

  /** Remove a worker (e.g., on WebSocket close). */
  removeWorker(workerId: WorkerId): void {
    this.workerPool.unregister(workerId);
  }

  /** Start periodic heartbeat monitoring. */
  startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const timedOut = this.workerPool.getTimedOutWorkers(this.options.heartbeatTimeoutMs);
      for (const worker of timedOut) {
        this.workerPool.markDisconnected(worker.id);
      }
    }, this.options.heartbeatIntervalMs);
  }

  /** Stop heartbeat monitoring (for cleanup). */
  stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --- Inference request handling ---

  /**
   * Submit an inference request and execute it through the pipeline.
   * This is the main entry point for API customers.
   */
  async submitRequest(prompt: string): Promise<InferenceResult> {
    if (typeof prompt !== 'string') {
      throw new TypeError('Coordinator prompt must be a string');
    }

    const request = this.createRequest(prompt);
    this.activeRequests.set(request.id, request);

    const pipeline = new Pipeline(
      this.segments,
      this.workerPool,
      this.checkpointStore,
      this.executor,
      {
        maxRetries: this.options.maxRetries,
        segmentTimeoutMs: this.options.segmentTimeoutMs,
        retryDelayMs: this.options.retryDelayMs,
      },
    );

    try {
      const result = await pipeline.run(request);
      this.activeRequests.delete(request.id);
      return result;
    } catch (error) {
      this.activeRequests.delete(request.id);
      throw error;
    }
  }

  /** Handle an incoming runtime-untrusted message from a worker. */
  handleWorkerMessage(message: unknown): CoordinatorMessage | null {
    const snapshot = snapshotWorkerMessage(message);

    switch (snapshot.type) {
      case 'worker:register':
        this.registerWorker(snapshot.payload);
        return null;
      case 'worker:heartbeat':
        this.workerHeartbeat(snapshot.payload.workerId);
        return {
          type: 'heartbeat:ack',
          payload: { timestamp: Date.now() },
        };
      case 'segment:result':
      case 'segment:failed':
        // These are handled via the SegmentExecutor's Promise resolution.
        // Validation above still prevents transport discriminator/payload drift.
        return null;
    }
  }

  private createRequest(prompt: string): InferenceRequest {
    this.requestCounter++;
    return {
      id: inferenceRequestId(`req-${this.requestCounter}`),
      prompt,
      createdAt: Date.now(),
      status: InferenceStatus.QUEUED,
      currentSegment: 0,
      totalSegments: this.segmentCountValue,
    };
  }

  // --- Status accessors ---

  get workerCount(): number {
    return this.workerPool.size;
  }

  get idleWorkerCount(): number {
    return this.workerPool.idleCount;
  }

  get activeRequestCount(): number {
    return this.activeRequests.size;
  }

  get checkpointCount(): number {
    return this.checkpointStore.size;
  }

  /** Segment count derived from the validated model manifest. */
  get segmentCount(): number {
    return this.segmentCountValue;
  }

  /** Model revision of the validated manifest (for run reports). */
  get modelRevision(): string {
    return this.manifest.modelRevision;
  }

  /** Manifest digest of the validated manifest (for run reports). */
  get manifestDigest(): string {
    return this.manifest.manifestDigest;
  }
}
