export * from './durable-coordinator-core-impl.js';

import { DurableCoordinator as DurableCoordinatorImplementation } from './durable-coordinator-core-impl.js';
import type { SegmentAcceptance } from './durable-coordinator-core-impl.js';
import type { ExecutionResult } from './durable-types.js';

const NativeUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const invalidCheckpointPayload = Object.freeze({});

function stableUint8ArrayView(value: unknown): unknown {
  let isUint8Array = false;
  try {
    isUint8Array = value instanceof NativeUint8Array;
  } catch {
    return invalidCheckpointPayload;
  }

  if (!isUint8Array) return value;

  // A Proxy can satisfy instanceof while failing the TypedArray internal-slot
  // requirement. Reject it before any intrinsic getter or constructor can leak
  // a native TypeError through the durable result boundary.
  if (!ArrayBuffer.isView(value)) return invalidCheckpointPayload;

  if (
    typeof typedArrayBufferGetter !== 'function'
    || typeof typedArrayByteOffsetGetter !== 'function'
    || typeof typedArrayByteLengthGetter !== 'function'
  ) {
    return invalidCheckpointPayload;
  }

  try {
    const buffer = typedArrayBufferGetter.call(value) as ArrayBufferLike;
    const byteOffset = typedArrayByteOffsetGetter.call(value) as number;
    const byteLength = typedArrayByteLengthGetter.call(value) as number;

    // Construct only a zero-copy base view. The implementation remains the
    // single owner of the pre-copy budget decision and the later ownership
    // allocation. Using intrinsic getters prevents subclass shadow properties
    // from influencing that decision.
    return new NativeUint8Array(buffer, byteOffset, byteLength);
  } catch {
    // Detached or otherwise invalid TypedArray state is untrusted input. Feed a
    // stable non-TypedArray sentinel into the existing rejection path so native
    // internal-slot errors never escape this trust boundary.
    return invalidCheckpointPayload;
  }
}

function checkpointWithStablePayload(checkpoint: unknown): unknown {
  if (typeof checkpoint !== 'object' || checkpoint === null || Array.isArray(checkpoint)) {
    return checkpoint;
  }

  let payloadCaptured = false;
  let payloadValue: unknown;
  const target = checkpoint as object;

  return new Proxy(target, {
    get(source, property) {
      if (property !== 'payload') return Reflect.get(source, property, source);
      if (!payloadCaptured) {
        payloadValue = stableUint8ArrayView(Reflect.get(source, property, source));
        payloadCaptured = true;
      }
      return payloadValue;
    },
  });
}

function resultWithStableCheckpointPayload(result: ExecutionResult): ExecutionResult {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return result;

  let checkpointCaptured = false;
  let checkpointValue: unknown;
  const target = result as object;

  return new Proxy(target, {
    get(source, property) {
      if (property !== 'checkpoint') return Reflect.get(source, property, source);
      if (!checkpointCaptured) {
        checkpointValue = checkpointWithStablePayload(Reflect.get(source, property, source));
        checkpointCaptured = true;
      }
      return checkpointValue;
    },
  }) as ExecutionResult;
}

/**
 * Trust-boundary shim around the durable implementation.
 *
 * The implementation keeps the authoritative ordering: identity/lease/final
 * branch first, then checkpoint byte ceiling, then ownership copy/digest. This
 * shim only canonicalizes a genuine Uint8Array to a zero-copy base view at the
 * exact moment the intermediate-checkpoint path first reads it.
 */
export class DurableCoordinator extends DurableCoordinatorImplementation {
  override async acceptResult(
    result: ExecutionResult,
    now = Date.now(),
  ): Promise<SegmentAcceptance> {
    return super.acceptResult(resultWithStableCheckpointPayload(result), now);
  }
}
