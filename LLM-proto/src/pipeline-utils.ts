/**
 * Shared utilities for Pipeline and SpanPipeline.
 *
 * Extracted to avoid code duplication between the two pipeline implementations.
 * Both pipelines need timeout-racing and retry delays with identical semantics.
 */

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
 * Async delay. Returns immediately if ms <= 0 (avoids fake-timer freeze in tests).
 */
export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
