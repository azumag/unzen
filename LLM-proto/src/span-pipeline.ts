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
import {
  SpanRouter,
  snapshotSpanSegments,
  type Route,
  type Span,
} from './span-router.js';
import {
  snapshotFinalOutput,
  type FinalOutputSnapshot,
} from './final-output-snapshot.js';
import { snapshotSpanResultRoot } from './worker-result-root-snapshot.js';
import { MAX_TIMER_DELAY_MS, withAbortableTimeout, delay } from './pipeline-utils.js';
import { SegmentTimeoutError } from './errors.js';

/**
 * Executes a span of contiguous segments on a single browser worker.
 * The worker keeps hidden states in GPU memory between segments within the span,
 * only producing a checkpoint after the last segment.
 *
 * `signal` is aborted when the span timeout elapses. Implementations should stop
 * transport/GPU work cooperatively so a disconnected worker does not keep an
 * orphaned span running after the coordinator has moved on.
 */
export interface SpanExecutor {
  execute(
    workerId: WorkerId,
    assignment: SpanAssignment,
    signal?: AbortSignal,
  ): Promise<SpanResult>;
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

interface SpanRunEnvelope {
  readonly requestId: InferenceRequestId;
  readonly totalSegments: number;
  readonly initialCurrentSegment: number;
}

interface ValidatedSpanResult {
  readonly checkpoint?: Checkpoint;
  readonly output?: FinalOutputSnapshot;
}

const DEFAULT_OPTIONS: SpanPipelineOptions = {
  maxRetries: 2,
  perSegmentTimeoutMs: 10_000,
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

function resolveSpanPipelineOptions(options: unknown): SpanPipelineOptions {
  if (options !== undefined && !isRecord(options)) {
    throw new TypeError('SpanPipeline options must be a non-null, non-array object');
  }

  // Do not spread or enumerate caller-owned objects. Capture only declared
  // own-enumerable fields, preserving the old spread semantics for inherited or
  // non-enumerable properties. Numeric controls are validated before the optional
  // residency dependency is read so malformed timing input still fails before
  // dependency side effects.
  const source = options as Partial<SpanPipelineOptions> | undefined;
  const capturedMaxRetries = readOwnEnumerableOption(source, 'maxRetries');
  const capturedPerSegmentTimeoutMs = readOwnEnumerableOption(source, 'perSegmentTimeoutMs');
  const capturedRetryDelayMs = readOwnEnumerableOption(source, 'retryDelayMs');

  const maxRetries = capturedMaxRetries === undefined
    ? DEFAULT_OPTIONS.maxRetries
    : capturedMaxRetries;
  const perSegmentTimeoutMs = capturedPerSegmentTimeoutMs === undefined
    ? DEFAULT_OPTIONS.perSegmentTimeoutMs
    : capturedPerSegmentTimeoutMs;
  const retryDelayMs = capturedRetryDelayMs === undefined
    ? DEFAULT_OPTIONS.retryDelayMs
    : capturedRetryDelayMs;

  if (!isNonNegativeSafeInteger(maxRetries)) {
    throw new TypeError('SpanPipeline maxRetries must be a non-negative safe integer');
  }
  if (!isNonNegativeFiniteNumber(perSegmentTimeoutMs)) {
    throw new TypeError('SpanPipeline perSegmentTimeoutMs must be a non-negative finite number');
  }
  if (perSegmentTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `SpanPipeline perSegmentTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}ms`,
    );
  }
  if (!isNonNegativeFiniteNumber(retryDelayMs)) {
    throw new TypeError('SpanPipeline retryDelayMs must be a non-negative finite number');
  }
  if (retryDelayMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`SpanPipeline retryDelayMs must not exceed ${MAX_TIMER_DELAY_MS}ms`);
  }

  const artifactResidencyLedger = readOwnEnumerableOption(source, 'artifactResidencyLedger');
  return artifactResidencyLedger === undefined
    ? {
        maxRetries,
        perSegmentTimeoutMs,
        retryDelayMs,
      }
    : {
        maxRetries,
        perSegmentTimeoutMs,
        retryDelayMs,
        artifactResidencyLedger,
      };
}

function captureSpanRunEnvelope(
  request: InferenceRequest,
  expectedTotalSegments: number,
): SpanRunEnvelope {
  if (!isRecord(request)) {
    throw new TypeError('SpanPipeline request must be a non-null, non-array object');
  }

  // Capture caller-owned identity/geometry once before any worker or checkpoint
  // side effect. Accessor-backed or Proxy inputs cannot redirect a later span by
  // returning a different value on a second read.
  const requestId = request.id;
  const totalSegments = request.totalSegments;
  const initialCurrentSegment = request.currentSegment;

  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new TypeError('SpanPipeline request id must be a non-empty string');
  }
  if (!isNonNegativeSafeInteger(totalSegments)) {
    throw new SpanPipelineError(
      'SpanPipeline request totalSegments must be a non-negative safe integer',
      requestId as InferenceRequestId,
    );
  }
  if (!isNonNegativeSafeInteger(initialCurrentSegment)) {
    throw new SpanPipelineError(
      'SpanPipeline request currentSegment must be a non-negative safe integer',
      requestId as InferenceRequestId,
    );
  }
  if (initialCurrentSegment > totalSegments) {
    throw new SpanPipelineError(
      `SpanPipeline request currentSegment ${initialCurrentSegment} exceeds totalSegments ${totalSegments}`,
      requestId as InferenceRequestId,
    );
  }
  if (totalSegments !== expectedTotalSegments) {
    throw new SpanPipelineError(
      `SpanPipeline request totalSegments ${totalSegments} does not match pipeline segment count ${expectedTotalSegments}`,
      requestId as InferenceRequestId,
    );
  }
  if (totalSegments > 0 && initialCurrentSegment === totalSegments) {
    throw new SpanPipelineError(
      `SpanPipeline request currentSegment ${initialCurrentSegment} has no executable segment for totalSegments ${totalSegments}`,
      requestId as InferenceRequestId,
    );
  }

  return Object.freeze({
    requestId: requestId as InferenceRequestId,
    totalSegments,
    initialCurrentSegment,
  });
}

export class SpanPipeline {
  private readonly segments: readonly SegmentConfig[];
  private readonly options: SpanPipelineOptions;

  constructor(
    segments: readonly SegmentConfig[],
    private readonly workerPool: WorkerPool,
    private readonly checkpointStore: CheckpointStore,
    private readonly executor: SpanExecutor,
    options?: Partial<SpanPipelineOptions>,
  ) {
    this.options = resolveSpanPipelineOptions(options);
    this.segments = snapshotSpanSegments(segments, 'SpanPipeline');
    this.options.artifactResidencyLedger?.assertCompatibleSegments(this.segments);
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
    const run = captureSpanRunEnvelope(request, this.segments.length);

    if (run.totalSegments === 0) {
      request.status = InferenceStatus.COMPLETED;
      this.checkpointStore.deleteAll(run.requestId);
      return {
        requestId: run.requestId,
        tokens: [],
        text: '',
        totalTimeMs: 0,
        segmentsCompleted: 0,
      };
    }

    const startTime = Date.now();
    request.status = InferenceStatus.IN_PROGRESS;

    try {
      return await this.executeWithRoute(request, run, startTime);
    } catch (error) {
      request.status = InferenceStatus.FAILED;
      this.checkpointStore.deleteAll(run.requestId);
      throw error;
    }
  }

  private async executeWithRoute(
    request: InferenceRequest,
    run: SpanRunEnvelope,
    startTime: number,
  ): Promise<InferenceResult> {
    // A final segment produces output, not a resumable checkpoint. Bounding the
    // lookup at N-2 prevents malformed/stale final checkpoints from skipping
    // the output-producing span.
    let resumeCheckpoint = this.checkpointStore.latest(
      run.requestId,
      run.totalSegments - 2,
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
          run.requestId,
        );
      }

      // Effective deadlines are route-derived coordinator configuration, not
      // worker behavior. Validate the complete route before any span marks a
      // worker busy so arithmetic overflow or unsupported host timer ranges
      // cannot disconnect a healthy worker.
      this.assertFiniteRouteTimeouts(run.requestId, route);

      try {
        return await this.executeRoute(
          request,
          run,
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
          run.requestId,
          run.totalSegments - 2,
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

    throw new SpanPipelineError('Route execution exhausted all retries', run.requestId);
  }

  private assertFiniteRouteTimeouts(
    requestId: InferenceRequestId,
    route: Route,
  ): void {
    for (const span of route) {
      const spanSize = span.endSegment - span.startSegment + 1;
      const timeoutMs = spanSize * this.options.perSegmentTimeoutMs;
      if (!Number.isFinite(timeoutMs)) {
        throw new SpanPipelineError(
          `effective timeout for span ${span.startSegment}..${span.endSegment} must be finite`,
          requestId,
        );
      }
      if (timeoutMs > MAX_TIMER_DELAY_MS) {
        throw new SpanPipelineError(
          `effective timeout for span ${span.startSegment}..${span.endSegment} exceeds host timer maximum ${MAX_TIMER_DELAY_MS}ms`,
          requestId,
        );
      }
    }
  }

  /** Execute one suffix route, relaying checkpoints only at span boundaries. */
  private async executeRoute(
    request: InferenceRequest,
    run: SpanRunEnvelope,
    route: Route,
    startTime: number,
    initialCheckpoint: Checkpoint | undefined,
  ): Promise<InferenceResult> {
    for (let i = 0; i < route.length; i++) {
      const span = route[i];
      const isFinalSpan = span.endSegment === run.totalSegments - 1;
      const spanSegments = this.segments.slice(span.startSegment, span.endSegment + 1);
      const checkpoint = i === 0
        ? initialCheckpoint
        : this.checkpointStore.get(run.requestId, route[i - 1].endSegment);

      this.assertInputCheckpoint(run.requestId, span, checkpoint);
      const assignment: SpanAssignment = {
        requestId: run.requestId,
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
        const validated = this.validateSpanResult(run.requestId, span, result, isFinalSpan);

        // Commit the validated checkpoint snapshot before the worker becomes
        // reusable or its artifact residency is trusted. A save-time failure
        // therefore stays inside the disconnect/clear failure boundary.
        if (validated.checkpoint !== undefined) {
          this.checkpointStore.save(validated.checkpoint);
        }

        this.workerPool.markIdle(span.workerId);
        this.options.artifactResidencyLedger?.markResidentRange(
          span.workerId,
          span.startSegment,
          span.endSegment,
        );

        if (!isFinalSpan) {
          request.currentSegment = span.endSegment + 1;
          continue;
        }

        if (validated.output === undefined) {
          throw new SpanPipelineError('Final span did not produce output', run.requestId);
        }
        request.status = InferenceStatus.COMPLETED;
        request.currentSegment = run.totalSegments;
        this.checkpointStore.deleteAll(run.requestId);
        return {
          requestId: run.requestId,
          tokens: validated.output.tokens,
          text: validated.output.text,
          totalTimeMs: Date.now() - startTime,
          segmentsCompleted: run.totalSegments,
        };
      } catch (error) {
        // A disconnected or contract-violating browser can no longer prove that
        // either its execution result or Cache API entry is trustworthy.
        this.workerPool.markDisconnected(span.workerId);
        this.options.artifactResidencyLedger?.clearWorker(span.workerId);
        throw error;
      }
    }

    throw new SpanPipelineError('Route ended without producing output', run.requestId);
  }

  private assertInputCheckpoint(
    requestId: InferenceRequestId,
    span: Span,
    checkpoint: Checkpoint | undefined,
  ): void {
    if (span.startSegment === 0) {
      if (checkpoint !== undefined) {
        throw new SpanPipelineError(
          'segment 0 must not receive a checkpoint',
          requestId,
        );
      }
      return;
    }

    if (checkpoint === undefined) {
      throw new SpanPipelineError(
        `missing checkpoint before segment ${span.startSegment}`,
        requestId,
      );
    }
    if (checkpoint.requestId !== requestId) {
      throw new SpanPipelineError(
        `checkpoint request ${checkpoint.requestId} does not match ${requestId}`,
        requestId,
      );
    }
    if (checkpoint.segmentIndex !== span.startSegment - 1) {
      throw new SpanPipelineError(
        `checkpoint segment ${checkpoint.segmentIndex} does not precede ` +
        `span start ${span.startSegment}`,
        requestId,
      );
    }
  }

  private validateSpanResult(
    requestId: InferenceRequestId,
    span: Span,
    result: unknown,
    isFinalSpan: boolean,
  ): ValidatedSpanResult {
    if (!isRecord(result)) {
      throw new SpanPipelineError(
        'span result must be a non-null, non-array object',
        requestId,
      );
    }

    const root = snapshotSpanResultRoot(result);
    if (typeof root.requestId !== 'string') {
      throw new SpanPipelineError(
        'span result requestId must be a string',
        requestId,
      );
    }
    if (root.requestId !== requestId) {
      throw new SpanPipelineError(
        `span result request ${root.requestId} does not match ${requestId}`,
        requestId,
      );
    }
    if (typeof root.workerId !== 'string') {
      throw new SpanPipelineError(
        'span result workerId must be a string',
        requestId,
      );
    }
    if (root.workerId !== span.workerId) {
      throw new SpanPipelineError(
        `span result worker ${root.workerId} does not match assigned worker ${span.workerId}`,
        requestId,
      );
    }
    if (!isNonNegativeSafeInteger(root.startSegment)) {
      throw new SpanPipelineError(
        'span result startSegment must be a non-negative safe integer',
        requestId,
      );
    }
    if (!isNonNegativeSafeInteger(root.endSegment)) {
      throw new SpanPipelineError(
        'span result endSegment must be a non-negative safe integer',
        requestId,
      );
    }
    if (root.startSegment !== span.startSegment || root.endSegment !== span.endSegment) {
      throw new SpanPipelineError(
        `span result range ${root.startSegment}..${root.endSegment} does not match ` +
        `assignment ${span.startSegment}..${span.endSegment}`,
        requestId,
      );
    }
    if (!isNonNegativeFiniteNumber(root.processingTimeMs)) {
      throw new SpanPipelineError(
        'span processingTimeMs must be a non-negative finite number',
        requestId,
      );
    }

    const checkpoint = root.checkpoint as Checkpoint | undefined;
    const output = root.output;
    if (isFinalSpan) {
      if (checkpoint !== undefined) {
        throw new SpanPipelineError(
          `final span ${span.startSegment}..${span.endSegment} must not produce a checkpoint`,
          requestId,
        );
      }
      if (output === undefined) {
        throw new SpanPipelineError(
          'Final span did not produce output',
          requestId,
        );
      }
      return {
        output: snapshotFinalOutput(
          output,
          (message) => new SpanPipelineError(message, requestId),
        ),
      };
    }

    if (output !== undefined) {
      throw new SpanPipelineError(
        `non-final span ${span.startSegment}..${span.endSegment} must not produce output`,
        requestId,
      );
    }
    if (checkpoint === undefined) {
      throw new SpanPipelineError(
        `non-final span ${span.startSegment}..${span.endSegment} did not produce a checkpoint`,
        requestId,
      );
    }
    if (!isRecord(checkpoint)) {
      throw new SpanPipelineError(
        'span result checkpoint must be a non-null, non-array object',
        requestId,
      );
    }
    if (typeof checkpoint.requestId !== 'string') {
      throw new SpanPipelineError(
        'checkpoint requestId must be a string',
        requestId,
      );
    }
    if (checkpoint.requestId !== requestId) {
      throw new SpanPipelineError(
        `checkpoint request ${checkpoint.requestId} does not match ${requestId}`,
        requestId,
      );
    }
    if (!isNonNegativeSafeInteger(checkpoint.segmentIndex)) {
      throw new SpanPipelineError(
        'checkpoint segmentIndex must be a non-negative safe integer',
        requestId,
      );
    }
    if (checkpoint.segmentIndex !== span.endSegment) {
      throw new SpanPipelineError(
        `checkpoint segment ${checkpoint.segmentIndex} does not match ` +
        `span end ${span.endSegment}`,
        requestId,
      );
    }
    try {
      CheckpointStore.assertValidCheckpoint(checkpoint);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown checkpoint validation error';
      throw new SpanPipelineError(
        `invalid checkpoint from span ${span.startSegment}..${span.endSegment}: ${detail}`,
        requestId,
      );
    }
    return { checkpoint };
  }

  private executeSpanWithTimeout(
    workerId: WorkerId,
    assignment: SpanAssignment,
    timeoutMs: number,
  ): Promise<SpanResult> {
    const label = `Span [${assignment.segments[0].index}-${assignment.segments[assignment.segments.length - 1].index}]`;
    return withAbortableTimeout(
      (signal) => this.executor.execute(workerId, assignment, signal),
      timeoutMs,
      label,
    ).catch((error: unknown) => {
      if (error instanceof SegmentTimeoutError) {
        throw new SegmentTimeoutError(`${label} timed out after ${timeoutMs}ms`);
      }
      throw error;
    });
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
