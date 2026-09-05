/**
 * Durable Coordinator (issue #103).
 *
 * The production-ready orchestration path built on top of the legacy
 * Coordinator's responsibilities. Key differences from the prototype
 * Coordinator:
 *
 *   - durable state: every request/attempt/lease/checkpoint/result lives in a
 *     DurableRepository with explicit storage boundaries; a fresh instance can
 *     restore state and continue after a process restart.
 *   - idempotency: the API caller's idempotency key is stored; a duplicate
 *     submission returns the existing request instead of double-executing.
 *   - state machine: accepted → queued → leased → running → completed (plus
 *     cancelled / retry-wait → queued / failed) with validated transitions;
 *     late updates from terminal states are rejected.
 *   - assignment identity: every assignment carries requestId, attemptId,
 *     leaseId, workerId, workerGeneration, segmentIndex and modelManifestDigest.
 *     Results/failures/checkpoints must echo that identity; the Coordinator
 *     commits ONLY when it matches the active lease exactly (LeaseManager).
 *   - checkpoint integrity: checkpoints travel as validated envelopes bound to
 *     producer identity + manifest digest + payload digest + TTL.
 *   - worker generation: one generation per transport connection; reconnect
 *     revokes the old generation and reclaims its leases; heartbeats never
 *     revive a revoked generation.
 *   - cancellation / timeout: cancellation is persisted before execution is
 *     stopped, so a fresh Coordinator can terminalize the durable request and
 *     late results cannot commit even when the local AbortController is gone.
 *   - restart recovery: persisted non-terminal requests are recovered through
 *     durable ownership, bounded lease/deadline waits, and the original retry
 *     budget instead of an unbounded result poll.
 *
 * The legacy Coordinator / Pipeline / WorkerPool / CheckpointStore remain for
 * their existing contract tests; this class is the durable path.
 */

import { InMemoryRepository } from './durable-repository.js';
import type { DurableRepository } from './durable-repository.js';
import { WorkerRegistry } from './worker-registry.js';
import { LeaseManager } from './lease-manager.js';
import type { IdentityMismatchReason } from './lease-manager.js';
import {
  type SegmentedModelManifest,
  segmentConfigsFromManifest,
} from './model-manifest.js';
import { assertValidModelManifest } from './model-manifest-validator.js';
import {
  ErrorCode,
  UnzenError,
  UnzenCancelledError,
  classifyError,
  retryPolicyFor,
  isIsolatable,
  RetryPolicy,
} from './errors.js';
import { TERMINAL_STAGES, isLegalTransition } from './request-state-machine.js';
import type { RequestStage } from './request-state-machine.js';
import {
  generateRequestId,
  generateAttemptId,
  generateLeaseId,
  idempotencyKey as brandIdempotencyKey,
} from './ids.js';
import type { AttemptId } from './ids.js';
import { WorkerTier, type WorkerId, type InferenceRequestId, type SegmentConfig } from './types.js';
import type { InferenceResult } from './types.js';
import { validateCheckpointEnvelope, isCheckpointExpired } from './checkpoint-envelope.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import { withAbortableTimeout, delay } from './pipeline-utils.js';
import { runDurableRecovery } from './durable-recovery-runner.js';
import type {
  AttemptRecord,
  AttemptOutcome,
  CancellationRecord,
  ExecutionAssignment,
  ExecutionFailure,
  ExecutionResult,
  RequestRecord,
  ResultIdentity,
} from './durable-types.js';

export interface DurableCoordinatorOptions {
  /** Heartbeat check interval in ms (default: 5000). */
  readonly heartbeatIntervalMs: number;
  /** Time without heartbeat before marking a worker disconnected (default: 15000). */
  readonly heartbeatTimeoutMs: number;
  /** Max retry attempts per segment (default: 2). */
  readonly maxRetries: number;
  /** Per-segment execution timeout in ms; aborts the underlying work (default: 30000). */
  readonly segmentTimeoutMs: number;
  /** Delay between retries (default: 1000). */
  readonly retryDelayMs: number;
  /** Lease lifetime in ms (default: 60000). */
  readonly leaseTtlMs: number;
  /** Checkpoint TTL in ms (default: 10 min). */
  readonly checkpointTtlMs: number;
  /** Interval of the periodic expired-checkpoint cleanup (default: 60s). */
  readonly checkpointCleanupIntervalMs: number;
  /** Operator-visible acknowledgement target; never used to fabricate an ack. */
  readonly cancelAckDeadlineMs: number;
  /** Hard cap on a checkpoint payload (default: 64 MiB). */
  readonly maxCheckpointBytes: number;
  /** Recovery ownership lifetime while one Coordinator is resuming a request. */
  readonly recoveryOwnershipTtlMs: number;
  /** Renewal cadence for a held recovery ownership. */
  readonly recoveryOwnershipRenewIntervalMs: number;
  /** Poll cadence while a peer recovery/execution owner is still live. */
  readonly recoveryPollIntervalMs: number;
  /** Test-only fixture-manifest escape hatch (production never sets this). */
  readonly allowFixtureManifest?: boolean;
}

const DEFAULT_OPTIONS: DurableCoordinatorOptions = {
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 15_000,
  maxRetries: 2,
  segmentTimeoutMs: 30_000,
  retryDelayMs: 1_000,
  leaseTtlMs: 60_000,
  checkpointTtlMs: 10 * 60_000,
  checkpointCleanupIntervalMs: 60_000,
  cancelAckDeadlineMs: 5_000,
  maxCheckpointBytes: 64 * 1024 * 1024,
  recoveryOwnershipTtlMs: 15_000,
  recoveryOwnershipRenewIntervalMs: 5_000,
  recoveryPollIntervalMs: 50,
};

/** The executor seam: mirrors the core SandboxExecutor cancel contract. */
export interface DurableSegmentExecutor {
  execute(
    workerId: WorkerId,
    assignment: ExecutionAssignment,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExecutionResult>;
}

export interface DurableSubmission {
  readonly requestId: InferenceRequestId;
  /** Settles once the request reaches a terminal state. */
  readonly result: Promise<InferenceResult>;
  /** Current request stage. */
  readonly status: () => RequestStage;
  /** Explicit Coordinator-side cancel. */
  cancel(): CancellationAck;
}

/** Observability view of a request (issue #103 deliverable 11 + 12). */
export interface RequestStatus {
  readonly requestId: InferenceRequestId;
  readonly stage: RequestStage;
  readonly prompt: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly currentSegment: number;
  readonly totalSegments: number;
  readonly retryCount: number;
  readonly attempts: readonly AttemptRecord[];
  readonly lastErrorCode?: ErrorCode;
  readonly result?: InferenceResult;
}

export type CancellationDisposition =
  | 'cancelled'
  | 'pending-stop'
  | 'already-cancelled'
  | 'already-completed'
  | 'already-failed';

export interface CancellationAck {
  readonly requestId: InferenceRequestId;
  readonly requestedAt: number;
  readonly deadlineMs: number;
  /**
   * True only when the Coordinator has durable evidence that no execution
   * owner still needs to settle. Cross-instance cancellation of an active
   * lease remains unacknowledged until the owning run observes the durable
   * cancellation and finishes; we never infer physical stop from lease removal.
   */
  readonly acknowledged: boolean;
  readonly disposition: CancellationDisposition;
}

/** Outcome of validating a pushed/late result at the Coordinator boundary. */
export type SegmentAcceptance =
  | { readonly kind: 'accepted'; readonly isFinal: boolean; readonly checkpoint?: CheckpointEnvelope; readonly output?: { readonly tokens: readonly number[]; readonly text: string } }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'identity-mismatch'; readonly reason: IdentityMismatchReason }
  | { readonly kind: 'checkpoint-rejected'; readonly message: string }
  | { readonly kind: 'checkpoint-conflict' }
  | { readonly kind: 'protocol-violation'; readonly message: string }
  | { readonly kind: 'output-missing' }
  | { readonly kind: 'duplicate' };

/** Recorded suppressed (late/duplicate/stale) delivery for observability. */
export interface SuppressionRecord {
  readonly requestId: InferenceRequestId;
  readonly attemptId?: AttemptId;
  readonly reason: string;
  readonly at: number;
}

interface InFlightEntry {
  readonly controller: AbortController;
  cancelKind: 'user' | 'deadline' | 'recovery-ownership';
  resultPromise?: Promise<InferenceResult>;
  cleanup: () => void;
}

export class DurableCoordinator {
  private readonly repo: DurableRepository;
  private readonly registry: WorkerRegistry;
  private readonly leaseManager: LeaseManager;
  private readonly options: DurableCoordinatorOptions;
  private readonly manifest: SegmentedModelManifest;
  private readonly segments: SegmentConfig[];
  private readonly segmentCountValue: number;
  private readonly recoveryOwnerId = `coordinator-${generateRequestId()}`;
  private readonly inFlight = new Map<InferenceRequestId, InFlightEntry>();
  private readonly suppressions: SuppressionRecord[] = [];
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private checkpointCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly executor: DurableSegmentExecutor,
    manifest: SegmentedModelManifest,
    options?: Partial<DurableCoordinatorOptions>,
    repository: DurableRepository = new InMemoryRepository(),
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    const validated = assertValidModelManifest(manifest, {
      allowedSources: this.options.allowFixtureManifest ? undefined : ['production'],
    });
    this.manifest = validated;
    this.segments = segmentConfigsFromManifest(validated);
    this.segmentCountValue = this.segments.length;
    this.repo = repository;
    this.registry = new WorkerRegistry(repository);
    this.leaseManager = new LeaseManager(repository);
  }

  // --- Submission ---

  /**
   * Submit an inference request. Returns immediately with a submission handle;
   * execution runs in the background and the request advances through the
   * durable state machine. A caller-supplied idempotency key returns the
   * existing request instead of double-executing.
   */
  submit(
    prompt: string,
    options: { readonly idempotencyKey?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): DurableSubmission {
    const key = options.idempotencyKey !== undefined
      ? brandIdempotencyKey(options.idempotencyKey)
      : undefined;

    // Idempotency: an existing key is actively recovered if its old process is
    // gone; it no longer falls back to an unbounded repository poll.
    if (key !== undefined) {
      const existing = this.repo.getIdempotencyMapping(key);
      if (existing !== undefined) return this.submissionForExisting(existing);
    }

    const requestId = generateRequestId();
    // Bind the key atomically; a concurrent submission may have won.
    if (key !== undefined && !this.repo.putIdempotencyMapping(key, requestId)) {
      const existing = this.repo.getIdempotencyMapping(key)!;
      return this.submissionForExisting(existing);
    }

    const record: RequestRecord = {
      requestId,
      prompt,
      stage: 'accepted',
      idempotencyKey: key,
      createdAt: Date.now(),
      currentSegment: 0,
      totalSegments: this.segmentCountValue,
      manifestDigest: this.manifest.manifestDigest,
      retryCount: 0,
      timeoutMs: options.timeoutMs,
    };
    this.repo.createRequest(record);
    this.repo.transitionStage(requestId, 'accepted', 'queued');

    const controller = new AbortController();
    const entry: InFlightEntry = { controller, cancelKind: 'user', cleanup: () => {} };
    const outerSignal = options.signal;
    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const deadlineTimer = options.timeoutMs !== undefined
      ? setTimeout(() => {
          entry.cancelKind = 'deadline';
          controller.abort();
        }, options.timeoutMs)
      : undefined;
    entry.cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    };
    this.inFlight.set(requestId, entry);

    const resultPromise = this.runRequest(requestId, controller.signal)
      .then(() => this.resultOrThrow(requestId))
      .finally(() => {
        entry.cleanup();
        this.inFlight.delete(requestId);
      });
    entry.resultPromise = resultPromise;

    return this.submissionHandle(requestId, resultPromise);
  }

  /**
   * Explicit startup recovery entry point. A runtime should call this after its
   * durable repository/worker registry is available. Each returned submission
   * is independently owned and bounded by persisted lease/deadline state.
   */
  recoverPendingRequests(): readonly DurableSubmission[] {
    return this.repo.listRequests()
      .filter((record) => !TERMINAL_STAGES.includes(record.stage))
      .map((record) => this.submissionForExisting(record.requestId));
  }

  /** Build a submission for a request that already exists (idempotent replay). */
  private submissionForExisting(requestId: InferenceRequestId): DurableSubmission {
    const entry = this.inFlight.get(requestId);
    if (entry?.resultPromise) return this.submissionHandle(requestId, entry.resultPromise);

    const stored = this.repo.getResult(requestId);
    if (stored) return this.submissionHandle(requestId, Promise.resolve(stored));

    const record = this.repo.getRequest(requestId);
    if (!record) {
      return this.submissionHandle(
        requestId,
        Promise.reject(new UnzenError('unknown request', ErrorCode.RequestNotFound)),
      );
    }
    if (record.stage === 'cancelled' || record.stage === 'failed') {
      return this.submissionHandle(requestId, Promise.resolve().then(() => this.resultOrThrow(requestId)));
    }
    return this.startRecovery(requestId);
  }

  private submissionHandle(
    requestId: InferenceRequestId,
    result: Promise<InferenceResult>,
  ): DurableSubmission {
    return {
      requestId,
      result,
      status: () => this.repo.getRequest(requestId)?.stage ?? 'failed',
      cancel: () => this.cancel(requestId),
    };
  }

  private resultOrThrow(requestId: InferenceRequestId): InferenceResult {
    const result = this.repo.getResult(requestId);
    if (result) return result;
    const current = this.repo.getRequest(requestId);
    if (!current) throw new UnzenError('unknown request', ErrorCode.RequestNotFound);
    if (current.stage === 'cancelled') {
      throw new UnzenCancelledError(`request ${requestId} was cancelled`);
    }
    if (current.stage === 'failed') {
      throw new UnzenError(
        current.lastError ?? `request ${requestId} failed`,
        current.lastErrorCode ?? ErrorCode.RuntimeTransient,
      );
    }
    throw new UnzenError(
      `request ${requestId} recovery ended at non-terminal stage ${current.stage}`,
      ErrorCode.StateTransitionViolation,
    );
  }

  /** Start/reuse one bounded cross-instance recovery operation. */
  private startRecovery(requestId: InferenceRequestId): DurableSubmission {
    const existing = this.inFlight.get(requestId);
    if (existing?.resultPromise) return this.submissionHandle(requestId, existing.resultPromise);

    const controller = new AbortController();
    const entry: InFlightEntry = { controller, cancelKind: 'user', cleanup: () => {} };
    this.inFlight.set(requestId, entry);

    const resultPromise = runDurableRecovery(this.repo, requestId, {
      ownerId: `${this.recoveryOwnerId}:${requestId}`,
      ownershipTtlMs: this.options.recoveryOwnershipTtlMs,
      ownershipRenewIntervalMs: this.options.recoveryOwnershipRenewIntervalMs,
      pollIntervalMs: this.options.recoveryPollIntervalMs,
      maxRetries: this.options.maxRetries,
      manifestDigest: this.manifest.manifestDigest,
      signal: controller.signal,
      onResume: async (context) => {
        // context.signal also aborts on recovery-ownership loss. Distinguish
        // that from cancel()/deadline aborts so a stale recovery instance does
        // not terminalize a request that a replacement owner may continue.
        const onResumeAbort = () => {
          if (!controller.signal.aborted) entry.cancelKind = 'recovery-ownership';
        };
        context.signal.addEventListener('abort', onResumeAbort, { once: true });

        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        if (context.deadlineAt !== undefined) {
          const remaining = Math.max(0, context.deadlineAt - Date.now());
          deadlineTimer = setTimeout(() => {
            entry.cancelKind = 'deadline';
            controller.abort();
          }, remaining);
        }
        try {
          await this.runRequest(requestId, context.signal);
        } finally {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          context.signal.removeEventListener('abort', onResumeAbort);
        }
      },
    })
      .then(() => this.resultOrThrow(requestId))
      .catch((error) => {
        const terminal = this.repo.getRequest(requestId);
        if (terminal && TERMINAL_STAGES.includes(terminal.stage)) {
          return this.resultOrThrow(requestId);
        }
        throw error;
      })
      .finally(() => {
        entry.cleanup();
        this.inFlight.delete(requestId);
      });
    entry.resultPromise = resultPromise;

    return this.submissionHandle(requestId, resultPromise);
  }

  // --- Request execution (pull model) ---

  private async runRequest(requestId: InferenceRequestId, signal: AbortSignal): Promise<void> {
    const record = this.repo.getRequest(requestId);
    if (record && record.startedAt === undefined) record.startedAt = Date.now();
    try {
      await this.executeAllSegments(requestId, signal);
      const current = this.repo.getRequest(requestId);
      if (current && !TERMINAL_STAGES.includes(current.stage)) {
        this.finalizeStage(requestId, 'failed', ErrorCode.RuntimeTransient, 'pipeline ended without a result');
      }
    } catch (error) {
      const code = classifyError(error);
      const kind = this.inFlight.get(requestId)?.cancelKind ?? 'user';
      if (code === ErrorCode.UserCancellation && kind === 'recovery-ownership') {
        // Another recovery owner replaced this one. Do not mutate durable state;
        // the winning owner must be allowed to continue from it.
        return;
      }
      if (code === ErrorCode.UserCancellation && kind === 'deadline') {
        this.finalizeStage(requestId, 'failed', ErrorCode.DeadlineExceeded, 'request deadline exceeded');
      } else if (code === ErrorCode.UserCancellation) {
        this.finalizeStage(requestId, 'cancelled');
      } else {
        this.finalizeStage(requestId, 'failed', code, error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.acknowledgeCancellation(requestId);
    }
  }

  private async executeAllSegments(
    requestId: InferenceRequestId,
    signal: AbortSignal,
  ): Promise<void> {
    const record = this.repo.getRequest(requestId)!;
    for (let segmentIndex = record.currentSegment; segmentIndex < record.totalSegments; segmentIndex++) {
      if (signal.aborted) throw abortError();
      const durable = this.repo.getRequest(requestId);
      if (!durable || TERMINAL_STAGES.includes(durable.stage)) return;
      if (this.repo.getCancellation(requestId)) {
        this.finalizeStage(requestId, 'cancelled');
        return;
      }
      const result = await this.executeSegmentWithRetry(requestId, segmentIndex, signal);
      if (!result) return;
      const current = this.repo.getRequest(requestId)!;
      if (current.stage === 'completed') return;
      if (current.stage === 'cancelled' || this.repo.getCancellation(requestId)) {
        this.finalizeStage(requestId, 'cancelled');
        return;
      }
      current.currentSegment = segmentIndex + 1;
      this.repo.putStreamCursor({
        requestId,
        lastCommittedSegment: segmentIndex,
        totalSegments: current.totalSegments,
        updatedAt: Date.now(),
      });
    }
  }

  private async executeSegmentWithRetry(
    requestId: InferenceRequestId,
    segmentIndex: number,
    signal: AbortSignal,
  ): Promise<ExecutionResult | null> {
    const segment = this.segments[segmentIndex];

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (signal.aborted) throw abortError();

      const record = this.repo.getRequest(requestId);
      if (!record || TERMINAL_STAGES.includes(record.stage)) return null;
      if (this.repo.getCancellation(requestId)) {
        this.finalizeStage(requestId, 'cancelled');
        return null;
      }
      if (record.stage === 'retry-wait') {
        this.transitionOrThrow(requestId, 'retry-wait', 'queued');
      }

      let previousCheckpoint: CheckpointEnvelope | undefined;
      if (segmentIndex > 0) {
        previousCheckpoint = this.repo.getCheckpoint(requestId, segmentIndex - 1);
        if (!previousCheckpoint) {
          this.finalizeStage(
            requestId,
            'failed',
            ErrorCode.CheckpointIntegrityMismatch,
            `checkpoint for segment ${segmentIndex - 1} missing before resume`,
          );
          return null;
        }
        if (
          previousCheckpoint.requestId !== requestId
          || previousCheckpoint.segmentIndex !== segmentIndex - 1
          || previousCheckpoint.modelManifestDigest !== this.manifest.manifestDigest
        ) {
          this.finalizeStage(
            requestId,
            'failed',
            ErrorCode.CheckpointIntegrityMismatch,
            `checkpoint identity mismatch for segment ${segmentIndex - 1} before resume`,
          );
          return null;
        }
        if (isCheckpointExpired(previousCheckpoint, Date.now())) {
          this.repo.deleteCheckpoint(requestId, segmentIndex - 1);
          this.finalizeStage(
            requestId,
            'failed',
            ErrorCode.CheckpointIntegrityMismatch,
            `checkpoint for segment ${segmentIndex - 1} expired before resume`,
          );
          return null;
        }
      }

      const worker = this.registry.getAvailableWorker(segment.estimatedVramMB);
      if (!worker) {
        if (attempt < this.options.maxRetries) {
          await delay(this.options.retryDelayMs);
          continue;
        }
        this.finalizeStage(requestId, 'failed', ErrorCode.WorkerDisconnected, `no available worker for segment ${segmentIndex}`);
        return null;
      }

      const attemptId = generateAttemptId();
      const leaseId = generateLeaseId();
      const now = Date.now();
      const lease = this.leaseManager.issue({
        requestId,
        attemptId,
        leaseId,
        workerId: worker.workerId,
        workerGeneration: worker.generation,
        segmentIndex,
        modelManifestDigest: this.manifest.manifestDigest,
        issuedAt: now,
        expiresAt: now + this.options.leaseTtlMs,
      });
      this.leaseManager.setActive(lease);
      this.repo.appendAttempt(requestId, {
        requestId,
        attemptId,
        leaseId,
        workerId: worker.workerId,
        workerGeneration: worker.generation,
        segmentIndex,
        startedAt: now,
      });
      this.transitionOrThrow(requestId, 'queued', 'leased');
      this.transitionOrThrow(requestId, 'leased', 'running');
      this.registry.markBusy(worker.workerId, worker.generation, segmentIndex);

      const assignment: ExecutionAssignment = {
        requestId,
        attemptId,
        leaseId,
        workerId: worker.workerId,
        workerGeneration: worker.generation,
        segmentIndex,
        modelManifestDigest: this.manifest.manifestDigest,
        segment,
        checkpoint: previousCheckpoint,
      };

      try {
        const result = await withAbortableTimeout(
          (innerSignal) => this.executor.execute(worker.workerId, assignment, { signal: innerSignal }),
          this.options.segmentTimeoutMs,
          `Segment ${segmentIndex}`,
          signal,
        );
        const acceptance = await this.acceptResult(result);
        this.registry.markIdle(worker.workerId, worker.generation);
        switch (acceptance.kind) {
          case 'accepted':
            if (!acceptance.isFinal) {
              this.transitionOrThrow(requestId, 'running', 'queued');
            }
            return result;
          case 'cancelled':
            this.updateAttemptOutcome(requestId, attemptId, 'cancelled', ErrorCode.UserCancellation, Date.now());
            this.finalizeStage(requestId, 'cancelled');
            return null;
          case 'duplicate':
            return result;
          default:
            this.isolateWorker(result.identity);
            this.updateAttemptOutcome(result.identity.requestId, result.identity.attemptId, 'suppressed', this.acceptanceErrorCode(acceptance), Date.now());
            this.finalizeStage(
              requestId,
              'failed',
              this.acceptanceErrorCode(acceptance),
              this.acceptanceMessage(acceptance),
            );
            return null;
        }
      } catch (error) {
        this.registry.markIdle(worker.workerId, worker.generation);
        if (signal.aborted) throw error;

        const code = classifyError(error);
        this.leaseManager.reclaimByRequest(requestId);
        this.updateAttemptOutcome(requestId, attemptId, 'failed', code, Date.now());
        const current = this.repo.getRequest(requestId);

        // `retryCount` is durable. Recovery never starts a fresh local retry
        // budget after process restart.
        if (
          retryPolicyFor(code) === RetryPolicy.Retryable
          && current
          && current.retryCount < this.options.maxRetries
        ) {
          if (isIsolatable(code)) {
            this.registry.markDisconnected(worker.workerId, worker.generation);
          }
          current.retryCount += 1;
          this.transitionOrThrow(requestId, 'running', 'retry-wait');
          await delay(this.options.retryDelayMs);
          continue;
        }

        this.finalizeStage(
          requestId,
          'failed',
          code,
          `segment ${segmentIndex} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }
    return null;
  }

  private acceptanceMessage(acceptance: SegmentAcceptance): string {
    switch (acceptance.kind) {
      case 'identity-mismatch':
        return `result identity mismatch: ${acceptance.reason}`;
      case 'checkpoint-rejected':
      case 'protocol-violation':
        return acceptance.message;
      case 'checkpoint-conflict':
        return 'checkpoint slot conflict';
      case 'output-missing':
        return 'final segment produced no output';
      case 'cancelled':
        return 'request cancelled';
      default:
        return acceptance.kind;
    }
  }

  private acceptanceErrorCode(acceptance: SegmentAcceptance): ErrorCode {
    switch (acceptance.kind) {
      case 'identity-mismatch':
        return ErrorCode.ResultIdentityMismatch;
      case 'checkpoint-rejected':
      case 'checkpoint-conflict':
        return ErrorCode.CheckpointIntegrityMismatch;
      case 'output-missing':
        return ErrorCode.ProtocolViolation;
      case 'protocol-violation':
        return ErrorCode.ProtocolViolation;
      case 'cancelled':
        return ErrorCode.UserCancellation;
      default:
        return ErrorCode.ProtocolViolation;
    }
  }

  async acceptResult(result: ExecutionResult, now = Date.now()): Promise<SegmentAcceptance> {
    const record = this.repo.getRequest(result.identity.requestId);
    if (!record) {
      this.recordSuppression(result.identity, 'request-not-found', now);
      return { kind: 'protocol-violation', message: 'request not found' };
    }
    if (this.repo.getCancellation(result.identity.requestId) || record.stage === 'cancelled') {
      this.recordSuppression(result.identity, 'request-cancelled', now);
      this.finalizeStage(result.identity.requestId, 'cancelled');
      return { kind: 'cancelled' };
    }

    const match = this.leaseManager.match(result.identity, now);
    if (!match.ok) {
      this.recordSuppression(result.identity, match.reason, now);
      return { kind: 'identity-mismatch', reason: match.reason };
    }
    const isFinal = result.identity.segmentIndex === record.totalSegments - 1;

    if (isFinal) {
      if (!result.output) return { kind: 'output-missing' };
      const commit = this.repo.commitCompletion(
        result.identity.requestId,
        'running',
        {
          requestId: result.identity.requestId,
          tokens: result.output.tokens,
          text: result.output.text,
          totalTimeMs: now - (record.startedAt ?? record.createdAt),
          segmentsCompleted: record.totalSegments,
        },
      );
      this.leaseManager.reclaimByRequest(result.identity.requestId);
      if (commit === 'committed') {
        this.updateAttemptOutcome(result.identity.requestId, result.identity.attemptId, 'completed', undefined, now);
        this.repo.deleteCheckpointsForRequest(result.identity.requestId);
        return { kind: 'accepted', isFinal: true, output: result.output };
      }
      if (commit === 'duplicate') {
        this.recordSuppression(result.identity, 'duplicate-completion', now);
        return { kind: 'duplicate' };
      }
      this.recordSuppression(result.identity, `completion-conflict-stage=${record.stage}`, now);
      return { kind: 'protocol-violation', message: `completion conflict at stage ${record.stage}` };
    }

    if (!result.checkpoint) {
      this.recordSuppression(result.identity, 'missing-checkpoint', now);
      return { kind: 'protocol-violation', message: 'intermediate segment produced no checkpoint' };
    }
    const checkpoint: CheckpointEnvelope = {
      ...result.checkpoint,
      payload: new Uint8Array(result.checkpoint.payload),
    };
    const validation = await validateCheckpointEnvelope(checkpoint, {
      requestId: result.identity.requestId,
      segmentIndex: result.identity.segmentIndex,
      workerId: result.identity.workerId,
      workerGeneration: result.identity.workerGeneration,
      modelManifestDigest: this.manifest.manifestDigest,
      formatVersion: this.manifest.checkpointFormat,
      maxPayloadBytes: this.options.maxCheckpointBytes,
      now,
    });
    if (!validation.ok) {
      this.recordSuppression(result.identity, validation.message, now);
      this.isolateWorker(result.identity);
      return { kind: 'checkpoint-rejected', message: validation.message };
    }

    const commitNow = Math.max(now, Date.now());
    if (this.repo.getCancellation(result.identity.requestId)) {
      this.recordSuppression(result.identity, 'post-validation-request-cancelled', commitNow);
      this.finalizeStage(result.identity.requestId, 'cancelled');
      return { kind: 'cancelled' };
    }
    const commitMatch = this.leaseManager.match(result.identity, commitNow);
    if (!commitMatch.ok) {
      this.recordSuppression(result.identity, `post-validation-${commitMatch.reason}`, commitNow);
      return { kind: 'identity-mismatch', reason: commitMatch.reason };
    }
    const currentRecord = this.repo.getRequest(result.identity.requestId);
    if (!currentRecord || currentRecord.stage !== 'running') {
      const currentStage = currentRecord?.stage ?? 'missing';
      this.recordSuppression(result.identity, `post-validation-stage=${currentStage}`, commitNow);
      return { kind: 'protocol-violation', message: `request no longer running after checkpoint validation (stage=${currentStage})` };
    }
    if (isCheckpointExpired(checkpoint, commitNow)) {
      const message = 'checkpoint TTL expired during validation';
      this.recordSuppression(result.identity, message, commitNow);
      return { kind: 'checkpoint-rejected', message };
    }

    const store = this.repo.putCheckpoint(checkpoint);
    if (store === 'conflict') {
      this.recordSuppression(result.identity, 'checkpoint-conflict', commitNow);
      this.isolateWorker(result.identity);
      return { kind: 'checkpoint-conflict' };
    }
    this.updateAttemptOutcome(result.identity.requestId, result.identity.attemptId, 'completed', undefined, commitNow);
    const reclaimed = this.leaseManager.reclaim(result.identity, commitNow);
    if (!reclaimed.ok) {
      this.recordSuppression(result.identity, `commit-reclaim-${reclaimed.reason}`, commitNow);
      return { kind: 'identity-mismatch', reason: reclaimed.reason };
    }
    return { kind: 'accepted', isFinal: false, checkpoint };
  }

  // --- Push-model entry points (worker messages) ---

  handleWorkerResult(result: ExecutionResult): Promise<SegmentAcceptance> {
    return this.acceptResult(result);
  }

  handleWorkerFailure(failure: ExecutionFailure): void {
    if (this.repo.getCancellation(failure.identity.requestId)) {
      this.recordSuppression(failure.identity, 'request-cancelled');
      this.updateAttemptOutcome(
        failure.identity.requestId,
        failure.identity.attemptId,
        'cancelled',
        ErrorCode.UserCancellation,
        Date.now(),
      );
      this.finalizeStage(failure.identity.requestId, 'cancelled');
      return;
    }
    const match = this.leaseManager.match(failure.identity, Date.now());
    if (!match.ok) {
      this.recordSuppression(failure.identity, match.reason);
      return;
    }
    this.updateAttemptOutcome(failure.identity.requestId, failure.identity.attemptId, 'failed', failure.code, Date.now());
    this.leaseManager.reclaimByRequest(failure.identity.requestId);
    if (isIsolatable(failure.code)) this.isolateWorker(failure.identity);
  }

  // --- Cancellation ---

  cancel(requestId: InferenceRequestId): CancellationAck {
    const requestedAt = Date.now();
    const deadlineMs = this.options.cancelAckDeadlineMs;
    const request = this.repo.getRequest(requestId);
    if (!request) {
      throw new UnzenError(`unknown request ${requestId}`, ErrorCode.RequestNotFound);
    }

    if (request.stage === 'completed') {
      return { requestId, requestedAt, deadlineMs, acknowledged: true, disposition: 'already-completed' };
    }
    if (request.stage === 'failed') {
      return { requestId, requestedAt, deadlineMs, acknowledged: true, disposition: 'already-failed' };
    }

    const entry = this.inFlight.get(requestId);
    const activeLease = this.repo.getActiveLease(requestId);
    const existing = this.repo.getCancellation(requestId);
    const cancellation: CancellationRecord = existing
      ? { ...existing }
      : { requestId, requestedAt, deadlineMs };

    this.repo.putCancellation(requestId, cancellation);

    if (entry) {
      entry.cancelKind = 'user';
      entry.controller.abort();
    }
    if (activeLease) {
      this.updateAttemptOutcome(
        requestId,
        activeLease.attemptId,
        'cancelled',
        ErrorCode.UserCancellation,
        requestedAt,
      );
    }

    if (request.stage === 'accepted') {
      this.repo.transitionStage(requestId, 'accepted', 'queued');
    }
    this.finalizeStage(requestId, 'cancelled');

    if (!existing && !entry && !activeLease) {
      cancellation.acknowledgedAt = requestedAt;
      this.repo.putCancellation(requestId, cancellation);
    }

    const acknowledged = cancellation.acknowledgedAt !== undefined;
    const disposition: CancellationDisposition = existing
      ? 'already-cancelled'
      : acknowledged
        ? 'cancelled'
        : 'pending-stop';
    return {
      requestId,
      requestedAt: cancellation.requestedAt,
      deadlineMs: cancellation.deadlineMs,
      acknowledged,
      disposition,
    };
  }

  private acknowledgeCancellation(requestId: InferenceRequestId): void {
    const record = this.repo.getCancellation(requestId);
    const request = this.repo.getRequest(requestId);
    if (
      record
      && record.acknowledgedAt === undefined
      && request?.stage === 'cancelled'
      && !this.repo.getActiveLease(requestId)
    ) {
      record.acknowledgedAt = Date.now();
      this.repo.putCancellation(requestId, record);
    }
  }

  // --- Worker management ---

  registerWorker(
    registration: { readonly workerId: WorkerId; readonly tier: WorkerTier; readonly vramMB: number },
    connectionId: string,
  ) {
    if (registration.vramMB < this.manifest.runtimeRequirements.minimumVramMB) {
      throw new UnzenError(
        `worker ${registration.workerId} reports ${registration.vramMB}MB VRAM, below the ${this.manifest.runtimeRequirements.minimumVramMB}MB minimum for this model`,
        ErrorCode.UnsupportedRequest,
      );
    }
    const outcome = this.registry.register(registration, connectionId);
    if (outcome.kind === 'reconnected') {
      this.leaseManager.reclaimByWorkerGeneration(registration.workerId, outcome.previousGeneration);
    }
    return outcome;
  }

  workerHeartbeat(workerId: WorkerId, generation: string): boolean {
    this.registry.heartbeat(workerId, generation as never);
    return true;
  }

  removeWorker(workerId: WorkerId): void {
    const record = this.registry.get(workerId);
    if (record) {
      this.registry.revokeGeneration(workerId, record.generation);
      this.leaseManager.reclaimByWorkerGeneration(workerId, record.generation);
    }
  }

  // --- Monitors ---

  startHeartbeatMonitor(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const worker of this.registry.listTimedOut(this.options.heartbeatTimeoutMs, now)) {
        this.registry.markDisconnected(worker.workerId, worker.generation);
        this.leaseManager.reclaimByWorkerGeneration(worker.workerId, worker.generation);
      }
    }, this.options.heartbeatIntervalMs);
  }

  stopHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startCheckpointCleanup(): void {
    if (this.checkpointCleanupTimer) return;
    this.checkpointCleanupTimer = setInterval(() => {
      this.repo.collectExpiredCheckpoints(Date.now());
    }, this.options.checkpointCleanupIntervalMs);
  }

  stopCheckpointCleanup(): void {
    if (this.checkpointCleanupTimer) {
      clearInterval(this.checkpointCleanupTimer);
      this.checkpointCleanupTimer = null;
    }
  }

  // --- Lookup / observability ---

  getStatus(requestId: InferenceRequestId): RequestStatus | undefined {
    const record = this.repo.getRequest(requestId);
    if (!record) return undefined;
    return {
      requestId: record.requestId,
      stage: record.stage,
      prompt: record.prompt,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      currentSegment: record.currentSegment,
      totalSegments: record.totalSegments,
      retryCount: record.retryCount,
      attempts: this.repo.listAttempts(requestId),
      lastErrorCode: record.lastErrorCode,
      result: this.repo.getResult(requestId),
    };
  }

  getResult(requestId: InferenceRequestId): InferenceResult | undefined {
    return this.repo.getResult(requestId);
  }

  getRequestRecord(requestId: InferenceRequestId): RequestRecord | undefined {
    return this.repo.getRequest(requestId);
  }

  getWorker(workerId: WorkerId) {
    return this.registry.get(workerId);
  }

  getSuppressions(requestId: InferenceRequestId): readonly SuppressionRecord[] {
    return this.suppressions.filter((s) => s.requestId === requestId);
  }

  get workerCount(): number {
    return this.registry.size;
  }

  get idleWorkerCount(): number {
    return this.registry.idleCount;
  }

  get activeRequestCount(): number {
    return this.inFlight.size;
  }

  get checkpointCount(): number {
    return this.repo.allCheckpoints().length;
  }

  get segmentCount(): number {
    return this.segmentCountValue;
  }

  get modelRevision(): string {
    return this.manifest.modelRevision;
  }

  get manifestDigest(): string {
    return this.manifest.manifestDigest;
  }

  // --- Internal helpers ---

  private transitionOrThrow(requestId: InferenceRequestId, from: RequestStage, to: RequestStage): void {
    if (!this.repo.transitionStage(requestId, from, to)) {
      const current = this.repo.getRequest(requestId)?.stage;
      throw new UnzenError(
        `request ${requestId}: ${from} → ${to} rejected (current=${current})`,
        ErrorCode.StateTransitionViolation,
      );
    }
  }

  private finalizeStage(
    requestId: InferenceRequestId,
    stage: 'cancelled' | 'failed',
    errorCode?: ErrorCode,
    message?: string,
  ): void {
    const record = this.repo.getRequest(requestId);
    if (!record || TERMINAL_STAGES.includes(record.stage)) return;
    if (!isLegalTransition(record.stage, stage)) return;
    this.repo.transitionStage(requestId, record.stage, stage);
    if (stage === 'failed') {
      record.lastErrorCode = errorCode;
      record.lastError = message;
    }
    record.completedAt = Date.now();
    this.repo.deleteCheckpointsForRequest(requestId);
    this.leaseManager.reclaimByRequest(requestId);
  }

  private isolateWorker(identity: ResultIdentity): void {
    const record = this.registry.getByGeneration(identity.workerGeneration);
    if (record && record.stage !== 'revoked') {
      this.registry.revokeGeneration(identity.workerId, identity.workerGeneration);
      this.leaseManager.reclaimByWorkerGeneration(identity.workerId, identity.workerGeneration);
    }
  }

  private recordSuppression(
    identity: ResultIdentity,
    reason: string,
    at = Date.now(),
  ): void {
    this.suppressions.push({
      requestId: identity.requestId,
      attemptId: identity.attemptId,
      reason,
      at,
    });
    if (this.suppressions.length > 5_000) {
      this.suppressions.splice(0, 2_500);
    }
  }

  private updateAttemptOutcome(
    requestId: InferenceRequestId,
    attemptId: AttemptId,
    outcome: AttemptOutcome,
    errorCode: ErrorCode | undefined,
    finishedAt: number,
  ): void {
    this.repo.updateAttempt(requestId, attemptId, { outcome, errorCode, finishedAt });
  }
}

function abortError(): DOMException {
  return new DOMException('AbortError', 'AbortError');
}
