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

export interface AbortSignalInputSnapshot {
  readonly signal?: AbortSignal;
  readonly initiallyAborted: boolean;
}

/** Live-read an AbortSignal without trusting a mutable structural stand-in. */
export function readAbortSignalAborted(signal?: AbortSignal): boolean {
  if (!signal) return false;

  let aborted: unknown;
  try {
    aborted = signal.aborted;
  } catch {
    throw new TypeError('signal state could not be read');
  }
  if (typeof aborted !== 'boolean') {
    throw new TypeError('signal state must be a boolean');
  }
  return aborted;
}

/**
 * Subscribe once and close the check/listen race.
 *
 * AbortSignal is accepted structurally at the public boundary, so its methods
 * can throw or invoke the listener synchronously. Cleanup is best-effort and
 * never allowed to prevent the owning request from settling.
 */
export function subscribeToAbortSignal(
  signal: AbortSignal,
  onAbort: () => void,
): () => void {
  let active = true;
  let mayBeRegistered = true;

  const removeListener = () => {
    if (!mayBeRegistered) return;
    mayBeRegistered = false;
    try {
      signal.removeEventListener('abort', guardedAbort);
    } catch {
      // Caller-owned cleanup must not corrupt executor/request settlement.
    }
  };
  const guardedAbort = () => {
    if (!active) return;
    active = false;
    try {
      onAbort();
    } finally {
      removeListener();
    }
  };
  const unsubscribe = () => {
    active = false;
    removeListener();
  };

  try {
    signal.addEventListener('abort', guardedAbort, { once: true });
    if (!active) {
      // A structural stand-in can invoke the callback before it finishes
      // storing the listener. Remove once more after registration returns.
      mayBeRegistered = true;
      removeListener();
    } else if (readAbortSignalAborted(signal)) {
      guardedAbort();
    }
  } catch {
    // addEventListener may throw after partially registering the callback.
    mayBeRegistered = true;
    unsubscribe();
    throw new TypeError('signal could not be subscribed');
  }

  return unsubscribe;
}

/** Validate and snapshot an optional AbortSignal reference before side effects. */
export function snapshotAbortSignalInput(value: unknown): AbortSignalInputSnapshot {
  if (value === undefined) return { initiallyAborted: false };
  if (typeof value !== 'object' || value === null) {
    throw new TypeError('signal must be an AbortSignal');
  }

  let aborted: unknown;
  let addEventListener: unknown;
  let removeEventListener: unknown;
  try {
    const record = value as Record<string, unknown>;
    aborted = record.aborted;
    addEventListener = record.addEventListener;
    removeEventListener = record.removeEventListener;
  } catch {
    throw new TypeError('signal must be an AbortSignal');
  }
  if (
    typeof aborted !== 'boolean'
    || typeof addEventListener !== 'function'
    || typeof removeEventListener !== 'function'
  ) {
    throw new TypeError('signal must be an AbortSignal');
  }
  return { signal: value as AbortSignal, initiallyAborted: aborted };
}

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
  if (readAbortSignalAborted(signal)) {
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
  if (readAbortSignalAborted(signal)) {
    return Promise.reject(new UnzenCancelledError('Execution cancelled by caller'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      callback();
    };

    promise.then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );

    try {
      unsubscribe = subscribeToAbortSignal(signal, () => {
        settle(() => reject(new UnzenCancelledError('Execution cancelled by caller')));
      });
    } catch (error) {
      settle(() => reject(error));
    }
  });
}
