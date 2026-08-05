/**
 * Abort / cancellation helpers
 *
 * Shared utilities for propagating AbortSignal cancellation through the
 * client's fetch pipeline and surfacing it as UnzenCancelledError instead of
 * a generic network/runtime error. This is what prevents a user cancellation
 * from being mistaken for an environment failure and triggering server
 * fallback (issue #105 §4).
 */

import { UnzenCancelledError } from '@unzen/shared';

/**
 * Detect an AbortError regardless of environment.
 *
 * Browsers reject aborted fetches with DOMException('AbortError'); Node.js may
 * surface `{ name: 'AbortError' }` too. Checking the error name is more robust
 * than `instanceof DOMException`, which does not exist in Node.
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && (error as { name?: string }).name === 'AbortError'
  );
}

/**
 * Throw UnzenCancelledError if the signal is already aborted.
 * Used at phase boundaries so an execution never starts work after cancel.
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new UnzenCancelledError('Execution cancelled by caller');
  }
}

/**
 * Race a shared promise against this caller's AbortSignal.
 *
 * Used where a promise is shared across callers (e.g. the manifest fetch
 * deduplication): aborting one caller must settle that caller with
 * UnzenCancelledError even though the underlying work is not aborted for the
 * others. The listener is always removed, so no leak survives.
 */
export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new UnzenCancelledError('Execution cancelled by caller'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new UnzenCancelledError('Execution cancelled by caller'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
