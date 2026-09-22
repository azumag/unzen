import { UnzenFunctionError, UnzenRuntimeError } from '@unzen/shared';

/**
 * Preserve known server QuickJS errors without letting hostile values escape
 * through Symbol.hasInstance / Proxy prototype traps.
 */
export function isKnownQuickJsRuntimeError(
  error: unknown,
): error is UnzenRuntimeError | UnzenFunctionError {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
    return false;
  }

  try {
    return error instanceof UnzenRuntimeError || error instanceof UnzenFunctionError;
  } catch {
    return false;
  }
}

/**
 * Format an arbitrary host/runtime failure without invoking object/function
 * coercion. Sandbox-thrown values intentionally dumped from QuickJS use the
 * separate shared formatSandboxError() path.
 */
export function describeQuickJsRuntimeFailure(error: unknown): string {
  if (error === null) return 'null';

  const kind = typeof error;
  if (kind !== 'object' && kind !== 'function') {
    return String(error);
  }

  let isError = false;
  try {
    isError = error instanceof Error;
  } catch {
    return 'Unknown error';
  }
  if (!isError) return 'Unknown error';

  let message: unknown;
  try {
    message = (error as Error).message;
  } catch {
    return 'Unknown error';
  }
  return typeof message === 'string' ? message : 'Unknown error';
}
