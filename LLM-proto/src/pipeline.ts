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
  InferenceStatus,
} from './types.js';
import type { SegmentAssignment, SegmentResult } from './protocol.js';
import { WorkerPool } from './worker-pool.js';
import { CheckpointStore } from './checkpoint.js';
import { withAbortableTimeout, delay } from './pipeline-utils.js';

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

const DEFAULT_OPTIONS: PipelineOptions = {
  maxRetries: 2,
  segmentTimeoutMs: 30_000,
  retryDelayMs: 1_000,
};

export class Pipeline {
  private readonly options: PipelineOptions;

  constructor(
    private readonly segments: readonly SegmentConfig[],
    private readonly workerPool: WorkerPool,
    private readonly checkpointStore: CheckpointStore,
    private readonly executor: SegmentExecutor,
    options?: Partial<PipelineOptions>,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute a full inference request through all segments.
   * Returns the final result or throws if all retries are exhausted.
   * Cleans up checkpoints on both success and failure.
   */
  async run(request: InferenceRequest): Promise<InferenceResult> {
    const startTime = Date.now();
    request.status = InferenceStatus.IN_PROGRESS;

    try {
      return await this.executeAllSegments(request, startTime);
    } catch (error) {
      // Clean up checkpoints on failure to prevent memory leaks
      this.checkpointStore.deleteAll(request.id);
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

      // Store checkpoint for intermediate segments
      if (result.checkpoint) {
        this.checkpointStore.save(result.checkpoint);
      }

      // Final segment produces the output
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
  ): Promise<SegmentResult | null> {
    const segment = this.segments[segmentIndex];

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const worker = this.workerPool.getAvailableWorker(segment.estimatedVramMB);
      if (!worker) {
        // No available worker: wait before retrying to let busy workers finish.
        if (attempt < this.options.maxRetries) {
          await delay(this.options.retryDelayMs);
          continue;
        }
        return null;
      }

      this.workerPool.markBusy(worker.id, segmentIndex);

      // Retrieve checkpoint from previous segment (undefined for segment 0)
      const checkpoint = segmentIndex > 0
        ? this.checkpointStore.get(request.id, segmentIndex - 1)
        : undefined;

      const assignment: SegmentAssignment = {
        requestId: request.id,
        segment,
        checkpoint,
      };

      try {
        const result = await this.executeWithTimeout(worker.id, assignment);
        this.workerPool.markIdle(worker.id);
        return result;
      } catch {
        // Worker failed: mark as DISCONNECTED so it is excluded from future
        // retry attempts. The checkpoint from the previous segment is still valid,
        // so no work is lost (only the current segment is retried).
        this.workerPool.markDisconnected(worker.id);
      }
    }

    return null;
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
