/**
 * Shared utilities for Pipeline and SpanPipeline.
 *
 * Extracted to avoid code duplication between the two pipeline implementations.
 * Both pipelines need timeout-racing and retry delays with identical semantics.
 */

import { SegmentTimeoutError } from './errors.js';

/**
 * Race a promise against a timeout. Rejects with an Error if the timeout fires first.
 *
 * Known limitation: the underlying promise is not cancelled when the timeout fires.
 * In production, callers should pass an AbortSignal to the underlying operation
 * so it can be cancelled cooperatively when the timeout triggers.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
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
 */
export function withAbortableTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
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

/**
 * Async delay. Returns immediately if ms <= 0 (avoids fake-timer freeze in tests).
 */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
