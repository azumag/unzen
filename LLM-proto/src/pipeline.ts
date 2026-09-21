/**
 * Pipeline: orchestrates a single inference request through N segments.
 *
 * Implements the checkpoint-resume pattern from PLAN.md 5.2:
 *   1. For each segment, select an available worker from the pool
 *   2. Send the segment assignment (with checkpoint from previous segment)
 *   3. On success: store checkpoint, advance to next segment
 *   4. On failure: mark worker disconnected, retry with a different worker
 *   5. Return final result after all segments complete
 *
 * The SegmentExecutor interface abstracts communication with browser workers.
 * In production it wraps WebSocket messaging; in tests it's mocked.
 */

import {
  type WorkerId,
  type InferenceRequest,
  type InferenceResult,
  type SegmentConfig,
  type InferenceRequestId,
  type Checkpoint,
  InferenceStatus,
} from './types.js';
import type { SegmentAssignment, SegmentResult } from './protocol.js';
import { WorkerPool } from './worker-pool.js';
import { CheckpointStore } from './checkpoint.js';
import { snapshotSpanSegments } from './span-router.js';
import {
  snapshotFinalOutput,
  type FinalOutputSnapshot,
} from './final-output-snapshot.js';
import { snapshotSegmentResultRoot } from './worker-result-root-snapshot.js';
import { MAX_TIMER_DELAY_MS, withAbortableTimeout, delay } from './pipeline-utils.js';

/**
 * Abstracts segment execution on a browser worker.
 * Production: WebSocket-based message exchange with the assigned browser.
 * Tests: Mock implementation that returns synthetic results.
 *
 * `options.signal` mirrors the `core/packages/client` cancellation contract
 * (issue #106): when the signal aborts the executor MUST settle (typically by
 * rejecting with AbortError, surfaced as user cancellation) and must never
 * trigger fallback/retry on its own. Existing callers that omit the option are
 * unaffected.
 */
export interface SegmentExecutor {
  execute(
    workerId: WorkerId,
    assignment: SegmentAssignment,
    options?: { readonly signal?: AbortSignal },
  ): Promise<SegmentResult>;
}

export interface PipelineOptions {
  /** Maximum retry attempts per segment (default: 2 per PLAN.md 5.4). */
  readonly maxRetries: number;
  /** Timeout per segment execution in ms. Executor.execute() is raced against this. */
  readonly segmentTimeoutMs: number;
  /** Delay between retry attempts when no worker is available (ms). */
  readonly retryDelayMs: number;
}

interface ValidatedSegmentResult {
  readonly checkpoint?: Checkpoint;
  readonly output?: FinalOutputSnapshot;
}

const DEFAULT_OPTIONS: PipelineOptions = {
  maxRetries: 2,
  segmentTimeoutMs: 30_000,
  retryDelayMs: 1_000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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

function resolvePipelineOptions(options: unknown): PipelineOptions {
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError('Pipeline options must be a non-null, non-array object');
  }

  // Runtime callers can supply accessor/Proxy-backed objects despite the static
  // Partial<PipelineOptions> type. Read only declared own-enumerable fields,
  // exactly once, so validation and retained state are bound to the same value
  // without enumerating unrelated properties or changing spread-era inheritance
  // semantics.
  const source = options as Partial<PipelineOptions> | undefined;
  const capturedMaxRetries = readOwnEnumerableOption(source, 'maxRetries');
  const capturedSegmentTimeoutMs = readOwnEnumerableOption(source, 'segmentTimeoutMs');
  const capturedRetryDelayMs = readOwnEnumerableOption(source, 'retryDelayMs');

  const maxRetries = capturedMaxRetries === undefined
    ? DEFAULT_OPTIONS.maxRetries
    : capturedMaxRetries;
  const segmentTimeoutMs = capturedSegmentTimeoutMs === undefined
    ? DEFAULT_OPTIONS.segmentTimeoutMs
    : capturedSegmentTimeoutMs;
  const retryDelayMs = capturedRetryDelayMs === undefined
    ? DEFAULT_OPTIONS.retryDelayMs
    : capturedRetryDelayMs;

  if (!isNonNegativeSafeInteger(maxRetries)) {
    throw new TypeError('Pipeline maxRetries must be a non-negative safe integer');
  }
  if (!isNonNegativeFiniteNumber(segmentTimeoutMs)) {
    throw new TypeError('Pipeline segmentTimeoutMs must be a non-negative finite number');
  }
  if (segmentTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `Pipeline segmentTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}ms`,
    );
  }
  if (!isNonNegativeFiniteNumber(retryDelayMs)) {
    throw new TypeError('Pipeline retryDelayMs must be a non-negative finite number');
  }
  if (retryDelayMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`Pipeline retryDelayMs must not exceed ${MAX_TIMER_DELAY_MS}ms`);
  }

  return {
    maxRetries,
    segmentTimeoutMs,
    retryDelayMs,
  };
}

function capturePipelineRunRequest(
  request: InferenceRequest,
  expectedTotalSegments: number,
): InferenceRequest {
  if (!isRecord(request)) {
    throw new TypeError('Pipeline request must be a non-null, non-array object');
  }

  const requestId = request.id;
  const totalSegments = request.totalSegments;
  const initialCurrentSegment = request.currentSegment;

  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new TypeError('Pipeline request id must be a non-empty string');
  }
  if (!isNonNegativeSafeInteger(totalSegments)) {
    throw new PipelineError(
      'Pipeline request totalSegments must be a non-negative safe integer',
      requestId as InferenceRequestId,
      -1,
    );
  }
  if (!isNonNegativeSafeInteger(initialCurrentSegment)) {
    throw new PipelineError(
      'Pipeline request currentSegment must be a non-negative safe integer',
      requestId as InferenceRequestId,
      -1,
    );
  }
  if (initialCurrentSegment > totalSegments) {
    throw new PipelineError(
      `Pipeline request currentSegment ${initialCurrentSegment} exceeds totalSegments ${totalSegments}`,
      requestId as InferenceRequestId,
      -1,
    );
  }
  if (totalSegments !== expectedTotalSegments) {
    throw new PipelineError(
      `Pipeline request totalSegments ${totalSegments} does not match pipeline segment count ${expectedTotalSegments}`,
      requestId as InferenceRequestId,
      -1,
    );
  }
  if (totalSegments > 0 && initialCurrentSegment === totalSegments) {
    throw new PipelineError(
      `Pipeline request currentSegment ${initialCurrentSegment} has no executable segment for totalSegments ${totalSegments}`,
      requestId as InferenceRequestId,
      -1,
    );
  }

  let currentSegment = initialCurrentSegment;
  return {
    id: requestId as InferenceRequestId,
    get prompt() {
      return request.prompt;
    },
    get createdAt() {
      return request.createdAt;
    },
    get status() {
      return request.status;
    },
    set status(value: InferenceStatus) {
      request.status = value;
    },
    get currentSegment() {
      return currentSegment;
    },
    set currentSegment(value: number) {
      currentSegment = value;
      request.currentSegment = value;
    },
    totalSegments,
  };
}

export class Pipeline {
  private readonly segments: readonly SegmentConfig[];
  private readonly options: PipelineOptions;

  constructor(
    segments: readonly SegmentConfig[],
    private readonly workerPool: WorkerPool,
    private readonly checkpointStore: CheckpointStore,
    private readonly executor: SegmentExecutor,
    options?: Partial<PipelineOptions>,
  ) {
    this.options = resolvePipelineOptions(options);
    this.segments = snapshotSpanSegments(segments, 'Pipeline');
  }

  /**
   * Execute a full inference request through all segments.
   * Returns the final result or throws if all retries are exhausted.
   * Cleans up checkpoints on both success and failure.
   */
  async run(request: InferenceRequest): Promise<InferenceResult> {
    const runRequest = capturePipelineRunRequest(request, this.segments.length);

    if (runRequest.totalSegments === 0) {
      runRequest.status = InferenceStatus.COMPLETED;
      this.checkpointStore.deleteAll(runRequest.id);
      return {
        requestId: runRequest.id,
        tokens: [],
        text: '',
        totalTimeMs: 0,
        segmentsCompleted: 0,
      };
    }

    const startTime = Date.now();
    runRequest.status = InferenceStatus.IN_PROGRESS;

    try {
      return await this.executeAllSegments(runRequest, startTime);
    } catch (error) {
      runRequest.status = InferenceStatus.FAILED;
      // Clean up checkpoints on failure to prevent memory leaks
      this.checkpointStore.deleteAll(runRequest.id);
      throw error;
    }
  }

  private async executeAllSegments(
    request: InferenceRequest,
    startTime: number,
  ): Promise<InferenceResult> {
    for (let i = request.currentSegment; i < request.totalSegments; i++) {
      request.currentSegment = i;
      const result = await this.executeSegmentWithRetry(request, i);

      if (!result) {
        request.status = InferenceStatus.FAILED;
        throw new PipelineError(
          `Segment ${i} failed after ${this.options.maxRetries} retries`,
          request.id,
          i,
        );
      }

      // Final segment produces the output. Intermediate checkpoints are already
      // committed inside the retry boundary before their worker becomes reusable.
      if (i === request.totalSegments - 1) {
        if (!result.output) {
          request.status = InferenceStatus.FAILED;
          throw new PipelineError(
            'Final segment did not produce output',
            request.id,
            i,
          );
        }

        request.status = InferenceStatus.COMPLETED;
        this.checkpointStore.deleteAll(request.id);

        return {
          requestId: request.id,
          tokens: result.output.tokens,
          text: result.output.text,
          totalTimeMs: Date.now() - startTime,
          segmentsCompleted: request.totalSegments,
        };
      }
    }

    // Should not reach here, but TypeScript needs the return
    throw new PipelineError('Pipeline ended without producing output', request.id, -1);
  }

  /**
   * Attempt to execute a single segment, retrying with different workers on failure.
   * Uses checkpoint-resume: the checkpoint from the previous segment is passed
   * to each retry attempt, so work is never duplicated (PLAN.md 5.2).
   *
   * When a worker fails, it is marked as DISCONNECTED so it won't be selected
   * again on the next retry. When no worker is available, a delay is inserted
   * before retrying to allow busy workers to become idle.
   */
  private async executeSegmentWithRetry(
    request: InferenceRequest,
    segmentIndex: number,
  ): Promise<ValidatedSegmentResult | null> {
    const segment = this.segments[segmentIndex];
    // Snapshot and validate the predecessor boundary once. A retry must execute
    // from the same known-good state even if the shared checkpoint store changes
    // while another browser attempt is failing.
    const checkpoint = segmentIndex > 0
      ? this.checkpointStore.get(request.id, segmentIndex - 1)
      : undefined;
    if (segmentIndex > 0 && checkpoint === undefined) {
      throw new PipelineError(
        `missing checkpoint before segment ${segmentIndex}`,
        request.id,
        segmentIndex,
      );
    }
    if (checkpoint !== undefined && checkpoint.requestId !== request.id) {
      throw new PipelineError(
        `checkpoint request ${checkpoint.requestId} does not match ${request.id}`,
        request.id,
        segmentIndex,
      );
    }
    if (checkpoint !== undefined && checkpoint.segmentIndex !== segmentIndex - 1) {
      throw new PipelineError(
        `checkpoint segment ${checkpoint.segmentIndex} does not precede segment ${segmentIndex}`,
        request.id,
        segmentIndex,
      );
    }

    let lastContractError: PipelineError | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const worker = this.workerPool.getAvailableWorker(segment.estimatedVramMB);
      if (!worker) {
        // No available worker: wait before retrying to let busy workers finish.
        if (attempt < this.options.maxRetries) {
          await delay(this.options.retryDelayMs);
          continue;
        }
        if (lastContractError) throw lastContractError;
        return null;
      }

      this.workerPool.markBusy(worker.id, segmentIndex);

      const assignment: SegmentAssignment = {
        requestId: request.id,
        segment,
        checkpoint,
      };

      try {
        const result = await this.executeWithTimeout(worker.id, assignment);
        // A resolved promise is not enough to trust browser output. Validate and
        // detach the accepted boundary before the worker becomes reusable.
        const validated = this.validateSegmentResult(request, worker.id, segmentIndex, result);
        if (validated.checkpoint !== undefined) {
          try {
            this.checkpointStore.save(validated.checkpoint);
          } catch (error) {
            const detail = error instanceof Error ? error.message : 'unknown checkpoint commit error';
            throw new PipelineError(
              `checkpoint commit failed after segment ${segmentIndex}: ${detail}`,
              request.id,
              segmentIndex,
            );
          }
        }
        this.workerPool.markIdle(worker.id);
        return validated;
      } catch (error) {
        // Worker failed or violated the result contract: mark it DISCONNECTED so
        // the same stale/misrouted browser cannot immediately satisfy the retry.
        // Preserve a contract failure so, if retries cannot recover, callers get
        // the boundary violation rather than an unrelated no-worker error.
        this.workerPool.markDisconnected(worker.id);
        if (error instanceof PipelineError) {
          lastContractError = error;
        }
      }
    }

    if (lastContractError) throw lastContractError;
    return null;
  }

  private validateSegmentResult(
    request: InferenceRequest,
    workerId: WorkerId,
    segmentIndex: number,
    result: unknown,
  ): ValidatedSegmentResult {
    if (!isRecord(result)) {
      throw new PipelineError(
        'segment result must be a non-null, non-array object',
        request.id,
        segmentIndex,
      );
    }

    const root = snapshotSegmentResultRoot(result);
    if (typeof root.requestId !== 'string') {
      throw new PipelineError(
        'segment result requestId must be a string',
        request.id,
        segmentIndex,
      );
    }
    if (root.requestId !== request.id) {
      throw new PipelineError(
        `segment result request ${root.requestId} does not match ${request.id}`,
        request.id,
        segmentIndex,
      );
    }
    if (!isNonNegativeSafeInteger(root.segmentIndex)) {
      throw new PipelineError(
        'segment result segmentIndex must be a non-negative safe integer',
        request.id,
        segmentIndex,
      );
    }
    if (root.segmentIndex !== segmentIndex) {
      throw new PipelineError(
        `segment result index ${root.segmentIndex} does not match assignment ${segmentIndex}`,
        request.id,
        segmentIndex,
      );
    }
    if (typeof root.workerId !== 'string') {
      throw new PipelineError(
        'segment result workerId must be a string',
        request.id,
        segmentIndex,
      );
    }
    if (root.workerId !== workerId) {
      throw new PipelineError(
        `segment result worker ${root.workerId} does not match assigned worker ${workerId}`,
        request.id,
        segmentIndex,
      );
    }
    if (!isNonNegativeFiniteNumber(root.processingTimeMs)) {
      throw new PipelineError(
        'segment processingTimeMs must be a non-negative finite number',
        request.id,
        segmentIndex,
      );
    }

    const checkpoint = root.checkpoint as Checkpoint | undefined;
    const output = root.output;
    const isFinalSegment = segmentIndex === request.totalSegments - 1;
    if (isFinalSegment) {
      if (output === undefined) {
        throw new PipelineError(
          'Final segment did not produce output',
          request.id,
          segmentIndex,
        );
      }
      if (checkpoint !== undefined) {
        throw new PipelineError(
          `final segment ${segmentIndex} must not produce a checkpoint`,
          request.id,
          segmentIndex,
        );
      }
      return {
        output: snapshotFinalOutput(
          output,
          (message) => new PipelineError(message, request.id, segmentIndex),
        ),
      };
    }

    if (output !== undefined) {
      throw new PipelineError(
        `non-final segment ${segmentIndex} must not produce output`,
        request.id,
        segmentIndex,
      );
    }
    if (checkpoint === undefined) {
      throw new PipelineError(
        `non-final segment ${segmentIndex} did not produce a checkpoint`,
        request.id,
        segmentIndex,
      );
    }
    if (!isRecord(checkpoint)) {
      throw new PipelineError(
        'segment result checkpoint must be a non-null, non-array object',
        request.id,
        segmentIndex,
      );
    }
    if (typeof checkpoint.requestId !== 'string') {
      throw new PipelineError(
        'checkpoint requestId must be a string',
        request.id,
        segmentIndex,
      );
    }
    if (checkpoint.requestId !== request.id) {
      throw new PipelineError(
        `checkpoint request ${checkpoint.requestId} does not match ${request.id}`,
        request.id,
        segmentIndex,
      );
    }
    if (!isNonNegativeSafeInteger(checkpoint.segmentIndex)) {
      throw new PipelineError(
        'checkpoint segmentIndex must be a non-negative safe integer',
        request.id,
        segmentIndex,
      );
    }
    if (checkpoint.segmentIndex !== segmentIndex) {
      throw new PipelineError(
        `checkpoint segment ${checkpoint.segmentIndex} does not match ` +
        `completed segment ${segmentIndex}`,
        request.id,
        segmentIndex,
      );
    }
    try {
      CheckpointStore.assertValidCheckpoint(checkpoint);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown checkpoint validation error';
      throw new PipelineError(
        `invalid checkpoint from segment ${segmentIndex}: ${detail}`,
        request.id,
        segmentIndex,
      );
    }
    return { checkpoint };
  }

  private executeWithTimeout(
    workerId: WorkerId,
    assignment: SegmentAssignment,
  ): Promise<SegmentResult> {
    // Issue #103: the timeout must abort the underlying execution, not just
    // orphan the promise, so the worker receives the signal via the executor.
    return withAbortableTimeout(
      (signal) => this.executor.execute(workerId, assignment, { signal }),
      this.options.segmentTimeoutMs,
      `Segment ${assignment.segment.index}`,
    );
  }
}

/**
 * Error thrown when a pipeline fails to complete an inference request.
 * Contains context about which segment failed for debugging.
 */
export class PipelineError extends Error {
  constructor(
    message: string,
    public readonly requestId: InferenceRequestId,
    public readonly segmentIndex: number,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}
