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
 * Lifecycle:
 *   1. Lazy init: Worker is created on first execute() call (not in constructor)
 *   2. Init: Sends 'init' message to load QuickJS Wasm (~100ms, one-time cost)
 *   3. Execute: Sends code+args, receives result via postMessage
 *   4. Dispose: Terminates worker, rejects pending promises
 *
 * Timeout strategy (dual-layer):
 *   - Cooperative: QuickJS setInterruptHandler checks deadline inside Wasm (fast, clean)
 *   - Forced: Worker.terminate() as hard kill with 1.5x buffer (handles stuck Wasm)
 *   - After forced termination, worker is re-created on next execute()
 *
 * Error classification:
 *   - function_error from worker → UnzenFunctionError (no server fallback)
 *   - runtime_error from worker → UnzenRuntimeError (triggers server fallback)
 *   - Worker init failure → UnzenRuntimeError (triggers server fallback)
 *   - Hard timeout → UnzenRuntimeError (triggers server fallback)
 */

import { UnzenFunctionError, UnzenRuntimeError } from '@unzen/shared';
import type { SandboxExecutor } from './quickjs-sandbox';
import type {
  WorkerMessage,
  WorkerResponse,
} from './worker/worker-protocol';

/**
 * Configuration options for WebWorkerSandboxExecutor
 */
export interface WebWorkerSandboxOptions {
  /** URL of the worker script (e.g., '/worker.js') */
  workerUrl: string;

  /** Execution timeout in milliseconds (default: 5000ms for browser-side execution).
   * The worker's QuickJS interrupt handler uses this as the cooperative timeout.
   * A hard kill via Worker.terminate() fires at 1.5x this value. */
  timeout?: number;

  /** Factory for creating Worker instances (injectable for testing).
   * In production, uses `new Worker(url, { type: 'module' })`.
   * In tests, returns a mock Worker. */
  createWorker?: (url: string | URL) => Worker;
}

// Default timeout for browser-side execution (more generous than server's 50ms
// because browser execution includes Wasm overhead)
const DEFAULT_TIMEOUT_MS = 5000;
// Hard kill multiplier — terminate worker at 1.5x the cooperative timeout
const HARD_KILL_MULTIPLIER = 1.5;

/** Counter for generating unique request IDs */
let requestIdCounter = 0;

/**
 * WebWorkerSandboxExecutor - SandboxExecutor implementation using Web Worker + QuickJS Wasm
 */
export class WebWorkerSandboxExecutor implements SandboxExecutor {
  private readonly workerUrl: string;
  private readonly timeout: number;
  private readonly createWorkerFn: (url: string | URL) => Worker;

  private worker: Worker | null = null;
  private initialized = false;
  private disposed = false;
  /** Deduplicates concurrent ensureInitialized() calls */
  private initPromise: Promise<void> | null = null;
  /** Reject function for pending init — called by dispose() to prevent hanging */
  private initReject: ((error: Error) => void) | null = null;

  /** Pending execute promises keyed by requestId */
  private readonly pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    hardKillTimer: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: WebWorkerSandboxOptions) {
    this.workerUrl = options.workerUrl;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    // Default worker factory uses standard Web Worker constructor with ESM type.
    // Injected in tests with mock Worker.
    this.createWorkerFn = options.createWorker ?? ((url) => new Worker(url, { type: 'module' }));
  }

  /**
   * Execute code in the QuickJS Wasm sandbox via Web Worker.
   *
   * @param code - JavaScript code defining a `run` function
   * @param args - Arguments to pass to `run`
   * @returns Function result
   * @throws {UnzenFunctionError} When user code fails (syntax error, runtime error in user code)
   * @throws {UnzenRuntimeError} When sandbox environment fails (init, timeout, terminated)
   */
  async execute(code: string, args: unknown[]): Promise<unknown> {
    if (this.disposed) {
      throw new UnzenRuntimeError('Executor has been disposed. Create a new instance.');
    }

    // Lazy init: create Worker and load QuickJS Wasm on first call
    await this.ensureInitialized();

    // Generate unique request ID for tracking concurrent executions
    const requestId = `req-${++requestIdCounter}`;

    return new Promise<unknown>((resolve, reject) => {
      // Hard kill timer — forced termination at 1.5x cooperative timeout.
      // This catches cases where QuickJS Wasm is stuck (e.g., in a tight C loop
      // that doesn't check the interrupt handler).
      const hardKillTimer = setTimeout(() => {
        // Guard: only act if this request is still pending.
        // If the worker responded at nearly the same tick as the timeout,
        // the request may already be resolved/rejected. Without this guard,
        // terminateAndReset() would kill the worker unnecessarily (H3 fix).
        if (!this.pendingRequests.has(requestId)) return;
        this.pendingRequests.delete(requestId);
        reject(new UnzenRuntimeError(
          `Execution hard timeout (worker terminated after ${Math.round(this.timeout * HARD_KILL_MULTIPLIER)}ms)`,
        ));
        // Terminate and recreate worker (it's in an unknown state after timeout)
        this.terminateAndReset();
      }, this.timeout * HARD_KILL_MULTIPLIER);

      this.pendingRequests.set(requestId, { resolve, reject, hardKillTimer });

      // Send execute message to worker
      this.worker!.postMessage({
        type: 'execute',
        requestId,
        code,
        args,
        timeout: this.timeout,
      } satisfies WorkerMessage);
    });
  }

  /**
   * Clean up resources — terminate Web Worker and reject pending promises.
   * Idempotent (safe to call multiple times).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.hardKillTimer);
      pending.reject(new UnzenRuntimeError('Executor disposed while execution was pending'));
    }
    this.pendingRequests.clear();

    // Reject pending init if in progress (C2 fix: dispose during ensureInitialized)
    if (this.initReject) {
      this.initReject(new UnzenRuntimeError('Executor disposed during initialization'));
      this.initReject = null;
    }

    // Terminate worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
  }

  /**
   * Ensure Worker is created and QuickJS Wasm is loaded.
   * Called on first execute() — subsequent calls are no-ops.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.worker) return;

    // Deduplicate concurrent init calls — second+ callers wait on the same promise
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInit();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  /** Actual init logic — creates Worker and waits for QuickJS Wasm to load */
  private doInit(): Promise<void> {
    // Create worker
    this.worker = this.createWorkerFn(this.workerUrl);

    // Send init message and wait for response
    return new Promise<void>((resolve, reject) => {
      // Track reject for dispose() to call if init is still in progress (C2 fix)
      this.initReject = reject;

      // Handle fatal worker errors (script load failure, CSP violation, Wasm compile crash).
      // Without this handler, the init promise would hang silently until dispose() or timeout.
      // Review finding H2: missing onerror handler caused silent failures.
      this.worker!.onerror = (event: ErrorEvent) => {
        this.initReject = null;
        this.worker?.terminate();
        this.worker = null;
        reject(new UnzenRuntimeError(
          `Worker error during initialization: ${event.message ?? 'unknown error'}`,
        ));
      };

      // Set onmessage handler to capture init-result
      this.worker!.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'init-result') {
          if (msg.success) {
            this.initialized = true;
            this.initReject = null; // Init succeeded, no longer need reject tracking
            // After successful init, switch to execute message handler
            this.setupMessageHandler();
            resolve();
          } else {
            this.initReject = null;
            // Clean up failed worker
            this.worker?.terminate();
            this.worker = null;
            reject(new UnzenRuntimeError(
              msg.error ?? 'QuickJS Wasm initialization failed',
            ));
          }
        }
      };

      this.worker!.postMessage({ type: 'init' } satisfies WorkerMessage);
    });
  }

  /**
   * Set up the message handler for execute responses.
   * Routes responses to pending promises by requestId.
   */
  private setupMessageHandler(): void {
    if (!this.worker) return;

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;

      if (msg.type !== 'execute-result') return;

      const pending = this.pendingRequests.get(msg.requestId);
      if (!pending) return; // Response for unknown request (already timed out or disposed)

      // Clear hard kill timer — worker responded before forced termination
      clearTimeout(pending.hardKillTimer);
      this.pendingRequests.delete(msg.requestId);

      if (msg.success) {
        pending.resolve(msg.value);
      } else {
        // Classify error based on errorType from worker
        if (msg.errorType === 'runtime_error') {
          pending.reject(new UnzenRuntimeError(msg.error ?? 'Runtime error'));
        } else {
          pending.reject(new UnzenFunctionError(msg.error ?? 'Function error'));
        }
      }
    };

    // Handle fatal worker errors during execution (e.g., out-of-memory crash).
    // Rejects all pending requests so callers don't hang forever.
    // Review finding H2: missing onerror caused silent hangs on worker crash.
    this.worker.onerror = () => {
      // Reject all pending requests — worker is in an unknown state
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.hardKillTimer);
        pending.reject(new UnzenRuntimeError('Worker crashed unexpectedly'));
      }
      this.pendingRequests.clear();
      this.terminateAndReset();
    };
  }

  /**
   * Terminate current worker and reset state for re-creation on next execute().
   * Called after hard timeout when worker is in an unknown state.
   */
  private terminateAndReset(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.initialized = false;
  }
}
