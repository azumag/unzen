export const MAX_HOST_TIMER_DELAY_MS = 2_147_483_647;

export class CheckpointWaitTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Coordinator checkpoint wait exceeded ${timeoutMs}ms`);
    this.name = 'CheckpointWaitTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function abortError(reason = 'operation aborted') {
  return new DOMException(reason, 'AbortError');
}

function readAbortSignalState(signal) {
  if (signal === undefined || signal === null) return false;
  let aborted;
  try {
    aborted = signal.aborted;
  } catch {
    throw new TypeError('AbortSignal state could not be read');
  }
  if (typeof aborted !== 'boolean') {
    throw new TypeError('AbortSignal aborted state must be boolean');
  }
  return aborted;
}

export function throwIfAborted(signal) {
  if (readAbortSignalState(signal)) throw abortError();
}

function requirePositiveSafeInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer: ${String(value)}`);
  }
  return value;
}

function requireHostTimerDelay(value, label, { allowZero }) {
  const minimum = allowZero ? 0 : 1;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > MAX_HOST_TIMER_DELAY_MS
  ) {
    const domain = allowZero ? 'non-negative' : 'positive';
    throw new Error(
      `${label} must be a ${domain} safe integer <= ${MAX_HOST_TIMER_DELAY_MS}: ${String(value)}`,
    );
  }
  return value;
}

export function delayWithSignal(ms, signal) {
  const delayMs = requireHostTimerDelay(ms, 'delay', { allowZero: true });
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let listenerMayBeRegistered = false;
    const removeAbortListener = () => {
      if (!listenerMayBeRegistered) return;
      listenerMayBeRegistered = false;
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch {
        // Caller-owned cleanup must never prevent the delay from settling.
      }
    };
    const finish = (action) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
      action();
    };
    const onAbort = () => finish(() => reject(abortError()));
    timer = setTimeout(() => finish(resolve), delayMs);

    if (signal !== undefined && signal !== null) {
      listenerMayBeRegistered = true;
      try {
        signal.addEventListener('abort', onAbort, { once: true });
        // Close the check-then-listen race: an AbortSignal that flips after the
        // initial throwIfAborted() but before listener installation must still
        // cancel this delay rather than resolving after the timer.
        if (readAbortSignalState(signal)) onAbort();
      } catch (error) {
        finish(() => reject(
          error?.name === 'AbortError'
            ? error
            : new TypeError('AbortSignal could not be subscribed for delay'),
        ));
      }
    }
  });
}

/**
 * Poll a Coordinator-owned checkpoint with both explicit cancellation and an
 * absolute max wait. `fetchCheckpoint` should return a Response-like object.
 */
export async function waitForCheckpointBounded({
  fetchCheckpoint,
  signal,
  timeoutMs,
  pollIntervalMs = 500,
  now = () => Date.now(),
  sleep = delayWithSignal,
}) {
  const stableTimeoutMs = requirePositiveSafeInteger(timeoutMs, 'checkpoint timeout');
  const stablePollIntervalMs = requireHostTimerDelay(
    pollIntervalMs,
    'checkpoint poll interval',
    { allowZero: false },
  );
  // Keep long timeout budgets in their original safe-integer domain instead of
  // adding them to an epoch timestamp, which can cross MAX_SAFE_INTEGER and
  // lose millisecond identity even though the timeout itself is valid.
  const startedAt = now();
  const elapsedSinceStart = () => now() - startedAt;
  for (;;) {
    throwIfAborted(signal);
    const response = await fetchCheckpoint(signal);
    throwIfAborted(signal);
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`checkpoint fetch failed: ${response.status}`);
      return response.json();
    }
    const remaining = stableTimeoutMs - elapsedSinceStart();
    if (remaining <= 0) throw new CheckpointWaitTimeoutError(stableTimeoutMs);
    await sleep(Math.min(stablePollIntervalMs, remaining), signal);
    if (elapsedSinceStart() >= stableTimeoutMs) {
      throw new CheckpointWaitTimeoutError(stableTimeoutMs);
    }
  }
}

/**
 * Own an ORT session and guarantee release is attempted at most once. The
 * wrapper makes the lifecycle explicit and is usable with fake ORT sessions in
 * tests without importing the browser runner.
 */
export function ownSession(session) {
  let released = false;
  return {
    session,
    get released() {
      return released;
    },
    async release() {
      if (released) return false;
      released = true;
      await session.release();
      return true;
    },
  };
}
