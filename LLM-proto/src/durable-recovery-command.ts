/**
 * Repository-backed recovery command for persisted DurableCoordinator requests.
 *
 * This is the mutating counterpart to durable-recovery-plan.ts. It serializes
 * concurrent recovery attempts with a short-lived ownership record, re-reads
 * durable state after claiming, applies terminal decisions, and normalizes a
 * resumable request back to `queued` without starting execution itself.
 *
 * Execution wiring deliberately remains outside this module: the caller that
 * receives `resume-claimed` owns the recovery claim until it either installs a
 * new execution owner/lease or explicitly releases the claim.
 */

import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import type { ErrorCode } from './errors.js';
import {
  planDurableRequestRecovery,
  type DurableRecoveryPlan,
} from './durable-recovery-plan.js';
import type {
  DurableRepository,
  RecoveryOwnership,
} from './durable-repository.js';
import type { Lease, RequestRecord } from './durable-types.js';
import type { InferenceRequestId } from './types.js';

export interface DurableRecoveryCommandOptions {
  readonly ownerId: string;
  readonly now: number;
  readonly ownershipTtlMs: number;
  readonly maxRetries: number;
  readonly manifestDigest: string;
}

export type DurableRecoveryCommandResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'owned-by-peer'; readonly ownership: RecoveryOwnership }
  | { readonly kind: 'terminal'; readonly stage: 'completed' | 'failed' | 'cancelled' }
  | { readonly kind: 'wait-active-owner'; readonly lease: Lease; readonly deadlineAt?: number }
  | {
      readonly kind: 'resume-claimed';
      readonly ownership: RecoveryOwnership;
      readonly segmentIndex: number;
      readonly checkpoint?: CheckpointEnvelope;
      readonly deadlineAt?: number;
    }
  | { readonly kind: 'state-changed'; readonly stage?: RequestRecord['stage'] };

function sameLease(left: Lease, right: Lease): boolean {
  return left.leaseId === right.leaseId
    && left.requestId === right.requestId
    && left.attemptId === right.attemptId
    && left.workerId === right.workerId
    && left.workerGeneration === right.workerGeneration
    && left.segmentIndex === right.segmentIndex
    && left.modelManifestDigest === right.modelManifestDigest
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt;
}

function reclaimExactLease(repo: DurableRepository, expected: Lease | undefined): boolean {
  if (!expected) return true;
  const active = repo.getActiveLease(expected.requestId);
  if (!active) return true;
  if (!sameLease(active, expected)) return false;
  repo.deleteLease(expected.leaseId);
  return true;
}

function release(
  repo: DurableRepository,
  requestId: InferenceRequestId,
  ownerId: string,
): void {
  repo.releaseRecoveryOwnership(requestId, ownerId);
}

function terminalize(
  repo: DurableRepository,
  requestId: InferenceRequestId,
  target: 'failed' | 'cancelled',
  now: number,
  error?: { readonly code: ErrorCode; readonly message: string },
): boolean {
  let record = repo.getRequest(requestId);
  if (!record) return false;
  if (record.stage === 'completed' || record.stage === 'failed' || record.stage === 'cancelled') {
    return record.stage === target;
  }

  // `accepted` has no direct terminal edge in the normal state machine. The
  // durable Coordinator already uses accepted -> queued before cancellation;
  // recovery follows the same path for both cancellation and failure.
  if (record.stage === 'accepted') {
    if (!repo.transitionStage(requestId, 'accepted', 'queued')) return false;
    record = repo.getRequest(requestId);
    if (!record) return false;
  }

  if (!repo.transitionStage(requestId, record.stage, target)) return false;
  const terminal = repo.getRequest(requestId);
  if (!terminal || terminal.stage !== target) return false;
  if (target === 'failed' && error) {
    terminal.lastErrorCode = error.code;
    terminal.lastError = error.message;
  }
  terminal.completedAt = now;
  repo.deleteCheckpointsForRequest(requestId);
  return true;
}

function normalizeResumeStage(
  repo: DurableRepository,
  requestId: InferenceRequestId,
  plan: Extract<DurableRecoveryPlan, { kind: 'resume' }>,
): boolean {
  if (plan.fromStage === 'queued') return repo.getRequest(requestId)?.stage === 'queued';

  // Recovery-only CAS normalization. `leased -> queued` is deliberately not a
  // general request-state-machine edge: it is valid here only after the exact
  // abandoned lease has been compare-and-deleted under recovery ownership.
  return repo.transitionStage(requestId, plan.fromStage, 'queued');
}

/**
 * Claim and apply one durable recovery decision.
 *
 * `resume-claimed` intentionally keeps the ownership record live. The caller
 * must retain it until execution ownership is established, then call
 * `releaseDurableRecoveryOwnership`. All other outcomes release automatically.
 */
export function beginDurableRecovery(
  repo: DurableRepository,
  requestId: InferenceRequestId,
  options: DurableRecoveryCommandOptions,
): DurableRecoveryCommandResult {
  const initial = repo.getRequest(requestId);
  if (!initial) return { kind: 'missing' };

  if (initial.stage === 'completed' || initial.stage === 'failed' || initial.stage === 'cancelled') {
    return { kind: 'terminal', stage: initial.stage };
  }

  const ownership: RecoveryOwnership = {
    requestId,
    ownerId: options.ownerId,
    claimedAt: options.now,
    expiresAt: options.now + options.ownershipTtlMs,
  };
  const claim = repo.claimRecoveryOwnership(ownership, options.now);
  if (claim === 'owned-by-peer') {
    return {
      kind: 'owned-by-peer',
      ownership: repo.getRecoveryOwnership(requestId)!,
    };
  }

  // Re-read every planner input after ownership acquisition. This closes the
  // gap between the initial scan and the command mutation.
  const request = repo.getRequest(requestId);
  if (!request) {
    release(repo, requestId, options.ownerId);
    return { kind: 'missing' };
  }
  const plan = planDurableRequestRecovery(
    {
      request,
      activeLease: repo.getActiveLease(requestId),
      checkpoints: repo.listCheckpoints(requestId),
      cancellationPresent: repo.getCancellation(requestId) !== undefined,
    },
    {
      now: options.now,
      maxRetries: options.maxRetries,
      manifestDigest: options.manifestDigest,
    },
  );

  if (plan.kind === 'terminal') {
    release(repo, requestId, options.ownerId);
    return { kind: 'terminal', stage: plan.stage };
  }

  if (plan.kind === 'wait-active-owner') {
    release(repo, requestId, options.ownerId);
    return {
      kind: 'wait-active-owner',
      lease: plan.lease,
      deadlineAt: plan.deadlineAt,
    };
  }

  if (plan.kind === 'cancel') {
    if (!reclaimExactLease(repo, plan.reclaimLease)) {
      release(repo, requestId, options.ownerId);
      return { kind: 'state-changed', stage: repo.getRequest(requestId)?.stage };
    }
    const ok = terminalize(repo, requestId, 'cancelled', options.now);
    release(repo, requestId, options.ownerId);
    return ok
      ? { kind: 'terminal', stage: 'cancelled' }
      : { kind: 'state-changed', stage: repo.getRequest(requestId)?.stage };
  }

  if (plan.kind === 'fail') {
    if (!reclaimExactLease(repo, plan.reclaimLease)) {
      release(repo, requestId, options.ownerId);
      return { kind: 'state-changed', stage: repo.getRequest(requestId)?.stage };
    }
    const ok = terminalize(repo, requestId, 'failed', options.now, {
      code: plan.code,
      message: plan.message,
    });
    release(repo, requestId, options.ownerId);
    return ok
      ? { kind: 'terminal', stage: 'failed' }
      : { kind: 'state-changed', stage: repo.getRequest(requestId)?.stage };
  }

  if (!reclaimExactLease(repo, plan.reclaimLease)) {
    release(repo, requestId, options.ownerId);
    return { kind: 'state-changed', stage: repo.getRequest(requestId)?.stage };
  }
  if (plan.normalizeToQueued && !normalizeResumeStage(repo, requestId, plan)) {
    release(repo, requestId, options.ownerId);
    return { kind: 'state-changed', stage: repo.getRequest(requestId)?.stage };
  }

  return {
    kind: 'resume-claimed',
    ownership,
    segmentIndex: plan.segmentIndex,
    checkpoint: plan.checkpoint,
    deadlineAt: plan.deadlineAt,
  };
}

/** Release a recovery claim only when the caller still owns it. */
export function releaseDurableRecoveryOwnership(
  repo: DurableRepository,
  requestId: InferenceRequestId,
  ownerId: string,
): boolean {
  return repo.releaseRecoveryOwnership(requestId, ownerId);
}
