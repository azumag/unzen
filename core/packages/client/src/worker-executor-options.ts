/** Largest delay accepted consistently by browser timer implementations. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type WorkerFactory = (url: string | URL) => Worker;

/** Require the constructor options bag before reading any of its fields. */
export function assertWorkerOptions(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Worker executor options must be an object');
  }
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
