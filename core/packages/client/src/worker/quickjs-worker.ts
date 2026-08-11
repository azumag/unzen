/**
 * QuickJS Web Worker - Browser-side sandboxed JavaScript execution
 *
 * This script runs inside a Web Worker, providing the 4-layer isolation model:
 *   Layer 1: Web Worker (separate thread, no DOM access)
 *   Layer 2: Wasm sandbox (memory isolation from host)
 *   Layer 3: QuickJS interpreter (separate JS engine, no V8 access)
 *   Layer 4: API restrictions (no eval/Function/Proxy/Reflect, frozen prototypes)
 *
 * Execution flow per message:
 *   1. Create fresh QuickJS context (isolation per execution)
 *   2. Set memory limit (16MB) and interrupt handler (timeout)
 *   3. Apply security hardening (SANDBOX_SECURITY_INIT from @unzen/shared)
 *   4. Load user code (defines `run` function)
 *   5. Inject arguments via JSON serialization
 *   6. Execute `run(...args)` and require a synchronous materialized result
 *   7. Dispose context (manual memory management required by QuickJS C model)
 *
 * Error classification:
 *   - Security init failure → runtime_error (triggers server fallback)
 *   - Code syntax/load failure → function_error (no fallback, user bug)
 *   - Execution error → function_error (no fallback, user bug)
 *   - Timeout → runtime_error (triggers server fallback)
 *   - QuickJS not initialized → runtime_error (triggers server fallback)
 */

import {
  SANDBOX_SECURITY_INIT,
  SANDBOX_SYNCHRONOUS_EXECUTION,
} from '@unzen/shared';
import {
  type WorkerMessage,
  type WorkerResponse,
  createInitResultMessage,
  createExecuteResultMessage,
  createExecuteErrorMessage,
  createCancelResultMessage,
  WORKER_PROTOCOL_VERSION,
} from './worker-protocol';

// Default timeout: 50ms (same as server-side QuickJSRuntime)
const DEFAULT_TIMEOUT_MS = 50;
// Memory limit: 16MB per context (same as server-side QuickJSRuntime)
const MEMORY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Worker state — holds the QuickJS Wasm module singleton and the set of
 * cancelled request ids.
 * Exported for testability (tests inject mock modules).
 */
export interface WorkerState {
  quickJS: QuickJSModule | null;
  /**
   * Request ids that have been cooperatively cancelled via a CancelMessage.
   * The running execution's interrupt handler checks this set so a cancelled
   * request stops computing as soon as the next interrupt point is reached.
   * Created lazily on the first cancel message.
   */
  cancelled?: Set<string>;
  /**
   * Request id of the execution currently running in QuickJS, or null.
   * A CancelMessage that arrives after the execution finished (the event loop
   * was blocked during the synchronous run) is ignored instead of re-adding a
   * completed request id to the cancelled set.
   */
  activeRequestId?: string | null;
}

/**
 * Minimal interface for QuickJS Wasm module (subset of QuickJSWASMModule).
 * Defined here to decouple from quickjs-emscripten-core types in tests.
 */
interface QuickJSModule {
  newContext(): QuickJSContextLike;
}

/** Minimal QuickJS context interface for testability */
interface QuickJSContextLike {
  evalCode(code: string): EvalResult;
  runtime: {
    setMemoryLimit(bytes: number): void;
    setInterruptHandler(handler: () => boolean): void;
  };
  dump(handle: unknown): unknown;
  dispose(): void;
}

/** QuickJS evalCode result — either success (.value) or error (.error) */
interface EvalResult {
  value?: { consume<T>(fn: (handle: unknown) => T): T };
  error?: { consume<T>(fn: (handle: unknown) => T): T };
}

function postRejectedMessage(
  msg: WorkerMessage,
  error: string,
  postMessage: (msg: WorkerResponse) => void,
): void {
  if (msg.type === 'init') {
    postMessage(createInitResultMessage(false, msg.generationId, error));
  } else if (msg.type === 'execute') {
    postMessage(createExecuteErrorMessage(
      msg.requestId,
      'runtime_error',
      error,
      msg.generationId,
    ));
  } else {
    postMessage(createCancelResultMessage(msg.requestId, false, msg.generationId, error));
  }
}

/**
 * Handle a worker message — core logic extracted for testability.
 *
 * @param event - MessageEvent with WorkerMessage data
 * @param state - Mutable worker state (holds QuickJS module reference)
 * @param postMessage - Function to send response back to main thread
 * @param loader - Optional QuickJS Wasm loader (injected in tests)
 */
export async function handleWorkerMessage(
  event: { data: WorkerMessage },
  state: WorkerState,
  postMessage: (msg: WorkerResponse) => void,
  loader?: () => Promise<QuickJSModule>,
): Promise<void> {
  const msg = event.data;

  if (!Number.isSafeInteger(msg.generationId) || msg.generationId < 1) {
    postRejectedMessage(
      msg,
      `malformed generationId: ${String(msg.generationId)}`,
      postMessage,
    );
    return;
  }
  if (msg.protocolVersion !== WORKER_PROTOCOL_VERSION) {
    const error = `protocol version mismatch (got ${String(msg.protocolVersion)}, expected ${WORKER_PROTOCOL_VERSION})`;
    postRejectedMessage(msg, error, postMessage);
    return;
  }

  if (msg.type === 'init') {
    await handleInit(state, postMessage, msg.generationId, loader);
  } else if (msg.type === 'execute') {
    await handleExecute(
      msg.requestId,
      msg.code,
      msg.args,
      msg.timeout,
      msg.generationId,
      state,
      postMessage,
    );
  } else if (msg.type === 'cancel') {
    handleCancel(msg, state, postMessage);
  }
}

/**
 * Initialize QuickJS Wasm module.
 * Called once on first use — subsequent calls are no-ops if already initialized.
 * The generationId is echoed back so the main thread can reject stale init
 * results from old Worker generations.
 */
async function handleInit(
  state: WorkerState,
  postMessage: (msg: WorkerResponse) => void,
  generationId: number,
  loader?: () => Promise<QuickJSModule>,
): Promise<void> {
  try {
    if (!state.quickJS) {
      // Use injected loader (tests) or real Wasm loader (production)
      const load = loader ?? loadQuickJS;
      state.quickJS = await load();
    }
    postMessage(createInitResultMessage(true, generationId));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage(createInitResultMessage(false, generationId, message));
  }
}

/**
 * Record a cooperative cancellation request.
 * The request id is added to the cancelled set, which the running execution's
 * interrupt handler consults. The acknowledgement lets the main thread know
 * the worker received the cancel without needing to force-terminate.
 */
function handleCancel(
  msg: { requestId: string; generationId: number },
  state: WorkerState,
  postMessage: (msg: WorkerResponse) => void,
): void {
  // Only an actively-running request can be cancelled. A cancel for a request
  // that already finished (or has not started) must not be recorded: the main
  // thread already settled it, and a stale id would linger forever.
  if (state.activeRequestId !== msg.requestId) return;
  if (!state.cancelled) state.cancelled = new Set();
  state.cancelled.add(msg.requestId);
  postMessage(createCancelResultMessage(msg.requestId, true, msg.generationId));
}

/**
 * Execute code in a fresh QuickJS context with full security hardening.
 *
 * Creates a new context per execution to ensure complete isolation.
 * Context is always disposed in finally block (QuickJS uses manual memory management).
 */
async function handleExecute(
  requestId: string,
  code: string,
  args: unknown[],
  timeout: number | undefined,
  generationId: number,
  state: WorkerState,
  postMessage: (msg: WorkerResponse) => void,
): Promise<void> {
  // QuickJS must be initialized before execution
  if (!state.quickJS) {
    postMessage(createExecuteErrorMessage(
      requestId,
      'runtime_error',
      'QuickJS not initialized. Send init message first.',
      generationId,
    ));
    return;
  }

  const context = state.quickJS.newContext();
  const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS;

  try {
    // Set memory limit to prevent DoS (same as server: 16MB)
    context.runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);

    // Step 1: Apply security hardening (same code as server-side)
    // This cuts Function constructor chains, removes dangerous globals, freezes prototypes
    const securityResult = context.evalCode(SANDBOX_SECURITY_INIT);
    if (securityResult.error) {
      const error = securityResult.error.consume((handle) => context.dump(handle));
      postMessage(createExecuteErrorMessage(
        requestId,
        'runtime_error',
        `Failed to apply security hardening: ${JSON.stringify(error)}`,
        generationId,
      ));
      return;
    }
    securityResult.value!.consume(() => {});

    // Step 2: Load user code (defines `run` function)
    const loadResult = context.evalCode(code);
    if (loadResult.error) {
      const error = loadResult.error.consume((handle) => context.dump(handle));
      postMessage(createExecuteErrorMessage(
        requestId,
        'function_error',
        `Failed to load function code: ${JSON.stringify(error)}`,
        generationId,
      ));
      return;
    }
    loadResult.value!.consume(() => {});

    // Step 3: Inject arguments via JSON serialization
    // Note: undefined becomes null in JSON (acceptable trade-off)
    const argsJson = JSON.stringify(args);
    const argsResult = context.evalCode(`globalThis.__args__ = ${argsJson}`);
    if (argsResult.error) {
      const error = argsResult.error.consume((handle) => context.dump(handle));
      postMessage(createExecuteErrorMessage(
        requestId,
        'runtime_error',
        `Failed to inject arguments: ${JSON.stringify(error)}`,
        generationId,
      ));
      return;
    }
    argsResult.value!.consume(() => {});

    // Step 4: Set timeout via interrupt handler
    // QuickJS checks this periodically during execution. The handler also
    // returns true when the request has been cooperatively cancelled, so a
    // cancelled execution unwinds at the next interrupt point instead of
    // running to completion.
    //
    // NOTE: while `evalCode` runs synchronously the worker's event loop is
    // blocked, so a CancelMessage cannot be dispatched mid-loop. This check
    // only helps when the cancel was registered before execution began (or
    // between steps); cancelling a CPU-bound running request is handled on
    // the main thread via the cancel-ack timeout and force-termination.
    const startTime = Date.now();
    let timeoutTriggered = false;
    let cancelledTriggered = false;
    state.activeRequestId = requestId;
    context.runtime.setInterruptHandler(() => {
      const isCancelled = state.cancelled?.has(requestId) ?? false;
      const exceeded = Date.now() - startTime > effectiveTimeout;
      if (isCancelled) cancelledTriggered = true;
      if (exceeded) timeoutTriggered = true;
      return isCancelled || exceeded;
    });

    // Step 6: Execute run() and reject deferred or iterator results
    const execResult = context.evalCode(SANDBOX_SYNCHRONOUS_EXECUTION);
    if (execResult.error) {
      const error = execResult.error.consume((handle) => context.dump(handle));

      // Cancellation is reported distinctly (the main thread turns it into
      // UnzenCancelledError; it must NOT trigger server fallback).
      if (cancelledTriggered) {
        postMessage(createExecuteErrorMessage(
          requestId,
          'runtime_error',
          'Execution cancelled',
          generationId,
        ));
        return;
      }

      // Timeout errors are runtime errors (trigger fallback)
      if (timeoutTriggered || JSON.stringify(error).includes('interrupted')) {
        postMessage(createExecuteErrorMessage(
          requestId,
          'deadline_exceeded',
          `Execution timeout exceeded (${effectiveTimeout}ms)`,
          generationId,
        ));
        return;
      }

      // All other execution errors are function errors (no fallback)
      postMessage(createExecuteErrorMessage(
        requestId,
        'function_error',
        `Function execution failed: ${JSON.stringify(error)}`,
        generationId,
      ));
      return;
    }

    // Step 6: Extract result value
    const value = execResult.value!.consume((handle) => context.dump(handle));
    postMessage(createExecuteResultMessage(requestId, value, generationId));
  } finally {
    // Always dispose context — QuickJS uses manual memory management (C model)
    context.dispose();
    // Prune the cancelled-set entry for this request so a long-lived worker
    // does not accumulate stale request ids.
    state.cancelled?.delete(requestId);
    // No request is executing anymore; a later CancelMessage for this id is
    // stale and must be ignored (see handleCancel).
    if (state.activeRequestId === requestId) {
      state.activeRequestId = null;
    }
  }
}

/**
 * Load QuickJS Wasm module from the browser-optimized singlefile variant.
 * This is the production loader — tests inject a mock instead.
 */
async function loadQuickJS(): Promise<QuickJSModule> {
  // Dynamic import to avoid bundling issues in test environment.
  // The singlefile variant embeds the Wasm binary as base64 in the JS file,
  // so no separate .wasm file needs to be served.
  const { newQuickJSWASMModuleFromVariant } = await import('quickjs-emscripten-core');
  const { default: variant } = await import('@jitl/quickjs-singlefile-browser-release-sync');
  return await newQuickJSWASMModuleFromVariant(variant);
}

// ============================================================
// Worker entry point — only activates when running as a real Web Worker
// (not when imported as a module in tests)
// ============================================================

// Check if we're running in a Web Worker context (self.onmessage is available)
// Tests import this module directly and call handleWorkerMessage() without this
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  const workerState: WorkerState = { quickJS: null };

  self.onmessage = (event: MessageEvent<WorkerMessage>) => {
    // Top-level try/catch to prevent unhandled exceptions from crashing the worker.
    // Any unexpected error is reported back as a runtime_error so the main thread
    // can handle it gracefully (e.g., fallback to server).
    handleWorkerMessage(event, workerState, self.postMessage.bind(self))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        // Attempt to send error back; if this also fails, there's nothing we can do
        try {
          const msg = event.data;
          const requestId = msg.type === 'execute' ? msg.requestId : undefined;
          if (requestId) {
            self.postMessage(createExecuteErrorMessage(
              requestId,
              'runtime_error',
              message,
              msg.generationId,
            ));
          } else {
            self.postMessage(createInitResultMessage(false, msg.generationId, message));
          }
        } catch {
          // Last resort: log to console (worker console is visible in DevTools)
          console.error('[unzen-worker] Unrecoverable error:', message);
        }
      });
  };
}
