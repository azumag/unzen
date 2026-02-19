/**
 * SpanPipeline: Petals-inspired pipeline that assigns contiguous segment spans to workers.
 *
 * Unlike the basic Pipeline (1 segment per worker), SpanPipeline uses the SpanRouter
 * to assign multiple contiguous segments to a single worker when VRAM allows.
 * This reduces checkpoint transfers: a route with 3 spans instead of 8 individual
 * segments means only 2 checkpoint hops instead of 7.
 *
 * Example with 8 segments and 3 workers:
 *   Basic Pipeline:    W1[0] → W2[1] → W3[2] → W1[3] → W2[4] → W3[5] → W1[6] → W2[7]
 *                      (7 checkpoint transfers)
 *   SpanPipeline:      W1[0-3] → W2[4-5] → W3[6-7]
 *                      (2 checkpoint transfers, ~70% less latency overhead)
 *
 * The SpanExecutor interface abstracts how a span is executed on a worker.
 * In production, the worker receives all segment configs in the span and processes
 * them sequentially in GPU memory without serializing intermediate hidden states.
 */

import {
  type WorkerId,
  type InferenceRequest,
  type InferenceResult,
  type SegmentConfig,
  type InferenceRequestId,
  InferenceStatus,
} from './types.js';
import type { SpanAssignment, SpanResult } from './protocol.js';
import { WorkerPool } from './worker-pool.js';
import { CheckpointStore } from './checkpoint.js';
import { SpanRouter, type Route } from './span-router.js';
import { withTimeout, delay } from './pipeline-utils.js';

/**
 * Executes a span of contiguous segments on a single browser worker.
 * The worker keeps hidden states in GPU memory between segments within the span,
 * only producing a checkpoint after the last segment.
 */
export interface SpanExecutor {
  execute(workerId: WorkerId, assignment: SpanAssignment): Promise<SpanResult>;
}

export interface SpanPipelineOptions {
  /** Maximum retry attempts per span (default: 2). */
  readonly maxRetries: number;
  /** Timeout per span execution in ms. Scales with span size. */
  readonly perSegmentTimeoutMs: number;
  /** Delay between retry attempts when routing fails (ms). */
  readonly retryDelayMs: number;
}

const DEFAULT_OPTIONS: SpanPipelineOptions = {
  maxRetries: 2,
  perSegmentTimeoutMs: 10_000,
  retryDelayMs: 1_000,
};

export class SpanPipeline {
  private readonly options: SpanPipelineOptions;

  constructor(
    private readonly segments: readonly SegmentConfig[],
    private readonly workerPool: WorkerPool,
    private readonly checkpointStore: CheckpointStore,
    private readonly executor: SpanExecutor,
    options?: Partial<SpanPipelineOptions>,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Execute a full inference request using span-based routing.
   * 1. Compute the optimal route (spans) using SpanRouter
   * 2. Execute each span sequentially, passing checkpoints between them
   * 3. Clean up checkpoints on both success and failure
   */
  async run(request: InferenceRequest): Promise<InferenceResult> {
    // Edge case: no segments to process
    if (this.segments.length === 0) {
      request.status = InferenceStatus.COMPLETED;
      return { requestId: request.id, tokens: [], text: '', totalTimeMs: 0, segmentsCompleted: 0 };
    }

    const startTime = Date.now();
    request.status = InferenceStatus.IN_PROGRESS;

    try {
      return await this.executeWithRoute(request, startTime);
    } catch (error) {
      this.checkpointStore.deleteAll(request.id);
      throw error;
    }
  }

  private async executeWithRoute(
    request: InferenceRequest,
    startTime: number,
  ): Promise<InferenceResult> {
    // Router reads workerPool state lazily on each computeRoute() call,
    // so workers marked disconnected during retries are automatically excluded.
    const router = new SpanRouter(this.segments, this.workerPool);

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const route = router.computeRoute();
      if (!route || route.length === 0) {
        // No viable route: wait and retry
        if (attempt < this.options.maxRetries) {
          await delay(this.options.retryDelayMs);
          continue;
        }
        request.status = InferenceStatus.FAILED;
        throw new SpanPipelineError(
          'No viable route: insufficient workers to cover all segments',
          request.id,
        );
      }

      try {
        return await this.executeRoute(request, route, startTime);
      } catch (error) {
        // Clean up checkpoints from partial execution before retrying
        this.checkpointStore.deleteAll(request.id);
        if (attempt >= this.options.maxRetries) {
          request.status = InferenceStatus.FAILED;
          throw error;
        }
        // Route failed: retry with a new route (failed workers are already disconnected)
      }
    }

    // Should not reach here
    throw new SpanPipelineError('Route execution exhausted all retries', request.id);
  }

  /**
   * Execute a pre-computed route: sequentially process each span,
   * passing checkpoints between span boundaries.
   */
  private async executeRoute(
    request: InferenceRequest,
    route: Route,
    startTime: number,
  ): Promise<InferenceResult> {
    for (let i = 0; i < route.length; i++) {
      const span = route[i];
      const isLastSpan = i === route.length - 1;

      // Get the segments for this span
      const spanSegments = this.segments.slice(span.startSegment, span.endSegment + 1);

      // Get checkpoint from previous span (undefined for first span)
      const checkpoint = i > 0
        ? this.checkpointStore.get(request.id, route[i - 1].endSegment)
        : undefined;

      const assignment: SpanAssignment = {
        requestId: request.id,
        segments: spanSegments,
        checkpoint,
      };

      // Mark worker as busy. currentSegment tracks the span's start index;
      // the span's full range is tracked in the route, not in WorkerInfo.
      this.workerPool.markBusy(span.workerId, span.startSegment);

      // Timeout scales with span size (more segments = more time needed)
      const spanSize = span.endSegment - span.startSegment + 1;
      const timeoutMs = spanSize * this.options.perSegmentTimeoutMs;

      try {
        const result = await this.executeSpanWithTimeout(
          span.workerId,
          assignment,
          timeoutMs,
        );

        this.workerPool.markIdle(span.workerId);

        // Save checkpoint at span boundary (if not the last span)
        if (result.checkpoint) {
          this.checkpointStore.save(result.checkpoint);
        }

        // Last span should produce the final output
        if (isLastSpan) {
          if (!result.output) {
            request.status = InferenceStatus.FAILED;
            throw new SpanPipelineError(
              'Final span did not produce output',
              request.id,
            );
          }

          request.status = InferenceStatus.COMPLETED;
          this.checkpointStore.deleteAll(request.id);

          return {
            requestId: request.id,
            tokens: result.output.tokens,
            text: result.output.text,
            totalTimeMs: Date.now() - startTime,
            segmentsCompleted: this.segments.length,
          };
        }
      } catch (error) {
        // Span failed: mark worker as disconnected and let the caller retry with new route
        this.workerPool.markDisconnected(span.workerId);
        throw error;
      }
    }

    throw new SpanPipelineError('Route ended without producing output', request.id);
  }

  private executeSpanWithTimeout(
    workerId: WorkerId,
    assignment: SpanAssignment,
    timeoutMs: number,
  ): Promise<SpanResult> {
    const label = `Span [${assignment.segments[0].index}-${assignment.segments[assignment.segments.length - 1].index}]`;
    return withTimeout(this.executor.execute(workerId, assignment), timeoutMs, label);
  }
}

export class SpanPipelineError extends Error {
  constructor(
    message: string,
    public readonly requestId: InferenceRequestId,
  ) {
    super(message);
    this.name = 'SpanPipelineError';
  }
}
