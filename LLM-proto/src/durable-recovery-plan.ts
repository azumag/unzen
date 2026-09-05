/**
 * Pure recovery planning for persisted DurableCoordinator requests (issue #183).
 *
 * This module deliberately does not mutate repository state. It turns a
 * persisted request snapshot plus its active lease/checkpoints into one
 * deterministic decision that a recovery command can apply atomically.
 * Keeping the decision logic pure makes restart behavior testable without
 * process-local timers or inFlight state.
 */

import { isCheckpointExpired } from './checkpoint-envelope.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import { ErrorCode } from './errors.js';
import type { ErrorCode as ErrorCodeValue } from './errors.js';
import { TERMINAL_STAGES } from './request-state-machine.js';
import type { RequestStage } from './request-state-machine.js';
import type { Lease, RequestRecord } from './durable-types.js';

export interface DurableRecoverySnapshot {
  readonly request: RequestRecord;
  readonly activeLease?: Lease;
  readonly checkpoints: readonly CheckpointEnvelope[];
  readonly cancellationPresent?: boolean;
}

export interface DurableRecoveryOptions {
  readonly now: number;
  readonly maxRetries: number;
  readonly manifestDigest: string;
}

export type DurableRecoveryPlan =
  | {
      readonly kind: 'terminal';
      readonly stage: 'completed' | 'failed' | 'cancelled';
    }
  | {
      readonly kind: 'cancel';
      readonly reason: 'durable-cancellation';
      readonly reclaimLease?: Lease;
    }
  | {
      readonly kind: 'wait-active-owner';
      readonly lease: Lease;
      readonly deadlineAt?: number;
    }
  | {
      readonly kind: 'resume';
      readonly fromStage: Exclude<RequestStage, 'completed' | 'failed' | 'cancelled'>;
      readonly segmentIndex: number;
      readonly checkpoint?: CheckpointEnvelope;
      /** Present when recovery must compare-and-delete an abandoned lease. */
      readonly reclaimLease?: Lease;
      /** Accepted/retry-wait/running need normalization before a fresh lease. */
      readonly normalizeToQueued: boolean;
      readonly deadlineAt?: number;
    }
  | {
      readonly kind: 'fail';
      readonly code: ErrorCodeValue;
      readonly message: string;
      readonly reclaimLease?: Lease;
    };

function absoluteDeadline(request: RequestRecord): number | undefined {
  return request.timeoutMs === undefined
    ? undefined
    : request.createdAt + request.timeoutMs;
}

function predecessorCheckpoint(
  request: RequestRecord,
  checkpoints: readonly CheckpointEnvelope[],
): CheckpointEnvelope | undefined {
  if (request.currentSegment <= 0) return undefined;
  return checkpoints.find((checkpoint) => checkpoint.segmentIndex === request.currentSegment - 1);
}

function checkpointFailure(
  request: RequestRecord,
  checkpoint: CheckpointEnvelope | undefined,
  options: DurableRecoveryOptions,
): DurableRecoveryPlan | undefined {
  if (request.currentSegment <= 0) return undefined;
  const expectedSegment = request.currentSegment - 1;
  if (!checkpoint) {
    return {
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
      message: `recovery checkpoint for segment ${expectedSegment} is missing`,
    };
  }
  if (
    checkpoint.requestId !== request.requestId
    || checkpoint.segmentIndex !== expectedSegment
    || checkpoint.modelManifestDigest !== options.manifestDigest
  ) {
    return {
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
      message: `recovery checkpoint identity mismatch for segment ${expectedSegment}`,
    };
  }
  if (isCheckpointExpired(checkpoint, options.now)) {
    return {
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
      message: `recovery checkpoint for segment ${expectedSegment} expired`,
    };
  }
  return undefined;
}

function leaseBelongsToRequest(
  request: RequestRecord,
  lease: Lease,
  manifestDigest: string,
): boolean {
  return lease.requestId === request.requestId
    && lease.segmentIndex === request.currentSegment
    && lease.modelManifestDigest === manifestDigest;
}

/**
 * Decide what a freshly constructed Coordinator should do with one persisted
 * non-terminal request.
 *
 * Important invariants:
 * - the API timeout remains absolute (`createdAt + timeoutMs`), never reset on
 *   restart;
 * - a still-valid active lease means another execution owner may still be
 *   running, so recovery waits instead of double-executing;
 * - an expired lease may be reclaimed, but the exact lease is returned so the
 *   mutating layer can use compare-and-delete rather than request-wide delete;
 * - continuation never resumes without a valid predecessor checkpoint;
 * - persisted retryCount is evaluated against the original maxRetries budget.
 */
export function planDurableRequestRecovery(
  snapshot: DurableRecoverySnapshot,
  options: DurableRecoveryOptions,
): DurableRecoveryPlan {
  const { request, activeLease } = snapshot;

  if (TERMINAL_STAGES.includes(request.stage)) {
    return {
      kind: 'terminal',
      stage: request.stage as 'completed' | 'failed' | 'cancelled',
    };
  }

  if (snapshot.cancellationPresent) {
    return {
      kind: 'cancel',
      reason: 'durable-cancellation',
      reclaimLease: activeLease,
    };
  }

  if (request.manifestDigest !== options.manifestDigest) {
    return {
      kind: 'fail',
      code: ErrorCode.CheckpointIntegrityMismatch,
      message: 'persisted request belongs to a different model manifest',
      reclaimLease: activeLease,
    };
  }

  const deadlineAt = absoluteDeadline(request);
  if (deadlineAt !== undefined && options.now >= deadlineAt) {
    return {
      kind: 'fail',
      code: ErrorCode.DeadlineExceeded,
      message: 'persisted request deadline elapsed before recovery',
      reclaimLease: activeLease,
    };
  }

  if (request.retryCount > options.maxRetries) {
    return {
      kind: 'fail',
      code: ErrorCode.RuntimeTransient,
      message: `persisted retry budget exceeded (${request.retryCount} > ${options.maxRetries})`,
      reclaimLease: activeLease,
    };
  }

  const checkpoint = predecessorCheckpoint(request, snapshot.checkpoints);
  const invalidCheckpoint = checkpointFailure(request, checkpoint, options);
  if (invalidCheckpoint) {
    return activeLease && invalidCheckpoint.kind === 'fail'
      ? { ...invalidCheckpoint, reclaimLease: activeLease }
      : invalidCheckpoint;
  }

  if (activeLease) {
    if (!leaseBelongsToRequest(request, activeLease, options.manifestDigest)) {
      return {
        kind: 'fail',
        code: ErrorCode.ResultIdentityMismatch,
        message: 'persisted active lease does not match request recovery identity',
        reclaimLease: activeLease,
      };
    }
    if (options.now < activeLease.expiresAt) {
      return {
        kind: 'wait-active-owner',
        lease: activeLease,
        deadlineAt,
      };
    }
  }

  const normalizeToQueued = request.stage !== 'queued';
  return {
    kind: 'resume',
    fromStage: request.stage,
    segmentIndex: request.currentSegment,
    checkpoint,
    reclaimLease: activeLease,
    normalizeToQueued,
    deadlineAt,
  };
}
