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

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

export function delayWithSignal(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
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
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`checkpoint timeout must be positive: ${timeoutMs}`);
  }
  const deadline = now() + timeoutMs;
  for (;;) {
    throwIfAborted(signal);
    const response = await fetchCheckpoint(signal);
    throwIfAborted(signal);
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`checkpoint fetch failed: ${response.status}`);
      return response.json();
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new CheckpointWaitTimeoutError(timeoutMs);
    await sleep(Math.min(pollIntervalMs, remaining), signal);
    if (now() >= deadline) throw new CheckpointWaitTimeoutError(timeoutMs);
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
