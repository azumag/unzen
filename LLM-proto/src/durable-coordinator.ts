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
import type { SegmentedModelManifest } from './model-manifest.js';

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
}
