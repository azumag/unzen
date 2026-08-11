import { MAX_FUNCTION_PAYLOAD_BYTES, type MoonBitAbi } from '@unzen/shared';
import { snapshotAbortSignalInput } from './abort';

export interface MoonBitExecutionOptionsSnapshot {
  readonly signal?: AbortSignal;
  readonly signalInitiallyAborted: boolean;
  readonly exportName: string;
  readonly moonbitAbi?: MoonBitAbi;
  readonly expectedHash?: string;
}

/** Validate an optional signal before a fetch, queue, or worker side effect. */
export function snapshotMoonBitAbortSignal(value: unknown) {
  try {
    return snapshotAbortSignalInput(value);
  } catch {
    throw new Error('MoonBit execution signal must be an AbortSignal');
  }
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
  let byteLength: number;
  try {
    const byteLengthGetter = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      'byteLength',
    )?.get;
    if (byteLengthGetter === undefined) throw new Error('missing byteLength getter');
    byteLength = Reflect.apply(byteLengthGetter, value, []) as number;
  } catch {
    throw new Error('MoonBit inline module must be an ArrayBuffer');
  }
  if (byteLength > MAX_FUNCTION_PAYLOAD_BYTES) {
    throw new Error(`MoonBit inline module exceeds ${MAX_FUNCTION_PAYLOAD_BYTES} bytes`);
  }
  return Reflect.apply(ArrayBuffer.prototype.slice, value, [0]) as ArrayBuffer;
}
