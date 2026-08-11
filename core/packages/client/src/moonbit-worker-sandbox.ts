/**
 * MoonBitWorkerSandboxExecutor - MoonBit wasm-gc execution in a Web Worker
 *
 * Executes MoonBit wasm-gc modules inside a dedicated Web Worker so a CPU-bound
 * export never blocks the page's main thread. This is the MoonBit counterpart
 * of WebWorkerSandboxExecutor (QuickJS).
 *
 * Lifecycle (state machine):
 *   empty → initializing → ready → (generation failure) → empty
 *                              ↘ (hard timeout / worker crash → fail generation)
 *   empty/initializing/ready → disposed
 *
 * Design rationale:
 * - **Single-flight**: one worker generation runs at most one request; extras
 *   wait in a bounded FIFO queue (maxQueueSize, default 4). Overflow is
 *   rejected with a stable runtime error.
 * - **Generation identity**: every worker (re)creation bumps `generationId`;
 *   responses from a stale generation are rejected.
 * - **Init timeout**: if `init-result` never arrives, init waiters settle
 *   within `initTimeoutMs` and the worker is terminated.
 * - **Execution timeout**: the wasm export is synchronous and uninterruptible
 *   inside the worker, so the only interrupt is `Worker.terminate()`. The
 *   hard-kill timer starts at execution START (not enqueue time) and fires at
 *   `timeout * hardKillMultiplier`.
 * - **Cancellation**: queued requests are removed and rejected immediately.
 *   A running request's cancel terminates the worker (the caller's intent is
 *   final; this must never trigger server fallback) and restarts queued work
 *   on a fresh generation, re-checking each caller's signal.
 * - **Error classification**: worker function errors → UnzenFunctionError (no
 *   fallback); runtime errors (compile/instantiate/timeout/crash) →
 *   UnzenRuntimeError (fallback-eligible).
 *
 * Module bytes are fetched on the MAIN thread (waiter-managed per URL, see
 * `prepare`) and transferred to the worker per execution. Fetching on the
 * main thread keeps cancellation of the network step consistent with the rest
 * of the SDK; the worker never needs network access.
 */

import {
  MAX_FUNCTION_PAYLOAD_BYTES,
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
  type MoonBitAbi,
} from '@unzen/shared';
import {
  isAbortError,
  raceWithAbort,
  readAbortSignalAborted,
  subscribeToAbortSignal,
  throwIfAborted,
} from './abort';
import {
  assertUnzenContentIntegrity,
  createUnzenContentCacheKey,
  isValidUnzenContentHash,
} from './content-integrity';
import { snapshotMoonBitCall } from './moonbit-array-bridge';
import {
  normalizeMoonBitModuleUrl,
  snapshotMoonBitAbortSignal,
  snapshotMoonBitExecutionOptions,
  snapshotMoonBitModuleBytes,
} from './moonbit-call';
import {
  normalizeMoonBitImportedStringConstants,
  type MoonBitImportedStringConstants,
} from './moonbit-compile-options';
import { normalizeMoonBitCacheLimit } from './moonbit-cache';
import type { ExecuteOptions, SandboxExecutor } from './sandbox-executor';
import { readBoundedResponseBytes } from './response-body';
import {
  createMoonbitExecuteMessage,
  createMoonbitInitMessage,
  validateMoonbitWorkerResponse,
  type MoonbitExecuteResultMessage,
} from './worker/moonbit-worker-protocol';
import {
  assertValidHardKillDelay,
  normalizeHardKillMultiplier,
  normalizeQueueSize,
  normalizeTimerMs,
  normalizeWorkerFactory,
  normalizeWorkerUrl,
  snapshotWorkerOptions,
} from './worker-executor-options';

// Execution timeout for a single MoonBit export (wasm is fast; generous
// default covers instantiate + the synchronous call).
const DEFAULT_TIMEOUT_MS = 5000;
// Hard-kill multiplier — terminate the worker at 1.5x the execution timeout.
const DEFAULT_HARD_KILL_MULTIPLIER = 1.5;
// Init timeout — the worker is trivial to start (no Wasm load), but a
// script-load failure must still settle init waiters.
const DEFAULT_INIT_TIMEOUT_MS = 10000;
// Bounded queue depth; single-flight + small queue keeps memory bounded.
const DEFAULT_MAX_QUEUE_SIZE = 4;

/** Counter for generating unique request IDs */
let requestIdCounter = 0;

/** Diagnostics counters (same taxonomy as WebWorkerSandboxExecutor). */
export interface MoonBitExecutorDiagnostics {
  initTimeoutCount: number;
  initFailureCount: number;
  queueWaitCount: number;
  queueOverflowCount: number;
  forcedTerminationCount: number;
  cancelCount: number;
  generationRestartCount: number;
  lateResponseCount: number;
  duplicateCompletionCount: number;
  malformedResponseCount: number;
}

/** Options for MoonBitWorkerSandboxExecutor */
export interface MoonBitWorkerSandboxOptions {
  /** URL of the MoonBit worker script (e.g. '/moonbit-worker.js') */
  workerUrl: string;
  /** Execution timeout in ms (default 5000); the worker is terminated at
   * `timeout * hardKillMultiplier` after execution starts. */
  timeout?: number;
  /** Timeout in ms for worker initialization (default 10000) */
  initTimeoutMs?: number;
  /** Maximum queued (not yet running) requests (default 4) */
  maxQueueSize?: number;
  /** Hard-kill multiplier (default 1.5) */
  hardKillMultiplier?: number;
  /** Factory for creating Worker instances (injectable for testing) */
  createWorker?: (url: string | URL) => Worker;
  /**
   * Namespace configured by MoonBit's `imported-string-constants` option.
   * Defaults to `_`. Use `null` for modules without imported constants.
   */
  importedStringConstants?: MoonBitImportedStringConstants;
  /** Maximum settled byte/module identities retained in LRU order (default 4; 0 disables). */
  maxCachedModules?: number;
}

type ExecutorState =
  | { status: 'empty' }
  | { status: 'initializing'; generationId: number }
  | { status: 'ready'; generationId: number }
  | { status: 'disposed' };

/** Common per-request bookkeeping */
interface BaseRequest {
  requestId: string;
  /** Worker compile-cache identity; hash-bound for verified URL execution. */
  cacheKey: string;
  /** Inline buffers compile per call; URL-based payloads may be cached. */
  cacheable: boolean;
  args: unknown[];
  /** wasm bytes to transfer (captured at execute/enqueue time) */
  bytes: ArrayBuffer;
  /** export to call on the module */
  exportName: string;
  /** Optional array-copy ABI for this export. */
  moonbitAbi?: MoonBitAbi;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

/** A request currently executing in the worker generation */
interface RunningRequest extends BaseRequest {
  generationId: number;
  startedAt: number;
  hardKillTimer: ReturnType<typeof setTimeout> | null;
  /** Set once the caller's signal aborts; a racing execute-result must then
   * be settled as cancellation instead of committing its value. */
  cancelRequested: boolean;
}

/** A request waiting in the bounded FIFO queue */
interface QueuedRequest extends BaseRequest {
  enqueuedAt: number;
}

/** A shared in-flight wasm-byte fetch per URL with waiter tracking. */
interface InflightBytesRequest {
  promise: Promise<ArrayBuffer>;
  controller: AbortController;
  waiters: number;
}

function isInflight(
  entry: ArrayBuffer | InflightBytesRequest,
): entry is InflightBytesRequest {
  return (entry as InflightBytesRequest).controller !== undefined;
}

/** True when the cached entry is no longer the in-flight request (settled). */
function isSettled(
  cache: Map<string, ArrayBuffer | InflightBytesRequest>,
  url: string,
  pending: InflightBytesRequest,
): boolean {
  return cache.get(url) !== pending;
}

export class MoonBitWorkerSandboxExecutor implements SandboxExecutor {
  private readonly workerUrl: string;
  private readonly timeout: number;
  private readonly initTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly hardKillMultiplier: number;
  private readonly createWorkerFn: (url: string | URL) => Worker;
  private readonly importedStringConstants: MoonBitImportedStringConstants;
  private readonly maxCachedModules: number;

  private state: ExecutorState = { status: 'empty' };
  private generationId = 0;
  private runningRequest: RunningRequest | null = null;
  private readonly queue: QueuedRequest[] = [];
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private initReject: ((error: Error) => void) | null = null;
  /** True when a generation failure left queued work to restart */
  private pendingRestart = false;

  /** Fetched wasm bytes cached per URL + expected hash. */
  private readonly bytesCache = new Map<string, ArrayBuffer | InflightBytesRequest>();

  private readonly diagnosticsState: MoonBitExecutorDiagnostics = {
    initTimeoutCount: 0,
    initFailureCount: 0,
    queueWaitCount: 0,
    queueOverflowCount: 0,
    forcedTerminationCount: 0,
    cancelCount: 0,
    generationRestartCount: 0,
    lateResponseCount: 0,
    duplicateCompletionCount: 0,
    malformedResponseCount: 0,
  };

  constructor(options: MoonBitWorkerSandboxOptions) {
    const snapshot = snapshotWorkerOptions(options, [
      'workerUrl',
      'timeout',
      'initTimeoutMs',
      'maxQueueSize',
      'hardKillMultiplier',
      'createWorker',
      'importedStringConstants',
      'maxCachedModules',
    ]);
    const workerUrl = snapshot.workerUrl;
    const timeout = snapshot.timeout;
    const initTimeoutMs = snapshot.initTimeoutMs;
    const maxQueueSize = snapshot.maxQueueSize;
    const hardKillMultiplier = snapshot.hardKillMultiplier;
    const createWorker = snapshot.createWorker;
    const importedStringConstants = snapshot.importedStringConstants;
    const maxCachedModules = snapshot.maxCachedModules;

    const normalizedTimeout = normalizeTimerMs('timeout', timeout, DEFAULT_TIMEOUT_MS);
    const normalizedHardKillMultiplier = normalizeHardKillMultiplier(
      hardKillMultiplier,
      DEFAULT_HARD_KILL_MULTIPLIER,
    );
    assertValidHardKillDelay(normalizedTimeout, normalizedHardKillMultiplier);

    this.workerUrl = normalizeWorkerUrl(workerUrl);
    this.timeout = normalizedTimeout;
    this.initTimeoutMs = normalizeTimerMs(
      'initTimeoutMs',
      initTimeoutMs,
      DEFAULT_INIT_TIMEOUT_MS,
    );
    this.maxQueueSize = normalizeQueueSize(maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
    this.hardKillMultiplier = normalizedHardKillMultiplier;
    this.createWorkerFn = normalizeWorkerFactory(
      createWorker,
      (url) => new Worker(url, { type: 'module' }),
    );
    this.importedStringConstants = normalizeMoonBitImportedStringConstants(
      importedStringConstants,
    );
    this.maxCachedModules = normalizeMoonBitCacheLimit(maxCachedModules);
  }

  get diagnostics(): MoonBitExecutorDiagnostics {
    return { ...this.diagnosticsState };
  }

  /** Whether the worker generation is ready to execute. */
  isReady(): boolean {
    return this.state.status === 'ready';
  }

  /**
   * Fetch (and cache) the wasm module bytes for `url`.
   *
   * Fetches are deduplicated per URL + expected hash. The shared fetch is NOT
   * bound to any single caller's signal: each caller races it against their own
   * AbortSignal, and the underlying fetch is aborted only when the last waiter
   * leaves or the executor is disposed.
   */
  async prepare(
    code: string,
    signal?: AbortSignal,
    expectedHash?: string,
  ): Promise<ArrayBuffer> {
    let signalSnapshot: ReturnType<typeof snapshotMoonBitAbortSignal>;
    try {
      signalSnapshot = snapshotMoonBitAbortSignal(signal);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    if (signalSnapshot.initiallyAborted) {
      throw new UnzenCancelledError('Execution cancelled by caller');
    }
    const requestSignal = signalSnapshot.signal;
    if (this.state.status === 'disposed') {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }
    let moduleUrl: string;
    try {
      moduleUrl = normalizeMoonBitModuleUrl(code);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    if (expectedHash !== undefined && !isValidUnzenContentHash(expectedHash)) {
      throw new UnzenNetworkError('Invalid MoonBit module hash in manifest');
    }

    const cacheKey = createUnzenContentCacheKey(moduleUrl, expectedHash);
    const cached = this.bytesCache.get(cacheKey);
    if (cached && !isInflight(cached)) {
      // Do not expose the cache-owned buffer: ArrayBuffer is mutable, and a
      // caller could otherwise alter already-verified bytes for later calls.
      this.bytesCache.delete(cacheKey);
      this.bytesCache.set(cacheKey, cached);
      return cached.slice(0);
    }

    let pending: InflightBytesRequest;
    if (cached) {
      pending = cached;
    } else {
      const controller = new AbortController();
      pending = {
        promise: this.fetchBytes(moduleUrl, controller.signal, expectedHash),
        controller,
        waiters: 0,
      };
      pending.promise.then(
        (bytes) => {
          if (!this.isDisposed() && this.bytesCache.get(cacheKey) === pending) {
            this.publishBytes(cacheKey, bytes);
          }
        },
        () => {
          if (this.bytesCache.get(cacheKey) === pending) {
            this.bytesCache.delete(cacheKey);
          }
        },
      ).catch(() => {});
      this.bytesCache.set(cacheKey, pending);
    }

    pending.waiters++;
    try {
      const bytes = await (requestSignal
        ? raceWithAbort(pending.promise, requestSignal)
        : pending.promise);
      // Each waiter receives an isolated snapshot while the original remains
      // private to the verified cache.
      return bytes.slice(0);
    } finally {
      pending.waiters--;
      if (
        pending.waiters === 0
        && this.bytesCache.get(cacheKey) === pending
        && !isSettled(this.bytesCache, cacheKey, pending)
      ) {
        this.bytesCache.delete(cacheKey);
        pending.controller.abort();
      }
    }
  }

  /**
   * Execute a MoonBit module.
   *
   * @param code - wasm URL (fetched via prepare) or already-fetched bytes
   * @param args - Scalar arguments, plus numeric arrays declared by moonbitAbi
   * @param options - signal + exportName (default 'run') + MoonBit ABI
   */
  async execute(
    code: string | ArrayBuffer,
    args: unknown[],
    options?: ExecuteOptions,
  ): Promise<unknown> {
    let executionOptions: ReturnType<typeof snapshotMoonBitExecutionOptions>;
    try {
      executionOptions = snapshotMoonBitExecutionOptions(options);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    if (executionOptions.signalInitiallyAborted) {
      throw new UnzenCancelledError('Execution cancelled by caller');
    }
    if (this.state.status === 'disposed') {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }

    // Validate before postMessage so invalid/non-cloneable inputs have the
    // same contract as worker-side validation instead of a DataCloneError.
    let call: ReturnType<typeof snapshotMoonBitCall>;
    try {
      call = snapshotMoonBitCall(args, executionOptions.moonbitAbi);
    } catch (error) {
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }

    let moduleUrl: string | undefined;
    let workerCacheKey: string | undefined;
    let bytes: ArrayBuffer;
    try {
      if (typeof code === 'string') {
        moduleUrl = normalizeMoonBitModuleUrl(code);
        bytes = await this.prepare(
          moduleUrl,
          executionOptions.signal,
          executionOptions.expectedHash,
        );
        workerCacheKey = createUnzenContentCacheKey(
          moduleUrl,
          executionOptions.expectedHash,
        );
      } else {
        bytes = snapshotMoonBitModuleBytes(code);
      }
    } catch (error) {
      if (
        error instanceof UnzenCancelledError
        || error instanceof UnzenNetworkError
        || error instanceof UnzenRuntimeError
      ) {
        throw error;
      }
      throw new UnzenRuntimeError(error instanceof Error ? error.message : String(error));
    }
    throwIfAborted(executionOptions.signal);

    const requestId = `req-${++requestIdCounter}`;
    return new Promise<unknown>((resolve, reject) => {
      const base: BaseRequest = {
        requestId,
        // Inline execution is deliberately non-cacheable. Its unique key still
        // makes the wire identity unambiguous for diagnostics and tests.
        cacheKey: workerCacheKey ?? `inline:${requestId}`,
        cacheable: workerCacheKey !== undefined,
        args: call.args,
        bytes,
        exportName: executionOptions.exportName,
        moonbitAbi: call.abi,
        resolve,
        reject,
        signal: executionOptions.signal,
      };

      if (this.state.status === 'initializing' || this.runningRequest) {
        this.enqueueOrReject(base);
        return;
      }
      this.startRequest(base, requestId);
    });
  }

  /** Idempotent disposal — terminates the worker and settles pending work. */
  dispose(): void {
    if (this.state.status === 'disposed') return;
    this.state = { status: 'disposed' };

    const running = this.runningRequest;
    if (running) {
      this.runningRequest = null;
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(new UnzenRuntimeError('Executor disposed while execution was pending'));
    }
    for (const queued of this.queue) {
      this.removeAbortListener(queued);
      queued.reject(new UnzenRuntimeError('Executor disposed while execution was pending'));
    }
    this.queue.length = 0;
    if (this.initReject) {
      const reject = this.initReject;
      this.initReject = null;
      reject(new UnzenRuntimeError('Executor disposed during initialization'));
    }
    this.initPromise = null;
    this.teardownWorker();
    for (const entry of this.bytesCache.values()) {
      if (isInflight(entry)) entry.controller.abort();
    }
    this.bytesCache.clear();
  }

  /** Promote verified bytes and evict least-recent settled identities. */
  private publishBytes(cacheKey: string, bytes: ArrayBuffer): void {
    this.bytesCache.delete(cacheKey);
    if (this.maxCachedModules === 0) return;
    this.bytesCache.set(cacheKey, bytes);

    let settledCount = 0;
    for (const entry of this.bytesCache.values()) {
      if (!isInflight(entry)) settledCount++;
    }
    while (settledCount > this.maxCachedModules) {
      for (const [key, entry] of this.bytesCache) {
        if (isInflight(entry)) continue;
        this.bytesCache.delete(key);
        settledCount--;
        break;
      }
    }
  }

  // ============================================================
  // Lifecycle internals
  // ============================================================

  private isDisposed(): boolean {
    return this.state.status === 'disposed';
  }

  private resetToEmptyIfNotDisposed(): void {
    if (this.state.status !== 'disposed') {
      this.state = { status: 'empty' };
    }
  }

  private enqueueOrReject(base: BaseRequest): void {
    let signalAborted: boolean;
    try {
      signalAborted = this.readSignalAborted(base.signal);
    } catch (error) {
      base.reject(error instanceof Error ? error : new UnzenRuntimeError(String(error)));
      return;
    }
    if (signalAborted) {
      this.diagnosticsState.cancelCount++;
      base.reject(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.diagnosticsState.queueOverflowCount++;
      base.reject(new UnzenRuntimeError(
        `Executor queue is full (max ${this.maxQueueSize} queued requests)`,
      ));
      return;
    }
    const queued: QueuedRequest = { ...base, enqueuedAt: Date.now() };
    this.queue.push(queued);
    try {
      this.attachAbortListener(queued, base.requestId);
    } catch (error) {
      const index = this.queue.findIndex((entry) => entry.requestId === base.requestId);
      if (index >= 0) this.queue.splice(index, 1);
      this.removeAbortListener(queued);
      queued.reject(error instanceof Error ? error : new UnzenRuntimeError(String(error)));
      return;
    }
    // A structural signal may abort synchronously during registration.
    if (this.queue.some((entry) => entry.requestId === base.requestId)) {
      this.diagnosticsState.queueWaitCount++;
    }
  }

  /**
   * Start a request: reserve the single-flight slot, (re)initialize the
   * worker if needed, then post the execute message with the wasm bytes.
   */
  private startRequest(
    req: BaseRequest,
    requestId: string,
  ): void {
    if (this.isDisposed()) {
      req.reject(new UnzenRuntimeError('Executor has been disposed.'));
      return;
    }
    let signalAborted: boolean;
    try {
      signalAborted = this.readSignalAborted(req.signal);
    } catch (error) {
      req.reject(error instanceof Error ? error : new UnzenRuntimeError(String(error)));
      return;
    }
    if (signalAborted) {
      this.diagnosticsState.cancelCount++;
      req.reject(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }

    const running: RunningRequest = {
      ...req,
      generationId: this.generationId,
      startedAt: Date.now(),
      hardKillTimer: null,
      cancelRequested: false,
    };
    this.runningRequest = running;
    this.removeAbortListener(running);
    try {
      this.attachAbortListener(running, requestId);
    } catch (error) {
      if (this.runningRequest?.requestId === requestId) {
        this.runningRequest = null;
      }
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(error instanceof Error ? error : new UnzenRuntimeError(String(error)));
      void this.drainQueue();
      return;
    }
    // Registration can observe an abort that happened after the earlier
    // state read. Its handler has already settled and released the slot.
    if (this.runningRequest?.requestId !== requestId) return;

    if (this.state.status === 'ready') {
      this.postExecuteMessage(running, this.generationId);
      return;
    }

    // Init owner: (re)initialize, then hand the request to the ready worker.
    this.ensureInitialized().then(
      () => {
        if (this.runningRequest?.requestId !== requestId) return;
        if (this.state.status !== 'ready') {
          const current = this.runningRequest;
          this.runningRequest = null;
          this.removeAbortListener(current!);
          current!.reject(new UnzenRuntimeError('Executor not ready after initialization'));
          return;
        }
        this.postExecuteMessage(this.runningRequest, this.generationId);
      },
      (error: Error) => {
        if (this.runningRequest?.requestId !== requestId) return;
        const err = error instanceof Error ? error : new UnzenRuntimeError(String(error));
        this.runningRequest = null;
        this.clearRunningTimers(running);
        this.removeAbortListener(running);
        running.reject(err);
        this.rejectAllQueued(err);
      },
    );
  }

  /**
   * Post the execute message for a ready worker generation and arm the
   * hard-kill timer at EXECUTION START (not enqueue time).
   */
  private postExecuteMessage(
    running: RunningRequest,
    generationId: number,
  ): void {
    running.generationId = generationId;
    running.startedAt = Date.now();
    running.hardKillTimer = setTimeout(() => {
      this.handleHardTimeout(running.requestId);
    }, this.timeout * this.hardKillMultiplier);

    try {
      // Transfer a COPY so the cached original stays intact and reusable: a
      // transferred ArrayBuffer is detached and cannot be sent again. The
      // copy is also what the worker sees, so the transfer list and the
      // message carry the SAME buffer (zero extra copy in the browser).
      const transferable = running.bytes.slice(0);
      const msg = createMoonbitExecuteMessage(
        running.requestId,
        running.cacheKey,
        transferable,
        running.cacheable,
        running.exportName,
        running.args,
        generationId,
        running.moonbitAbi,
      );
      this.worker!.postMessage(msg, [transferable]);
    } catch (error) {
      // Synchronous send failure (e.g. DataCloneError): settle and continue
      // the queue instead of leaving the request on its hard-kill timer.
      this.runningRequest = null;
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(new UnzenRuntimeError(
        `Failed to send execute message: ${error instanceof Error ? error.message : String(error)}`,
      ));
      void this.drainQueue();
    }
  }

  private ensureInitialized(): Promise<void> {
    const st = this.state;
    if (st.status === 'ready') return Promise.resolve();
    if (st.status === 'disposed') {
      return Promise.reject(new UnzenRuntimeError('Executor has been disposed.'));
    }
    if (this.initPromise) return this.initPromise;

    const generationId = ++this.generationId;
    this.state = { status: 'initializing', generationId };
    this.initPromise = this.doInit(generationId).then(
      () => {
        this.initPromise = null;
        if (this.state.status === 'initializing' && this.state.generationId === generationId) {
          this.state = { status: 'ready', generationId };
          if (this.pendingRestart) {
            this.diagnosticsState.generationRestartCount++;
            this.pendingRestart = false;
          }
        }
      },
      (error: Error) => {
        this.initPromise = null;
        if (this.state.status === 'initializing' && this.state.generationId === generationId) {
          this.state = { status: 'empty' };
        }
        throw error;
      },
    );
    return this.initPromise;
  }

  private doInit(generationId: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      let worker: Worker;
      try {
        worker = this.createWorkerFn(this.workerUrl);
      } catch (error) {
        this.diagnosticsState.initFailureCount++;
        this.resetToEmptyIfNotDisposed();
        reject(new UnzenRuntimeError(
          `Failed to create Worker: ${error instanceof Error ? error.message : String(error)}`,
        ));
        return;
      }
      this.worker = worker;

      const initTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.diagnosticsState.initTimeoutCount++;
        this.initReject = null;
        this.teardownWorker();
        this.resetToEmptyIfNotDisposed();
        reject(new UnzenRuntimeError(
          `Worker initialization timed out after ${this.initTimeoutMs}ms`,
        ));
      }, this.initTimeoutMs);

      this.initReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.initReject = null;
        this.teardownWorker();
        this.resetToEmptyIfNotDisposed();
        reject(error);
      };

      worker.onerror = (event: ErrorEvent) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.diagnosticsState.initFailureCount++;
        this.initReject = null;
        this.teardownWorker();
        this.resetToEmptyIfNotDisposed();
        reject(new UnzenRuntimeError(
          `Worker error during initialization: ${event.message ?? 'unknown error'}`,
        ));
      };

      worker.onmessage = (event: MessageEvent<unknown>) => {
        const validated = validateMoonbitWorkerResponse(event.data);
        if (!validated.ok) {
          this.diagnosticsState.malformedResponseCount++;
          if (settled) return;
          settled = true;
          clearTimeout(initTimer);
          this.initReject = null;
          this.teardownWorker();
          this.resetToEmptyIfNotDisposed();
          reject(new UnzenRuntimeError(`Malformed worker init response: ${validated.reason}`));
          return;
        }
        const msg = validated.msg;
        if (msg.type !== 'init-result') return;
        if (msg.generationId !== generationId) {
          this.diagnosticsState.lateResponseCount++;
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.initReject = null;
        if (msg.success) {
          this.setupMessageHandler(generationId, worker);
          resolve();
        } else {
          this.diagnosticsState.initFailureCount++;
          this.teardownWorker();
          this.state = { status: 'empty' };
          reject(new UnzenRuntimeError(msg.error ?? 'MoonBit worker initialization failed'));
        }
      };

      try {
        worker.postMessage(createMoonbitInitMessage(
          generationId,
          this.importedStringConstants,
          this.maxCachedModules,
        ));
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.diagnosticsState.initFailureCount++;
        this.initReject = null;
        this.teardownWorker();
        this.resetToEmptyIfNotDisposed();
        reject(new UnzenRuntimeError(
          `Failed to send init message: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
  }

  private setupMessageHandler(generationId: number, worker: Worker): void {
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const validated = validateMoonbitWorkerResponse(event.data);
      if (!validated.ok) {
        this.diagnosticsState.malformedResponseCount++;
        this.failGeneration(new UnzenRuntimeError(`Malformed worker response: ${validated.reason}`));
        return;
      }
      const msg = validated.msg;
      if (msg.generationId !== generationId) {
        this.diagnosticsState.lateResponseCount++;
        return;
      }
      if (msg.type === 'execute-result') {
        this.handleExecuteResult(msg);
      }
      // cancel-result is not expected from the main-thread path (cancellation
      // terminates the worker), but an idle worker ack is ignored safely.
    };
    worker.onerror = () => {
      this.failGeneration(new UnzenRuntimeError('Worker crashed unexpectedly'));
    };
  }

  private handleExecuteResult(msg: MoonbitExecuteResultMessage): void {
    const running = this.runningRequest;
    if (!running) {
      this.diagnosticsState.duplicateCompletionCount++;
      return;
    }
    if (msg.requestId !== running.requestId) {
      this.diagnosticsState.duplicateCompletionCount++;
      this.failGeneration(new UnzenRuntimeError(
        `Worker responded for unknown request ${msg.requestId} (expected ${running.requestId})`,
      ));
      return;
    }

    this.runningRequest = null;
    this.clearRunningTimers(running);
    this.removeAbortListener(running);

    // A result that raced the caller's abort must never be committed: the
    // worker could not observe the cancel mid-run and reported a value.
    if (running.cancelRequested) {
      running.reject(new UnzenCancelledError('Execution cancelled by caller'));
    } else if (msg.success) {
      running.resolve(msg.value);
    } else if (msg.errorType === 'runtime_error') {
      running.reject(new UnzenRuntimeError(msg.error ?? 'Runtime error'));
    } else {
      running.reject(new UnzenFunctionError(msg.error ?? 'Function error'));
    }
    void this.drainQueue();
  }

  /** Hard timeout is generation-fatal: settle and terminate the worker. */
  private handleHardTimeout(requestId: string): void {
    if (!this.runningRequest || this.runningRequest.requestId !== requestId) {
      this.diagnosticsState.lateResponseCount++;
      return;
    }
    if (this.runningRequest.cancelRequested) {
      this.failGeneration(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }
    this.failGeneration(new UnzenDeadlineExceededError(
      `Execution hard timeout (worker terminated after ${Math.round(this.timeout * this.hardKillMultiplier)}ms)`,
    ));
  }

  /** Generation-fatal failure: settle the running request, tear down, restart. */
  private failGeneration(error: Error): void {
    this.diagnosticsState.forcedTerminationCount++;
    this.pendingRestart = true;

    const running = this.runningRequest;
    if (running) {
      this.runningRequest = null;
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(error);
    }
    this.teardownWorker();
    this.state = { status: 'empty' };
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    while (!this.isDisposed()) {
      if (this.runningRequest) return;
      if (this.queue.length === 0) return;

      if (this.state.status !== 'ready') {
        try {
          await this.ensureInitialized();
        } catch (error) {
          const err = error instanceof Error ? error : new UnzenRuntimeError(String(error));
          this.rejectAllQueued(err);
          return;
        }
        if (this.isDisposed()) return;
        if (this.runningRequest) return;
        continue;
      }

      const next = this.queue.shift();
      if (!next) return;
      // startRequest performs the live abort-state read and settles malformed
      // structural signals without losing the shifted queue entry. The queued
      // entry already owns its bytes/export snapshot, so no re-fetch occurs.
      this.startRequest(next, next.requestId);
    }
  }

  private rejectAllQueued(error: Error): void {
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!;
      this.removeAbortListener(queued);
      queued.reject(error);
    }
  }

  private attachAbortListener(req: BaseRequest, requestId: string): void {
    if (!req.signal) return;
    const handler = () => {
      const running = this.runningRequest;
      if (running?.requestId === requestId) {
        if (this.state.status === 'ready' && running.hardKillTimer !== null) {
          // A running MoonBit export cannot be interrupted cooperatively:
          // record the intent (a racing result is settled as cancelled) and
          // terminate the worker so the caller settles promptly.
          running.cancelRequested = true;
          this.diagnosticsState.cancelCount++;
          this.failGeneration(new UnzenCancelledError('Execution cancelled by caller'));
        } else {
          // The request has not posted its execute message yet (it is either
          // initializing or between listener registration and dispatch).
          this.diagnosticsState.cancelCount++;
          this.runningRequest = null;
          this.clearRunningTimers(running);
          this.removeAbortListener(running);
          running.reject(new UnzenCancelledError('Execution cancelled by caller'));
          void this.drainQueue();
        }
        return;
      }
      const idx = this.queue.findIndex((q) => q.requestId === requestId);
      if (idx >= 0) {
        const [queued] = this.queue.splice(idx, 1);
        this.diagnosticsState.cancelCount++;
        queued.reject(new UnzenCancelledError('Execution cancelled while queued'));
      }
    };
    try {
      req.abortHandler = subscribeToAbortSignal(req.signal, handler);
    } catch {
      throw new UnzenRuntimeError('MoonBit execution signal could not be subscribed');
    }
  }

  private removeAbortListener(req: BaseRequest): void {
    const abortHandler = req.abortHandler;
    req.abortHandler = undefined;
    if (!abortHandler) return;
    try {
      abortHandler();
    } catch {
      // Caller-owned cleanup must not corrupt executor settlement.
    }
  }

  private readSignalAborted(signal?: AbortSignal): boolean {
    try {
      return readAbortSignalAborted(signal);
    } catch {
      throw new UnzenRuntimeError('MoonBit execution signal state could not be read');
    }
  }

  private clearRunningTimers(running: RunningRequest): void {
    if (running.hardKillTimer) {
      clearTimeout(running.hardKillTimer);
      running.hardKillTimer = null;
    }
  }

  private teardownWorker(): void {
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.initReject = null;
    this.initPromise = null;
  }

  private async fetchBytes(
    url: string,
    signal: AbortSignal,
    expectedHash?: string,
  ): Promise<ArrayBuffer> {
    let response: Response;
    try {
      response = await globalThis.fetch(url, { method: 'GET', signal });
    } catch (error) {
      if (isAbortError(error)) {
        throw new UnzenRuntimeError('MoonBit module fetch aborted');
      }
      throw new UnzenNetworkError(
        `Failed to fetch MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new UnzenNetworkError(
        `Failed to fetch MoonBit module: ${response.status} ${response.statusText}`,
      );
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await readBoundedResponseBytes(
        response,
        MAX_FUNCTION_PAYLOAD_BYTES,
        'MoonBit module response',
      );
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        throw new UnzenRuntimeError('MoonBit module fetch aborted');
      }
      throw new UnzenNetworkError(
        `Failed to read MoonBit module: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throwIfAborted(signal);
    if (expectedHash !== undefined) {
      try {
        await assertUnzenContentIntegrity(bytes, expectedHash);
      } catch (error) {
        throw new UnzenNetworkError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throwIfAborted(signal);
    }
    return bytes;
  }
}
