import type { MoonBitAbi } from '@unzen/shared';

export interface MoonBitExecutionOptionsSnapshot {
  readonly signal?: AbortSignal;
  readonly signalInitiallyAborted: boolean;
  readonly exportName: string;
  readonly moonbitAbi?: MoonBitAbi;
  readonly expectedHash?: string;
}

export interface MoonBitAbortSignalSnapshot {
  readonly signal?: AbortSignal;
  readonly initiallyAborted: boolean;
}

/** Validate an optional signal before a fetch, queue, or worker side effect. */
export function snapshotMoonBitAbortSignal(value: unknown): MoonBitAbortSignalSnapshot {
  if (value === undefined) return { initiallyAborted: false };
  if (typeof value !== 'object' || value === null) {
    throw new Error('MoonBit execution signal must be an AbortSignal');
  }

  let aborted: unknown;
  let addEventListener: unknown;
  let removeEventListener: unknown;
  try {
    const record = value as Record<string, unknown>;
    aborted = record.aborted;
    addEventListener = record.addEventListener;
    removeEventListener = record.removeEventListener;
  } catch {
    throw new Error('MoonBit execution signal must be an AbortSignal');
  }
  if (
    typeof aborted !== 'boolean'
    || typeof addEventListener !== 'function'
    || typeof removeEventListener !== 'function'
  ) {
    throw new Error('MoonBit execution signal must be an AbortSignal');
  }
  return { signal: value as AbortSignal, initiallyAborted: aborted };
}

/** Read per-execution options once before any asynchronous MoonBit work. */
export function snapshotMoonBitExecutionOptions(
  value: unknown,
): MoonBitExecutionOptionsSnapshot {
  if (value === undefined) {
    return { signalInitiallyAborted: false, exportName: 'run' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MoonBit execution options must be an object');
  }

  let signal: unknown;
  let exportName: unknown;
  let moonbitAbi: unknown;
  let expectedHash: unknown;
  try {
    const record = value as Record<string, unknown>;
    signal = record.signal;
    exportName = record.exportName;
    moonbitAbi = record.moonbitAbi;
    expectedHash = record.expectedHash;
  } catch {
    throw new Error('MoonBit execution options could not be read');
  }

  const signalSnapshot = snapshotMoonBitAbortSignal(signal);
  if (exportName !== undefined && typeof exportName !== 'string') {
    throw new Error('MoonBit exportName must be a string');
  }
  if (moonbitAbi !== undefined && (typeof moonbitAbi !== 'object' || moonbitAbi === null)) {
    throw new Error('Invalid MoonBit ABI metadata');
  }
  if (expectedHash !== undefined && typeof expectedHash !== 'string') {
    throw new Error('MoonBit expectedHash must be a string');
  }

  return {
    signal: signalSnapshot.signal,
    signalInitiallyAborted: signalSnapshot.initiallyAborted,
    exportName: (exportName as string | undefined) ?? 'run',
    moonbitAbi: moonbitAbi as MoonBitAbi | undefined,
    expectedHash: expectedHash as string | undefined,
  };
}

/** Reject unusable fetch identities before touching a network/cache boundary. */
export function normalizeMoonBitModuleUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('MoonBit module URL must be a non-empty string');
  }
  return value;
}

/** Take private ownership of inline wasm bytes before worker initialization. */
export function snapshotMoonBitModuleBytes(value: unknown): ArrayBuffer {
  try {
    return Reflect.apply(ArrayBuffer.prototype.slice, value, [0]) as ArrayBuffer;
  } catch {
    throw new Error('MoonBit inline module must be an ArrayBuffer');
  }
}
