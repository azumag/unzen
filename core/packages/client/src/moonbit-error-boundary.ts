import {
  UnzenCancelledError,
  UnzenNetworkError,
  UnzenRuntimeError,
} from '@unzen/shared';

const UNKNOWN_MOONBIT_FAILURE = 'Unknown error';

function isObjectLike(value: unknown): value is object | ((...args: never[]) => unknown) {
  const kind = typeof value;
  return value !== null && (kind === 'object' || kind === 'function');
}

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

/** Bound ordinary Error identity checks against revoked/hostile Proxies. */
export function isMoonBitErrorFailure(error: unknown): error is Error {
  if (!isObjectLike(error)) return false;
  try {
    return error instanceof Error;
  } catch {
    return false;
  }
}

/** Bound cancellation identity checks against revoked/hostile Proxies. */
export function isMoonBitCancelledFailure(error: unknown): error is UnzenCancelledError {
  if (!isObjectLike(error)) return false;
  try {
    return error instanceof UnzenCancelledError;
  } catch {
    return false;
  }
}

/** Bound network-error identity checks against revoked/hostile Proxies. */
export function isMoonBitNetworkFailure(error: unknown): error is UnzenNetworkError {
  if (!isObjectLike(error)) return false;
  try {
    return error instanceof UnzenNetworkError;
  } catch {
    return false;
  }
}

/** Bound runtime-error identity checks against revoked/hostile Proxies. */
export function isMoonBitRuntimeFailure(error: unknown): error is UnzenRuntimeError {
  if (!isObjectLike(error)) return false;
  try {
    return error instanceof UnzenRuntimeError;
  } catch {
    return false;
  }
}
