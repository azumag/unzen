import {
  MAX_EXECUTION_REQUEST_BYTES,
  MAX_MOONBIT_ABI_PARAMS,
  normalizeMoonBitAbi,
  utf8ByteLength,
  type MoonBitAbi,
  type MoonBitAbiType,
} from '@unzen/shared';
import { isArrayContainer, readArrayIndex, readArrayLength } from './array-container';
import { describeMoonbitArgError, isSupportedScalar } from './moonbit-scalar';

/** Bound copy work and memory retained by one execution. */
export const MAX_MOONBIT_ARRAY_ELEMENTS = 100_000;
export const MAX_MOONBIT_ARGUMENTS = MAX_MOONBIT_ABI_PARAMS;
export const MAX_MOONBIT_STRING_BYTES = MAX_EXECUTION_REQUEST_BYTES;

export interface MoonBitCallSnapshot {
  args: unknown[];
  abi?: MoonBitAbi;
}

type MoonBitArrayAbiType = Exclude<MoonBitAbiType, 'scalar'>;

interface ArrayBridgeExports {
  create: string;
  set: string;
  length: string;
  get: string;
}

const ARRAY_BRIDGES: Record<MoonBitArrayAbiType, ArrayBridgeExports> = {
  'i32[]': {
    create: 'unzen_array_i32_new',
    set: 'unzen_array_i32_set',
    length: 'unzen_array_i32_length',
    get: 'unzen_array_i32_get',
  },
  'f64[]': {
    create: 'unzen_array_f64_new',
    set: 'unzen_array_f64_set',
    length: 'unzen_array_f64_length',
    get: 'unzen_array_f64_get',
  },
};

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (isArrayContainer(value)) return 'array';
  return typeof value;
}

/** Format arbitrary bridge failures without invoking object/function coercion. */
function describeBridgeFailure(error: unknown): string {
  if (error === null) return 'null';

  const kind = typeof error;
  if (kind !== 'object' && kind !== 'function') {
    return String(error);
  }
  if (kind === 'function') return 'Unknown error';

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

/** Describe an invalid bridge return value without coercing objects/functions. */
function describeBridgeValue(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'object' || kind === 'function') return kind;
  return String(value);
}

function assertArrayElement(type: MoonBitArrayAbiType, value: unknown, path: string): void {
  if (type === 'i32[]') {
    if (
      typeof value !== 'number'
      || !Number.isInteger(value)
      || value < -2_147_483_648
      || value > 2_147_483_647
    ) {
      throw new Error(`${path} must be a signed 32-bit integer`);
    }
    return;
  }
  if (typeof value !== 'number') {
    throw new Error(`${path} must be a number`);
  }
}

/** Capture the caller-owned top-level argument array without iterators/coercion. */
function snapshotTopLevelMoonBitArguments(args: unknown): unknown[] {
  if (!isArrayContainer(args)) {
    throw new Error('MoonBit arguments must be an array');
  }
  const lengthRead = readArrayLength(args);
  if (!lengthRead.ok) {
    throw new Error('MoonBit arguments could not be read');
  }
  const argCount = lengthRead.value;
  if (
    typeof argCount !== 'number'
    || !Number.isInteger(argCount)
    || argCount < 0
    || argCount > MAX_MOONBIT_ARGUMENTS
  ) {
    throw new Error(`MoonBit supports at most ${MAX_MOONBIT_ARGUMENTS} arguments`);
  }

  const snapshot = new Array<unknown>(argCount);
  for (let index = 0; index < argCount; index++) {
    const read = readArrayIndex(args, index);
    if (!read.ok) {
      throw new Error('MoonBit arguments could not be read');
    }
    snapshot[index] = read.value;
  }
  return snapshot;
}

/** Validate an already-owned argument snapshot. */
function validateOwnedMoonBitArguments(args: unknown[], abi?: MoonBitAbi): void {
  const argCount = args.length;
  let totalStringBytes = 0;
  const validateScalar = (arg: unknown, errorPrefix: string): void => {
    if (!isSupportedScalar(arg)) {
      throw new Error(describeMoonbitArgError(errorPrefix, arg));
    }
    if (typeof arg === 'string') {
      totalStringBytes += utf8ByteLength(
        arg,
        MAX_MOONBIT_STRING_BYTES - totalStringBytes,
      );
      if (totalStringBytes > MAX_MOONBIT_STRING_BYTES) {
        throw new Error(
          `MoonBit string arguments exceed ${MAX_MOONBIT_STRING_BYTES} total UTF-8 bytes`,
        );
      }
    }
  };

  if (abi === undefined) {
    for (let argIndex = 0; argIndex < argCount; argIndex++) {
      validateScalar(
        args[argIndex],
        'MoonBit supports number/boolean/bigint/string arguments only',
      );
    }
    return;
  }

  if (argCount !== abi.params.length) {
    throw new Error(`MoonBit ABI expects ${abi.params.length} arguments, got ${argCount}`);
  }

  let totalArrayElements = 0;
  for (let argIndex = 0; argIndex < abi.params.length; argIndex++) {
    const type = abi.params[argIndex];
    const arg = args[argIndex];
    if (type === 'scalar') {
      validateScalar(arg, `MoonBit ABI argument ${argIndex} expects a scalar`);
      continue;
    }
    if (!Array.isArray(arg)) {
      throw new Error(
        `MoonBit ABI argument ${argIndex} expects ${type} (got ${describeValue(arg)})`,
      );
    }
    const arrayLength = arg.length;
    totalArrayElements += arrayLength;
    if (totalArrayElements > MAX_MOONBIT_ARRAY_ELEMENTS) {
      throw new Error(
        `MoonBit array arguments exceed ${MAX_MOONBIT_ARRAY_ELEMENTS} total elements`,
      );
    }
    for (let elementIndex = 0; elementIndex < arrayLength; elementIndex++) {
      assertArrayElement(type, arg[elementIndex],
        `MoonBit ABI argument ${argIndex} ${type} element ${elementIndex}`);
    }
  }
}

/** Validate ABI metadata and arguments before instantiation/postMessage. */
export function validateMoonBitArguments(args: unknown[], abi?: MoonBitAbi): void {
  void snapshotMoonBitCall(args, abi);
}

/**
 * Snapshot and validate one call before asynchronous work. Shape/length
 * preflight happens before any nested array allocation or element iteration.
 */
export function snapshotMoonBitCall(
  args: unknown[],
  abi?: MoonBitAbi,
): MoonBitCallSnapshot {
  const topLevelArgs = snapshotTopLevelMoonBitArguments(args);
  const argCount = topLevelArgs.length;

  if (abi === undefined) {
    validateOwnedMoonBitArguments(topLevelArgs);
    return { args: topLevelArgs };
  }

  const snapshotAbi = normalizeMoonBitAbi(abi);
  if (snapshotAbi === undefined) {
    throw new Error('Invalid MoonBit ABI metadata');
  }

  const snapshotParams = snapshotAbi.params;
  const paramCount = snapshotParams.length;
  if (argCount !== paramCount) {
    throw new Error(`MoonBit ABI expects ${paramCount} arguments, got ${argCount}`);
  }

  const arrayLengths = new Array<number | undefined>(argCount);
  const arraySources = new Array<unknown>(argCount);
  let totalArrayElements = 0;
  for (let argIndex = 0; argIndex < argCount; argIndex++) {
    const type = snapshotParams[argIndex];
    if (type === 'scalar') continue;
    const arg = topLevelArgs[argIndex];
    if (!isArrayContainer(arg)) {
      throw new Error(
        `MoonBit ABI argument ${argIndex} expects ${type} (got ${describeValue(arg)})`,
      );
    }
    const lengthRead = readArrayLength(arg);
    if (!lengthRead.ok) {
      throw new Error(`MoonBit ABI argument ${argIndex} has an invalid array length`);
    }
    const arrayLength = lengthRead.value;
    if (typeof arrayLength !== 'number' || !Number.isInteger(arrayLength) || arrayLength < 0) {
      throw new Error(`MoonBit ABI argument ${argIndex} has an invalid array length`);
    }
    totalArrayElements += arrayLength;
    if (totalArrayElements > MAX_MOONBIT_ARRAY_ELEMENTS) {
      throw new Error(
        `MoonBit array arguments exceed ${MAX_MOONBIT_ARRAY_ELEMENTS} total elements`,
      );
    }
    arrayLengths[argIndex] = arrayLength;
    arraySources[argIndex] = arg;
  }

  const snapshotArgs = new Array<unknown>(argCount);
  for (let argIndex = 0; argIndex < argCount; argIndex++) {
    const arrayLength = arrayLengths[argIndex];
    if (arrayLength === undefined) {
      snapshotArgs[argIndex] = topLevelArgs[argIndex];
      continue;
    }
    const source = arraySources[argIndex];
    const values = new Array<unknown>(arrayLength);
    for (let elementIndex = 0; elementIndex < arrayLength; elementIndex++) {
      const read = readArrayIndex(source, elementIndex);
      if (!read.ok) {
        throw new Error(`MoonBit ABI argument ${argIndex} could not be read`);
      }
      values[elementIndex] = read.value;
    }
    snapshotArgs[argIndex] = values;
  }

  validateOwnedMoonBitArguments(snapshotArgs, snapshotAbi);
  return { args: snapshotArgs, abi: snapshotAbi };
}

function requireBridgeFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...args: unknown[]) => unknown {
  const fn = (instance.exports as Record<string, unknown>)[name];
  if (typeof fn !== 'function') {
    throw new Error(`MoonBit module does not export required array bridge "${name}"`);
  }
  return fn as (...args: unknown[]) => unknown;
}

/** Copy validated JS arrays into opaque MoonBit wasm-gc array handles. */
export function marshalMoonBitArguments(
  instance: WebAssembly.Instance,
  args: unknown[],
  abi?: MoonBitAbi,
): unknown[] {
  if (abi === undefined) return args;

  return args.map((arg, argIndex) => {
    const type = abi.params[argIndex];
    if (type === 'scalar') return arg;
    const values = arg as number[];
    const bridge = ARRAY_BRIDGES[type];
    const create = requireBridgeFunction(instance, bridge.create);
    const set = requireBridgeFunction(instance, bridge.set);
    let handle: unknown;
    try {
      handle = create(values.length);
      for (let index = 0; index < values.length; index++) {
        set(handle, index, values[index]);
      }
    } catch (error) {
      throw new Error(
        `MoonBit ${type} bridge failed while copying argument ${argIndex}: `
        + describeBridgeFailure(error),
      );
    }
    return handle;
  });
}

/** Copy an opaque MoonBit array result back into a plain JS number array. */
export function unmarshalMoonBitResult(
  instance: WebAssembly.Instance,
  result: unknown,
  abi?: MoonBitAbi,
): unknown {
  const type = abi?.result ?? 'scalar';
  if (type === 'scalar') {
    if (!isSupportedScalar(result)) {
      throw new Error('MoonBit export returned an unsupported (non-scalar) value');
    }
    if (
      typeof result === 'string'
      && utf8ByteLength(result, MAX_MOONBIT_STRING_BYTES) > MAX_MOONBIT_STRING_BYTES
    ) {
      throw new Error(`MoonBit string result exceeds ${MAX_MOONBIT_STRING_BYTES} UTF-8 bytes`);
    }
    return result;
  }

  const bridge = ARRAY_BRIDGES[type];
  const lengthFn = requireBridgeFunction(instance, bridge.length);
  const get = requireBridgeFunction(instance, bridge.get);
  let length: unknown;
  try {
    length = lengthFn(result);
  } catch (error) {
    throw new Error(
      `MoonBit ${type} bridge failed while reading result length: `
      + describeBridgeFailure(error),
    );
  }
  if (
    typeof length !== 'number'
    || !Number.isInteger(length)
    || length < 0
    || length > MAX_MOONBIT_ARRAY_ELEMENTS
  ) {
    throw new Error(
      `MoonBit ${type} bridge returned invalid result length ${describeBridgeValue(length)} `
      + `(max ${MAX_MOONBIT_ARRAY_ELEMENTS})`,
    );
  }

  const values = new Array<number>(length);
  try {
    for (let index = 0; index < length; index++) {
      const value = get(result, index);
      assertArrayElement(type, value, `MoonBit ${type} result element ${index}`);
      values[index] = value as number;
    }
  } catch (error) {
    throw new Error(
      `MoonBit ${type} bridge failed while copying result: `
      + describeBridgeFailure(error),
    );
  }
  return values;
}
