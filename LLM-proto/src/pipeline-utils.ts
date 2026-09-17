/**
 * Shared utilities for Pipeline and SpanPipeline.
 *
 * Extracted to avoid code duplication between the two pipeline implementations.
 * Both pipelines need timeout-racing and retry delays with identical semantics.
 */

import { SegmentTimeoutError } from './errors.js';

type TimeoutThen<T> = (
  onFulfilled: (value: T) => unknown,
  onRejected: (reason: unknown) => unknown,
) => unknown;

type AbortAddEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) => void;

type AbortRemoveEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | EventListenerOptions,
) => void;

interface AbortSignalListenerMethods {
  readonly addEventListener: AbortAddEventListener;
  readonly removeEventListener: AbortRemoveEventListener;
}

/** Maximum delay that browser/Node timers can represent without 32-bit overflow. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Race a promise against a timeout. Rejects with an Error if the timeout fires first.
 *
 * Known limitation: the underlying promise is not cancelled when the timeout fires.
 * In production, callers should pass an AbortSignal to the underlying operation
 * so it can be cancelled cooperatively when the timeout triggers.
 *
 * Runtime inputs are preflighted before timer registration. The promise check is
 * structural rather than `instanceof Promise` so cross-realm promises and valid
 * thenables retain the established compatibility surface.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let then: TimeoutThen<T>;
    try {
      then = assertLegacyTimeoutRuntimeEnvelope<T>(promise, timeoutMs, label);
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      action();
    };

    timer = setTimeout(() => {
      finish(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    try {
      then.call(
        promise,
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function assertSupportedTimerDelay(
  timeoutMs: number,
  fieldName = 'timeoutMs',
): void {
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${fieldName} must not exceed ${MAX_TIMER_DELAY_MS}ms`);
  }
}

function assertLegacyTimeoutRuntimeEnvelope<T>(
  promise: unknown,
  timeoutMs: unknown,
  label: unknown,
): TimeoutThen<T> {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite non-negative number');
  }
  assertSupportedTimerDelay(timeoutMs);
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new TypeError('timeout label must be a non-empty string');
  }
  if (
    (typeof promise !== 'object' || promise === null)
    && typeof promise !== 'function'
  ) {
    throw new TypeError('timeout promise-like must expose a callable then');
  }

  let then: unknown;
  try {
    then = (promise as { then?: unknown }).then;
  } catch {
    throw new TypeError('timeout promise-like must expose a callable then');
  }
  if (typeof then !== 'function') {
    throw new TypeError('timeout promise-like must expose a callable then');
  }
  return then as TimeoutThen<T>;
}

/**
 * Race a factory-created promise against a timeout AND an optional external
 * AbortSignal, aborting the underlying work on either condition.
 *
 * Issue #103 deliverable 6: timeouts must abort the underlying execution, not
 * just orphan a promise. The factory receives an AbortController signal that
 * is aborted when:
 *   - the external `signal` aborts (caller cancellation), or
 *   - the per-segment timeout elapses (segments must stop promptly).
 *
 * The rejection semantics distinguish the two:
 *   - external abort → rejects with AbortError (maps to user cancellation),
 *   - timeout → rejects with SegmentTimeoutError (retryable).
 *
 * The factory promise, the timeout, and the external signal are raced so the
 * returned promise always settles even if the underlying work ignores abort.
 * Runtime inputs are validated before timer/listener registration or factory
 * invocation so malformed asserted/decoded values cannot partially arm the
 * timeout machinery before failing. Listener methods are captured during that
 * preflight so accessor-backed structural signals cannot swap out cleanup after
 * a listener has been registered. After registering an external abort listener,
 * the signal state is re-checked before factory invocation so an abort that wins
 * the check-then-listen window cannot be lost. Post-preflight state reads are
 * also fail-safe: a hostile accessor that throws or stops returning a boolean is
 * rejected through the normal cleanup path.
 */
export function withAbortableTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let signalMethods: AbortSignalListenerMethods | undefined;
    try {
      signalMethods = assertAbortableTimeoutRuntimeEnvelope(factory, timeoutMs, label, signal);
    } catch (error) {
      reject(error);
      return;
    }

    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const removeOuterAbortListener = (): void => {
      if (signal === undefined || signalMethods === undefined) return;
      try {
        signalMethods.removeEventListener.call(signal, 'abort', onOuterAbort);
      } catch {
        // Caller-owned structural signals must not prevent promise settlement.
      }
    };
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      removeOuterAbortListener();
      action();
    };
    const onOuterAbort = (): void => {
      controller.abort();
      // AbortError (name + message) surfaces as user cancellation at the
      // Coordinator boundary (classifyError checks name === 'AbortError').
      finish(() => reject(new DOMException('AbortError', 'AbortError')));
    };
    const readOuterAborted = (): boolean | undefined => {
      if (signal === undefined) return false;
      try {
        return readAbortSignalState(signal);
      } catch (error) {
        controller.abort();
        finish(() => reject(error));
        return undefined;
      }
    };
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new SegmentTimeoutError(`${label} exceeded ${timeoutMs}ms`)));
    }, timeoutMs);

    const initiallyAborted = readOuterAborted();
    if (settled) return;
    if (initiallyAborted) {
      onOuterAbort();
      return;
    }
    try {
      if (signal !== undefined && signalMethods !== undefined) {
        signalMethods.addEventListener.call(signal, 'abort', onOuterAbort, { once: true });
      }
    } catch {
      controller.abort();
      finish(() => reject(new TypeError('timeout signal could not be subscribed')));
      return;
    }

    // A structural signal may synchronously invoke the listener before its
    // addEventListener implementation finishes storing it. Cleanup once more
    // after registration returns so that late storage cannot leak a listener.
    if (settled) {
      removeOuterAbortListener();
      return;
    }

    // An abort may have been dispatched after the first state check but before
    // the listener became active. Re-check after subscription so caller
    // cancellation wins before any underlying execution is started. Structural
    // accessors that become malformed at this point reject through finish(), so
    // the already-armed timer/listener cannot leak.
    const abortedAfterSubscription = readOuterAborted();
    if (settled) return;
    if (abortedAfterSubscription) onOuterAbort();
    if (settled) return;

    // Invoke the factory synchronously so the caller can observe the signal
    // before awaiting the returned promise.
    let resultPromise: Promise<T>;
    try {
      resultPromise = Promise.resolve(factory(controller.signal));
    } catch (error) {
      resultPromise = Promise.reject(error);
    }
    resultPromise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function readAbortSignalState(signal: AbortSignal): boolean {
  let aborted: unknown;
  try {
    aborted = (signal as { aborted?: unknown }).aborted;
  } catch {
    throw new TypeError('timeout signal aborted state could not be read');
  }
  if (typeof aborted !== 'boolean') {
    throw new TypeError('timeout signal aborted state must remain boolean');
  }
  return aborted;
}

function assertAbortableTimeoutRuntimeEnvelope(
  factory: unknown,
  timeoutMs: unknown,
  label: unknown,
  signal: unknown,
): AbortSignalListenerMethods | undefined {
  if (typeof factory !== 'function') {
    throw new TypeError('timeout factory must be a function');
  }
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('timeoutMs must be a finite non-negative number');
  }
  assertSupportedTimerDelay(timeoutMs);
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new TypeError('timeout label must be a non-empty string');
  }
  if (signal === undefined) {
    return undefined;
  }
  if (typeof signal !== 'object' || signal === null) {
    throw new TypeError(
      'timeout signal must expose boolean aborted and callable addEventListener/removeEventListener',
    );
  }

  readAbortSignalState(signal as AbortSignal);
  let addEventListener: unknown;
  let removeEventListener: unknown;
  try {
    addEventListener = (signal as { addEventListener?: unknown }).addEventListener;
    removeEventListener = (signal as { removeEventListener?: unknown }).removeEventListener;
  } catch {
    throw new TypeError('timeout signal listener methods could not be read');
  }
  if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
    throw new TypeError(
      'timeout signal must expose boolean aborted and callable addEventListener/removeEventListener',
    );
  }
  return {
    addEventListener: addEventListener as AbortAddEventListener,
    removeEventListener: removeEventListener as AbortRemoveEventListener,
  };
}

function assertDelayRuntimeEnvelope(ms: unknown): asserts ms is number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError('delay ms must be a finite number');
  }
  assertSupportedTimerDelay(ms, 'delay ms');
}

/**
 * Async delay. Finite values <= 0 resolve immediately (avoids fake-timer freeze
 * in tests). Positive delays are validated before they reach the host timer.
 */
export function delay(ms: number): Promise<void> {
  try {
    assertDelayRuntimeEnvelope(ms);
  } catch (error) {
    return Promise.reject(error);
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
