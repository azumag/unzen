/**
 * Lease manager: assignment identity matching (issue #103 deliverable 4).
 *
 * Each segment execution is covered by a lease that carries the full
 * assignment identity. Results, failures, and checkpoints must echo that
 * identity verbatim; the Coordinator commits only when `match` returns ok.
 *
 * Lease lifecycle:
 *   issue → setActive → (worker executes) → match → reclaim
 *
 * A lease expires at `expiresAt`; after expiry — or after the request was
 * retried/cancelled/completed (no active lease) — any late result is
 * suppressed. The lease store is a storage boundary of the durable
 * repository, so the manager is a thin policy layer over it.
 */

import { ErrorCode, UnzenError } from './errors.js';
import type { LeaseId, AttemptId, WorkerGeneration } from './ids.js';
import type { WorkerId, InferenceRequestId } from './types.js';
import type { Lease, ResultIdentity } from './durable-types.js';

/** The repository lease-store boundary this manager needs. */
export interface LeaseRepository {
  putLease(lease: Lease): void;
  getActiveLease(requestId: InferenceRequestId): Lease | undefined;
  deleteLease(leaseId: LeaseId): void;
  listActiveLeases(): readonly Lease[];
}

export interface IssueLeaseInput {
  readonly requestId: InferenceRequestId;
  readonly attemptId: AttemptId;
  readonly leaseId: LeaseId;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly segmentIndex: number;
  readonly modelManifestDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export type IdentityMismatchReason =
  | 'no-active-lease'
  | 'lease-expired'
  | 'attempt-mismatch'
  | 'lease-mismatch'
  | 'worker-mismatch'
  | 'generation-mismatch'
  | 'segment-mismatch';

export type IdentityMatch =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: IdentityMismatchReason };

/** Typed error for a result whose identity does not match the active lease. */
export class ResultIdentityError extends UnzenError {
  constructor(reason: IdentityMismatchReason, requestId: InferenceRequestId) {
    super(`Result identity does not match active lease (${reason}) for ${requestId}`, ErrorCode.ResultIdentityMismatch);
    this.name = 'ResultIdentityError';
  }
}

export class LeaseManager {
  constructor(private readonly store: LeaseRepository) {}

  issue(input: IssueLeaseInput): Lease {
    return {
      leaseId: input.leaseId,
      requestId: input.requestId,
      attemptId: input.attemptId,
      workerId: input.workerId,
      workerGeneration: input.workerGeneration,
      segmentIndex: input.segmentIndex,
      modelManifestDigest: input.modelManifestDigest,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    };
  }

  setActive(lease: Lease): void {
    this.store.putLease(lease);
  }

  getActive(requestId: InferenceRequestId): Lease | undefined {
    return this.store.getActiveLease(requestId);
  }

  isActive(requestId: InferenceRequestId): boolean {
    return this.store.getActiveLease(requestId) !== undefined;
  }

  /** Reclaim the active lease of a request (on completion/cancel/retry). */
  reclaimByRequest(requestId: InferenceRequestId): void {
    const lease = this.store.getActiveLease(requestId);
    if (lease) this.store.deleteLease(lease.leaseId);
  }

  /** Reclaim every lease held by a revoked worker generation. */
  reclaimByWorkerGeneration(workerId: WorkerId, generation: WorkerGeneration): void {
    for (const lease of this.store.listActiveLeases()) {
      if (lease.workerId === workerId && lease.workerGeneration === generation) {
        this.store.deleteLease(lease.leaseId);
      }
    }
  }

  /**
   * Match a result/failure/checkpoint identity against the active lease.
   * Requires an EXACT match on every identity field plus a live lease.
   */
  match(identity: ResultIdentity, now: number): IdentityMatch {
    const lease = this.store.getActiveLease(identity.requestId);
    if (!lease) return { ok: false, reason: 'no-active-lease' };
    if (now > lease.expiresAt) return { ok: false, reason: 'lease-expired' };
    if (identity.attemptId !== lease.attemptId) return { ok: false, reason: 'attempt-mismatch' };
    if (identity.leaseId !== lease.leaseId) return { ok: false, reason: 'lease-mismatch' };
    if (identity.workerId !== lease.workerId) return { ok: false, reason: 'worker-mismatch' };
    if (identity.workerGeneration !== lease.workerGeneration) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    if (identity.segmentIndex !== lease.segmentIndex) {
      return { ok: false, reason: 'segment-mismatch' };
    }
    return { ok: true };
  }
}
