/**
 * UnzenClient - Main client SDK
 *
 * Entry point for executing functions in the unzen core framework.
 * Orchestrates manifest fetching, code loading, sandbox execution,
 * and fallback to server.
 *
 * Execution modes:
 * - development: Always use server fallback (fast iteration)
 * - production: Try browser execution, fallback on runtime error
 * - browser-only: Browser execution only, no fallback
 *
 * Execution flow (production mode):
 * 1. Fetch manifest to get function metadata
 * 2. Fetch function code from URL
 * 3. Execute in browser sandbox
 * 4. If UnzenRuntimeError → fallback to server
 * 5. If UnzenFunctionError → throw immediately (no fallback)
 * 6. If UnzenCancelledError → cancel immediately (no fallback)
 *
 * Execution lifecycle (issue #105):
 * - `execute(request)` / `executeWithDiagnostics(request)` accept an explicit
 *   request object with an AbortSignal and an onEvent listener, exposing the
 *   full lifecycle (manifest/code fetch → browser attempt → fallback → result)
 *   instead of only the final outcome.
 * - A single AbortSignal propagates through manifest/code fetch, the sandbox
 *   executor, and server fallback. User cancellation is surfaced as
 *   UnzenCancelledError and NEVER triggers server fallback.
 * - Diagnostics keep a per-attempt chain (browser + server) with outcomes and
 *   error codes, so the caller can see why and where a fallback happened.
 * - `dispose()` rejects new executions and cancels in-flight ones so no
 *   promise is left unsettled.
 *
 * Design rationale:
 * - Development mode speeds up iteration (no browser execution overhead)
 * - Production mode optimizes for performance (browser execution is faster)
 * - Browser-only mode for scenarios where server is unavailable
 * - Function errors don't fallback (user code bugs should be fixed, not masked)
 * - Runtime errors fallback (environment issues are recoverable)
 * - Cancellation is a deliberate caller decision — it never falls back
 */

import {
  MAX_EXECUTION_ARGUMENTS,
  UnzenCancelledError,
  UnzenDeadlineExceededError,
  UnzenFunctionError,
  UnzenNetworkError,
  UnzenRuntimeError,
  isValidFunctionName,
  type FunctionManifestEntry,
} from '@unzen/shared';
import { FallbackHandler } from './fallback-handler';
import { ManifestFetcher } from './manifest-fetcher';
import { CodeFetcher } from './code-fetcher';
import type { SandboxExecutor } from './sandbox-executor';
import { WebWorkerSandboxExecutor } from './web-worker-sandbox';
import { MoonBitSandboxExecutor } from './moonbit-sandbox';
import { MoonBitWorkerSandboxExecutor } from './moonbit-worker-sandbox';
import type { MoonBitImportedStringConstants } from './moonbit-compile-options';
import { normalizeUnzenClientOptions } from './unzen-client-options';
import { raceWithAbort, readAbortSignalAborted, subscribeToAbortSignal } from './abort';

/**
 * Diagnostic metadata returned with successful callWithDiagnostics() calls.
 * Provides transparency about where, how fast, and whether caching was used.
 *
 * @deprecated Use executeWithDiagnostics()'s ExecutionDiagnostics (issue #105).
 *   Kept for backwards compatibility with callWithDiagnostics().
 */
export interface DiagnosticInfo {
  /** Where the function was executed: browser sandbox or server fallback */
  executedOn: 'browser' | 'server';
  /** Total execution time in milliseconds (includes fetch + sandbox/server time) */
  durationMs: number;
  /** Whether the manifest was already cached when this call was made */
  cached: boolean;
}

/**
 * Partial diagnostic info included with error results.
 * Always includes durationMs and cached (measurable regardless of success/failure).
 * executedOn is included when we know where the error occurred.
 *
 * @deprecated Use executeWithDiagnostics()'s ExecutionDiagnostics (issue #105).
 */
export interface PartialDiagnosticInfo {
  /** Where the error occurred, if determinable */
  executedOn?: 'browser' | 'server';
  /** Total time from call start to error, in milliseconds */
  durationMs: number;
  /** Whether the manifest was already cached when this call was made */
  cached: boolean;
}

/**
 * Diagnostic result type for callWithDiagnostics
 *
 * Success case: { success: true, result: T, diagnostics: DiagnosticInfo }
 * Error case: { success: false, error: {type, message}, diagnostics: PartialDiagnosticInfo }
 *
 * @deprecated Use executeWithDiagnostics() (issue #105).
 */
export type DiagnosticResult<T = unknown> =
  | { success: true; result: T; diagnostics: DiagnosticInfo; error?: never }
  | { success: false; result?: never; error: { type: string; message: string }; diagnostics: PartialDiagnosticInfo };

// ============================================================
// issue #105 — explicit execution request / events / diagnostics
// ============================================================

/**
 * Explicit execution request.
 *
 * Kept unambiguous: function arguments are arbitrary objects, so the trailing
 * argument is never silently treated as options.
 */
export interface UnzenExecutionRequest {
  /** Function name */
  name: string;
  /** Function arguments */
  args: unknown[];
  /** Optional AbortSignal that cancels the whole execution (fetch → sandbox → fallback) */
  signal?: AbortSignal;
  /** Optional lifecycle event listener */
  onEvent?: (event: UnzenExecutionEvent) => void;
}

interface NormalizedExecutionRequest {
  readonly name: string;
  readonly args: unknown[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: UnzenExecutionEvent) => void;
}

type ExecutionRequestNormalization =
  | { ok: true; request: NormalizedExecutionRequest }
  | { ok: false; error: UnzenFunctionError };

/** Fields every execution event carries */
export interface UnzenExecutionEventBase {
  /** Unique id for this execution */
  executionId: string;
  /** Monotonic sequence within the execution (1, 2, 3, …) */
  sequence: number;
  /** Epoch millisecond timestamp */
  timestamp: number;
}

/**
 * Execution lifecycle events (discriminated union).
 *
 * Exactly one terminal event is emitted per execution:
 * - `completed` — a result was produced
 * - `cancelled` — the caller cancelled (or dispose() cancelled the client)
 * - `failed` — a non-cancellation failure ended the execution
 *
 * Event payloads deliberately exclude args/result bodies and raw stack traces
 * to avoid leaking sensitive data to listeners.
 */
export type UnzenExecutionEvent =
  | (UnzenExecutionEventBase & { type: 'accepted' })
  | (UnzenExecutionEventBase & { type: 'manifest-fetch-started' })
  | (UnzenExecutionEventBase & { type: 'manifest-fetch-completed' })
  | (UnzenExecutionEventBase & { type: 'code-fetch-started' })
  | (UnzenExecutionEventBase & { type: 'code-fetch-completed' })
  | (UnzenExecutionEventBase & { type: 'sandbox-initializing' })
  | (UnzenExecutionEventBase & { type: 'browser-execution-started' })
  | (UnzenExecutionEventBase & { type: 'browser-execution-failed' })
  | (UnzenExecutionEventBase & { type: 'fallback-started' })
  | (UnzenExecutionEventBase & { type: 'server-execution-started' })
  | (UnzenExecutionEventBase & { type: 'completed' })
  | (UnzenExecutionEventBase & { type: 'cancel-requested' })
  | (UnzenExecutionEventBase & { type: 'cancelled' })
  | (UnzenExecutionEventBase & { type: 'failed'; errorCode: string });

/** Per-attempt diagnostic entry in an execution's attempt chain */
export interface ExecutionAttemptDiagnostic {
  kind: 'browser' | 'server';
  startedAt: number;
  durationMs: number;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  errorCode?: ExecutionErrorCode;
}

/** Rich diagnostics for an execution (issue #105 §3) */
export interface ExecutionDiagnostics {
  executionId: string;
  /** Where the final result came from, if one was produced */
  finalRoute?: 'browser' | 'server';
  /** Last phase an execution attempt was started in (also on failure) */
  lastAttemptedOn?: 'browser' | 'server';
  /** Whether the browser attempt failed and a server fallback was used */
  fallbackUsed: boolean;
  /** Attempt chain: browser failure + server fallback are both recorded */
  attempts: ExecutionAttemptDiagnostic[];
  /** Total wall time of the execution in milliseconds */
  totalDurationMs: number;
  /** Manifest cache status at the start of the execution ('unknown' when the
   * runtime did not report it, e.g. a legacy/malformed diagnostics object) */
  manifestCache: 'hit' | 'miss' | 'unknown';
}

/** Result of executeWithDiagnostics() */
export type ExecutionDiagnosticResult<T = unknown> =
  | { success: true; result: T; diagnostics: ExecutionDiagnostics; error?: never }
  | { success: false; result?: never; error: { code: ExecutionErrorCode; message: string }; diagnostics: ExecutionDiagnostics };

/**
 * Stable error codes (issue #105 §5).
 * Routing and UI state must be derived from these codes, never by parsing
 * message strings.
 */
export type ExecutionErrorCode =
  | 'cancelled'
  | 'manifest_fetch_failed'
  | 'code_fetch_failed'
  | 'browser_runtime_failed'
  | 'deadline_exceeded'
  | 'function_failed'
  | 'server_fallback_failed'
  | 'server_network_failed'
  | 'client_disposed';

/** Execution phase used to classify errors into stable codes */
type Phase = 'none' | 'manifest' | 'code' | 'browser' | 'server';

/** Event payload without the execution envelope fields (filled in per execution) */
type EmittableEvent =
  | { type: 'accepted' }
  | { type: 'manifest-fetch-started' }
  | { type: 'manifest-fetch-completed' }
  | { type: 'code-fetch-started' }
  | { type: 'code-fetch-completed' }
  | { type: 'sandbox-initializing' }
  | { type: 'browser-execution-started' }
  | { type: 'browser-execution-failed' }
  | { type: 'fallback-started' }
  | { type: 'server-execution-started' }
  | { type: 'completed' }
  | { type: 'cancel-requested' }
  | { type: 'cancelled' }
  | { type: 'failed'; errorCode: ExecutionErrorCode };

/**
 * Classify an error into a stable code for the given phase.
 * Cancellation and function errors win over phase-specific codes.
 */
function classifyError(error: Error, phase: Phase): ExecutionErrorCode {
  if (error instanceof UnzenCancelledError) return 'cancelled';
  if (error instanceof UnzenFunctionError) return 'function_failed';
  if (error instanceof UnzenDeadlineExceededError) return 'deadline_exceeded';
  switch (phase) {
    case 'none': return 'client_disposed';
    case 'manifest': return 'manifest_fetch_failed';
    case 'code': return 'code_fetch_failed';
    case 'browser': return 'browser_runtime_failed';
    case 'server': return error instanceof UnzenNetworkError
      ? 'server_network_failed'
      : 'server_fallback_failed';
  }
}

/**
 * Client configuration options
 */
export interface UnzenClientOptions {
  /**
   * Server endpoint URL (e.g., "https://example.com")
   */
  endpoint: string;

  /**
   * Execution mode
   * - production: Try browser, fallback to server (default)
   * - development: Always use server (fast iteration)
   * - browser-only: Browser only, no fallback
   */
  mode?: 'production' | 'development' | 'browser-only';

  /**
   * URL to the QuickJS worker script (e.g., '/worker.js').
   * When provided, uses WebWorkerSandboxExecutor for browser-side execution
   * with 4-layer isolation (Web Worker + Wasm + QuickJS + API restrictions).
   * When omitted, a custom SandboxExecutor must be provided via `sandbox`.
   */
  workerUrl?: string;

  /**
   * Custom SandboxExecutor instance (advanced usage).
   * Takes precedence over workerUrl if both are provided.
   * Allows injecting custom sandbox implementations for testing or
   * alternative isolation strategies.
   */
  sandbox?: SandboxExecutor;

  /**
   * MoonBit wasm-gc SandboxExecutor (defaults to MoonBitSandboxExecutor).
   * Used when the manifest entry declares runtime 'moonbit'. Override for
   * testing or alternative wasm runtimes.
   */
  moonbitSandbox?: SandboxExecutor;

  /**
   * URL of the MoonBit worker script (e.g. '/moonbit-worker.js'). When set,
   * MoonBit functions execute in a dedicated Web Worker via
   * MoonBitWorkerSandboxExecutor instead of on the main thread. Takes
   * precedence over the main-thread MoonBitSandboxExecutor default; an
   * explicit `moonbitSandbox` override wins over both.
   */
  moonbitWorkerUrl?: string;

  /**
   * Namespace configured by MoonBit's `imported-string-constants` option.
   * Defaults to `_`; set `null` for modules that do not use imported string
   * constants. Applied to the built-in main-thread and worker executors.
   */
  moonbitImportedStringConstants?: MoonBitImportedStringConstants;
}

/** Default untyped schema used when no generated function map is supplied. */
export type UnzenFunctionMap = Record<string, (...args: unknown[]) => unknown>;

type UnzenFunctionArgs<Definition> = Definition extends (
  ...args: infer Args
) => unknown ? Args : never;

type UnzenFunctionResult<Definition> = Definition extends (
  ...args: infer _Args
) => infer Result ? Awaited<Result> : never;

/** Counter for generating unique execution ids */
let executionIdCounter = 0;

/**
 * UnzenClient - Main SDK class
 *
 * Usage:
 * ```typescript
 * const client = new UnzenClient({ endpoint: 'https://example.com', workerUrl: '/worker.js' });
 * const result = await client.call('add', 1, 2);
 * // or with lifecycle + cancellation:
 * const controller = new AbortController();
 * const result = await client.execute({ name: 'add', args: [1, 2], signal: controller.signal });
 * client.dispose();
 * ```
 */
export class UnzenClient<Functions = UnzenFunctionMap> {
  private readonly endpoint: string;
  private readonly mode: 'production' | 'development' | 'browser-only';

  // Components
  private readonly fallbackHandler: FallbackHandler;
  private readonly manifestFetcher: ManifestFetcher;
  private readonly codeFetcher: CodeFetcher;
  private readonly sandboxExecutor: SandboxExecutor;
  /** MoonBit wasm-gc executor — used for functions with runtime 'moonbit' */
  private readonly moonbitSandbox: SandboxExecutor;

  // Disposal tracking
  private disposed = false;

  /** Internal AbortControllers of in-flight executions — dispose() aborts them all */
  private readonly inFlightControllers = new Set<AbortController>();

  constructor(options: UnzenClientOptions) {
    const normalized = normalizeUnzenClientOptions(options);
    this.endpoint = normalized.endpoint;
    this.mode = normalized.mode;

    // Initialize components
    this.fallbackHandler = new FallbackHandler(this.endpoint);
    this.manifestFetcher = new ManifestFetcher(this.endpoint);
    this.codeFetcher = new CodeFetcher(this.endpoint);
    if (normalized.moonbitSandbox.kind === 'custom') {
      this.moonbitSandbox = normalized.moonbitSandbox.executor;
    } else if (normalized.moonbitSandbox.kind === 'worker') {
      // Dedicated worker execution: MoonBit exports never block the main
      // thread, and timeouts/cancellation terminate the worker.
      this.moonbitSandbox = new MoonBitWorkerSandboxExecutor({
        workerUrl: normalized.moonbitSandbox.workerUrl,
        importedStringConstants: normalized.moonbitSandbox.importedStringConstants,
      });
    } else {
      this.moonbitSandbox = new MoonBitSandboxExecutor({
        importedStringConstants: normalized.moonbitSandbox.importedStringConstants,
      });
    }

    // Select sandbox executor: explicit sandbox > workerUrl > error
    // - options.sandbox: Custom executor (advanced usage / testing)
    // - options.workerUrl: WebWorkerSandboxExecutor with 4-layer isolation (production)
    // - error: No fallback — workerUrl or sandbox must be provided
    if (normalized.sandbox.kind === 'custom') {
      this.sandboxExecutor = normalized.sandbox.executor;
    } else {
      this.sandboxExecutor = new WebWorkerSandboxExecutor({
        workerUrl: normalized.sandbox.workerUrl,
      });
    }
  }

  /**
   * Call a function (compatibility wrapper, no signal/events).
   *
   * A finite generated schema selects the first overload and constrains the
   * function name, arguments, and result. The conditional fallback overload is
   * callable only when Functions has the default string index signature. This
   * preserves legacy `call<Result>(name, ...args)` usage for untyped clients
   * without letting a typed client bypass its generated contract.
   *
   * @param name - Function name
   * @param args - Function arguments
   * @returns Function result
   * @throws {UnzenFunctionError} When function execution fails
   * @throws {UnzenRuntimeError} When runtime error occurs (browser-only mode)
   * @throws {UnzenCancelledError} When the execution is cancelled
   */
  async call<Name extends Extract<keyof Functions, string>>(
    name: Name,
    ...args: UnzenFunctionArgs<Functions[Name]>
  ): Promise<UnzenFunctionResult<Functions[Name]>>;
  async call<T = unknown>(
    name: string extends keyof Functions ? string : never,
    ...args: string extends keyof Functions ? unknown[] : never
  ): Promise<T>;
  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    return this.execute<T>({ name, args });
  }

  /**
   * Call a function with legacy diagnostics (compatibility wrapper).
   * Returns the issue-#105 richer result via executeWithDiagnostics and maps
   * it to the old DiagnosticResult shape.
   */
  async callWithDiagnostics<T = unknown>(
    name: string,
    ...args: unknown[]
  ): Promise<DiagnosticResult<T>> {
    const result = await this.executeWithDiagnostics<T>({ name, args });

    const durationMs = result.diagnostics.totalDurationMs;
    const cached = result.diagnostics.manifestCache === 'hit';

    if (result.success) {
      // On success an attempt was necessarily made, so lastAttemptedOn is set.
      return {
        success: true,
        result: result.result,
        diagnostics: {
          executedOn: result.diagnostics.lastAttemptedOn!,
          durationMs,
          cached,
        },
      };
    }

    return {
      success: false,
      error: { type: mapToLegacyErrorType(result.error.code), message: result.error.message },
      diagnostics: {
        executedOn: result.diagnostics.lastAttemptedOn,
        durationMs,
        cached,
      },
    };
  }

  /**
   * Execute a function with explicit request options (issue #105).
   *
   * @param request - Function name, args, optional AbortSignal and onEvent
   * @returns Function result
   * @throws {UnzenFunctionError} When function execution fails
   * @throws {UnzenCancelledError} When the caller aborts via request.signal
   * @throws {UnzenRuntimeError} When runtime error occurs (browser-only mode)
   */
  async execute<T = unknown>(request: UnzenExecutionRequest): Promise<T> {
    const outcome = await this.runExecution<T>(request);
    if (outcome.ok) {
      return outcome.result as T;
    }
    throw outcome.error;
  }

  /**
   * Execute a function with lifecycle events and rich diagnostics (issue #105).
   *
   * Never throws — failures are captured in the returned result with a stable
   * error code and the full attempt chain.
   */
  async executeWithDiagnostics<T = unknown>(
    request: UnzenExecutionRequest,
  ): Promise<ExecutionDiagnosticResult<T>> {
    const outcome = await this.runExecution<T>(request);

    if (outcome.ok) {
      return {
        success: true,
        result: outcome.result as T,
        diagnostics: {
          executionId: outcome.executionId,
          finalRoute: outcome.finalRoute,
          lastAttemptedOn: outcome.lastAttemptedOn,
          fallbackUsed: outcome.fallbackUsed,
          attempts: outcome.attempts,
          totalDurationMs: outcome.totalDurationMs,
          manifestCache: outcome.manifestCache,
        },
      };
    }

    return {
      success: false,
      error: { code: outcome.errorCode, message: outcome.error!.message },
      diagnostics: {
        executionId: outcome.executionId,
        finalRoute: outcome.finalRoute,
        lastAttemptedOn: outcome.lastAttemptedOn,
        fallbackUsed: outcome.fallbackUsed,
        attempts: outcome.attempts,
        totalDurationMs: outcome.totalDurationMs,
        manifestCache: outcome.manifestCache,
      },
    };
  }

  /**
   * Clean up resources
   *
   * Rejects new executions, cancels all in-flight executions (settling their
   * promises), then releases the sandbox executor.
   * Idempotent (safe to call multiple times).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Cancel every in-flight execution so no pending promise is left unsettled.
    // Each execution observes the abort and settles as cancelled.
    for (const controller of this.inFlightControllers) {
      controller.abort();
    }
    this.inFlightControllers.clear();

    // Attempt every distinct executor even when caller-owned cleanup throws.
    let disposeError: unknown;
    try {
      this.sandboxExecutor.dispose();
    } catch (error) {
      disposeError = error;
    }
    if (this.moonbitSandbox !== this.sandboxExecutor) {
      try {
        this.moonbitSandbox.dispose();
      } catch (error) {
        disposeError ??= error;
      }
    }
    if (disposeError !== undefined) throw disposeError;
  }

  /**
   * Run an execution end-to-end and return the raw outcome.
   *
   * This is the single pipeline shared by execute() (throw path) and
   * executeWithDiagnostics() (result path). It records lifecycle events and
   * the per-attempt diagnostic chain as it goes.
   */
  private async runExecution<T>(
    requestValue: UnzenExecutionRequest,
  ): Promise<RunExecutionOutcome<T>> {
    const executionId = `exec-${++executionIdCounter}`;
    const startedAt = performance.now();
    const wasManifestCached = this.manifestFetcher.isCached();
    const normalized = normalizeExecutionRequest(requestValue);

    if (!normalized.ok) {
      return {
        ok: false,
        error: normalized.error,
        errorCode: 'function_failed',
        executionId,
        fallbackUsed: false,
        attempts: [],
        totalDurationMs: performance.now() - startedAt,
        manifestCache: wasManifestCached ? 'hit' : 'miss',
      };
    }

    const request = normalized.request;

    let sequence = 0;
    let terminalEmitted = false;
    const attempts: ExecutionAttemptDiagnostic[] = [];
    let finalRoute: 'browser' | 'server' | undefined;
    // Last phase an execution attempt was started in — used by the legacy
    // callWithDiagnostics mapping (executedOn must reflect where the error
    // occurred, not just where a result was produced).
    let lastAttemptedOn: 'browser' | 'server' | undefined;
    let fallbackUsed = false;
    // Set when `cancel-requested` is emitted (or the internal signal aborts).
    // Once set, no new phase event may be emitted — only the terminal
    // `cancelled` may follow (issue #105 AC: cancel is final).
    let cancellationRequested = false;

    // Emit an event, guarding against terminal-event duplicates and listener
    // exceptions (a throwing listener must not break the execution pipeline).
    const emit = (event: EmittableEvent) => {
      // Nothing may be emitted after a terminal event, and after a cancellation
      // request only the terminal `cancelled` may be emitted. A listener can
      // abort the run synchronously inside an emit() call, so the flag is set
      // before the listener runs to keep re-entrant emits suppressed.
      if (terminalEmitted || (cancellationRequested && event.type !== 'cancelled')) {
        return;
      }
      const fullEvent = {
        ...event,
        executionId,
        sequence: ++sequence,
        timestamp: Date.now(),
      } as UnzenExecutionEvent;
      if (event.type === 'cancel-requested') {
        cancellationRequested = true;
      }
      if (
        event.type === 'completed'
        || event.type === 'cancelled'
        || event.type === 'failed'
      ) {
        terminalEmitted = true;
        cancellationRequested = true;
      }
      try {
        request.onEvent?.(fullEvent);
      } catch {
        // Listener errors are isolated — they must not corrupt execution state.
      }
    };

    const pushAttempt = (
      kind: 'browser' | 'server',
      attemptStartedAt: number,
      outcome: ExecutionAttemptDiagnostic['outcome'],
      errorCode?: ExecutionErrorCode,
    ): void => {
      attempts.push({
        kind,
        startedAt: attemptStartedAt,
        durationMs: performance.now() - attemptStartedAt,
        outcome,
        errorCode,
      });
    };

    // Build the shared diagnostics snapshot at completion.
    const buildOutcome = (
      ok: boolean,
      result?: T,
      error?: Error,
      errorCode?: ExecutionErrorCode,
    ): RunExecutionOutcome<T> => ({
      ok,
      result,
      error,
      errorCode: errorCode ?? 'client_disposed',
      executionId,
      finalRoute,
      lastAttemptedOn,
      fallbackUsed,
      attempts,
      totalDurationMs: performance.now() - startedAt,
      manifestCache: wasManifestCached ? 'hit' : 'miss',
    });

    // Emit the terminal `cancelled` event and build a cancelled outcome.
    // Used whenever the internal signal is (or becomes) aborted so no late
    // result can be committed as success (issue #105 AC #5).
    const cancelledOutcome = (): RunExecutionOutcome<T> => {
      emit({ type: 'cancelled' });
      return buildOutcome(
        false,
        undefined,
        new UnzenCancelledError('Execution cancelled by caller'),
        'cancelled',
      );
    };

    // Internal AbortController: dispose() aborts every in-flight controller,
    // and the caller's signal is forwarded onto it, so one cancellation path
    // covers both dispose and caller abort.
    const internalController = new AbortController();
    this.inFlightControllers.add(internalController);
    let removeCallerAbortListener: (() => void) | undefined;

    const forwardAbort = () => {
      emit({ type: 'cancel-requested' });
      internalController.abort();
    };

    try {
      // Caller signal forwarding (removed on completion).
      if (request.signal) {
        try {
          if (readAbortSignalAborted(request.signal)) {
            return cancelledOutcome();
          }
          removeCallerAbortListener = subscribeToAbortSignal(request.signal, forwardAbort);
          // subscribeToAbortSignal closes the check/listen race and may invoke
          // forwardAbort synchronously before returning.
          if (internalController.signal.aborted) {
            return cancelledOutcome();
          }
        } catch {
          // A structural signal can notify abort and then throw from its
          // registration method. Caller cancellation remains authoritative.
          if (internalController.signal.aborted) {
            return cancelledOutcome();
          }
          const error = invalidExecutionRequest('signal could not be subscribed');
          emit({ type: 'failed', errorCode: 'function_failed' });
          return buildOutcome(false, undefined, error, 'function_failed');
        }
      }

      // Reject new executions on a disposed client (terminal event included
      // so an event-driven UI is always told the execution ended).
      if (this.disposed) {
        emit({ type: 'failed', errorCode: 'client_disposed' });
        return buildOutcome(
          false,
          undefined,
          new UnzenRuntimeError('Client has been disposed. Create a new instance.'),
          'client_disposed',
        );
      }

      emit({ type: 'accepted' });
      if (internalController.signal.aborted) {
        // The caller cancelled inside the `accepted` listener — end here.
        return cancelledOutcome();
      }

      // === Development mode: server only ===
      if (this.mode === 'development') {
        // The noFallback contract ("inputs never leave the client") applies in
        // EVERY mode: development mode must not send password/MoonBit inputs
        // to /exec just because it skips the browser. Resolve the manifest
        // metadata first and refuse server execution for noFallback/MoonBit.
        lastAttemptedOn = 'server';
        emit({ type: 'manifest-fetch-started' });
        let devEntry: FunctionManifestEntry | undefined;
        try {
          const manifest = await this.manifestFetcher.fetch(internalController.signal);
          if (internalController.signal.aborted) {
            return cancelledOutcome();
          }
          emit({ type: 'manifest-fetch-completed' });
          if (internalController.signal.aborted) {
            return cancelledOutcome();
          }
          devEntry = Object.hasOwn(manifest.functions, request.name)
            ? manifest.functions[request.name]
            : undefined;
        } catch (error) {
          // Fail CLOSED: unless the manifest proves this is an ordinary
          // server-executable function, inputs must not leave the client. A
          // manifest fetch failure never proceeds to /exec.
          const err = toError(error);
          if (err instanceof UnzenCancelledError || internalController.signal.aborted) {
            return cancelledOutcome();
          }
          emit({ type: 'failed', errorCode: 'manifest_fetch_failed' });
          return buildOutcome(false, undefined, err, 'manifest_fetch_failed');
        }
        if (!devEntry) {
          const err = new UnzenFunctionError(
            `Function "${request.name}" not found in manifest`,
          );
          emit({ type: 'failed', errorCode: 'function_failed' });
          return buildOutcome(false, undefined, err, 'function_failed');
        }
        if (devEntry.noFallback || devEntry.runtime === 'moonbit') {
          const err = new UnzenRuntimeError(
            `Function "${request.name}" requires browser execution (server fallback disabled)`,
          );
          emit({ type: 'failed', errorCode: 'browser_runtime_failed' });
          return buildOutcome(false, undefined, err, 'browser_runtime_failed');
        }

        emit({ type: 'server-execution-started' });
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
        const attemptStart = performance.now();
        try {
          const result = await raceWithAbort(
            this.fallbackHandler.execute(
              request.name,
              request.args,
              internalController.signal,
            ),
            internalController.signal,
          );
          // Guard against a late result committing after cancellation.
          if (internalController.signal.aborted) {
            pushAttempt('server', attemptStart, 'cancelled', 'cancelled');
            return cancelledOutcome();
          }
          pushAttempt('server', attemptStart, 'succeeded');
          finalRoute = 'server';
          emit({ type: 'completed' });
          return buildOutcome(true, result as T);
        } catch (error) {
          const err = toError(error);
          pushAttempt(
            'server',
            attemptStart,
            err instanceof UnzenCancelledError ? 'cancelled' : 'failed',
            classifyError(err, 'server'),
          );
          if (err instanceof UnzenCancelledError || internalController.signal.aborted) {
            return cancelledOutcome();
          }
          emit({ type: 'failed', errorCode: classifyError(err, 'server') });
          return buildOutcome(false, undefined, err, classifyError(err, 'server'));
        }
      }

      // === Browser attempt ===
      // 1. Manifest fetch
      lastAttemptedOn = 'browser';
      emit({ type: 'manifest-fetch-started' });
      let manifest;
      try {
        manifest = await this.manifestFetcher.fetch(internalController.signal);
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
        emit({ type: 'manifest-fetch-completed' });
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
      } catch (error) {
        const err = toError(error);
        if (err instanceof UnzenCancelledError || internalController.signal.aborted) {
          return cancelledOutcome();
        }
        emit({ type: 'failed', errorCode: 'manifest_fetch_failed' });
        return buildOutcome(false, undefined, err, 'manifest_fetch_failed');
      }

      // 2. Function existence check. ManifestFetcher has already validated
      // and snapshotted the response; own-property lookup keeps the boundary
      // explicit even if the cached representation changes later.
      const entry = Object.hasOwn(manifest.functions, request.name)
        ? manifest.functions[request.name]
        : undefined;
      if (!entry) {
        // Function not in manifest is a user error (calling non-existent function)
        const err = new UnzenFunctionError(`Function "${request.name}" not found in manifest`);
        emit({ type: 'failed', errorCode: 'function_failed' });
        return buildOutcome(false, undefined, err, 'function_failed');
      }

      // 3. Code/module fetch
      emit({ type: 'code-fetch-started' });
      let code: string | undefined;
      try {
        if (entry.runtime === 'moonbit') {
          // MoonBit functions are compiled wasm, not JS source: prepare the
          // module (fetch + compile the .wasm from the manifest codeUrl). The
          // executor instance is ready after preparation; the execution itself
          // happens in step 4.
          const preparation = this.moonbitSandbox.prepare?.(
            entry.codeUrl,
            internalController.signal,
            entry.hash,
          );
          if (preparation !== undefined) {
            await raceWithAbort(Promise.resolve(preparation), internalController.signal);
          }
        } else {
          code = await this.codeFetcher.fetch(entry, internalController.signal);
        }
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
        emit({ type: 'code-fetch-completed' });
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
      } catch (error) {
        const err = toError(error);
        if (err instanceof UnzenCancelledError || internalController.signal.aborted) {
          return cancelledOutcome();
        }
        emit({ type: 'failed', errorCode: 'code_fetch_failed' });
        return buildOutcome(false, undefined, err, 'code_fetch_failed');
      }

      // 4. Browser sandbox execution
      // The sandbox may lazily initialize (WebWorkerSandboxExecutor). Surface
      // that state so the UI can show "sandbox initializing" without parsing
      // messages; warm sandboxes (already ready) emit nothing.
      const executor = entry.runtime === 'moonbit' ? this.moonbitSandbox : this.sandboxExecutor;
      let executorReady = true;
      try {
        executorReady = executor.isReady?.() ?? true;
      } catch {
        // Readiness is diagnostic-only; a custom probe must not block execution.
      }
      if (!executorReady) {
        emit({ type: 'sandbox-initializing' });
      }
      emit({ type: 'browser-execution-started' });
      const browserAttemptStart = performance.now();
      try {
        const execution = entry.runtime === 'moonbit'
          ? executor.execute(entry.codeUrl, request.args, {
              signal: internalController.signal,
              exportName: entry.exportName,
              moonbitAbi: entry.moonbitAbi,
              expectedHash: entry.hash,
            })
          : executor.execute(code!, request.args, {
              signal: internalController.signal,
            });
        const result = await raceWithAbort(
          Promise.resolve(execution),
          internalController.signal,
        );
        // A late result after cancellation must never be committed as success.
        if (internalController.signal.aborted) {
          pushAttempt('browser', browserAttemptStart, 'cancelled', 'cancelled');
          return cancelledOutcome();
        }
        pushAttempt('browser', browserAttemptStart, 'succeeded');
        finalRoute = 'browser';
        emit({ type: 'completed' });
        return buildOutcome(true, result as T);
      } catch (error) {
        const err = toError(error);

        // Cancellation is not a failure: emit only the `cancelled` terminal.
        if (err instanceof UnzenCancelledError || internalController.signal.aborted) {
          pushAttempt('browser', browserAttemptStart, 'cancelled', 'cancelled');
          return cancelledOutcome();
        }

        pushAttempt(
          'browser',
          browserAttemptStart,
          'failed',
          classifyError(err, 'browser'),
        );
        emit({ type: 'browser-execution-failed' });

        // The listener may have cancelled the run while the failure was being
        // reported. Cancellation is final: do not start fallback, and do not
        // mark fallbackUsed / finalRoute for a run that never reached the
        // server attempt.
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }

        // Function errors are NOT recovered by fallback
        // Rationale: User code bugs should be fixed, not masked
        if (err instanceof UnzenFunctionError) {
          emit({ type: 'failed', errorCode: 'function_failed' });
          return buildOutcome(false, undefined, err, 'function_failed');
        }

        // Runtime errors in browser-only mode are fatal, and functions marked
        // noFallback (MoonBit wasm-gc, privacy-sensitive inputs) never fall
        // back: the browser error is the final result, and the server never
        // receives the inputs.
        // MoonBit cannot execute on the server at all (QuickJS runtime), so
        // the runtime alone suppresses fallback even when the manifest omits
        // the (optional) noFallback flag.
        if (this.mode === 'browser-only' || entry.noFallback || entry.runtime === 'moonbit') {
          const code = classifyError(err, 'browser');
          emit({ type: 'failed', errorCode: code });
          return buildOutcome(false, undefined, err, code);
        }

        // === Production mode: fallback on runtime error ===
        // Rationale: Environment issues (WASM failure, etc.) are recoverable
        fallbackUsed = true;
        lastAttemptedOn = 'server';
        emit({ type: 'fallback-started' });
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
        emit({ type: 'server-execution-started' });
        if (internalController.signal.aborted) {
          return cancelledOutcome();
        }
        const serverAttemptStart = performance.now();
        try {
          const result = await raceWithAbort(
            this.fallbackHandler.execute(
              request.name,
              request.args,
              internalController.signal,
            ),
            internalController.signal,
          );
          // A late fallback result after cancellation must not commit either.
          if (internalController.signal.aborted) {
            pushAttempt('server', serverAttemptStart, 'cancelled', 'cancelled');
            return cancelledOutcome();
          }
          pushAttempt('server', serverAttemptStart, 'succeeded');
          finalRoute = 'server';
          emit({ type: 'completed' });
          return buildOutcome(true, result as T);
        } catch (serverError) {
          const serverErr = toError(serverError);
          pushAttempt(
            'server',
            serverAttemptStart,
            serverErr instanceof UnzenCancelledError ? 'cancelled' : 'failed',
            classifyError(serverErr, 'server'),
          );
          if (serverErr instanceof UnzenCancelledError || internalController.signal.aborted) {
            return cancelledOutcome();
          }
          emit({ type: 'failed', errorCode: classifyError(serverErr, 'server') });
          return buildOutcome(false, undefined, serverErr, classifyError(serverErr, 'server'));
        }
      }
    } finally {
      // Always deregister: no listener, no in-flight controller survives.
      removeCallerAbortListener?.();
      this.inFlightControllers.delete(internalController);
    }
  }
}

/** Outcome of runExecution shared by execute() and executeWithDiagnostics() */
interface RunExecutionOutcome<T> {
  ok: boolean;
  result?: T;
  error?: Error;
  errorCode: ExecutionErrorCode;
  executionId: string;
  finalRoute?: 'browser' | 'server';
  /** Last phase an attempt was started in (used by legacy diagnostics mapping) */
  lastAttemptedOn?: 'browser' | 'server';
  fallbackUsed: boolean;
  attempts: ExecutionAttemptDiagnostic[];
  totalDurationMs: number;
  manifestCache: 'hit' | 'miss';
}

/** Normalize an unknown thrown value into an Error */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function invalidExecutionRequest(reason: string): UnzenFunctionError {
  return new UnzenFunctionError(`Invalid execution request: ${reason}`);
}

/**
 * Validate and shallow-copy a public execution request before any async work.
 * Indexed copies avoid invoking caller-provided array iterators.
 */
function normalizeExecutionRequest(value: unknown): ExecutionRequestNormalization {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: invalidExecutionRequest('request must be an object') };
    }

    const record = value as Record<string, unknown>;
    const name = record.name;
    if (!isValidFunctionName(name)) {
      return { ok: false, error: invalidExecutionRequest('function name is unsafe') };
    }

    const rawArgs = record.args;
    if (!Array.isArray(rawArgs)) {
      return { ok: false, error: invalidExecutionRequest('args must be an array') };
    }
    const argumentCount: unknown = rawArgs.length;
    if (
      typeof argumentCount !== 'number'
      || !Number.isSafeInteger(argumentCount)
      || argumentCount < 0
      || argumentCount > MAX_EXECUTION_ARGUMENTS
    ) {
      return {
        ok: false,
        error: invalidExecutionRequest(
          `args must contain at most ${MAX_EXECUTION_ARGUMENTS} items`,
        ),
      };
    }

    const args = new Array<unknown>(argumentCount);
    for (let index = 0; index < argumentCount; index += 1) {
      args[index] = rawArgs[index];
    }

    const rawSignal = record.signal;
    let signal: AbortSignal | undefined;
    if (rawSignal !== undefined) {
      if (typeof rawSignal !== 'object' || rawSignal === null) {
        return { ok: false, error: invalidExecutionRequest('signal must be an AbortSignal') };
      }
      const signalRecord = rawSignal as unknown as Record<string, unknown>;
      const aborted = signalRecord.aborted;
      const addEventListener = signalRecord.addEventListener;
      const removeEventListener = signalRecord.removeEventListener;
      if (
        typeof aborted !== 'boolean'
        || typeof addEventListener !== 'function'
        || typeof removeEventListener !== 'function'
      ) {
        return { ok: false, error: invalidExecutionRequest('signal must be an AbortSignal') };
      }
      signal = {
        get aborted() {
          const current = signalRecord.aborted;
          if (typeof current !== 'boolean') {
            throw new TypeError('signal aborted state could not be read');
          }
          return current;
        },
        addEventListener(_type: string, listener: EventListenerOrEventListenerObject, options?: unknown) {
          Reflect.apply(addEventListener, rawSignal, ['abort', listener, options]);
        },
        removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
          Reflect.apply(removeEventListener, rawSignal, ['abort', listener]);
        },
      } as unknown as AbortSignal;
    }

    const onEvent = record.onEvent;
    if (onEvent !== undefined && typeof onEvent !== 'function') {
      return { ok: false, error: invalidExecutionRequest('onEvent must be a function') };
    }

    return {
      ok: true,
      request: {
        name,
        args,
        ...(signal !== undefined && { signal }),
        ...(onEvent !== undefined && {
          onEvent: onEvent as (event: UnzenExecutionEvent) => void,
        }),
      },
    };
  } catch {
    return {
      ok: false,
      error: invalidExecutionRequest('request properties could not be read'),
    };
  }
}

/** Map a new stable error code to the legacy callWithDiagnostics error type */
function mapToLegacyErrorType(code: string): string {
  switch (code) {
    case 'function_failed': return 'function_error';
    case 'server_fallback_failed': return 'server_runtime_error';
    case 'client_disposed': return 'client_disposed';
    case 'cancelled': return 'cancelled';
    default: return 'browser_runtime_error';
  }
}
