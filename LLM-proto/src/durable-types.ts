/**
 * Shared types for the durable Coordinator path (issue #103).
 *
 * These are the storage records and identity-carrying protocol types consumed
 * by the repository, the worker registry, the lease manager, and the
 * Coordinator. They are kept separate from `types.ts` / `protocol.ts` so the
 * legacy prototype types stay untouched.
 *
 * Every record that crosses the network or is persisted carries the full
 * assignment identity (requestId, attemptId, leaseId, workerId,
 * workerGeneration, segmentIndex, modelManifestDigest) so results, failures,
 * and checkpoints can be matched exactly against the active lease at the
 * Coordinator boundary.
 */

import type { ErrorCode } from './errors.js';
import type { AttemptId, IdempotencyKey, LeaseId, WorkerGeneration } from './ids.js';
import type { RequestStage } from './request-state-machine.js';
import type {
  InferenceRequestId,
  InferenceResult,
  SegmentConfig,
  WorkerId,
  WorkerTier,
} from './types.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';

// --- Attempt history (storage boundary: attempt history) ---

export type AttemptOutcome = 'completed' | 'failed' | 'cancelled' | 'suppressed';

/** One execution attempt of one segment under one lease. */
export interface AttemptRecord {
  readonly requestId: InferenceRequestId;
  readonly attemptId: AttemptId;
  readonly leaseId: LeaseId;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly segmentIndex: number;
  readonly startedAt: number;
  finishedAt?: number;
  outcome?: AttemptOutcome;
  errorCode?: ErrorCode;
}

// --- Request state (storage boundary: request state) ---

export interface RequestRecord {
  readonly requestId: InferenceRequestId;
  readonly prompt: string;
  stage: RequestStage;
  /** API caller idempotency key, if supplied. */
  readonly idempotencyKey?: IdempotencyKey;
  readonly createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Segment index currently being processed (0-based). */
  currentSegment: number;
  readonly totalSegments: number;
  /** Digest of the model manifest driving this run. */
  readonly manifestDigest: string;
  /** Number of retries performed so far (observability). */
  retryCount: number;
  /** Last failure code, if any (observability). */
  lastErrorCode?: ErrorCode;
  /** Last failure message, if any (observability). */
  lastError?: string;
  /** Per-request deadline, if the API caller supplied one. */
  readonly timeoutMs?: number;
}

// --- Cancellation state (storage boundary: cancellation) ---

export interface CancellationRecord {
  readonly requestId: InferenceRequestId;
  readonly requestedAt: number;
  /** Grace period (ms) after which the cancel is force-acknowledged. */
  readonly deadlineMs: number;
  acknowledgedAt?: number;
}

// --- Streaming cursor (storage boundary: streaming cursor) ---

export interface StreamCursor {
  readonly requestId: InferenceRequestId;
  /** Last fully committed segment index (-1 before any segment). */
  readonly lastCommittedSegment: number;
  readonly totalSegments: number;
  updatedAt: number;
}

// --- Worker registration / generation (storage boundary: workers) ---

/** Worker health stage. `revoked` means the generation must never be revived. */
export const WorkerStage = {
  Idle: 'idle',
  Busy: 'busy',
  Disconnected: 'disconnected',
  Revoked: 'revoked',
} as const;
export type WorkerStage = (typeof WorkerStage)[keyof typeof WorkerStage];

export interface WorkerRecord {
  readonly workerId: WorkerId;
  /** One per transport connection / auth session (issue #103). */
  readonly generation: WorkerGeneration;
  /** Transport connection id this generation is bound to. */
  readonly connectionId: string;
  readonly tier: WorkerTier;
  readonly vramMB: number;
  stage: WorkerStage;
  lastHeartbeat: number;
  readonly registeredAt: number;
  /** Set when this generation is revoked (re-registration/reconnect). */
  revokedAt?: number;
  currentSegment?: number;
}

// --- Lease (storage boundary: lease) ---

export interface Lease {
  readonly leaseId: LeaseId;
  readonly requestId: InferenceRequestId;
  readonly attemptId: AttemptId;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly segmentIndex: number;
  readonly modelManifestDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

// --- Assignment / result identity (wire protocol) ---

/**
 * Full assignment identity. Echoed back verbatim by results, failures, and
 * checkpoints; the Coordinator commits only when it matches the active lease
 * exactly.
 */
export interface ResultIdentity {
  readonly requestId: InferenceRequestId;
  readonly attemptId: AttemptId;
  readonly leaseId: LeaseId;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly segmentIndex: number;
}

/** Segment assignment sent to a worker (issue #103 identity-bearing). */
export interface ExecutionAssignment extends ResultIdentity {
  readonly segment: SegmentConfig;
  readonly modelManifestDigest: string;
  /** Validated checkpoint from the previous segment (envelope form). */
  readonly checkpoint?: CheckpointEnvelope;
}

/** Successful segment result echoing the assignment identity. */
export interface ExecutionResult {
  readonly identity: ResultIdentity;
  /** Checkpoint envelope for the next segment (intermediate segments). */
  readonly checkpoint?: CheckpointEnvelope;
  /** Final output; present only for the last segment. */
  readonly output?: { readonly tokens: readonly number[]; readonly text: string };
  readonly processingTimeMs: number;
}

/** Failed segment execution echoing the assignment identity. */
export interface ExecutionFailure {
  readonly identity: ResultIdentity;
  readonly code: ErrorCode;
  readonly message: string;
}

/** Result of a completed inference run (compatible with legacy InferenceResult). */
export interface DurableInferenceResult extends InferenceResult {}
