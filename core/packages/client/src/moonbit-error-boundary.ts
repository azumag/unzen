import { UnzenCancelledError } from '@unzen/shared';

const UNKNOWN_MOONBIT_FAILURE = 'Unknown error';

/**
 * Format an arbitrary caught value without invoking object/function coercion.
 *
 * Primitive values keep their useful text. Object/function values are only
 * inspected as Error instances, and every potentially hostile operation is
 * bounded so revoked Proxies or throwing accessors cannot escape the catch
 * path. In particular, Symbol.toPrimitive/valueOf/toString are never called.
 */
export function describeMoonBitFailure(error: unknown): string {
  if (error === null) return 'null';

  const kind = typeof error;
  if (kind !== 'object' && kind !== 'function') {
    return String(error);
  }

  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    return UNKNOWN_MOONBIT_FAILURE;
  }
  if (!isError) return UNKNOWN_MOONBIT_FAILURE;

  let message: unknown;
  try {
    message = (error as Error).message;
  } catch {
    return UNKNOWN_MOONBIT_FAILURE;
  }
  return typeof message === 'string' ? message : UNKNOWN_MOONBIT_FAILURE;
}

/** Bound cancellation identity checks against revoked/hostile Proxies. */
export function isMoonBitCancelledFailure(error: unknown): boolean {
  if (error === null) return false;
  const kind = typeof error;
  if (kind !== 'object' && kind !== 'function') return false;

  try {
    return error instanceof UnzenCancelledError;
  } catch {
    return false;
  }
}
