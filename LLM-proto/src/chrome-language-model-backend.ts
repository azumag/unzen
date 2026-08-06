/**
 * ChromeLanguageModelBackend (issue #95).
 *
 * A full-model `InferenceBackend` that wraps Chrome's Built-in AI / Prompt API
 * (`window.ai.languageModel`). It does NOT manage model weights, layers, or
 * checkpoints: Chrome owns the on-device model session lifecycle, and this
 * backend wraps it. Responsibilities:
 *
 *   - API availability determination (`unsupported` without throwing);
 *   - input/output language & modality option consistency (expectedInputs /
 *     expectedOutputs);
 *   - model preparation / session creation after user activation, with
 *     download progress notification (`monitor` / `downloadprogress`);
 *   - non-streaming `prompt()` and streaming `promptStreaming()`;
 *   - abort / timeout / cancel via `AbortSignal` — no events flow after abort;
 *   - context usage monitoring with soft/hard thresholds and an explicit
 *     context-quota error (never silently drop input);
 *   - session reuse / reset / destroy with reliable page-unload cleanup;
 *   - mapping Chrome API exceptions to the common `ErrorCode` taxonomy;
 *   - capability + health telemetry for `describeCapabilities()`.
 *
 * Non-responsibilities (per the issue): DOM display/consent UI, iframe /
 * extension surface selection, Coordinator transport, segmented inference /
 * checkpoint relay, and obtaining/re-distributing Chrome-managed model files.
 *
 * State machine (discriminated union + validated transitions):
 *
 *   unsupported -> (none)
 *   unavailable -> preparing (download progress) -> ready | failed
 *   ready -> busy (streaming) -> ready
 *   ready/busy/preparing/unavailable/failed -> destroyed
 *
 * The single-session invariant: `ready` means a session exists, except under
 * the `per-request` session policy, where the session is released when each
 * request finishes and the next request creates a fresh one.
 * `prepare()` is the only way into `ready`; `failed` is terminal except
 * `destroyed` (the caller disposes and recreates the backend); a `prepare()`
 * rejected because a user activation is missing returns to `unavailable` so a
 * retry after the user gesture is possible.
 */

import {
  CAPABILITY_SCHEMA_VERSION,
  INFERENCE_PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  type InferenceBackend,
  type InferenceEvent,
  type InferencePrepareEvent,
  type InferenceRequest,
  type ModelDownloadState,
  type PrepareOptions,
  type PreparationResult,
  type WorkerCapability,
  type WorkerHealth,
} from './inference-backend.js';
import {
  ErrorCode,
  StateTransitionError,
  UnzenError,
  type UnzenError as UnzenErrorType,
} from './errors.js';
import type {
  ChromePromptApiNamespace,
  ChromePromptApiSession,
} from './chrome-prompt-api-adapter.js';

// --- State machine -----------------------------------------------------------

/**
 * Discriminated union of the backend's lifecycle phases. Transitions between
 * phases are validated by `transitionBackendState()`; the backend never mutates
 * phases through scattered string comparisons.
 */
export type ChromeBackendState =
  | { readonly phase: 'unsupported' }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'preparing'; readonly progress: number }
  | { readonly phase: 'ready' }
  | { readonly phase: 'busy'; readonly requestId: string }
  | { readonly phase: 'failed'; readonly code: ErrorCode; readonly message: string }
  | { readonly phase: 'destroyed' };

export type ChromeBackendPhase = ChromeBackendState['phase'];

/** Allowed phase transitions. `destroyed` is terminal; `failed` is terminal except destroy. */
export const ALLOWED_CHROME_TRANSITIONS: Readonly<Record<ChromeBackendPhase, readonly ChromeBackendPhase[]>> = {
  unsupported: ['destroyed'],
  unavailable: ['preparing', 'destroyed'],
  preparing: ['ready', 'failed', 'unavailable', 'destroyed'],
  ready: ['busy', 'failed', 'destroyed'],
  busy: ['ready', 'failed', 'destroyed'],
  failed: ['destroyed'],
  destroyed: [],
};

/**
 * Validate and apply one state transition. Throws `StateTransitionError` on an
 * illegal transition so a coding error fails fast instead of corrupting state.
 * Exported for direct unit testing of the transition table.
 */
export function transitionBackendState(
  from: ChromeBackendState,
  to: ChromeBackendState,
): ChromeBackendState {
  if (!ALLOWED_CHROME_TRANSITIONS[from.phase].includes(to.phase)) {
    throw new StateTransitionError(
      `illegal Chrome backend transition: ${from.phase} -> ${to.phase}`,
    );
  }
  return to;
}

// --- Session policy ----------------------------------------------------------

export type ChromeSessionMode = 'per-request' | 'per-conversation';
export type ChromeHardThresholdAction = 'error' | 'rotate-session';

/**
 * Session / context policy.
 *
 * - `mode: 'per-request'` rotates to a fresh session at the start of every
 *   execute() so context never accumulates across requests.
 * - `mode: 'per-conversation'` reuses one session across execute() calls.
 *   The soft threshold is a warning (`context` event); the hard threshold is
 *   either an explicit `context-overflow` error or a fresh-session rotation.
 *   Input is never silently dropped either way.
 */
export interface ChromeSessionPolicy {
  readonly mode: ChromeSessionMode;
  /** Ratio [0,1] of the context window at which a warning is emitted. */
  readonly softUsageRatio: number;
  /** Ratio [0,1] of the context window at which the hard action fires. */
  readonly hardUsageRatio: number;
  readonly onHardThreshold: ChromeHardThresholdAction;
}

/**
 * Note on Chrome's `contextoverflow` event: regardless of `onHardThreshold`,
 * an overflow that made Chrome drop conversation history is treated as
 * terminal for the session. The session is known to be corrupted (history
 * silently truncated), so neither rotation nor a warning can make it
 * trustworthy again; the backend fails with an explicit `ContextOverflow`
 * error and the caller recreates it.
 */

export const DEFAULT_CHROME_SESSION_POLICY: ChromeSessionPolicy = {
  mode: 'per-conversation',
  softUsageRatio: 0.7,
  hardUsageRatio: 0.9,
  onHardThreshold: 'error',
};

/** An event-target-like object that can dispatch page unload (for cleanup). */
export interface ChromeUnloadEmitter {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

// --- Backend options ---------------------------------------------------------

export interface ChromeLanguageModelBackendOptions {
  /**
   * The injected Prompt API namespace. Production passes the wrapped
   * `window.ai.languageModel` (see chrome-prompt-api-adapter.ts); tests inject
   * a fake. `undefined` means the environment is unsupported.
   */
  readonly namespace?: ChromePromptApiNamespace;
  readonly runtimeVersion?: string;
  /** Fallback context window when the session does not report one. */
  readonly contextWindowTokens?: number;
  /** Languages passed to expectedInputs/expectedOutputs and the capability. */
  readonly supportedLanguages?: readonly string[];
  readonly policy?: ChromeSessionPolicy;
  /**
   * Object that emits a `pagehide` event when the document unloads; defaults to
   * the global `window` when present, so session cleanup is reliable on unload.
   */
  readonly unloadEmitter?: ChromeUnloadEmitter;
}

// --- Constants ---------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW_TOKENS = 4096;
const DEFAULT_EXPECTED_LATENCY_MS = 1_000;
const HEALTH_WINDOW_SIZE = 10;

/** Text delta between a cumulative streaming chunk and the text so far. */
function computeDelta(previousText: string, chunk: string): string {
  if (chunk.startsWith(previousText)) return chunk.slice(previousText.length);
  return chunk;
}

// --- Error mapping -----------------------------------------------------------

function isAbortLike(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { name?: unknown };
    if (candidate.name === 'AbortError') return true;
  }
  return error instanceof AbortSignal && error.aborted;
}

function errorName(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Map an arbitrary thrown value from the Prompt API to the common `ErrorCode`
 * taxonomy (issue #95 deliverable / error taxonomy). Unknown values degrade to
 * `RuntimeTransient`.
 *
 * The classification is context-sensitive: during model preparation a
 * `NotSupportedError` means the environment cannot run the model (hardware /
 * OS / feature gaps) and maps to `ModelUnavailable`; during execution it means
 * the request's language/modality is unsupported and maps to
 * `UnsupportedModality`.
 */
export function classifyChromeError(
  error: unknown,
  context: 'prepare' | 'execute' = 'execute',
): ErrorCode {
  if (error instanceof UnzenError) return error.code;
  if (isAbortLike(error)) return ErrorCode.UserCancellation;
  const name = errorName(error);
  const message = errorMessage(error);
  if (name === 'QuotaExceededError') return ErrorCode.ContextOverflow;
  if (name === 'NotAllowedError') {
    return /activation/i.test(message)
      ? ErrorCode.UserActivationRequired
      : ErrorCode.PermissionDenied;
  }
  if (name === 'NotSupportedError') {
    return context === 'prepare' ? ErrorCode.ModelUnavailable : ErrorCode.UnsupportedModality;
  }
  if (name === 'InvalidArgumentError' || name === 'TypeError') return ErrorCode.InvalidInput;
  if (name === 'InvalidStateError') return ErrorCode.SessionDestroyed;
  return ErrorCode.RuntimeTransient;
}

/** Session-level failures poison the session; task-level failures do not. */
function isSessionLevelError(code: ErrorCode): boolean {
  switch (code) {
    case ErrorCode.RuntimeTransient:
    case ErrorCode.SessionDestroyed:
    case ErrorCode.ModelPreparationFailure:
    case ErrorCode.PermissionDenied:
    case ErrorCode.UnsupportedApi:
    case ErrorCode.ModelUnavailable:
      return true;
    default:
      return false;
  }
}

function toUnzenError(error: unknown, context: 'prepare' | 'execute' = 'execute'): UnzenErrorType {
  if (error instanceof UnzenError) return error;
  return new UnzenError(errorMessage(error), classifyChromeError(error, context));
}

/** Outcome summary returned by the execution helpers via their generator value. */
interface ExecutionOutcome {
  readonly ok: boolean;
  readonly code?: ErrorCode;
  readonly message?: string;
}

// --- Backend -----------------------------------------------------------------

export class ChromeLanguageModelBackend implements InferenceBackend {
  private readonly namespace: ChromePromptApiNamespace | undefined;
  private readonly runtimeVersion: string;
  private readonly contextWindowTokens: number;
  private readonly supportedLanguages: readonly string[];
  private readonly policy: ChromeSessionPolicy;
  private readonly unloadEmitter: ChromeUnloadEmitter | undefined;
  private readonly unloadBound: boolean;

  private state: ChromeBackendState;
  private session: ChromePromptApiSession | undefined;
  /** Last observed browser availability (drives the capability's download state). */
  private observedAvailability:
    | 'unavailable'
    | 'downloadable'
    | 'downloading'
    | 'available'
    | undefined;
  /**
   * Last observed context window (from the most recent session). Kept after the
   * session is released (per-request policy) so the capability still reports
   * the real window instead of falling back to the EXAMPLE placeholder.
   */
  private lastContextWindowTokens: number | undefined;
  /** Set when Chrome fired `contextoverflow` (it silently dropped history). */
  private contextOverflowed = false;

  private readonly prepareListeners = new Set<(event: InferencePrepareEvent) => void>();
  private readonly recentOutcomes: boolean[] = [];
  private lastFailureCode: ErrorCode | undefined;
  private executions = 0;
  private failures = 0;

  private readonly onPageHide: () => void;

  constructor(options: ChromeLanguageModelBackendOptions) {
    this.namespace = options.namespace;
    this.runtimeVersion = options.runtimeVersion ?? 'unknown';
    this.contextWindowTokens = options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.supportedLanguages = options.supportedLanguages ?? ['ja', 'en'];
    this.policy = { ...DEFAULT_CHROME_SESSION_POLICY, ...options.policy };
    this.unloadEmitter = options.unloadEmitter ?? defaultUnloadEmitter();

    // Synchronous feature detection: the namespace adapter already resolved to
    // undefined when the API is absent/malformed.
    this.state = this.namespace === undefined
      ? { phase: 'unsupported' }
      : { phase: 'unavailable' };

    // Reliable cleanup: destroy the session when the document unloads, so a
    // browser-managed model session is never leaked. pagehide fires on both
    // navigation and tab close. Note: pagehide also fires on bfcache
    // (back/forward) navigation, which leaves the backend 'destroyed' after a
    // restore; the caller recreates the backend on pageshow.
    this.onPageHide = () => {
      void this.dispose();
    };
    this.unloadBound = this.unloadEmitter !== undefined;
    if (this.unloadBound) {
      this.unloadEmitter!.addEventListener('pagehide', this.onPageHide);
    }
  }

  // --- Public extensions beyond the InferenceBackend contract ---------------

  /** Current state snapshot (telemetry / tests). */
  snapshotState(): ChromeBackendState {
    return this.state;
  }

  /** Subscribe to model-preparation progress during `prepare()`. */
  onPrepare(listener: (event: InferencePrepareEvent) => void): () => void {
    this.prepareListeners.add(listener);
    return () => {
      this.prepareListeners.delete(listener);
    };
  }

  /** Health + execution counters (feeds describeCapabilities). */
  telemetry(): {
    readonly executions: number;
    readonly failures: number;
    readonly health: WorkerHealth;
  } {
    return { executions: this.executions, failures: this.failures, health: this.healthSnapshot() };
  }

  // --- InferenceBackend contract ---------------------------------------------

  async describeCapabilities(): Promise<WorkerCapability> {
    await this.refreshAvailability();
    return this.buildCapability();
  }

  async prepare(options: PrepareOptions = {}): Promise<PreparationResult> {
    switch (this.state.phase) {
      case 'destroyed':
        throw new UnzenError('Chrome backend was disposed', ErrorCode.SessionDestroyed);
      case 'unsupported':
        // Acceptance criterion: an environment without the API reports
        // unsupported without throwing.
        return {
          state: 'unavailable',
          detail: 'Chrome Prompt API (window.ai.languageModel) is not available in this environment',
        };
      case 'ready':
        return { state: 'available' };
      case 'busy':
        throw new UnzenError(
          `backend is busy executing '${this.state.requestId}'; cannot prepare concurrently`,
          ErrorCode.StateTransitionViolation,
        );
      case 'preparing':
        return { state: 'downloading', progress: this.state.progress };
      case 'failed':
        throw new UnzenError(this.state.message, this.state.code);
      case 'unavailable':
        break;
    }

    // A prepare() that arrives already cancelled must not enter 'preparing'
    // (which would start a model download) only to bounce back on the abort
    // check after create(). Checked after the lifecycle gates so a terminal
    // state (destroyed) keeps its error priority.
    if (options.signal?.aborted) {
      throw new UnzenError('prepare() was aborted', ErrorCode.UserCancellation);
    }

    // unavailable -> preparing. Creating the session may trigger the first
    // model download; the monitor forwards downloadprogress to subscribers.
    this.transition({ phase: 'preparing', progress: 0 });
    let session: ChromePromptApiSession;
    try {
      session = await this.createSession({
        signal: options.signal,
        context: 'prepare',
        onProgress: (progress) => {
          // No progress events after disposal: a download that resolves after
          // pagehide must not deliver zombie events to subscribers.
          if (this.isDisposed()) return;
          // Progress only ever refines the in-flight 'preparing' phase: emit
          // nothing when the phase moved on (e.g. an aborted prepare returned
          // to 'unavailable' but the browser still fires a late progress
          // callback), so stale download values never leak into a retry.
          if (this.state.phase !== 'preparing') return;
          this.state = { phase: 'preparing', progress };
          this.emitPrepare({ type: 'prepare', state: 'downloading', progress }, options.onProgress);
        },
      });
    } catch (error) {
      // The backend may have been disposed (pagehide) while create() was in
      // flight. A rejection racing the disposal must surface as
      // SessionDestroyed, never as an illegal transition out of the terminal
      // 'destroyed' phase (the catch below would otherwise transition back to
      // 'unavailable'/'failed' and throw StateTransitionError).
      if (this.isDisposed()) {
        throw new UnzenError('backend was disposed during prepare', ErrorCode.SessionDestroyed);
      }
      const code = classifyChromeError(error, 'prepare');
      if (
        code === ErrorCode.UserCancellation ||
        (options.signal !== undefined && options.signal.aborted)
      ) {
        // prepare() was aborted or the caller gave up; allow a later retry.
        this.transition({ phase: 'unavailable' });
        throw new UnzenError(errorMessage(error), ErrorCode.UserCancellation);
      }
      if (code === ErrorCode.UserActivationRequired) {
        // The first model download requires a user gesture. Return to
        // 'unavailable' so a retry inside a user activation is possible.
        this.transition({ phase: 'unavailable' });
        throw new UnzenError(errorMessage(error), code);
      }
      // Any other create failure is a download/preparation failure (or an
      // environment/capability problem); the backend is now terminally failed.
      const mapped = code === ErrorCode.RuntimeTransient ? ErrorCode.ModelPreparationFailure : code;
      const reason = new UnzenError(`model preparation failed: ${errorMessage(error)}`, mapped);
      this.transition({ phase: 'failed', code: reason.code, message: reason.message });
      throw reason;
    }

    // The backend may have been disposed (e.g. pagehide during a long model
    // download) while create() was resolving. The unload listener is already
    // detached at that point, so a session created for a disposed backend must
    // be released here or nothing will ever clean it up for the page's
    // lifetime.
    if (this.isDisposed()) {
      try {
        session.destroy();
      } catch {
        // Best-effort cleanup of an already-created session.
      }
      throw new UnzenError('backend was disposed during prepare', ErrorCode.SessionDestroyed);
    }

    // The caller may have aborted while create() was resolving.
    if (options.signal !== undefined && options.signal.aborted) {
      try {
        session.destroy();
      } catch {
        // Best-effort cleanup of an already-created session.
      }
      this.transition({ phase: 'unavailable' });
      throw new UnzenError('prepare() was aborted', ErrorCode.UserCancellation);
    }

    this.session = session;
    this.wireContextOverflow(session);
    this.transition({ phase: 'ready' });
    this.emitPrepare({ type: 'prepare', state: 'available' }, options.onProgress);
    return { state: 'available' };
  }

  async *execute(
    request: InferenceRequest,
    signal: AbortSignal,
  ): AsyncIterable<InferenceEvent> {
    const startedAt = Date.now();
    const requestId = request.requestId;

    // Advisory fields: Chrome owns token limits and the model is the device's
    // built-in model, so request.maxTokens / request.modelId are not enforced
    // (Chrome may still truncate at its own window).
    if (!isSupportedProtocolVersion(request.protocolVersion)) {
      yield this.errorEvent(
        ErrorCode.UnsupportedRequest,
        `unsupported protocol version '${request.protocolVersion}'`,
      );
      return;
    }

    // Lifecycle gates (each yields an error event instead of throwing, so the
    // AsyncIterable contract is preserved for the caller).
    switch (this.state.phase) {
      case 'unsupported':
        yield this.errorEvent(ErrorCode.UnsupportedApi, 'Chrome Prompt API is not available');
        return;
      case 'destroyed':
        // Acceptance criterion: session reuse after destroy is rejected.
        yield this.errorEvent(ErrorCode.SessionDestroyed, 'Chrome backend was disposed; reuse is rejected');
        return;
      case 'busy':
        yield this.errorEvent(
          ErrorCode.StateTransitionViolation,
          `backend is busy executing '${this.state.requestId}'; maxConcurrency is 1`,
        );
        return;
      case 'failed':
        yield this.errorEvent(this.state.code, this.state.message);
        return;
      case 'unavailable':
      case 'preparing':
        yield this.errorEvent(
          ErrorCode.ModelPreparationFailure,
          `backend is not prepared (phase '${this.state.phase}'); call prepare() first`,
        );
        return;
      case 'ready':
        break;
    }

    // Chrome fired contextoverflow (it dropped history) since we last checked:
    // in per-conversation mode the session is compromised, so fail explicitly
    // rather than continue on silently truncated context. Under the per-request
    // policy the session is single-use and released when this request finishes,
    // so a stale overflow event from it cannot poison the next request.
    if (this.contextOverflowed && this.policy.mode === 'per-conversation') {
      this.destroySession();
      this.transition({
        phase: 'failed',
        code: ErrorCode.ContextOverflow,
        message: 'Chrome dropped conversation history on context overflow; input was not silently processed',
      });
      yield this.errorEvent(
        ErrorCode.ContextOverflow,
        'Chrome dropped conversation history on context overflow',
      );
      return;
    }

    this.executions += 1;
    this.transition({ phase: 'busy', requestId });
    let sessionFailure: { code: ErrorCode; message: string } | undefined;
    let outcome: ExecutionOutcome = { ok: true };
    try {
      // A request that arrives already cancelled must never create a session
      // (which could trigger a model download) nor run the model.
      if (signal.aborted) {
        yield this.abortEvent(requestId, signal);
        return;
      }
      // Session resolution per policy. A fresh session (per-request or rotation)
      // may be needed; creating it can fail, which is surfaced as an error.
      let session: ChromePromptApiSession;
      try {
        session = await this.resolveSession(signal);
      } catch (error) {
        const result = yield* this.yieldSessionResolutionFailure(error, signal, requestId);
        if (result === 'abort') return;
        if (result !== undefined) {
          sessionFailure = result;
          this.destroySession();
        }
        return;
      }

      if (this.policy.mode === 'per-conversation') {
        const usage = this.readContextUsage(session);
        const ratio = usage.limitTokens > 0 ? usage.usageTokens / usage.limitTokens : 0;
        if (ratio >= this.policy.hardUsageRatio) {
          if (this.policy.onHardThreshold === 'error') {
            // Explicit context-quota error: never silently drop input.
            const failure = new UnzenError(
              `context usage ${usage.usageTokens}/${usage.limitTokens} exceeds hard threshold ${this.policy.hardUsageRatio}`,
              ErrorCode.ContextOverflow,
            );
            this.recordFailure(failure.code);
            yield this.errorEvent(failure.code, failure.message);
            return;
          }
          // rotate-session: process the input in a fresh session; input is not
          // dropped, the prior context is deliberately discarded by policy.
          this.destroySession();
          try {
            session = await this.resolveSession(signal);
          } catch (error) {
            const result = yield* this.yieldSessionResolutionFailure(error, signal, requestId);
            if (result === 'abort') return;
            if (result !== undefined) {
              sessionFailure = result;
              this.destroySession();
            }
            return;
          }
        } else if (ratio >= this.policy.softUsageRatio) {
          // Soft threshold: notify, keep executing.
          yield { type: 'context', usageTokens: usage.usageTokens, limitTokens: usage.limitTokens };
        }
      }

      if (signal.aborted) {
        yield this.abortEvent(requestId, signal);
        return;
      }

      if (request.requiresStreaming === true) {
        outcome = yield* this.streamExecution(session, request, signal, startedAt);
      } else {
        outcome = yield* this.singleExecution(session, request, signal, startedAt);
      }
    } finally {
      if (this.isDisposed()) {
        // The backend was disposed mid-execution (e.g. pagehide during a long
        // stream). 'destroyed' is terminal: release any session and stop, but
        // never throw a transition error out of the AsyncIterable.
        this.destroySession();
        return;
      }
      if (sessionFailure !== undefined) {
        this.transition({ phase: 'failed', code: sessionFailure.code, message: sessionFailure.message });
      } else if (!outcome.ok && outcome.code !== undefined && isSessionLevelError(outcome.code)) {
        // A session-level failure surfaced from the prompt/stream helpers.
        this.destroySession();
        this.transition({ phase: 'failed', code: outcome.code, message: outcome.message ?? '' });
      } else {
        if (this.policy.mode === 'per-request') {
          // Single-use sessions: release the browser-managed session now so the
          // next request starts fresh without accumulating context.
          this.destroySession();
        }
        this.transition({ phase: 'ready' });
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.state.phase === 'destroyed') return;
    if (this.unloadBound && this.unloadEmitter !== undefined) {
      this.unloadEmitter.removeEventListener('pagehide', this.onPageHide);
    }
    this.destroySession();
    this.transition({ phase: 'destroyed' });
  }

  // --- Execution helpers -----------------------------------------------------

  /**
   * Handle a session-creation failure during execute() (both the initial
   * resolution and the hard-threshold rotation share this path). Yields the
   * event the caller must surface and returns the outcome:
   *
   *   - 'abort'        the request was cancelled while creating the session;
   *                    the abort event was yielded (never an error event);
   *   - undefined      task-level failure; the error event was yielded and the
   *                    backend stays usable;
   *   - {code,message} session-level failure; the error event was yielded and
   *                    the caller must poison the backend.
   */
  private async *yieldSessionResolutionFailure(
    error: unknown,
    signal: AbortSignal,
    requestId: string,
  ): AsyncGenerator<InferenceEvent, 'abort' | { code: ErrorCode; message: string } | undefined> {
    // A disposal racing the session creation silences everything: the backend
    // is gone, so neither an abort nor an error event should surface and the
    // failure must not be counted in telemetry.
    if (this.isDisposed()) return undefined;
    const failure = toUnzenError(error);
    if (signal.aborted || failure.code === ErrorCode.UserCancellation) {
      // A cancellation racing the session creation is an abort, never an
      // error; a cancelled request must not look like a worker failure.
      yield this.abortEvent(requestId, signal);
      return 'abort';
    }
    this.recordFailure(failure.code);
    yield this.errorEvent(failure.code, failure.message);
    return isSessionLevelError(failure.code)
      ? { code: failure.code, message: failure.message }
      : undefined;
  }

  private async *streamExecution(
    session: ChromePromptApiSession,
    request: InferenceRequest,
    signal: AbortSignal,
    startedAt: number,
  ): AsyncGenerator<InferenceEvent, ExecutionOutcome> {
    let reader: ReadableStreamDefaultReader<string>;
    try {
      const stream = session.promptStreaming(request.input, { signal });
      // getReader() can throw for a malformed stream; it must surface as an
      // error event like any other Prompt API failure, never as an exception
      // escaping the AsyncIterable.
      reader = stream.getReader();
    } catch (error) {
      // A disposal racing this failure silences everything: a disposed backend
      // emits no events and must not mutate telemetry.
      if (this.isDisposed()) return { ok: true };
      const code = classifyChromeError(error);
      if (signal.aborted || code === ErrorCode.UserCancellation) {
        yield this.abortEvent(request.requestId, signal);
        return { ok: true };
      }
      this.recordFailure(code);
      yield this.errorEvent(code, errorMessage(error));
      return { ok: false, code, message: errorMessage(error) };
    }
    let fullText = '';
    let pending: string | undefined;
    try {
      while (true) {
        if (signal.aborted || this.isDisposed()) break;
        const result = await reader.read();
        if (result.done) break;
        if (signal.aborted || this.isDisposed()) break;
        const delta = computeDelta(fullText, result.value);
        if (pending !== undefined) {
          yield { type: 'stream', text: pending, done: false };
        }
        pending = delta;
        fullText += delta;
      }
    } catch (error) {
      // A disposal racing this failure silences everything (see above).
      if (this.isDisposed()) return { ok: true };
      const code = classifyChromeError(error);
      if (signal.aborted || code === ErrorCode.UserCancellation) {
        yield this.abortEvent(request.requestId, signal);
        return { ok: true };
      }
      this.recordFailure(code);
      yield this.errorEvent(code, errorMessage(error));
      return { ok: false, code, message: errorMessage(error) };
    }
    if (this.isDisposed()) {
      // The backend was disposed while the stream was running; discard the
      // partial output and stop without further events.
      return { ok: true };
    }
    if (signal.aborted) {
      // No further token/event flows after abort.
      yield this.abortEvent(request.requestId, signal);
      return { ok: true };
    }
    yield { type: 'stream', text: pending ?? '', done: true };
    this.recordSuccess();
    yield {
      type: 'completion',
      requestId: request.requestId,
      output: { tokens: [], text: fullText },
      totalTimeMs: Date.now() - startedAt,
    };
    yield this.contextEvent(session);
    return { ok: true };
  }

  private async *singleExecution(
    session: ChromePromptApiSession,
    request: InferenceRequest,
    signal: AbortSignal,
    startedAt: number,
  ): AsyncGenerator<InferenceEvent, ExecutionOutcome> {
    let output: string;
    try {
      output = await session.prompt(request.input, { signal });
    } catch (error) {
      // A disposal racing this failure silences everything (see
      // streamExecution): a disposed backend emits no events and must not
      // mutate telemetry.
      if (this.isDisposed()) return { ok: true };
      const code = classifyChromeError(error);
      if (signal.aborted || code === ErrorCode.UserCancellation) {
        yield this.abortEvent(request.requestId, signal);
        return { ok: true };
      }
      this.recordFailure(code);
      yield this.errorEvent(code, errorMessage(error));
      return { ok: false, code, message: errorMessage(error) };
    }
    if (this.isDisposed()) {
      // The backend was disposed while prompt() was running; the response is
      // discarded and no further events flow.
      return { ok: true };
    }
    if (signal.aborted) {
      yield this.abortEvent(request.requestId, signal);
      return { ok: true };
    }
    this.recordSuccess();
    yield {
      type: 'completion',
      requestId: request.requestId,
      output: { tokens: [], text: output },
      totalTimeMs: Date.now() - startedAt,
    };
    yield this.contextEvent(session);
    return { ok: true };
  }

  private async resolveSession(signal: AbortSignal | undefined): Promise<ChromePromptApiSession> {
    if (this.policy.mode === 'per-request') {
      // A fresh session per request: execute() releases the session when the
      // request finishes (see the finally block), so any session seen here is
      // still fresh (typically the one prepared by prepare()). Only create one
      // when none exists; the session prepared by prepare() is reused for the
      // first request instead of being created and immediately discarded.
      if (this.session === undefined) {
        const session = await this.createSession({ signal });
        this.session = session;
        this.wireContextOverflow(session);
      }
      return this.session;
    }
    if (this.session === undefined) {
      const session = await this.createSession({ signal });
      this.session = session;
      this.wireContextOverflow(session);
      return session;
    }
    return this.session;
  }

  private async createSession(options: {
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
    /** Error-classification context: prepare failures map NotSupportedError to ModelUnavailable. */
    context?: 'prepare' | 'execute';
  }): Promise<ChromePromptApiSession> {
    if (this.namespace === undefined) {
      throw new UnzenError('Chrome Prompt API is not available', ErrorCode.UnsupportedApi);
    }
    try {
      const session = await this.namespace.create({
        signal: options.signal,
        monitor: (monitor) => {
          monitor.addEventListener('downloadprogress', (event) => {
            const progress =
              event.totalTokens > 0
                ? Math.max(0, Math.min(1, event.loadedTokens / event.totalTokens))
                : 0;
            options.onProgress?.(progress);
          });
        },
        expectedInputs: [{ type: 'text', languages: [...this.supportedLanguages] }],
        expectedOutputs: [{ type: 'text', languages: [...this.supportedLanguages] }],
      });
      return session;
    } catch (error) {
      throw toUnzenError(error, options.context ?? 'execute');
    }
  }

  private wireContextOverflow(session: ChromePromptApiSession): void {
    try {
      session.addEventListener('contextoverflow', () => {
        this.contextOverflowed = true;
      });
    } catch {
      // Builds without the event rely on the QuotaExceededError path.
    }
  }

  // --- Context + telemetry ---------------------------------------------------

  private readContextUsage(session: ChromePromptApiSession): {
    usageTokens: number;
    limitTokens: number;
  } {
    const limit = session.contextWindow.maxTokens > 0
      ? session.contextWindow.maxTokens
      : this.contextWindowTokens;
    // Remember the measured window even after this session is released, so
    // capability reports stay truthful between per-request rotations.
    this.lastContextWindowTokens = limit;
    const usage =
      Number.isFinite(session.contextUsage) && session.contextUsage >= 0
        ? session.contextUsage
        : limit - session.contextWindow.tokensLeft;
    // Fail-closed when both metrics are missing: usage collapses to the limit,
    // so the first request hits the hard threshold instead of silently
    // exceeding an unknown window. Real Chrome always reports both metrics;
    // treating an unmeasurable window as full is the safe default.
    return {
      usageTokens: Math.min(Math.max(0, usage), limit),
      limitTokens: limit,
    };
  }

  private contextEvent(session: ChromePromptApiSession): InferenceEvent {
    const usage = this.readContextUsage(session);
    return { type: 'context', usageTokens: usage.usageTokens, limitTokens: usage.limitTokens };
  }

  private recordSuccess(): void {
    // A recovered backend must not keep advertising a stale failure reason.
    this.lastFailureCode = undefined;
    this.recentOutcomes.push(true);
    if (this.recentOutcomes.length > HEALTH_WINDOW_SIZE) this.recentOutcomes.shift();
  }

  private recordFailure(code: ErrorCode): void {
    this.failures += 1;
    this.lastFailureCode = code;
    this.recentOutcomes.push(false);
    if (this.recentOutcomes.length > HEALTH_WINDOW_SIZE) this.recentOutcomes.shift();
  }

  private healthSnapshot(): WorkerHealth {
    const windowSize = this.recentOutcomes.length;
    const failed = this.recentOutcomes.filter((ok) => !ok).length;
    // WorkerHealth fields are readonly; build the optional error code in-line
    // instead of assigning after construction.
    const health: WorkerHealth =
      this.lastFailureCode === undefined
        ? { recentFailureRate: windowSize > 0 ? failed / windowSize : 0 }
        : {
            recentFailureRate: windowSize > 0 ? failed / windowSize : 0,
            lastErrorCode: this.lastFailureCode,
          };
    return health;
  }

  // --- Capability ------------------------------------------------------------

  private async refreshAvailability(): Promise<void> {
    if (this.namespace === undefined) return;
    if (this.state.phase !== 'unavailable') return;
    try {
      const availability = await this.namespace.availability({
        expectedInputs: [{ type: 'text', languages: [...this.supportedLanguages] }],
        expectedOutputs: [{ type: 'text', languages: [...this.supportedLanguages] }],
      });
      this.observedAvailability = availability;
    } catch {
      // Keep the previous observation; never throw from capability queries.
    }
  }

  private modelDownloadState(): ModelDownloadState {
    switch (this.state.phase) {
      case 'ready':
      case 'busy':
        return 'available';
      case 'preparing':
        return 'downloading';
      case 'unavailable':
        return this.observedAvailability ?? 'unavailable';
      case 'unsupported':
      case 'failed':
      case 'destroyed':
        return 'unavailable';
    }
  }

  private buildCapability(): WorkerCapability {
    const usage = this.session !== undefined ? this.readContextUsage(this.session) : undefined;
    const capability: WorkerCapability = {
      schemaVersion: CAPABILITY_SCHEMA_VERSION,
      backend: 'browser-built-in-full-model',
      runtimeName: 'chrome-prompt-api',
      runtimeVersion: this.runtimeVersion,
      executionMode: 'full-model',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedLanguages: [...this.supportedLanguages],
      streaming: true,
      // The measured window when one was ever observed; the configured
      // fallback otherwise (which mirrors the #93 EXAMPLE placeholder).
      contextWindowTokens:
        usage !== undefined ? usage.limitTokens : (this.lastContextWindowTokens ?? this.contextWindowTokens),
      modelDownloadState: this.modelDownloadState(),
      requiresUserActivation: true,
      executionSurfaces: ['document'],
      supportsCancellation: true,
      maxConcurrency: 1,
      expectedLatencyMs: DEFAULT_EXPECTED_LATENCY_MS,
      health: this.state.phase === 'unsupported'
        ? { recentFailureRate: 0, lastErrorCode: ErrorCode.UnsupportedApi }
        : this.healthSnapshot(),
      privacyBoundary: 'in-browser',
      allowedNetworkDestinations: ['none'],
      // WorkerCapability fields are readonly; spread the optional usage
      // snapshot instead of assigning after construction.
      ...(usage !== undefined ? { currentContextUsageTokens: usage.usageTokens } : {}),
    };
    return capability;
  }

  // --- Small helpers ---------------------------------------------------------

  private transition(to: ChromeBackendState): void {
    this.state = transitionBackendState(this.state, to);
  }

  /**
   * Live 'destroyed' check. Written as a method because TypeScript keeps the
   * pre-await narrowing of `this.state.phase` (e.g. 'unavailable' or 'ready')
   * even across await points where dispose() can actually interleave (pagehide
   * during create()/streaming), which would make a direct comparison look
   * unreachable and is also a genuine correctness hazard.
   */
  private isDisposed(): boolean {
    return this.state.phase === 'destroyed';
  }

  private emitPrepare(event: InferencePrepareEvent, onProgress?: (event: InferencePrepareEvent) => void): void {
    // The contract-level callback (PrepareOptions.onProgress) and the
    // backend-specific subscribers both receive every preparation event; a
    // misbehaving listener must not corrupt preparation.
    if (onProgress !== undefined) {
      try {
        onProgress(event);
      } catch {
        // A misbehaving subscriber must not corrupt preparation.
      }
    }
    for (const listener of [...this.prepareListeners]) {
      try {
        listener(event);
      } catch {
        // A misbehaving subscriber must not corrupt preparation.
      }
    }
  }

  private destroySession(): void {
    if (this.session !== undefined) {
      try {
        this.session.destroy();
      } catch {
        // The browser may already have freed the session.
      }
      this.session = undefined;
    }
  }

  private abortEvent(requestId: string, signal: AbortSignal): InferenceEvent {
    const reason = typeof signal.reason === 'string' ? signal.reason : 'user cancellation';
    return { type: 'abort', requestId, reason };
  }

  private errorEvent(code: ErrorCode, message: string): InferenceEvent {
    return { type: 'error', code, message };
  }
}

/** Default unload emitter: the global window when running in a document. */
function defaultUnloadEmitter(): ChromeUnloadEmitter | undefined {
  if (typeof window === 'undefined') return undefined;
  return window as unknown as ChromeUnloadEmitter;
}

// Re-exported for consumers building requests without a second import.
export { INFERENCE_PROTOCOL_VERSION };
