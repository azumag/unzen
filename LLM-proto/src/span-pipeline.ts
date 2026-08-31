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

import type { ArtifactResidencyLedger } from './artifact-residency-ledger.js';
import {
  type Checkpoint,
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
import { SpanRouter, type Route, type Span } from './span-router.js';
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
  /** Maximum retry attempts after the initial route (default: 2). */
  readonly maxRetries: number;
  /** Timeout per span execution in ms. Scales with span size. */
  readonly perSegmentTimeoutMs: number;
  /** Delay between retry attempts when routing fails (ms). */
  readonly retryDelayMs: number;
  /**
   * Optional manifest-backed browser cache inventory. The router prefers
   * contiguous resident artifacts, and successful execution commits the span
   * to that worker's residency snapshot.
   */
  readonly artifactResidencyLedger?: ArtifactResidencyLedger;
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
    this.options.artifactResidencyLedger?.assertCompatibleSegments(segments);
  }

  /**
   * Execute a full inference request using span-based routing.
   *
   * A durable checkpoint already present for this request is honored on the
   * first attempt. Later worker failures retain the newest validated checkpoint
   * and reroute only the unfinished suffix. Checkpoints are deleted only after
   * final success or terminal failure.
   */
  async run(request: InferenceRequest): Promise<InferenceResult> {
    if (this.segments.length === 0) {
      request.status = InferenceStatus.COMPLETED;
      return { requestId: request.id, tokens: [], text: '', totalTimeMs: 0, segmentsCompleted: 0 };
    }

    const startTime = Date.now();
    request.status = InferenceStatus.IN_PROGRESS;

    try {
      return await this.executeWithRoute(request, startTime);
    } catch (error) {
      request.status = InferenceStatus.FAILED;
      this.checkpointStore.deleteAll(request.id);
      throw error;
    }
  }

  private async executeWithRoute(
    request: InferenceRequest,
    startTime: number,
  ): Promise<InferenceResult> {
    // A final segment produces output, not a resumable checkpoint. Bounding the
    // lookup at N-2 prevents malformed/stale final checkpoints from skipping
    // the output-producing span.
    let resumeCheckpoint = this.checkpointStore.latest(
      request.id,
      this.segments.length - 2,
    );
    let resumeSegment = resumeCheckpoint === undefined
      ? 0
      : resumeCheckpoint.segmentIndex + 1;
    request.currentSegment = resumeSegment;

    // Router reads workerPool and residency state lazily on every computeRoute()
    // call, so retries exclude disconnected workers and use current cache facts.
    const router = new SpanRouter(
      this.segments,
      this.workerPool,
      this.options.artifactResidencyLedger,
    );

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      const route = router.computeRoute(resumeSegment);
      if (!route || route.length === 0) {
        if (attempt < this.options.maxRetries) {
          await delay(this.options.retryDelayMs);
          continue;
        }
        throw new SpanPipelineError(
          `No viable route for unfinished suffix starting at segment ${resumeSegment}`,
          request.id,
        );
      }

      try {
        return await this.executeRoute(
          request,
          route,
          startTime,
          resumeCheckpoint,
        );
      } catch (error) {
        if (attempt >= this.options.maxRetries) {
          throw error;
        }

        // A route may have completed one or more spans before a later worker
        // failed. Keep the newest validated boundary and retry only after it.
        const latest = this.checkpointStore.latest(
          request.id,
          this.segments.length - 2,
        );
        if (
          latest !== undefined &&
          (resumeCheckpoint === undefined || latest.segmentIndex >= resumeCheckpoint.segmentIndex)
        ) {
          resumeCheckpoint = latest;
          resumeSegment = latest.segmentIndex + 1;
          request.currentSegment = resumeSegment;
        }
      }
    }

    throw new SpanPipelineError('Route execution exhausted all retries', request.id);
  }

  /** Execute one suffix route, relaying checkpoints only at span boundaries. */
  private async executeRoute(
    request: InferenceRequest,
    route: Route,
    startTime: number,
    initialCheckpoint: Checkpoint | undefined,
  ): Promise<InferenceResult> {
    for (let i = 0; i < route.length; i++) {
      const span = route[i];
      const isFinalSpan = span.endSegment === this.segments.length - 1;
      const spanSegments = this.segments.slice(span.startSegment, span.endSegment + 1);
      const checkpoint = i === 0
        ? initialCheckpoint
        : this.checkpointStore.get(request.id, route[i - 1].endSegment);

      this.assertInputCheckpoint(request, span, checkpoint);
      const assignment: SpanAssignment = {
        requestId: request.id,
        segments: spanSegments,
        checkpoint,
      };

      // currentSegment tracks the unfinished suffix boundary, while WorkerInfo
      // tracks the current span's first segment.
      request.currentSegment = span.startSegment;
      this.workerPool.markBusy(span.workerId, span.startSegment);
      const spanSize = span.endSegment - span.startSegment + 1;
      const timeoutMs = spanSize * this.options.perSegmentTimeoutMs;

      try {
        const result = await this.executeSpanWithTimeout(
          span.workerId,
          assignment,
          timeoutMs,
        );
        this.assertSpanResult(request, span, result, isFinalSpan);

        this.workerPool.markIdle(span.workerId);
        this.options.artifactResidencyLedger?.markResidentRange(
          span.workerId,
          span.startSegment,
          span.endSegment,
        );

        if (!isFinalSpan) {
          // assertSpanResult guarantees the checkpoint exists and matches the
          // completed boundary before it reaches durable storage.
          this.checkpointStore.save(result.checkpoint!);
          request.currentSegment = span.endSegment + 1;
          continue;
        }

        request.status = InferenceStatus.COMPLETED;
        request.currentSegment = this.segments.length;
        this.checkpointStore.deleteAll(request.id);
        return {
          requestId: request.id,
          tokens: result.output!.tokens,
          text: result.output!.text,
          totalTimeMs: Date.now() - startTime,
          segmentsCompleted: this.segments.length,
        };
      } catch (error) {
        // A disconnected or contract-violating browser can no longer prove that
        // either its execution result or Cache API entry is trustworthy.
        this.workerPool.markDisconnected(span.workerId);
        this.options.artifactResidencyLedger?.clearWorker(span.workerId);
        throw error;
      }
    }

    throw new SpanPipelineError('Route ended without producing output', request.id);
  }

  private assertInputCheckpoint(
    request: InferenceRequest,
    span: Span,
    checkpoint: Checkpoint | undefined,
  ): void {
    if (span.startSegment === 0) {
      if (checkpoint !== undefined) {
        throw new SpanPipelineError(
          'segment 0 must not receive a checkpoint',
          request.id,
        );
      }
      return;
    }

    if (checkpoint === undefined) {
      throw new SpanPipelineError(
        `missing checkpoint before segment ${span.startSegment}`,
        request.id,
      );
    }
    if (checkpoint.requestId !== request.id) {
      throw new SpanPipelineError(
        `checkpoint request ${checkpoint.requestId} does not match ${request.id}`,
        request.id,
      );
    }
    if (checkpoint.segmentIndex !== span.startSegment - 1) {
      throw new SpanPipelineError(
        `checkpoint segment ${checkpoint.segmentIndex} does not precede ` +
        `span start ${span.startSegment}`,
        request.id,
      );
    }
  }

  private assertSpanResult(
    request: InferenceRequest,
    span: Span,
    result: SpanResult,
    isFinalSpan: boolean,
  ): void {
    if (result.requestId !== request.id) {
      throw new SpanPipelineError(
        `span result request ${result.requestId} does not match ${request.id}`,
        request.id,
      );
    }
    if (result.workerId !== span.workerId) {
      throw new SpanPipelineError(
        `span result worker ${result.workerId} does not match assigned worker ${span.workerId}`,
        request.id,
      );
    }
    if (result.startSegment !== span.startSegment || result.endSegment !== span.endSegment) {
      throw new SpanPipelineError(
        `span result range ${result.startSegment}..${result.endSegment} does not match ` +
        `assignment ${span.startSegment}..${span.endSegment}`,
        request.id,
      );
    }
    if (!Number.isFinite(result.processingTimeMs) || result.processingTimeMs < 0) {
      throw new SpanPipelineError(
        `span processingTimeMs must be a non-negative finite number`,
        request.id,
      );
    }

    if (isFinalSpan) {
      if (result.checkpoint !== undefined) {
        throw new SpanPipelineError(
          `final span ${span.startSegment}..${span.endSegment} must not produce a checkpoint`,
          request.id,
        );
      }
      if (result.output === undefined) {
        throw new SpanPipelineError(
          'Final span did not produce output',
          request.id,
        );
      }
      return;
    }

    if (result.output !== undefined) {
      throw new SpanPipelineError(
        `non-final span ${span.startSegment}..${span.endSegment} must not produce output`,
        request.id,
      );
    }
    if (result.checkpoint === undefined) {
      throw new SpanPipelineError(
        `non-final span ${span.startSegment}..${span.endSegment} did not produce a checkpoint`,
        request.id,
      );
    }
    if (result.checkpoint.requestId !== request.id) {
      throw new SpanPipelineError(
        `checkpoint request ${result.checkpoint.requestId} does not match ${request.id}`,
        request.id,
      );
    }
    if (result.checkpoint.segmentIndex !== span.endSegment) {
      throw new SpanPipelineError(
        `checkpoint segment ${result.checkpoint.segmentIndex} does not match ` +
        `span end ${span.endSegment}`,
        request.id,
      );
    }
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
