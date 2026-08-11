/**
 * WebWorkerSandboxExecutor - Browser-side QuickJS Wasm sandbox via Web Worker
 *
 * Implements the SandboxExecutor interface using a Web Worker running QuickJS Wasm.
 * Provides the 4-layer isolation model:
 *   Layer 1: Web Worker (separate thread, no DOM access)
 *   Layer 2: Wasm sandbox (memory isolation from host)
 *   Layer 3: QuickJS interpreter (separate JS engine)
 *   Layer 4: API restrictions (no eval/Function/Proxy, frozen prototypes)
 *
 * Lifecycle (state machine):
 *   empty → initializing → ready → (generation failure) → empty
 *                              ↘ (hard timeout / worker crash → fail generation)
 *   empty/initializing/ready → disposed
 *
 * Design rationale (issue #106):
 * - **Single-flight concurrency**: one Worker generation executes at most one
 *   request at a time. Additional requests wait in a bounded FIFO queue. This
 *   makes execution timeout, cancel, and crash semantics deterministic instead
 *   of racing multiple requests through one Worker.
 * - **Generation identity**: every Worker (re)creation bumps `generationId`.
 *   All worker messages carry it; responses from a stale generation are
 *   rejected. This prevents late responses from a terminated Worker being
 *   applied to a fresh one.
 * - **Init timeout**: if `init-result` never arrives, init waiters are settled
 *   within `initTimeoutMs` instead of hanging forever.
 * - **Execution timeout measured from execution start**: the hard-kill timer
 *   starts when a request actually begins running (not when it was enqueued),
 *   so queue wait time is never mistaken for execution time.
 * - **Cooperative cancellation**: queued requests are removed and rejected
 *   immediately on abort; running requests are cancelled via the worker
 *   protocol. If the worker does not acknowledge within `cancelAckTimeoutMs`,
 *   the generation is force-terminated so the promise settles promptly.
 * - **Generation-fatal failures**: hard timeout, worker crash, and protocol
 *   violations settle the running request immediately, tear down the Worker,
 *   and restart queued requests on a fresh generation (re-checking each
 *   caller's AbortSignal). No affected request is left waiting on its own timer.
 * - **Protocol validation**: responses are validated against a versioned
 *   schema. Malformed, duplicate, or stale-generation responses are classified
 *   and counted rather than trusted.
 *
 * Error classification:
 *   - function_error from worker → UnzenFunctionError (no server fallback)
 *   - runtime_error from worker → UnzenRuntimeError (triggers server fallback)
 *   - caller cancellation → UnzenCancelledError (never server fallback)
 *   - Worker init failure → UnzenRuntimeError (triggers server fallback)
 *   - Hard timeout → UnzenRuntimeError (triggers server fallback)
 */

import {
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenRuntimeError,
} from '@unzen/shared';
import type { ExecuteOptions, SandboxExecutor } from './sandbox-executor';
import {
  createCancelMessage,
  createExecuteMessage,
  createInitMessage,
  validateWorkerResponse,
  type CancelResultMessage,
  type ExecuteResultMessage,
} from './worker/worker-protocol';
import {
  assertValidHardKillDelay,
  assertWorkerOptions,
  normalizeHardKillMultiplier,
  normalizeQueueSize,
  normalizeTimerMs,
  normalizeWorkerFactory,
  normalizeWorkerUrl,
} from './worker-executor-options';
import {
  snapshotQuickJsCall,
  snapshotQuickJsExecutionOptions,
} from './quickjs-call';

/**
 * Configuration options for WebWorkerSandboxExecutor
 */
export interface WebWorkerSandboxOptions {
  /** URL of the worker script (e.g., '/worker.js') */
  workerUrl: string;

  /** Execution timeout in milliseconds (default: 5000ms for browser-side execution).
   * The worker's QuickJS interrupt handler uses this as the cooperative timeout.
   * A hard kill via Worker.terminate() fires at `timeout * hardKillMultiplier`
   * after the request actually starts executing. */
  timeout?: number;

  /** Timeout in ms for Worker initialization (default: 10000).
   * If the worker does not respond with `init-result`, init waiters are
   * rejected with UnzenRuntimeError and the worker is terminated. */
  initTimeoutMs?: number;

  /** Maximum number of queued (not yet running) requests (default: 4).
   * Requests beyond this limit are rejected immediately with an overflow
   * runtime error instead of growing the queue without bound. */
  maxQueueSize?: number;

  /** Timeout in ms to wait for a cooperative cancel acknowledgement from the
   * worker (default: 2000). If the worker does not respond, the generation is
   * force-terminated so the cancelled request settles promptly. */
  cancelAckTimeoutMs?: number;

  /** Hard-kill multiplier applied to `timeout` (default: 1.5). */
  hardKillMultiplier?: number;

  /** Factory for creating Worker instances (injectable for testing).
   * In production, uses `new Worker(url, { type: 'module' })`.
   * In tests, returns a mock Worker. */
  createWorker?: (url: string | URL) => Worker;
}

// Default timeout for browser-side execution (more generous than server's 50ms
// because browser execution includes Wasm overhead)
const DEFAULT_TIMEOUT_MS = 5000;
// Hard kill multiplier — terminate worker at 1.5x the cooperative timeout
const DEFAULT_HARD_KILL_MULTIPLIER = 1.5;
// Init timeout — QuickJS Wasm singlefile variant can take a while to decode
const DEFAULT_INIT_TIMEOUT_MS = 10000;
// Bounded queue depth; single-flight + small queue keeps memory bounded
const DEFAULT_MAX_QUEUE_SIZE = 4;
// Cooperative cancel acknowledgement window before force-termination
const DEFAULT_CANCEL_ACK_TIMEOUT_MS = 2000;

/** Counter for generating unique request IDs */
let requestIdCounter = 0;

/**
 * Diagnostics counters for the executor.
 *
 * Used to make lifecycle failures observable (issue #106):
 * queue overflow, init timeouts, forced terminations, cancel latency, and
 * stale/malformed response suppression are all counted here.
 */
export interface ExecutorDiagnostics {
  /** init-timeout events: init-result did not arrive within initTimeoutMs */
  initTimeoutCount: number;
  /** init failures: init-result with success=false or worker error during init */
  initFailureCount: number;
  /** requests that waited in the queue before running */
  queueWaitCount: number;
  /** requests rejected because the bounded queue was full */
  queueOverflowCount: number;
  /** generation-fatal teardowns (hard timeout / crash / protocol violation) */
  forcedTerminationCount: number;
  /** cancel requests that timed out waiting for a worker acknowledgement */
  cancelAckTimeoutCount: number;
  /** requests cancelled by the caller via AbortSignal */
  cancelCount: number;
  /** generations recreated after a failure (restarts) */
  generationRestartCount: number;
  /** responses from a stale generation or after the request already settled */
  lateResponseCount: number;
  /** duplicate or mismatched completions for settled/unknown requests */
  duplicateCompletionCount: number;
  /** responses that failed versioned schema validation */
  malformedResponseCount: number;
  /** time between a running request starting and its cancel acknowledgement (ms) */
  cancelLatencyMs: number | null;
}

/** Executor state machine (discriminated union, issue #106 §1) */
type ExecutorState =
  | { status: 'empty' }
  | { status: 'initializing'; generationId: number }
  | { status: 'ready'; generationId: number }
  | { status: 'disposed' };

/** Common per-request bookkeeping shared by queued and running requests */
interface BaseRequest {
  requestId: string;
  code: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  /** Detaches the abort listener — must be called when the request settles */
  abortHandler?: () => void;
}

/** A request currently executing in the Worker generation */
interface RunningRequest extends BaseRequest {
  generationId: number;
  startedAt: number;
  /** Hard-kill timer, started when execution begins (not when enqueued).
   * Null while the request owns initialization and has not started running. */
  hardKillTimer: ReturnType<typeof setTimeout> | null;
  /** Timer waiting for a cooperative cancel acknowledgement (null when idle) */
  cancelAckTimer: ReturnType<typeof setTimeout> | null;
  /** Set once the caller's signal aborts; a racing execute-result must then be
   * settled as cancellation instead of committing its value. */
  cancelRequested: boolean;
  /** Monotonic timestamp of the cancel request (for cancel-latency metrics) */
  cancelRequestedAt: number | null;
}

/** A request waiting in the bounded FIFO queue */
interface QueuedRequest extends BaseRequest {
  enqueuedAt: number;
}

/**
 * WebWorkerSandboxExecutor - SandboxExecutor implementation using Web Worker + QuickJS Wasm
 */
export class WebWorkerSandboxExecutor implements SandboxExecutor {
  private readonly workerUrl: string;
  private readonly timeout: number;
  private readonly initTimeoutMs: number;
  private readonly maxQueueSize: number;
  private readonly cancelAckTimeoutMs: number;
  private readonly hardKillMultiplier: number;
  private readonly createWorkerFn: (url: string | URL) => Worker;

  /** Executor state machine (see ExecutorState) */
  private state: ExecutorState = { status: 'empty' };
  /** Monotonic generation counter; bumped on every Worker (re)creation */
  private generationId = 0;
  /** Currently executing request, or null when idle */
  private runningRequest: RunningRequest | null = null;
  /** True when a generation failure left queued work to restart on a fresh
   * generation; cleared once that restart actually starts. */
  private pendingRestart = false;
  /** Bounded FIFO queue of requests waiting to execute */
  private readonly queue: QueuedRequest[] = [];
  /** Deduplicates concurrent ensureInitialized() calls */
  private initPromise: Promise<void> | null = null;
  /** Reject function for pending init — called by dispose()/timeout/teardown */
  private initReject: ((error: Error) => void) | null = null;
  /** Current Worker instance (null between generations) */
  private worker: Worker | null = null;

  private readonly diagnosticsState: ExecutorDiagnostics = {
    initTimeoutCount: 0,
    initFailureCount: 0,
    queueWaitCount: 0,
    queueOverflowCount: 0,
    forcedTerminationCount: 0,
    cancelAckTimeoutCount: 0,
    cancelCount: 0,
    generationRestartCount: 0,
    lateResponseCount: 0,
    duplicateCompletionCount: 0,
    malformedResponseCount: 0,
    cancelLatencyMs: null,
  };

  constructor(options: WebWorkerSandboxOptions) {
    assertWorkerOptions(options);
    const workerUrl = options.workerUrl;
    const timeout = options.timeout;
    const initTimeoutMs = options.initTimeoutMs;
    const maxQueueSize = options.maxQueueSize;
    const cancelAckTimeoutMs = options.cancelAckTimeoutMs;
    const hardKillMultiplier = options.hardKillMultiplier;
    const createWorker = options.createWorker;

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
    this.cancelAckTimeoutMs = normalizeTimerMs(
      'cancelAckTimeoutMs',
      cancelAckTimeoutMs,
      DEFAULT_CANCEL_ACK_TIMEOUT_MS,
    );
    this.hardKillMultiplier = normalizedHardKillMultiplier;
    this.createWorkerFn = normalizeWorkerFactory(
      createWorker,
      (url) => new Worker(url, { type: 'module' }),
    );
  }

  /**
   * Return a snapshot of the diagnostics counters.
   * The snapshot is defensive — callers cannot mutate internal state.
   */
  get diagnostics(): ExecutorDiagnostics {
    return { ...this.diagnosticsState };
  }

  /**
   * Whether the QuickJS Wasm runtime is ready to execute.
   *
   * False while the worker is empty/initializing (e.g. on first use or after a
   * generation failure); the client surfaces a `sandbox-initializing` event
   * based on this so a UI can show the init state instead of guessing.
   */
  isReady(): boolean {
    return this.state.status === 'ready';
  }

  /**
   * Whether the executor has been disposed.
   *
   * Read via a method (not direct property access) so TypeScript does not
   * carry control-flow narrowing across `await` boundaries: a concurrent
   * dispose() call can transition the state machine to 'disposed' at any
   * yield point, so the check must always be a fresh read.
   */
  private isDisposed(): boolean {
    return this.state.status === 'disposed';
  }

  /**
   * Reset the state machine to 'empty' unless the executor was disposed.
   *
   * doInit's failure paths and dispose() may race: dispose() sets 'disposed'
   * and then rejects the pending init; the init reject path must not clobber
   * 'disposed' back to 'empty' (that would resurrect a disposed executor).
   */
  private resetToEmptyIfNotDisposed(): void {
    if (this.state.status !== 'disposed') {
      this.state = { status: 'empty' };
    }
  }

  /**
   * Execute code in the QuickJS Wasm sandbox via Web Worker.
   *
   * @param code - JavaScript code defining a `run` function
   * @param args - Arguments to pass to `run`
   * @param options - Optional per-execution controls (AbortSignal cancels the
   *   request whether queued or running)
   * @returns Function result
   * @throws {UnzenFunctionError} When user code fails (syntax error, runtime error in user code)
   * @throws {UnzenCancelledError} When the caller aborts via options.signal
   * @throws {UnzenRuntimeError} When sandbox environment fails (init, timeout, terminated)
   */
  async execute(
    code: string,
    args: unknown[],
    options?: ExecuteOptions,
  ): Promise<unknown> {
    if (this.state.status === 'disposed') {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }
    let executionOptions: ReturnType<typeof snapshotQuickJsExecutionOptions>;
    try {
      executionOptions = snapshotQuickJsExecutionOptions(options);
    } catch (error) {
      throw new UnzenFunctionError(error instanceof Error ? error.message : String(error));
    }
    const signal = executionOptions.signal;
    // Reject immediately if the caller already aborted before calling.
    // Cancellation is a deliberate caller decision, never a runtime error.
    if (executionOptions.signalInitiallyAborted) {
      this.diagnosticsState.cancelCount++;
      throw new UnzenCancelledError('Execution cancelled by caller');
    }

    let call: ReturnType<typeof snapshotQuickJsCall>;
    try {
      call = snapshotQuickJsCall(code, args);
    } catch (error) {
      throw new UnzenFunctionError(error instanceof Error ? error.message : String(error));
    }

    // Generate unique request ID for tracking concurrent executions
    const requestId = `req-${++requestIdCounter}`;

    return new Promise<unknown>((resolve, reject) => {
      const base: BaseRequest = {
        requestId,
        code: call.code,
        args: call.args,
        resolve,
        reject,
        signal,
      };

      // Single-flight: while a request is running OR the worker is still
      // initializing, new requests wait in the bounded FIFO queue. Applying
      // the bound during init keeps memory bounded even when Wasm load is slow
      // and lets callers cancel promptly instead of hanging on the init await.
      if (this.state.status === 'initializing' || this.runningRequest) {
        this.enqueueOrReject(base);
        return;
      }

      this.startRequest(base, requestId);
    });
  }

  /**
   * Enqueue a request, or reject it when the queue is full / already aborted.
   *
   * The caller may have aborted before calling; an already-aborted signal
   * never fires its abort listener, so re-check here to avoid a stale queue
   * occupant.
   */
  private enqueueOrReject(base: BaseRequest): void {
    if (base.signal?.aborted) {
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
    this.diagnosticsState.queueWaitCount++;
    this.attachAbortListener(queued, base.requestId);
  }

  /**
   * Clean up resources — terminate Web Worker and reject pending promises.
   * Idempotent (safe to call multiple times).
   *
   * Guarantees after disposal: no timers, no abort listeners, no pending
   * promises, no message handlers remain attached to the Worker.
   */
  dispose(): void {
    if (this.state.status === 'disposed') return;
    this.state = { status: 'disposed' };

    // Reject the running request and clear its timers/listeners.
    const running = this.runningRequest;
    if (running) {
      this.runningRequest = null;
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(new UnzenRuntimeError('Executor disposed while execution was pending'));
    }

    // Reject all queued requests.
    for (const queued of this.queue) {
      this.removeAbortListener(queued);
      queued.reject(new UnzenRuntimeError('Executor disposed while execution was pending'));
    }
    this.queue.length = 0;

    // Reject pending init waiters so nothing hangs on an abandoned init.
    if (this.initReject) {
      const reject = this.initReject;
      this.initReject = null;
      reject(new UnzenRuntimeError('Executor disposed during initialization'));
    }
    this.initPromise = null;

    // Detach handlers and terminate the worker (no timers/listeners survive).
    this.teardownWorker();
  }

  /**
   * Ensure Worker is created and QuickJS Wasm is loaded.
   * Called before every request start — no-ops when already ready.
   * Concurrent callers share the same init promise.
   */
  private ensureInitialized(): Promise<void> {
    const st = this.state;
    if (st.status === 'ready') return Promise.resolve();
    if (st.status === 'disposed') {
      return Promise.reject(new UnzenRuntimeError('Executor has been disposed.'));
    }
    if (this.initPromise) return this.initPromise;

    // Start a new generation for this init attempt.
    const generationId = ++this.generationId;
    this.state = { status: 'initializing', generationId };

    this.initPromise = this.doInit(generationId).then(
      () => {
        this.initPromise = null;
        // Only promote to ready if we are still the current init attempt.
        // dispose()/teardown may have moved us to disposed/empty meanwhile.
        if (this.state.status === 'initializing' && this.state.generationId === generationId) {
          this.state = { status: 'ready', generationId };
          // A generation failure left work to restart; count each successful
          // restart regardless of whether anything was queued at the time.
          if (this.pendingRestart) {
            this.diagnosticsState.generationRestartCount++;
            this.pendingRestart = false;
          }
        }
      },
      (error: Error) => {
        this.initPromise = null;
        // doInit resets to 'empty' on its own failure paths; this guard is a
        // belt-and-braces fallback so we never stick in 'initializing'.
        if (this.state.status === 'initializing' && this.state.generationId === generationId) {
          this.state = { status: 'empty' };
        }
        throw error;
      },
    );
    return this.initPromise;
  }

  /** Actual init logic — creates Worker and waits for QuickJS Wasm to load */
  private doInit(generationId: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // `settled` guards against double-settle from timer + message + error.
      let settled = false;

      // The Worker constructor itself can throw synchronously (SecurityError,
      // invalid URL, a test-injected factory). That is an init failure, not a
      // hang: settle immediately so the init-owner and queued requests are
      // rejected and the executor can retry on a fresh generation later.
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

      // Init timeout: if `init-result` never arrives, settle init waiters
      // instead of leaving them pending forever (issue #106 §3).
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

      // Track reject for dispose()/teardown to call if init is still in progress.
      this.initReject = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.initReject = null;
        this.teardownWorker();
        this.resetToEmptyIfNotDisposed();
        reject(error);
      };

      // Handle fatal worker errors (script load failure, CSP violation, Wasm compile crash).
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

      // Validate the init response against the versioned schema and the
      // generation id before trusting it.
      worker.onmessage = (event: MessageEvent<unknown>) => {
        const validated = validateWorkerResponse(event.data);
        if (!validated.ok) {
          // Malformed response during init → treat as an init failure.
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
        // Ignore non-init messages while we wait for init-result.
        if (msg.type !== 'init-result') return;

        // Reject a stale init-result from an old generation.
        if (msg.generationId !== generationId) {
          this.diagnosticsState.lateResponseCount++;
          return;
        }

        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.initReject = null;

        if (msg.success) {
          // Init succeeded — switch to the execution/cancel message handler.
          this.setupMessageHandler(generationId, worker);
          resolve();
        } else {
          // Init failed (e.g. Wasm load error inside the worker).
          this.diagnosticsState.initFailureCount++;
          this.teardownWorker();
          this.state = { status: 'empty' };
          reject(new UnzenRuntimeError(msg.error ?? 'QuickJS Wasm initialization failed'));
        }
      };

      try {
        worker.postMessage(createInitMessage(generationId));
      } catch (error) {
        // Synchronous send failure (e.g. DataCloneError / dead worker): settle
        // the init immediately instead of leaving the init timer running.
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

  /**
   * Start executing a request on the current Worker generation.
   * Called when the executor is idle and no request is running.
   *
   * When the worker is already ready this posts the execute message
   * immediately. When the worker is empty/initializing the request becomes the
   * single-flight slot that OWNS initialization: it reserves the running slot
   * (so concurrent callers queue against it) and only arms its execution
   * timeout once the worker is actually ready — init has its own timeout.
   */
  private startRequest(req: BaseRequest, requestId: string): void {
    if (this.state.status === 'disposed') {
      req.reject(new UnzenRuntimeError('Executor has been disposed.'));
      return;
    }
    // Re-check the caller's signal (it may have aborted while queued).
    if (req.signal?.aborted) {
      this.diagnosticsState.cancelCount++;
      req.reject(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }

    // Reserve the single-flight slot now. `hardKillTimer` stays null until
    // execution actually begins (beginExecution), so an abort during init can
    // settle the request without waiting for init to finish.
    const running: RunningRequest = {
      ...req,
      generationId: this.generationId,
      startedAt: Date.now(),
      hardKillTimer: null,
      cancelAckTimer: null,
      cancelRequested: false,
      cancelRequestedAt: null,
    };
    this.runningRequest = running;

    // A queued request already carries an abort listener from enqueue time.
    // Detach it before attaching the running-request handler below — otherwise
    // the signal accumulates two listeners and cancelling fires twice.
    this.removeAbortListener(running);
    this.attachAbortListener(running, requestId);

    if (this.state.status === 'ready') {
      this.postExecuteMessage(running, this.generationId);
      return;
    }

    // Init owner: (re)initialize, then hand the request to the ready worker.
    // The rejection handler is required even when the request already settled
    // (e.g. aborted during init) so a later init failure is not an unhandled
    // rejection.
    this.ensureInitialized().then(
      () => {
        // The request may have settled (abort/dispose) or the slot may have
        // been claimed by drainQueue while we initialized — never restart it.
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
   * Post the execute message for a request on a ready worker generation.
   *
   * Arms the hard-kill timer at EXECUTION START (not enqueue time), so queue
   * wait time and init time are never counted against the execution timeout.
   */
  private postExecuteMessage(running: RunningRequest, generationId: number): void {
    running.generationId = generationId;
    running.startedAt = Date.now();
    running.hardKillTimer = setTimeout(() => {
      this.handleHardTimeout(running.requestId);
    }, this.timeout * this.hardKillMultiplier);

    try {
      this.worker!.postMessage(createExecuteMessage(
        running.requestId,
        running.code,
        running.args,
        generationId,
        this.timeout,
      ));
    } catch (error) {
      // Synchronous send failure (e.g. DataCloneError from an unserializable
      // argument, or the worker died between init and now): settle this
      // request and continue the queue instead of leaving it on its hard-kill
      // timer with a busy executor. The worker itself is still healthy for
      // clone failures, so this is not generation-fatal.
      this.runningRequest = null;
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(new UnzenRuntimeError(
        `Failed to send execute message: ${error instanceof Error ? error.message : String(error)}`,
      ));
      void this.drainQueue();
    }
  }

  /**
   * Handle a hard timeout for the given request.
   *
   * Hard timeout is generation-fatal: the running request is settled and the
   * worker is torn down. The guard prevents a stale timer (fired after the
   * request already settled) from killing a healthy worker.
   */
  private handleHardTimeout(requestId: string): void {
    if (!this.runningRequest || this.runningRequest.requestId !== requestId) {
      this.diagnosticsState.lateResponseCount++;
      return;
    }
    if (this.runningRequest.cancelRequested) {
      // The caller aborted but the worker neither finished nor acknowledged
      // the cancel in time — surface the caller's intent, not a runtime
      // failure that would wrongly trigger server fallback.
      this.failGeneration(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }
    this.failGeneration(new UnzenDeadlineExceededError(
      `Execution hard timeout (worker terminated after ${Math.round(this.timeout * this.hardKillMultiplier)}ms)`,
    ));
  }

  /**
   * Generation-fatal failure handling.
   *
   * Settles the running request immediately (no waiting for its own timer),
   * tears down the worker, and restarts queued requests on a fresh generation
   * per the default queue policy (each queued request's signal is re-checked).
   */
  private failGeneration(error: Error): void {
    this.diagnosticsState.forcedTerminationCount++;
    // The next successful initialization starts a fresh generation. Count it
    // as a restart whether or not queued work existed at failure time.
    this.pendingRestart = true;

    // Settle the running request immediately with the failure.
    const running = this.runningRequest;
    if (running) {
      this.runningRequest = null;
      this.clearRunningTimers(running);
      this.removeAbortListener(running);
      running.reject(error);
    }

    // Terminate the unusable worker and reset init state.
    this.teardownWorker();
    this.state = { status: 'empty' };

    // Queue policy (default): keep queued requests and restart on a new
    // generation, re-checking each caller's signal/deadline.
    void this.drainQueue();
  }

  /**
   * Drain the queue: start the next queued request once the executor is idle.
   *
   * Re-initializes the worker on a fresh generation if needed (e.g. after a
   * generation failure). If (re)init fails, all remaining queued requests are
   * failed with the same error rather than retrying in a hot loop.
   */
  private async drainQueue(): Promise<void> {
    while (!this.isDisposed()) {
      if (this.runningRequest) return;
      if (this.queue.length === 0) return;

      // Wait for (re)initialization while the queue still owns the abort
      // listeners, so an abort during init settles the queued request
      // promptly instead of only at init completion.
      if (this.state.status !== 'ready') {
        try {
          await this.ensureInitialized();
        } catch (error) {
          // Init failed — nothing in the queue can run. Fail them all with the
          // same error rather than retrying in a hot loop.
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

      // Re-check the caller's signal before starting on a fresh generation.
      if (next.signal?.aborted) {
        this.diagnosticsState.cancelCount++;
        this.removeAbortListener(next);
        next.reject(new UnzenCancelledError('Execution cancelled by caller'));
        continue;
      }

      this.startRequest(next, next.requestId);
    }
  }

  /**
   * Fail every remaining queued request with the given error.
   * Used when (re)initialization fails and no request can run.
   */
  private rejectAllQueued(error: Error): void {
    while (this.queue.length > 0) {
      const queued = this.queue.shift()!;
      this.removeAbortListener(queued);
      queued.reject(error);
    }
  }

  /**
   * Handle an execute-result message from the worker.
   * Validates request identity (mismatch = protocol violation) and settles the
   * running request, then drains the queue for the next request.
   *
   * Generation filtering already happened in setupMessageHandler; here we only
   * validate request ownership within the current generation.
   */
  private handleExecuteResult(msg: ExecuteResultMessage): void {
    const running = this.runningRequest;
    if (!running) {
      // Late or duplicate completion for a request that already settled.
      this.diagnosticsState.duplicateCompletionCount++;
      return;
    }

    if (msg.requestId !== running.requestId) {
      // A response for a request that is not the one running — the worker is
      // behaving inconsistently with the protocol. Treat as generation-fatal.
      this.diagnosticsState.duplicateCompletionCount++;
      this.failGeneration(new UnzenRuntimeError(
        `Worker responded for unknown request ${msg.requestId} (expected ${running.requestId})`,
      ));
      return;
    }

    this.runningRequest = null;
    this.clearRunningTimers(running);
    this.removeAbortListener(running);

    // A result that raced the caller's abort must never be committed: even a
    // successful completion after abort settles as cancellation (the worker
    // could not observe the cancel mid-run and reported the finished value).
    if (running.cancelRequested) {
      running.reject(new UnzenCancelledError('Execution cancelled by caller'));
    } else if (msg.success) {
      running.resolve(msg.value);
    } else if (msg.errorType === 'deadline_exceeded') {
      running.reject(new UnzenDeadlineExceededError(msg.error ?? 'Execution timeout exceeded'));
    } else if (msg.errorType === 'runtime_error') {
      running.reject(new UnzenRuntimeError(msg.error ?? 'Runtime error'));
    } else {
      running.reject(new UnzenFunctionError(msg.error ?? 'Function error'));
    }

    void this.drainQueue();
  }

  /**
   * Handle a cooperative cancel acknowledgement from the worker.
   * Settles the cancelled request with UnzenCancelledError.
   *
   * Only a `success: true` ack is trusted: a `success: false` ack means the
   * worker could not cancel (e.g. unknown request), so the request is left
   * running — the hard-kill timer or the cancel-ack timeout will settle it.
   */
  private handleCancelResult(msg: CancelResultMessage): void {
    const running = this.runningRequest;
    if (!running || running.requestId !== msg.requestId) {
      // Cancel ack for an already-settled request — ignore.
      this.diagnosticsState.lateResponseCount++;
      return;
    }
    if (!running.cancelRequested) {
      // A worker may acknowledge only a cancel that this executor actually
      // sent. Otherwise a forged or out-of-order response could turn an active
      // execution into a caller cancellation and suppress server fallback.
      this.failGeneration(new UnzenRuntimeError(
        `Unexpected cancel acknowledgement for request ${msg.requestId}`,
      ));
      return;
    }
    if (!msg.success) {
      // Worker reports it could not cancel (e.g. unknown request). The cancel
      // ack timer would otherwise fire later and count the same cancel twice.
      // Settle via the generation-fatal path now: the caller's intent is
      // final, the counter is counted exactly once here.
      this.diagnosticsState.cancelAckTimeoutCount++;
      this.failGeneration(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }

    this.diagnosticsState.cancelLatencyMs = running.cancelRequestedAt
      ? Date.now() - running.cancelRequestedAt
      : null;
    this.runningRequest = null;
    this.clearRunningTimers(running);
    this.removeAbortListener(running);
    running.reject(new UnzenCancelledError('Execution cancelled by caller'));

    void this.drainQueue();
  }

  /**
   * Initiate a cooperative cancellation for the running request.
   *
   * Sends a cancel message to the worker and starts an acknowledgement timer.
   * If the worker does not acknowledge (e.g. stuck in a C loop that ignores
   * the interrupt handler), the generation is force-terminated so the request
   * settles promptly rather than hanging.
   *
   * The force-terminated request is settled with UnzenCancelledError (not a
   * runtime error): the caller asked to cancel, so the failure is their
   * intent, and it must never trigger server fallback.
   */
  private initiateCancel(requestId: string): void {
    const running = this.runningRequest;
    if (!running || running.requestId !== requestId) return;

    // Record the caller's intent so a racing execute-result cannot commit its
    // value after the abort (see handleExecuteResult). Count the cancellation
    // exactly once, at the moment the abort is first accepted — a racing
    // execute-result that arrives before the cancel-result must not double- or
    // under-count it.
    running.cancelRequested = true;
    running.cancelRequestedAt = Date.now();
    this.diagnosticsState.cancelCount++;

    try {
      this.worker?.postMessage(createCancelMessage(requestId, running.generationId));
    } catch {
      // The worker is gone (already terminated): the caller's cancellation is
      // final, so settle via the generation-fatal path without waiting for a
      // cancel ack that can never arrive.
      this.diagnosticsState.cancelAckTimeoutCount++;
      this.failGeneration(new UnzenCancelledError('Execution cancelled by caller'));
      return;
    }

    running.cancelAckTimer = setTimeout(() => {
      // Guard: the request may have settled while waiting for the ack.
      if (this.runningRequest?.requestId !== requestId) return;
      this.diagnosticsState.cancelAckTimeoutCount++;
      this.failGeneration(new UnzenCancelledError(
        'Cancel acknowledgement timeout — worker terminated',
      ));
    }, this.cancelAckTimeoutMs);
  }

  /**
   * Attach an abort listener that cancels the request on signal abort.
   *
   * Works for both queued (removed from queue and rejected) and running
   * (cooperative worker cancel with force-termination fallback) requests.
   * The listener is removed once the request settles.
   */
  private attachAbortListener(req: BaseRequest, requestId: string): void {
    if (!req.signal) return;

    const handler = () => {
      const running = this.runningRequest;
      if (running?.requestId === requestId) {
        if (this.state.status === 'ready') {
          this.initiateCancel(requestId);
        } else {
          // The request owns initialization and has not begun executing, so a
          // worker cancel is neither possible nor needed: settle immediately
          // (the shared init may continue for queued requests).
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

    req.signal.addEventListener('abort', handler, { once: true });
    req.abortHandler = () => req.signal!.removeEventListener('abort', handler);
  }

  /** Detach the abort listener (if any) — must be called when a request settles */
  private removeAbortListener(req: BaseRequest): void {
    if (req.abortHandler) {
      req.abortHandler();
      req.abortHandler = undefined;
    }
  }

  /** Clear the hard-kill and cancel-ack timers for a settled running request */
  private clearRunningTimers(running: RunningRequest): void {
    if (running.hardKillTimer) {
      clearTimeout(running.hardKillTimer);
      running.hardKillTimer = null;
    }
    if (running.cancelAckTimer) {
      clearTimeout(running.cancelAckTimer);
      running.cancelAckTimer = null;
    }
  }

  /**
   * Set up the message handler for execute/cancel responses on a given
   * Worker generation.
   *
   * Validates every response against the versioned schema, rejects stale
   * generation messages, and classifies malformed/protocol-violating responses
   * as generation-fatal.
   */
  private setupMessageHandler(generationId: number, worker: Worker): void {
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const validated = validateWorkerResponse(event.data);
      if (!validated.ok) {
        // Malformed response from a live worker → protocol violation.
        this.diagnosticsState.malformedResponseCount++;
        this.failGeneration(new UnzenRuntimeError(`Malformed worker response: ${validated.reason}`));
        return;
      }

      const msg = validated.msg;

      // Reject any message from a generation other than the one this handler
      // was installed for (stale worker responses after a restart). Every
      // response carries a generationId by protocol contract.
      if (msg.generationId !== generationId) {
        this.diagnosticsState.lateResponseCount++;
        return;
      }

      if (msg.type === 'execute-result') {
        this.handleExecuteResult(msg);
      } else if (msg.type === 'cancel-result') {
        this.handleCancelResult(msg);
      }
      // init-result / unknown types are ignored here (init is complete).
    };

    // Handle fatal worker errors during execution (e.g., out-of-memory crash).
    worker.onerror = () => {
      this.failGeneration(new UnzenRuntimeError('Worker crashed unexpectedly'));
    };
  }

  /**
   * Terminate current worker and detach its handlers.
   * Does NOT mutate `state` — callers own the state transition.
   */
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
}
