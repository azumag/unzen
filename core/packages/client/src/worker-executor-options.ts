/** Largest delay accepted consistently by browser timer implementations. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type WorkerFactory = (url: string | URL) => Worker;

/** Require the constructor options bag before reading any of its fields. */
export function assertWorkerOptions(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
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
  return value as WorkerFactory;
}

/** Validate the minimal Worker surface used by the executors. */
export function assertWorkerInstance(value: unknown): asserts value is Worker {
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
