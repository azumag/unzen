export * from './durable-coordinator-core-impl.js';

import { DurableCoordinator as DurableCoordinatorImplementation } from './durable-coordinator-core-impl.js';
import type { SegmentAcceptance } from './durable-coordinator-core-impl.js';
import type { ExecutionFailure, ExecutionResult, ResultIdentity } from './durable-types.js';
import { classifyErrorCode } from './errors.js';

const NativeUint8Array = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(NativeUint8Array.prototype) as object;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const typedArrayByteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const invalidCheckpointPayload = Object.freeze({});

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function stableMalformedRecordValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  try {
    Array.isArray(value);
    return value;
  } catch {
    // Revoked Proxies must not cross back into the implementation's own shape
    // checks. Preserve safe malformed values and replace only the unsafe root.
    return null;
  }
}

function readUntrustedField(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    // Keep caller/worker-thrown values opaque. Undefined feeds the existing
    // implementation validator and preserves its reached-field diagnostic.
    return undefined;
  }
}

interface ResultIdentitySnapshot {
  readonly identity: unknown;
  readonly valid: boolean;
}

function snapshotResultIdentity(identity: unknown): ResultIdentitySnapshot {
  if (!isRecord(identity)) {
    return { identity: stableMalformedRecordValue(identity), valid: false };
  }

  const owned: Record<string, unknown> = {};
  for (const field of ['requestId', 'attemptId', 'leaseId', 'workerId', 'workerGeneration'] as const) {
    const value = readUntrustedField(identity, field);
    owned[field] = value;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { identity: owned, valid: false };
    }
  }

  const segmentIndex = readUntrustedField(identity, 'segmentIndex');
  owned.segmentIndex = segmentIndex;
  if (
    typeof segmentIndex !== 'number'
    || !Number.isSafeInteger(segmentIndex)
    || segmentIndex < 0
  ) {
    return { identity: owned, valid: false };
  }

  return { identity: owned as unknown as ResultIdentity, valid: true };
}

function malformedFinalOutput(tokens: unknown = undefined): ExecutionResult['output'] {
  return {
    tokens: tokens as readonly number[],
    text: undefined as unknown as string,
  };
}

function snapshotFinalOutput(output: unknown): ExecutionResult['output'] {
  if (!isRecord(output)) {
    return stableMalformedRecordValue(output) as ExecutionResult['output'];
  }

  const tokensValue = readUntrustedField(output, 'tokens');
  let tokensAreArray = false;
  try {
    tokensAreArray = Array.isArray(tokensValue);
  } catch {
    return malformedFinalOutput();
  }
  if (!tokensAreArray) return malformedFinalOutput(tokensValue);

  const tokenArray = tokensValue as unknown[];
  let tokenCount: unknown;
  try {
    tokenCount = tokenArray.length;
  } catch {
    return malformedFinalOutput();
  }
  if (
    typeof tokenCount !== 'number'
    || !Number.isSafeInteger(tokenCount)
    || tokenCount < 0
    || tokenCount > 0xFFFF_FFFF
  ) {
    return malformedFinalOutput();
  }

  const ownedTokens: unknown[] = [];
  for (let index = 0; index < tokenCount; index += 1) {
    let token: unknown;
    try {
      token = tokenArray[index];
    } catch {
      token = undefined;
    }
    ownedTokens.push(token);
    if (typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0) {
      return malformedFinalOutput(ownedTokens as unknown as readonly number[]);
    }
  }

  const textValue = readUntrustedField(output, 'text');
  return {
    tokens: ownedTokens as unknown as readonly number[],
    text: textValue as string,
  };
}

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

function snapshotExecutionResult(result: unknown): ExecutionResult {
  if (!isRecord(result)) {
    return stableMalformedRecordValue(result) as ExecutionResult;
  }

  const identityValue = readUntrustedField(result, 'identity');
  const identitySnapshot = snapshotResultIdentity(identityValue);
  if (!identitySnapshot.valid) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      processingTimeMs: undefined as unknown as number,
    };
  }

  const processingTimeMsValue = readUntrustedField(result, 'processingTimeMs');
  if (
    typeof processingTimeMsValue !== 'number'
    || !Number.isFinite(processingTimeMsValue)
    || processingTimeMsValue < 0
  ) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      processingTimeMs: processingTimeMsValue as number,
    };
  }

  let outputCaptured = false;
  let outputValue: unknown;
  let checkpointCaptured = false;
  let checkpointValue: unknown;

  return {
    identity: identitySnapshot.identity as ResultIdentity,
    processingTimeMs: processingTimeMsValue,
    get output() {
      if (!outputCaptured) {
        outputValue = snapshotFinalOutput(readUntrustedField(result, 'output'));
        outputCaptured = true;
      }
      return outputValue as ExecutionResult['output'];
    },
    get checkpoint() {
      if (!checkpointCaptured) {
        checkpointValue = checkpointWithStablePayload(readUntrustedField(result, 'checkpoint'));
        checkpointCaptured = true;
      }
      return checkpointValue as ExecutionResult['checkpoint'];
    },
  };
}

function snapshotExecutionFailure(failure: unknown): ExecutionFailure {
  if (!isRecord(failure)) {
    return stableMalformedRecordValue(failure) as ExecutionFailure;
  }

  const identityValue = readUntrustedField(failure, 'identity');
  const identitySnapshot = snapshotResultIdentity(identityValue);
  if (!identitySnapshot.valid) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      code: undefined as unknown as ExecutionFailure['code'],
      message: undefined as unknown as string,
    };
  }

  const codeValue = readUntrustedField(failure, 'code');
  if (typeof codeValue !== 'string' || classifyErrorCode(codeValue) === undefined) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      code: codeValue as ExecutionFailure['code'],
      message: undefined as unknown as string,
    };
  }

  const messageValue = readUntrustedField(failure, 'message');
  return {
    identity: identitySnapshot.identity as ResultIdentity,
    code: codeValue as ExecutionFailure['code'],
    message: messageValue as string,
  };
}

/**
 * Trust-boundary shim around the durable implementation.
 *
 * The implementation keeps the authoritative validation and state-transition
 * ordering. This shim snapshots the direct-core result/failure envelope fields
 * that can execute caller code, keeps final-output/checkpoint access lazy, and
 * canonicalizes a genuine checkpoint Uint8Array to a zero-copy base view at
 * the exact moment the intermediate-checkpoint path first reads it.
 */
export class DurableCoordinator extends DurableCoordinatorImplementation {
  override async acceptResult(
    result: ExecutionResult,
    now = Date.now(),
  ): Promise<SegmentAcceptance> {
    return super.acceptResult(snapshotExecutionResult(result), now);
  }

  override handleWorkerFailure(failure: ExecutionFailure): void {
    super.handleWorkerFailure(snapshotExecutionFailure(failure));
  }
}
