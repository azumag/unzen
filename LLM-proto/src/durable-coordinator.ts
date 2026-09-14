/**
 * DurableCoordinator constructor trust boundary.
 *
 * The durable implementation remains in durable-coordinator-core.ts. This
 * public entry point owns and validates caller-supplied constructor options
 * before the core constructor can merge or retain them.
 */

import { DurableCoordinator as DurableCoordinatorCore } from './durable-coordinator-core.js';
import type {
  DurableCoordinatorOptions,
  DurableSegmentExecutor,
} from './durable-coordinator-core.js';
import type { DurableRepository } from './durable-repository.js';
import type { ExecutionFailure, ExecutionResult, ResultIdentity } from './durable-types.js';
import { ErrorCode, UnzenError, classifyErrorCode } from './errors.js';
import type { SegmentedModelManifest } from './model-manifest.js';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || descriptor.enumerable !== true) return undefined;
  return source[key];
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
    ['maxCheckpointBytes', maxCheckpointBytes],
    ['recoveryOwnershipTtlMs', recoveryOwnershipTtlMs],
    ['recoveryOwnershipRenewIntervalMs', recoveryOwnershipRenewIntervalMs],
    ['recoveryPollIntervalMs', recoveryPollIntervalMs],
  ] as const) {
    if (value !== undefined && !isNonNegativeFiniteNumber(value)) {
      throw new TypeError(`DurableCoordinator ${field} must be a non-negative finite number`);
    }
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

function snapshotDurableSubmissionOptions(
  options: unknown,
): OwnedDurableSubmissionOptions {
  if (!isRecord(options)) {
    throw new UnzenError(
      'submission options must be a non-null, non-array object',
      ErrorCode.ProtocolViolation,
    );
  }

  // submit() historically uses normal property lookup. Detach only the
  // top-level envelope; the AbortSignal object itself intentionally remains
  // live so future aborts still propagate after submission.
  const idempotencyKeyValue = options.idempotencyKey;
  const signalValue = options.signal;
  const timeoutMsValue = options.timeoutMs;

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
        checkpointValue = result.checkpoint;
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
  constructor(
    executor: DurableSegmentExecutor,
    manifest: SegmentedModelManifest,
    options?: Partial<DurableCoordinatorOptions>,
    repository?: DurableRepository,
  ) {
    const ownedOptions = resolveDurableCoordinatorOptions(options);
    super(executor, manifest, ownedOptions, repository);
  }

  submit(
    prompt: string,
    options: { readonly idempotencyKey?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ) {
    const ownedOptions = snapshotDurableSubmissionOptions(options);
    return super.submit(prompt, ownedOptions);
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
