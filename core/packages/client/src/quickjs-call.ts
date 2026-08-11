import {
  exceedsUtf8ByteLength,
  MAX_EXECUTION_ARGUMENTS,
  MAX_EXECUTION_REQUEST_BYTES,
  MAX_FUNCTION_PAYLOAD_BYTES,
} from '@unzen/shared';
import { snapshotAbortSignalInput } from './abort';

export interface QuickJsCallSnapshot {
  readonly code: string;
  readonly args: unknown[];
}

export interface QuickJsExecutionOptionsSnapshot {
  readonly signal?: AbortSignal;
  readonly signalInitiallyAborted: boolean;
}

/** Read the QuickJS per-call option bag once before code/argument work. */
export function snapshotQuickJsExecutionOptions(
  value: unknown,
): QuickJsExecutionOptionsSnapshot {
  if (value === undefined) return { signalInitiallyAborted: false };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('QuickJS execution options must be an object');
  }

  let signal: unknown;
  try {
    signal = (value as Record<string, unknown>).signal;
  } catch {
    throw new Error('QuickJS execution options could not be read');
  }

  try {
    const snapshot = snapshotAbortSignalInput(signal);
    return {
      signal: snapshot.signal,
      signalInitiallyAborted: snapshot.initiallyAborted,
    };
  } catch {
    throw new Error('QuickJS execution signal must be an AbortSignal');
  }
}

/**
 * Validate and own one QuickJS call before initialization or queueing.
 * QuickJS arguments cross a JSON boundary, so round-trip them now to prevent
 * later caller mutation and worker-side serialization failures.
 */
export function snapshotQuickJsCall(code: unknown, args: unknown): QuickJsCallSnapshot {
  if (typeof code !== 'string') {
    throw new Error('QuickJS code must be a non-empty string');
  }
  if (exceedsUtf8ByteLength(code, MAX_FUNCTION_PAYLOAD_BYTES)) {
    throw new Error(`QuickJS code exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
  }
  if (code.trim().length === 0) {
    throw new Error('QuickJS code must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new Error('QuickJS arguments must be an array');
  }

  const argumentCount: unknown = args.length;
  if (
    typeof argumentCount !== 'number'
    || !Number.isSafeInteger(argumentCount)
    || argumentCount < 0
    || argumentCount > MAX_EXECUTION_ARGUMENTS
  ) {
    throw new Error(`QuickJS supports at most ${MAX_EXECUTION_ARGUMENTS} arguments`);
  }

  let serialized: string;
  try {
    const indexedSnapshot = new Array<unknown>(argumentCount);
    for (let index = 0; index < argumentCount; index += 1) {
      indexedSnapshot[index] = args[index];
    }
    const candidate = JSON.stringify(indexedSnapshot);
    if (typeof candidate !== 'string') {
      throw new Error('serialization returned no payload');
    }
    serialized = candidate;
  } catch {
    throw new Error(
      `QuickJS arguments must be JSON-serializable and contain at most ${MAX_EXECUTION_ARGUMENTS} items`,
    );
  }
  if (exceedsUtf8ByteLength(serialized, MAX_EXECUTION_REQUEST_BYTES)) {
    throw new Error(`QuickJS arguments exceed ${MAX_EXECUTION_REQUEST_BYTES} bytes`);
  }
  const jsonSnapshot: unknown = JSON.parse(serialized);
  if (!Array.isArray(jsonSnapshot)) {
    throw new Error('Serialized QuickJS arguments were not an array');
  }
  return { code, args: jsonSnapshot };
}
