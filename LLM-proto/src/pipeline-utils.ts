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

function assertSupportedTimerDelay(timeoutMs: number): void {
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}ms`);
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
 * timeout machinery before failing.
 */
export function withAbortableTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      assertAbortableTimeoutRuntimeEnvelope(factory, timeoutMs, label, signal);
    } catch (error) {
      reject(error);
      return;
    }

    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
      action();
    };
    const onOuterAbort = (): void => {
      controller.abort();
      // AbortError (name + message) surfaces as user cancellation at the
      // Coordinator boundary (classifyError checks name === 'AbortError').
      finish(() => reject(new DOMException('AbortError', 'AbortError')));
    };
    timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(new SegmentTimeoutError(`${label} exceeded ${timeoutMs}ms`)));
    }, timeoutMs);

    if (signal?.aborted) {
      onOuterAbort();
      return;
    }
    signal?.addEventListener('abort', onOuterAbort, { once: true });

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

function assertAbortableTimeoutRuntimeEnvelope(
  factory: unknown,
  timeoutMs: unknown,
  label: unknown,
  signal: unknown,
): void {
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
    return;
  }
  if (
    typeof signal !== 'object'
    || signal === null
    || typeof (signal as { aborted?: unknown }).aborted !== 'boolean'
    || typeof (signal as { addEventListener?: unknown }).addEventListener !== 'function'
    || typeof (signal as { removeEventListener?: unknown }).removeEventListener !== 'function'
  ) {
    throw new TypeError(
      'timeout signal must expose boolean aborted and callable addEventListener/removeEventListener',
    );
  }
}

/**
 * Async delay. Returns immediately if ms <= 0 (avoids fake-timer freeze in tests).
 */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
