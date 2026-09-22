/**
 * demo-error-boundary.js — safe formatting for unexpected demo failures.
 *
 * The demo normally receives structured ExecutionResult values from the SDK,
 * but the outer UI pipeline keeps a defensive catch for unexpected adapter or
 * SDK failures. Values crossing that catch boundary are untrusted JavaScript
 * values: they may be revoked Proxies or objects/functions with hostile
 * coercion hooks. Formatting must therefore never stringify arbitrary objects.
 *
 * Pure module: importable from both demo.js (browser) and vitest tests.
 */

const UNKNOWN_ERROR_MESSAGE = 'Unknown error';

/**
 * Format an arbitrary thrown/rejected value without invoking caller-controlled
 * object/function coercion hooks.
 *
 * Primitive values retain their useful String() representation. Object and
 * function values are only inspected as Error instances, with both the
 * `instanceof` operation and the `.message` read bounded because hostile or
 * revoked Proxies can throw from either operation. Non-string Error messages
 * are only converted when they are primitives.
 */
export function formatDemoThrownValue(value) {
  const kind = typeof value;
  if (value === null || (kind !== 'object' && kind !== 'function')) {
    return String(value);
  }

  let isError;
  try {
    isError = value instanceof Error;
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }
  if (!isError) return UNKNOWN_ERROR_MESSAGE;

  let message;
  try {
    message = value.message;
  } catch {
    return UNKNOWN_ERROR_MESSAGE;
  }

  const messageKind = typeof message;
  if (message === null || messageKind === 'object' || messageKind === 'function') {
    return UNKNOWN_ERROR_MESSAGE;
  }
  return String(message);
}
