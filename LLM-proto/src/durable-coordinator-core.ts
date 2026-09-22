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
  if (typeof checkpoint !== 'object' || checkpoint === null) return checkpoint;

  let checkpointIsArray: boolean;
  try {
    checkpointIsArray = Array.isArray(checkpoint);
  } catch {
    // A revoked checkpoint Proxy cannot safely cross into the implementation's
    // own Array.isArray/property checks. Preserve the existing malformed-object
    // path with a stable sentinel instead of leaking the native TypeError.
    return null;
  }
  if (checkpointIsArray) return checkpoint;

  let payloadCaptured = false;
  let payloadValue: unknown;
  const target = checkpoint as object;

  return new Proxy(target, {
    get(source, property) {
      if (property !== 'payload') return Reflect.get(source, property, source);
      if (!payloadCaptured) {
        let rawPayload: unknown;
        try {
          rawPayload = Reflect.get(source, property, source);
        } catch {
          // Keep caller-thrown values opaque and feed a stable malformed value
          // into the existing Uint8Array rejection path.
          rawPayload = invalidCheckpointPayload;
        }
        payloadValue = stableUint8ArrayView(rawPayload);
        payloadCaptured = true;
      }
      return payloadValue;
    },
  });
}

function resultWithStableCheckpointPayload(result: ExecutionResult): ExecutionResult {
  if (typeof result !== 'object' || result === null) return result;

  let resultIsArray: boolean;
  try {
    resultIsArray = Array.isArray(result);
  } catch {
    // The implementation's top-level result validator already owns the public
    // malformed-result diagnostic; replace only the unsafe revoked container.
    return null as unknown as ExecutionResult;
  }
  if (resultIsArray) return result;

  let checkpointCaptured = false;
  let checkpointValue: unknown;
  const target = result as object;

  return new Proxy(target, {
    get(source, property) {
      if (property !== 'checkpoint') return Reflect.get(source, property, source);
      if (!checkpointCaptured) {
        let rawCheckpoint: unknown;
        try {
          rawCheckpoint = Reflect.get(source, property, source);
        } catch {
          // An inaccessible checkpoint is equivalent to a missing checkpoint
          // for the implementation's existing intermediate-result taxonomy.
          rawCheckpoint = undefined;
        }
        checkpointValue = checkpointWithStablePayload(rawCheckpoint);
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
 * exact moment the intermediate-checkpoint path first reads it, while bounding
 * the result/checkpoint shape probes and lazy checkpoint/payload reads needed
 * to reach that canonicalization safely.
 */
export class DurableCoordinator extends DurableCoordinatorImplementation {
  override async acceptResult(
    result: ExecutionResult,
    now = Date.now(),
  ): Promise<SegmentAcceptance> {
    return super.acceptResult(resultWithStableCheckpointPayload(result), now);
  }
}
