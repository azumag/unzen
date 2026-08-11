/** Execution contract shared by host-side mocks and QuickJS runtimes. */

export const UNZEN_ASYNC_RESULT_ERROR =
  'Unzen functions must return synchronously; Promise and thenable results are unsupported.';

export const UNZEN_ITERATOR_RESULT_ERROR =
  'Unzen functions must return a materialized value; iterator and generator results are unsupported.';

/** Reject deferred and iterator results before they cross the execution boundary. */
export function assertSynchronousUnzenResult(value: unknown): void {
  if (
    value === null
    || (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return;
  }

  const candidate = value as { then?: unknown; next?: unknown };
  if (typeof candidate.then === 'function') {
    throw new TypeError(UNZEN_ASYNC_RESULT_ERROR);
  }
  if (typeof candidate.next === 'function') {
    throw new TypeError(UNZEN_ITERATOR_RESULT_ERROR);
  }
}

/**
 * QuickJS expression that invokes the registered run function and enforces
 * the same synchronous result contract as assertSynchronousUnzenResult().
 */
export const SANDBOX_SYNCHRONOUS_EXECUTION = `
(function() {
  var value = run(...globalThis.__args__);
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (typeof value.then === 'function') {
      throw new TypeError(${JSON.stringify(UNZEN_ASYNC_RESULT_ERROR)});
    }
    if (typeof value.next === 'function') {
      throw new TypeError(${JSON.stringify(UNZEN_ITERATOR_RESULT_ERROR)});
    }
  }
  return value;
})()
`;
