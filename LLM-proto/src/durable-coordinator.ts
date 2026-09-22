/**
 * DurableCoordinator constructor trust boundary.
 *
 * The durable implementation remains in durable-coordinator-core.ts. This
 * public entry point owns and validates caller-supplied constructor options
 * before the core constructor can merge or retain them.
 */

import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import { DurableCoordinator as DurableCoordinatorCore } from './durable-coordinator-core.js';
import type {
  DurableCoordinatorOptions,
  DurableSegmentExecutor,
} from './durable-coordinator-core.js';
import { InMemoryRepository } from './durable-repository.js';
import type { DurableRepository } from './durable-repository.js';
import type { ExecutionFailure, ExecutionResult, ResultIdentity } from './durable-types.js';
import { ErrorCode, UnzenError, classifyErrorCode } from './errors.js';
import { idempotencyKey as brandIdempotencyKey } from './ids.js';
import type { SegmentedModelManifest } from './model-manifest.js';
import { MAX_TIMER_DELAY_MS } from './pipeline-utils.js';
import { WorkerTier, type WorkerId } from './types.js';

export type {
  DurableCoordinatorOptions,
  DurableSegmentExecutor,
  DurableSubmission,
  RequestStatus,
  CancellationDisposition,
  CancellationAck,
  SegmentAcceptance,
  SuppressionRecord,
} from './durable-coordinator-core.js';

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset',
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readOwnEnumerableOption<T extends object, K extends keyof T>(
  source: T | undefined,
  key: K,
): T[K] | undefined {
  if (source === undefined) return undefined;

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw new TypeError(`DurableCoordinator option ${String(key)} could not be inspected`);
  }
  if (descriptor === undefined || descriptor.enumerable !== true) return undefined;

  try {
    return source[key];
  } catch {
    throw new TypeError(`DurableCoordinator option ${String(key)} could not be read`);
  }
}

function resolveDurableCoordinatorOptions(
  options: unknown,
): Partial<DurableCoordinatorOptions> {
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError('DurableCoordinator options must be a non-null, non-array object');
  }

  // Preserve the old object-spread membership rule without enumerating the
  // caller object: only declared own-enumerable fields participate. Capture
  // each participating value once so validation and the retained core options
  // are bound to the same runtime value.
  const source = options as Partial<DurableCoordinatorOptions> | undefined;
  const heartbeatIntervalMs = readOwnEnumerableOption(source, 'heartbeatIntervalMs');
  const heartbeatTimeoutMs = readOwnEnumerableOption(source, 'heartbeatTimeoutMs');
  const maxRetries = readOwnEnumerableOption(source, 'maxRetries');
  const segmentTimeoutMs = readOwnEnumerableOption(source, 'segmentTimeoutMs');
  const retryDelayMs = readOwnEnumerableOption(source, 'retryDelayMs');
  const leaseTtlMs = readOwnEnumerableOption(source, 'leaseTtlMs');
  const checkpointTtlMs = readOwnEnumerableOption(source, 'checkpointTtlMs');
  const checkpointCleanupIntervalMs = readOwnEnumerableOption(source, 'checkpointCleanupIntervalMs');
  const cancelAckDeadlineMs = readOwnEnumerableOption(source, 'cancelAckDeadlineMs');
  const maxCheckpointBytes = readOwnEnumerableOption(source, 'maxCheckpointBytes');
  const recoveryOwnershipTtlMs = readOwnEnumerableOption(source, 'recoveryOwnershipTtlMs');
  const recoveryOwnershipRenewIntervalMs = readOwnEnumerableOption(source, 'recoveryOwnershipRenewIntervalMs');
  const recoveryPollIntervalMs = readOwnEnumerableOption(source, 'recoveryPollIntervalMs');
  const allowFixtureManifest = readOwnEnumerableOption(source, 'allowFixtureManifest');

  for (const [field, value] of [
    ['heartbeatIntervalMs', heartbeatIntervalMs],
    ['heartbeatTimeoutMs', heartbeatTimeoutMs],
    ['segmentTimeoutMs', segmentTimeoutMs],
    ['retryDelayMs', retryDelayMs],
    ['leaseTtlMs', leaseTtlMs],
    ['checkpointTtlMs', checkpointTtlMs],
    ['checkpointCleanupIntervalMs', checkpointCleanupIntervalMs],
    ['cancelAckDeadlineMs', cancelAckDeadlineMs],
    ['recoveryOwnershipTtlMs', recoveryOwnershipTtlMs],
    ['recoveryOwnershipRenewIntervalMs', recoveryOwnershipRenewIntervalMs],
    ['recoveryPollIntervalMs', recoveryPollIntervalMs],
  ] as const) {
    if (value !== undefined && !isNonNegativeFiniteNumber(value)) {
      throw new TypeError(`DurableCoordinator ${field} must be a non-negative finite number`);
    }
  }

  for (const [field, value] of [
    ['heartbeatIntervalMs', heartbeatIntervalMs],
    ['segmentTimeoutMs', segmentTimeoutMs],
    ['retryDelayMs', retryDelayMs],
    ['checkpointCleanupIntervalMs', checkpointCleanupIntervalMs],
    ['recoveryOwnershipRenewIntervalMs', recoveryOwnershipRenewIntervalMs],
    ['recoveryPollIntervalMs', recoveryPollIntervalMs],
  ] as const) {
    if (value !== undefined && value > MAX_TIMER_DELAY_MS) {
      throw new RangeError(
        `DurableCoordinator ${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`,
      );
    }
  }

  if (maxCheckpointBytes !== undefined && !isNonNegativeSafeInteger(maxCheckpointBytes)) {
    throw new TypeError('DurableCoordinator maxCheckpointBytes must be a non-negative safe integer');
  }
  if (maxRetries !== undefined && !isNonNegativeSafeInteger(maxRetries)) {
    throw new TypeError('DurableCoordinator maxRetries must be a non-negative safe integer');
  }
  if (allowFixtureManifest !== undefined && typeof allowFixtureManifest !== 'boolean') {
    throw new TypeError('DurableCoordinator allowFixtureManifest must be a boolean');
  }

  return {
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    ...(heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(segmentTimeoutMs === undefined ? {} : { segmentTimeoutMs }),
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
    ...(leaseTtlMs === undefined ? {} : { leaseTtlMs }),
    ...(checkpointTtlMs === undefined ? {} : { checkpointTtlMs }),
    ...(checkpointCleanupIntervalMs === undefined ? {} : { checkpointCleanupIntervalMs }),
    ...(cancelAckDeadlineMs === undefined ? {} : { cancelAckDeadlineMs }),
    ...(maxCheckpointBytes === undefined ? {} : { maxCheckpointBytes }),
    ...(recoveryOwnershipTtlMs === undefined ? {} : { recoveryOwnershipTtlMs }),
    ...(recoveryOwnershipRenewIntervalMs === undefined ? {} : { recoveryOwnershipRenewIntervalMs }),
    ...(recoveryPollIntervalMs === undefined ? {} : { recoveryPollIntervalMs }),
    ...(allowFixtureManifest === undefined ? {} : { allowFixtureManifest }),
  };
}

interface OwnedDurableWorkerRegistration {
  readonly workerId: WorkerId;
  readonly tier: WorkerTier;
  readonly vramMB: number;
}

function snapshotDurableWorkerRegistration(
  registration: unknown,
): OwnedDurableWorkerRegistration {
  if (!isRecord(registration)) {
    throw new UnzenError(
      'worker registration must be a non-null, non-array object',
      ErrorCode.ProtocolViolation,
    );
  }

  // Registration fields historically use normal property lookup rather than
  // object-spread membership. Preserve that behavior while reading each field
  // only once, then let the existing core validator remain authoritative for
  // type/range checks and manifest minimum-VRAM policy.
  const workerIdValue = registration.workerId;
  const tierValue = registration.tier;
  const vramMBValue = registration.vramMB;

  return {
    workerId: workerIdValue as WorkerId,
    tier: tierValue as WorkerTier,
    vramMB: vramMBValue as number,
  };
}

interface OwnedDurableSubmissionOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface CapturedSubmissionSignalSurface {
  readonly signal: AbortSignal;
  readonly aborted: boolean;
  readonly addEventListener: AbortSignal['addEventListener'];
  readonly removeEventListener: AbortSignal['removeEventListener'];
}

interface BridgedSubmissionSignal {
  readonly signal: AbortSignal;
  readonly observedByCore: () => boolean;
  readonly cleanup: () => void;
}

function submissionSignalError(message: string): UnzenError {
  return new UnzenError(message, ErrorCode.ProtocolViolation);
}

function captureSubmissionSignalSurface(
  signal: unknown,
): CapturedSubmissionSignalSurface | undefined {
  if (signal === undefined) return undefined;
  if (!isRecord(signal)) {
    throw submissionSignalError('submission signal must be an AbortSignal-compatible object');
  }

  const aborted = signal.aborted;
  const addEventListener = signal.addEventListener;
  const removeEventListener = signal.removeEventListener;
  if (
    typeof aborted !== 'boolean'
    || typeof addEventListener !== 'function'
    || typeof removeEventListener !== 'function'
  ) {
    throw submissionSignalError(
      'submission signal must expose boolean aborted and event-listener methods',
    );
  }

  return {
    signal: signal as unknown as AbortSignal,
    aborted,
    addEventListener: addEventListener as AbortSignal['addEventListener'],
    removeEventListener: removeEventListener as AbortSignal['removeEventListener'],
  };
}

function bridgeSubmissionSignal(surface: CapturedSubmissionSignalSurface): BridgedSubmissionSignal {
  const controller = new AbortController();
  let callerSubscribed = false;
  let cleaned = false;
  let observedByCore = false;
  const onAbort = () => controller.abort();

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (!callerSubscribed) return;
    try {
      surface.removeEventListener.call(surface.signal, 'abort', onAbort);
    } catch {
      // Caller-owned cleanup must not replace a durable request result or leak
      // the in-flight entry. The stable bridge is already independent of it.
    }
  };

  if (surface.aborted) {
    onAbort();
  } else {
    callerSubscribed = true;
    try {
      surface.addEventListener.call(surface.signal, 'abort', onAbort, { once: true });
    } catch {
      cleanup();
      throw submissionSignalError('submission signal could not be subscribed');
    }

    let abortedAfterSubscribe: unknown;
    try {
      abortedAfterSubscribe = surface.signal.aborted;
    } catch {
      cleanup();
      throw submissionSignalError('submission signal state could not be read after subscription');
    }
    if (typeof abortedAfterSubscribe !== 'boolean') {
      cleanup();
      throw submissionSignalError(
        'submission signal aborted state must remain boolean after subscription',
      );
    }
    if (abortedAfterSubscribe) onAbort();
  }

  const innerSignal = controller.signal;
  const stableSignal = {
    get aborted() {
      return innerSignal.aborted;
    },
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'abort') observedByCore = true;
      innerSignal.addEventListener(type, listener, options);
    },
    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      innerSignal.removeEventListener(type, listener, options);
    },
  } as unknown as AbortSignal;

  return {
    signal: stableSignal,
    observedByCore: () => observedByCore,
    cleanup,
  };
}

function snapshotDurableSubmissionOptions(
  options: unknown,
): OwnedDurableSubmissionOptions {
  if (!isRecord(options)) {
    throw new UnzenError(
      'submission options must be a non-null, non-array object',
      ErrorCode.ProtocolViolation,
    );
  }

  // submit() historically uses normal property lookup. Detach the top-level
  // envelope once so later validation, idempotency checks and signal bridging
  // all operate on the same captured option identities.
  const idempotencyKeyValue = options.idempotencyKey;
  const signalValue = options.signal;
  const timeoutMsValue = options.timeoutMs;

  if (
    timeoutMsValue !== undefined
    && (
      typeof timeoutMsValue !== 'number'
      || !Number.isFinite(timeoutMsValue)
      || timeoutMsValue < 0
    )
  ) {
    throw new UnzenError(
      'submission timeoutMs must be a non-negative finite number',
      ErrorCode.ProtocolViolation,
    );
  }

  // Reject a well-formed timer value that the browser/Node host cannot
  // represent before idempotency or durable request state can be mutated.
  if (
    typeof timeoutMsValue === 'number'
    && Number.isFinite(timeoutMsValue)
    && timeoutMsValue >= 0
    && timeoutMsValue > MAX_TIMER_DELAY_MS
  ) {
    throw new UnzenError(
      `submission timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}ms`,
      ErrorCode.ProtocolViolation,
    );
  }

  return {
    idempotencyKey: idempotencyKeyValue as string | undefined,
    signal: signalValue as AbortSignal | undefined,
    timeoutMs: timeoutMsValue as number | undefined,
  };
}

interface ResultIdentitySnapshot {
  readonly identity: unknown;
  readonly valid: boolean;
}

function snapshotResultIdentity(identity: unknown): ResultIdentitySnapshot {
  if (!isRecord(identity)) return { identity, valid: false };

  const owned: Record<string, unknown> = {};
  for (const field of ['requestId', 'attemptId', 'leaseId', 'workerId', 'workerGeneration'] as const) {
    const value = identity[field];
    owned[field] = value;
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { identity: owned, valid: false };
    }
  }

  const segmentIndex = identity.segmentIndex;
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

function snapshotDurableFinalOutput(output: unknown): ExecutionResult['output'] {
  // Preserve the core validator's existing malformed-container diagnostics.
  if (!isRecord(output)) return output as ExecutionResult['output'];

  const tokensValue = output.tokens;
  if (!Array.isArray(tokensValue)) {
    return {
      tokens: tokensValue as unknown as readonly number[],
      text: undefined as unknown as string,
    };
  }

  // Avoid caller-controlled iteration. Read each element once and validate the
  // same captured primitive before deciding whether the legacy validator would
  // have progressed far enough to touch `text`.
  const tokenCount = tokensValue.length;
  const ownedTokens: unknown[] = [];
  for (let index = 0; index < tokenCount; index += 1) {
    const token = tokensValue[index];
    ownedTokens.push(token);
    if (typeof token !== 'number' || !Number.isSafeInteger(token) || token < 0) {
      return {
        tokens: ownedTokens as unknown as readonly number[],
        text: undefined as unknown as string,
      };
    }
  }

  const textValue = output.text;
  return {
    tokens: ownedTokens as unknown as readonly number[],
    text: textValue as string,
  };
}

interface CapturedOwnEnumerableField {
  readonly present: boolean;
  readonly value: unknown;
}

const INACCESSIBLE_CHECKPOINT_FIELD = null;

function captureOwnEnumerableField(
  source: Record<string, unknown>,
  key: string,
): CapturedOwnEnumerableField {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  } catch {
    // A declared field that cannot be inspected is represented as present but
    // invalid so the authoritative checkpoint validator rejects it. In
    // particular, an inaccessible optional previousCheckpointDigest must not
    // be silently reinterpreted as "absent".
    return { present: true, value: INACCESSIBLE_CHECKPOINT_FIELD };
  }
  if (descriptor === undefined || descriptor.enumerable !== true) {
    return { present: false, value: undefined };
  }

  try {
    return { present: true, value: source[key] };
  } catch {
    return { present: true, value: INACCESSIBLE_CHECKPOINT_FIELD };
  }
}

function malformedCheckpointPayload(): ExecutionResult['checkpoint'] {
  return { payload: undefined } as unknown as CheckpointEnvelope;
}

/**
 * Convert a genuine Uint8Array (including subclasses) into a plain view over
 * the same backing bytes without copying them. Intrinsic typed-array getters
 * bypass caller-defined `buffer`/`byteOffset`/`byteLength` accessors, and live
 * Proxy-wrapped typed arrays are rejected because `ArrayBuffer.isView()` does
 * not treat the Proxy as a genuine ArrayBuffer view.
 */
function stableCheckpointPayloadView(value: unknown): Uint8Array | undefined {
  if (
    !ArrayBuffer.isView(value)
    || !(value instanceof Uint8Array)
    || !TYPED_ARRAY_BUFFER_GETTER
    || !TYPED_ARRAY_BYTE_OFFSET_GETTER
    || !TYPED_ARRAY_BYTE_LENGTH_GETTER
  ) {
    return undefined;
  }

  try {
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
    const byteOffset = Reflect.apply(TYPED_ARRAY_BYTE_OFFSET_GETTER, value, []) as number;
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    return new Uint8Array(buffer, byteOffset, byteLength);
  } catch {
    return undefined;
  }
}

function snapshotDurableCheckpoint(checkpoint: unknown): ExecutionResult['checkpoint'] {
  // Preserve the core's malformed-container and payload-first safety gates,
  // while bounding Array.isArray/Proxy traps at this public wrapper boundary.
  if (typeof checkpoint !== 'object' || checkpoint === null) {
    return checkpoint as ExecutionResult['checkpoint'];
  }

  let checkpointIsArray: boolean;
  try {
    checkpointIsArray = Array.isArray(checkpoint);
  } catch {
    return malformedCheckpointPayload();
  }
  if (checkpointIsArray) return checkpoint as ExecutionResult['checkpoint'];

  const checkpointRecord = checkpoint as Record<string, unknown>;
  let payloadValue: unknown;
  try {
    payloadValue = checkpointRecord.payload;
  } catch {
    return malformedCheckpointPayload();
  }

  const payload = stableCheckpointPayloadView(payloadValue);
  if (payload === undefined) {
    return { payload: payloadValue } as unknown as CheckpointEnvelope;
  }

  // Do not copy executor-owned checkpoint bytes here. The core owns the
  // configured byte ceiling, so it must reject an oversized payload before any
  // ownership allocation. The stable view above shares the original backing
  // bytes; the core still performs the first byte copy synchronously after the
  // size gate and before crossing the async digest boundary.

  // The legacy core spread retained only own-enumerable metadata fields. Read
  // only those declared names, once each, without enumerating unknown caller
  // properties. Payload intentionally keeps the legacy direct-lookup rule.
  // Descriptor/getter failures are converted to a stable invalid primitive so
  // the core remains the source of truth for the public rejection taxonomy.
  const requestId = captureOwnEnumerableField(checkpointRecord, 'requestId').value;
  const attemptId = captureOwnEnumerableField(checkpointRecord, 'attemptId').value;
  const workerIdValue = captureOwnEnumerableField(checkpointRecord, 'workerId').value;
  const workerGeneration = captureOwnEnumerableField(checkpointRecord, 'workerGeneration').value;
  const formatVersion = captureOwnEnumerableField(checkpointRecord, 'formatVersion').value;
  const segmentIndex = captureOwnEnumerableField(checkpointRecord, 'segmentIndex').value;
  const payloadLength = captureOwnEnumerableField(checkpointRecord, 'payloadLength').value;
  const modelManifestDigest = captureOwnEnumerableField(checkpointRecord, 'modelManifestDigest').value;
  const payloadDigest = captureOwnEnumerableField(checkpointRecord, 'payloadDigest').value;
  const createdAt = captureOwnEnumerableField(checkpointRecord, 'createdAt').value;
  const ttlMs = captureOwnEnumerableField(checkpointRecord, 'ttlMs').value;
  const previousCheckpointDigest = captureOwnEnumerableField(checkpointRecord, 'previousCheckpointDigest');

  return {
    requestId: requestId as CheckpointEnvelope['requestId'],
    attemptId: attemptId as CheckpointEnvelope['attemptId'],
    workerId: workerIdValue as CheckpointEnvelope['workerId'],
    workerGeneration: workerGeneration as CheckpointEnvelope['workerGeneration'],
    formatVersion: formatVersion as string,
    segmentIndex: segmentIndex as number,
    payloadLength: payloadLength as number,
    modelManifestDigest: modelManifestDigest as string,
    payloadDigest: payloadDigest as string,
    createdAt: createdAt as number,
    ttlMs: ttlMs as number,
    ...(previousCheckpointDigest.present
      ? { previousCheckpointDigest: previousCheckpointDigest.value as string | undefined }
      : {}),
    payload,
  };
}

function snapshotDurableExecutionResult(result: unknown): ExecutionResult {
  // Let the existing core validator retain its exact malformed-top-level error.
  if (!isRecord(result)) return result as ExecutionResult;

  const identityValue = result.identity;
  const identitySnapshot = snapshotResultIdentity(identityValue);
  if (!identitySnapshot.valid) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      processingTimeMs: undefined as unknown as number,
    };
  }

  const processingTimeMsValue = result.processingTimeMs;
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

  // Preserve the core's branch ordering. Final output and checkpoint are not
  // touched until the core actually reaches their existing final/intermediate
  // paths, but once reached their top-level caller-owned reference is memoized.
  let outputRead = false;
  let outputValue: unknown;
  let checkpointRead = false;
  let checkpointValue: unknown;

  return {
    identity: identitySnapshot.identity as ResultIdentity,
    processingTimeMs: processingTimeMsValue,
    get output() {
      if (!outputRead) {
        outputValue = snapshotDurableFinalOutput(result.output);
        outputRead = true;
      }
      return outputValue as ExecutionResult['output'];
    },
    get checkpoint() {
      if (!checkpointRead) {
        checkpointValue = snapshotDurableCheckpoint(result.checkpoint);
        checkpointRead = true;
      }
      return checkpointValue as ExecutionResult['checkpoint'];
    },
  };
}

function snapshotDurableExecutionFailure(failure: unknown): ExecutionFailure {
  // Let the existing core validator retain its exact malformed-top-level error.
  if (!isRecord(failure)) return failure as ExecutionFailure;

  const identityValue = failure.identity;
  const identitySnapshot = snapshotResultIdentity(identityValue);
  if (!identitySnapshot.valid) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      code: undefined as unknown as ExecutionFailure['code'],
      message: undefined as unknown as string,
    };
  }

  const codeValue = failure.code;
  if (typeof codeValue !== 'string' || classifyErrorCode(codeValue) === undefined) {
    return {
      identity: identitySnapshot.identity as ResultIdentity,
      code: codeValue as ExecutionFailure['code'],
      message: undefined as unknown as string,
    };
  }

  const messageValue = failure.message;
  return {
    identity: identitySnapshot.identity as ResultIdentity,
    code: codeValue as ExecutionFailure['code'],
    message: messageValue as string,
  };
}

export class DurableCoordinator extends DurableCoordinatorCore {
  private readonly submissionRepository: DurableRepository;

  constructor(
    executor: DurableSegmentExecutor,
    manifest: SegmentedModelManifest,
    options?: Partial<DurableCoordinatorOptions>,
    repository?: DurableRepository,
  ) {
    const ownedOptions = resolveDurableCoordinatorOptions(options);
    const ownedRepository = repository ?? new InMemoryRepository();
    super(executor, manifest, ownedOptions, ownedRepository);
    this.submissionRepository = ownedRepository;
  }

  submit(
    prompt: string,
    options: { readonly idempotencyKey?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ) {
    // Keep the public boundary aligned with the core ordering so no caller
    // listener is attached for a prompt that would be rejected immediately.
    if (typeof prompt !== 'string') {
      throw new UnzenError('submission prompt must be a string', ErrorCode.ProtocolViolation);
    }

    const ownedOptions = snapshotDurableSubmissionOptions(options);
    const signalSurface = captureSubmissionSignalSurface(ownedOptions.signal);
    const key = ownedOptions.idempotencyKey === undefined
      ? undefined
      : brandIdempotencyKey(ownedOptions.idempotencyKey);

    // Preserve the existing-idempotency fast path: duplicate submission must
    // not subscribe to a new caller signal because that signal must never gain
    // cancellation authority over an already-existing durable request.
    if (
      key !== undefined
      && this.submissionRepository.getIdempotencyMapping(key) !== undefined
    ) {
      return super.submit(prompt, ownedOptions);
    }

    const bridge = signalSurface === undefined
      ? undefined
      : bridgeSubmissionSignal(signalSurface);
    try {
      const submission = super.submit(prompt, {
        ...ownedOptions,
        signal: bridge?.signal,
      });

      if (bridge !== undefined) {
        // A concurrent idempotency winner returns before the core subscribes
        // to the stable bridge. Drop the speculative caller listener
        // immediately. An already-aborted bridge also needs no live listener.
        if (bridge.signal.aborted || !bridge.observedByCore()) {
          bridge.cleanup();
        } else {
          // Consume either settlement branch so caller-owned cleanup can never
          // create a secondary rejected promise or replace the durable result.
          void submission.result.then(bridge.cleanup, bridge.cleanup);
        }
      }
      return submission;
    } catch (error) {
      bridge?.cleanup();
      throw error;
    }
  }

  registerWorker(
    registration: { readonly workerId: WorkerId; readonly tier: WorkerTier; readonly vramMB: number },
    connectionId: string,
  ) {
    const ownedRegistration = snapshotDurableWorkerRegistration(registration);
    return super.registerWorker(ownedRegistration, connectionId);
  }

  acceptResult(result: ExecutionResult, now?: number) {
    return super.acceptResult(snapshotDurableExecutionResult(result), now);
  }

  handleWorkerFailure(failure: ExecutionFailure): void {
    super.handleWorkerFailure(snapshotDurableExecutionFailure(failure));
  }
}
