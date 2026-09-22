/**
 * Format an arbitrary host/runtime failure without invoking object/function
 * coercion. This is deliberately separate from formatSandboxError(), which is
 * used for values intentionally dumped from sandboxed QuickJS code.
 */
export function describeQuickJsWorkerFailure(error: unknown): string {
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
