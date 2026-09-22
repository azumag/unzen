/** Largest delay accepted consistently by browser timer implementations. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type WorkerFactory = (url: string | URL) => Worker;

interface WorkerMethodSnapshot {
  readonly postMessage: (...args: unknown[]) => unknown;
  readonly terminate: () => unknown;
}

/**
 * Normalize an arbitrary caller/browser Worker lifecycle failure without
 * invoking object/function coercion.
 *
 * Primitive thrown values keep the same useful text that the previous
 * String(error) catch paths exposed. Ordinary Error instances contribute only
 * a safely snapshotted string message; the returned Error is always owned by
 * the executor boundary so a stateful Proxy cannot become hostile after the
 * first prototype/message read. Revoked Proxies, throwing prototype
 * checks/message getters, and other object/function values collapse to an
 * owned Error with a stable diagnostic.
 */
function normalizeWorkerHostFailure(error: unknown): Error {
  if (error === null) return new Error('null');

  const kind = typeof error;
  if (kind !== 'object' && kind !== 'function') {
    return new Error(String(error));
  }

  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    return new Error('Unknown error');
  }
  if (!isError) return new Error('Unknown error');

  let message: unknown;
  try {
    message = (error as Error).message;
  } catch {
    return new Error('Unknown error');
  }
  return new Error(typeof message === 'string' ? message : 'Unknown error');
}

/**
 * Snapshot the only MessageEvent field consumed by the executors. An
 * unreadable/revoked custom event becomes an undefined payload, which existing
 * protocol validation classifies as a malformed worker response.
 */
function snapshotWorkerMessageEvent(event: unknown): MessageEvent<unknown> {
  let data: unknown;
  if ((typeof event === 'object' || typeof event === 'function') && event !== null) {
    try {
      data = (event as { data?: unknown }).data;
    } catch {
      data = undefined;
    }
  }
  return { data } as MessageEvent<unknown>;
}

/** Snapshot custom Worker error diagnostics without trusting the event object. */
function snapshotWorkerErrorEvent(event: unknown): ErrorEvent {
  let message = 'unknown error';
  if ((typeof event === 'object' || typeof event === 'function') && event !== null) {
    try {
      const candidate = (event as { message?: unknown }).message;
      if (typeof candidate === 'string') message = candidate;
    } catch {
      // Keep the stable fallback; never coerce the caller-owned envelope.
    }
  }
  return { message } as ErrorEvent;
}

/** Read the minimal Worker method surface exactly once. */
function snapshotWorkerMethods(value: unknown): WorkerMethodSnapshot {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new TypeError('createWorker must return a Worker-like object');
  }

  let postMessage: unknown;
  let terminate: unknown;
  try {
    postMessage = (value as { postMessage?: unknown }).postMessage;
    terminate = (value as { terminate?: unknown }).terminate;
  } catch {
    throw new TypeError('createWorker result could not be inspected');
  }

  if (typeof postMessage !== 'function' || typeof terminate !== 'function') {
    throw new TypeError('createWorker must return a Worker-like object');
  }

  return {
    postMessage: postMessage as (...args: unknown[]) => unknown,
    terminate: terminate as () => unknown,
  };
}

/**
 * Wrap a caller-provided Worker in the exact host surface used by the
 * executors. The wrapper preserves handler assignment on the underlying Worker
 * while ensuring lifecycle failures and event envelopes cross the executor
 * boundary only as owned values.
 */
function createBoundedWorkerFacade(worker: unknown): Worker {
  const methods = snapshotWorkerMethods(worker);
  const target = worker as Worker;
  let currentOnMessage: Worker['onmessage'] = null;
  let currentOnError: Worker['onerror'] = null;

  const facade = {
    get onmessage(): Worker['onmessage'] {
      return currentOnMessage;
    },
    set onmessage(handler: Worker['onmessage']) {
      const boundedHandler = handler === null
        ? null
        : ((event: MessageEvent<unknown>) => {
            Reflect.apply(
              handler as unknown as (...args: unknown[]) => unknown,
              target,
              [snapshotWorkerMessageEvent(event)],
            );
          }) as Worker['onmessage'];
      try {
        target.onmessage = boundedHandler;
      } catch (error) {
        throw normalizeWorkerHostFailure(error);
      }
      currentOnMessage = handler;
    },
    get onerror(): Worker['onerror'] {
      return currentOnError;
    },
    set onerror(handler: Worker['onerror']) {
      const boundedHandler = handler === null
        ? null
        : ((event: unknown) => {
            Reflect.apply(
              handler as unknown as (...args: unknown[]) => unknown,
              target,
              [snapshotWorkerErrorEvent(event)],
            );
          }) as Worker['onerror'];
      try {
        target.onerror = boundedHandler;
      } catch (error) {
        throw normalizeWorkerHostFailure(error);
      }
      currentOnError = handler;
    },
    postMessage(...args: unknown[]): void {
      try {
        Reflect.apply(methods.postMessage, target, args);
      } catch (error) {
        throw normalizeWorkerHostFailure(error);
      }
    },
    terminate(): void {
      try {
        Reflect.apply(methods.terminate, target, []);
      } catch (error) {
        throw normalizeWorkerHostFailure(error);
      }
    },
  };

  return facade as unknown as Worker;
}

/** Require the constructor options bag before reading any of its fields. */
export function assertWorkerOptions(value: unknown): asserts value is Record<string, unknown> {
  let isArray = false;
  if (typeof value === 'object' && value !== null) {
    try {
      isArray = Array.isArray(value);
    } catch {
      throw new TypeError('Worker executor options must be an object');
    }
  }
  if (typeof value !== 'object' || value === null || isArray) {
    throw new TypeError('Worker executor options must be an object');
  }
}

/** Read a fixed worker option surface once before any executor state is initialized. */
export function snapshotWorkerOptions(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  assertWorkerOptions(value);
  const snapshot = Object.create(null) as Record<string, unknown>;
  try {
    for (const field of fields) snapshot[field] = value[field];
  } catch {
    throw new TypeError('Worker executor options could not be read');
  }
  return snapshot;
}

export function normalizeWorkerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('workerUrl must be a non-empty string');
  }
  return value;
}

export function normalizeTimerMs(
  name: string,
  value: unknown,
  fallback: number,
): number {
  const normalized = value === undefined ? fallback : value;
  if (
    typeof normalized !== 'number'
    || !Number.isInteger(normalized)
    || normalized < 1
    || normalized > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return normalized;
}

export function normalizeQueueSize(value: unknown, fallback: number): number {
  const normalized = value === undefined ? fallback : value;
  if (
    typeof normalized !== 'number'
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError('maxQueueSize must be a non-negative safe integer');
  }
  return normalized;
}

export function normalizeHardKillMultiplier(value: unknown, fallback: number): number {
  const normalized = value === undefined ? fallback : value;
  if (
    typeof normalized !== 'number'
    || !Number.isFinite(normalized)
    || normalized <= 0
  ) {
    throw new TypeError('hardKillMultiplier must be a positive finite number');
  }
  return normalized;
}

export function assertValidHardKillDelay(timeout: number, multiplier: number): void {
  const delay = timeout * multiplier;
  if (!Number.isFinite(delay) || delay < 1 || delay > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `hard-kill delay must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds`,
    );
  }
}

export function normalizeWorkerFactory(
  value: unknown,
  fallback: WorkerFactory,
): WorkerFactory {
  if (value === undefined) return fallback;
  if (typeof value !== 'function') {
    throw new TypeError('createWorker must be a function');
  }

  const factory = value as WorkerFactory;
  return (url) => {
    let worker: unknown;
    try {
      worker = factory(url);
    } catch (error) {
      throw normalizeWorkerHostFailure(error);
    }
    return createBoundedWorkerFacade(worker);
  };
}

/** Validate the minimal Worker surface used by the executors. */
export function assertWorkerInstance(value: unknown): asserts value is Worker {
  snapshotWorkerMethods(value);
}

/** Detach caller-owned handlers and terminate without letting cleanup faults escape. */
export function detachAndTerminateWorker(worker: Worker): void {
  try {
    worker.onmessage = null;
  } catch {
    // A custom Worker implementation must not prevent the remaining cleanup.
  }
  try {
    worker.onerror = null;
  } catch {
    // A custom Worker implementation must not prevent termination.
  }
  try {
    worker.terminate();
  } catch {
    // Cleanup is best-effort; the executor still has to settle its callers.
  }
}
