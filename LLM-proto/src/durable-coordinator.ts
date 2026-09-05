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
 *   - cancellation / timeout: per-request AbortController; cancel and timeout
 *     propagate to the underlying SegmentExecutor and abort its work.
 *
 * The legacy Coordinator / Pipeline / WorkerPool / CheckpointStore remain for
 * their existing contract tests; this class is the durable path.
 */

import { InMemoryRepository } from './durable-repository.js';
import type { DurableRepository } from './durable-repository.js';
import { WorkerRegistry } from './worker-registry.js';
import { LeaseManager } from './lease-manager.js';
import type { IdentityMatch, IdentityMismatchReason } from './lease-manager.js';
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
import type { AttemptId, IdempotencyKey } from './ids.js';
import { WorkerTier, type WorkerId, type InferenceRequestId, type SegmentConfig } from './types.js';
import type { InferenceResult } from './types.js';
import { validateCheckpointEnvelope, isCheckpointExpired } from './checkpoint-envelope.js';
import type { CheckpointEnvelope } from './checkpoint-envelope.js';
import { withAbortableTimeout, delay } from './pipeline-utils.js';
import type {
  AttemptRecord,
  AttemptOutcome,
  CancellationRecord,
  ExecutionAssignment,
  ExecutionFailure,
  ExecutionResult,
  Lease,
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
  /** Grace period after which a cancel is force-acknowledged (default: 5000). */
  readonly cancelAckDeadlineMs: number;
  /** Hard cap on a checkpoint payload (default: 64 MiB). */
  readonly maxCheckpointBytes: number;
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
  cancel(): void;
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

export interface CancellationAck {
  readonly requestId: InferenceRequestId;
  readonly requestedAt: number;
  readonly deadlineMs: number;
  /** True when no in-flight work had to be stopped (acknowledged at once). */
  readonly acknowledged: boolean;
}

/** Outcome of validating a pushed/late result at the Coordinator boundary. */
export type SegmentAcceptance =
  | { readonly kind: 'accepted'; readonly isFinal: boolean; readonly checkpoint?: CheckpointEnvelope; readonly output?: { readonly tokens: readonly number[]; readonly text: string } }
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
  cancelKind: 'user' | 'deadline';
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

    // Idempotency: an existing key returns the existing request's status/result.
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

    // Per-request cancellation: user signal + deadline share one controller.
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
      .then(() => {
        const result = this.repo.getResult(requestId);
        if (result) return result;
        const current = this.repo.getRequest(requestId);
        if (current?.stage === 'cancelled') {
          throw new UnzenCancelledError(`request ${requestId} was cancelled`);
        }
        throw new UnzenError(
          current?.lastError ?? `request ${requestId} failed`,
          current?.lastErrorCode ?? ErrorCode.RuntimeTransient,
        );
      })
      .finally(() => {
        entry.cleanup();
        this.inFlight.delete(requestId);
      });
    entry.resultPromise = resultPromise;

    return {
      requestId,
      result: resultPromise,
      status: () => this.repo.getRequest(requestId)?.stage ?? 'failed',
      cancel: () => this.cancel(requestId),
    };
  }

  /** Build a submission for a request that already exists (idempotent replay). */
  private submissionForExisting(requestId: InferenceRequestId): DurableSubmission {
    const entry = this.inFlight.get(requestId);
    if (entry?.resultPromise) {
      return {
        requestId,
        result: entry.resultPromise,
        status: () => this.repo.getRequest(requestId)?.stage ?? 'failed',
        cancel: () => this.cancel(requestId),
      };
    }
    const stored = this.repo.getResult(requestId);
    if (stored) {
      return {
        requestId,
        result: Promise.resolve(stored),
        status: () => 'completed',
        cancel: () => {},
      };
    }
    // Terminal-but-resultless, or running on another instance: wait on the repo.
    return {
      requestId,
      result: this.waitForTerminalResult(requestId),
      status: () => this.repo.getRequest(requestId)?.stage ?? 'failed',
      cancel: () => this.cancel(requestId),
    };
  }

  /** Poll the repository until a terminal result exists (cross-instance wait). */
  private waitForTerminalResult(requestId: InferenceRequestId): Promise<InferenceResult> {
    return new Promise<InferenceResult>((resolve, reject) => {
      const check = () => {
        const result = this.repo.getResult(requestId);
        if (result) return resolve(result);
        const record = this.repo.getRequest(requestId);
        if (!record) return reject(new UnzenError('unknown request', ErrorCode.RequestNotFound));
        if (record.stage === 'cancelled') {
          return reject(new UnzenCancelledError(`request ${requestId} was cancelled`));
        }
        if (record.stage === 'failed') {
          return reject(new UnzenError(record.lastError ?? 'request failed', record.lastErrorCode ?? ErrorCode.RuntimeTransient));
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  // --- Request execution (pull model) ---

  private async runRequest(requestId: InferenceRequestId, signal: AbortSignal): Promise<void> {
    const record = this.repo.getRequest(requestId);
    if (record) record.startedAt = Date.now();
    try {
      await this.executeAllSegments(requestId, signal);
      const current = this.repo.getRequest(requestId);
      if (current && !TERMINAL_STAGES.includes(current.stage)) {
        this.finalizeStage(requestId, 'failed', ErrorCode.RuntimeTransient, 'pipeline ended without a result');
      }
    } catch (error) {
      const code = classifyError(error);
      const kind = this.inFlight.get(requestId)?.cancelKind ?? 'user';
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
      const result = await this.executeSegmentWithRetry(requestId, segmentIndex, signal);
      if (!result) return; // finalized (failed/cancelled) inside
      const current = this.repo.getRequest(requestId)!;
      if (current.stage === 'completed') return; // final commit done by acceptResult
      // Intermediate segment: advance the streaming cursor and request pointer.
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

      const record = this.repo.getRequest(requestId)!;
      if (record.stage === 'retry-wait') {
        this.transitionOrThrow(requestId, 'retry-wait', 'queued');
      }

      // Continuation segments must have a valid predecessor checkpoint before
      // any worker capacity is reserved. Missing/expired/cross-run state is a
      // terminal integrity failure; never dispatch an undefined checkpoint.
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

      // Issue the lease with the full assignment identity.
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
            // A non-final segment returns the request to the scheduling queue
            // for its next segment's lease; the final segment stays completed.
            if (!acceptance.isFinal) {
              this.transitionOrThrow(requestId, 'running', 'queued');
            }
            return result;
          case 'duplicate':
            // 'duplicate' means the result was already committed; the request
            // is completed and the outer loop will stop on stage === completed.
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
        if (signal.aborted) throw error; // cancel / deadline handled by runRequest

        const code = classifyError(error);
        this.leaseManager.reclaimByRequest(requestId);
        this.updateAttemptOutcome(requestId, attemptId, 'failed', code, Date.now());

        if (retryPolicyFor(code) === RetryPolicy.Retryable && attempt < this.options.maxRetries) {
          // Isolate unresponsive/transient workers so the retry picks another.
          if (isIsolatable(code)) {
            this.registry.markDisconnected(worker.workerId, worker.generation);
          }
          const current = this.repo.getRequest(requestId)!;
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
      default:
        return ErrorCode.ProtocolViolation;
    }
  }

  /**
   * Validate a result at the Coordinator boundary and, when it matches the
   * active lease exactly, commit the checkpoint / final result.
   */
  async acceptResult(result: ExecutionResult, now = Date.now()): Promise<SegmentAcceptance> {
    const match = this.leaseManager.match(result.identity, now);
    if (!match.ok) {
      this.recordSuppression(result.identity, match.reason, now);
      return { kind: 'identity-mismatch', reason: match.reason };
    }
    const record = this.repo.getRequest(result.identity.requestId);
    if (!record) {
      this.recordSuppression(result.identity, 'request-not-found', now);
      return { kind: 'protocol-violation', message: 'request not found' };
    }
    const isFinal = result.identity.segmentIndex === record.totalSegments - 1;

    if (isFinal) {
      if (!result.output) {
        return { kind: 'output-missing' };
      }
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
        // The run is over: release its checkpoints so intermediate state never
        // stays in memory after completion (issue #103 deliverable 10).
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

    // Intermediate segment: a checkpoint envelope is mandatory and must pass
    // full integrity + identity validation before it touches the store.
    if (!result.checkpoint) {
      this.recordSuppression(result.identity, 'missing-checkpoint', now);
      return { kind: 'protocol-violation', message: 'intermediate segment produced no checkpoint' };
    }
    const validation = await validateCheckpointEnvelope(result.checkpoint, {
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
    const store = this.repo.putCheckpoint(result.checkpoint);
    if (store === 'conflict') {
      this.recordSuppression(result.identity, 'checkpoint-conflict', now);
      this.isolateWorker(result.identity);
      return { kind: 'checkpoint-conflict' };
    }
    this.updateAttemptOutcome(result.identity.requestId, result.identity.attemptId, 'completed', undefined, now);
    this.leaseManager.reclaimByRequest(result.identity.requestId);
    return { kind: 'accepted', isFinal: false, checkpoint: result.checkpoint };
  }

  // --- Push-model entry points (worker messages) ---

  /** Validate and commit (or suppress) a pushed segment result. */
  handleWorkerResult(result: ExecutionResult): Promise<SegmentAcceptance> {
    return this.acceptResult(result);
  }

  /** Record and reclaim a pushed failure; isolation follows the error code. */
  handleWorkerFailure(failure: ExecutionFailure): void {
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

  /**
   * Cancel a request: record the cancellation, abort the in-flight work, and
   * let the executor settle. Acknowledged immediately when no work is running.
   */
  cancel(requestId: InferenceRequestId): CancellationAck {
    const entry = this.inFlight.get(requestId);
    const requestedAt = Date.now();
    const deadlineMs = this.options.cancelAckDeadlineMs;
    if (entry) {
      entry.cancelKind = 'user';
      entry.controller.abort();
    }
    const record = this.repo.getCancellation(requestId);
    const cancellation: CancellationRecord = {
      requestId,
      requestedAt,
      deadlineMs,
      acknowledgedAt: entry ? undefined : requestedAt,
    };
    if (record?.acknowledgedAt !== undefined) cancellation.acknowledgedAt = record.acknowledgedAt;
    this.repo.putCancellation(requestId, cancellation);
    return { requestId, requestedAt, deadlineMs, acknowledged: !entry };
  }

  private acknowledgeCancellation(requestId: InferenceRequestId): void {
    const record = this.repo.getCancellation(requestId);
    if (record && record.acknowledgedAt === undefined) {
      record.acknowledgedAt = Date.now();
      this.repo.putCancellation(requestId, record);
    }
  }

  // --- Worker management ---

  /**
   * Register (or re-register) a worker. Capability is validated against the
   * model manifest; re-registration on a new connection revokes the old
   * generation and reclaims its leases.
   */
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

  /** Process a heartbeat. Throws structured errors for unknown/stale generations. */
  workerHeartbeat(workerId: WorkerId, generation: string): boolean {
    this.registry.heartbeat(workerId, generation as never);
    return true;
  }

  /** Remove a worker (connection closed): revoke its generation + leases. */
  removeWorker(workerId: WorkerId): void {
    const record = this.registry.get(workerId);
    if (record) {
      this.registry.revokeGeneration(workerId, record.generation);
      this.leaseManager.reclaimByWorkerGeneration(workerId, record.generation);
    }
  }

  // --- Monitors ---

  /** Periodic heartbeat monitoring: disconnect timed-out workers + reclaim leases. */
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

  /** Periodic cleanup so checkpoints never remain in memory forever. */
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

  /** Suppressed (late/duplicate/stale) deliveries, for observability. */
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

  /**
   * Finalize a request to a terminal stage. Late updates from terminal states
   * are rejected: a stale completion/cancel that arrives after the request
   * already terminated never mutates state.
   */
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

  /** Quarantine a worker generation after protocol/identity/integrity failure. */
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
    // Bound the in-memory observability log so a hostile/long-lived stream of
    // late results cannot grow it without limit.
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