export interface SegmentResultRootSnapshot {
  readonly requestId: unknown;
  readonly segmentIndex: unknown;
  readonly workerId: unknown;
  readonly processingTimeMs: unknown;
  readonly checkpoint: unknown;
  readonly output: unknown;
}

export interface SpanResultRootSnapshot {
  readonly requestId: unknown;
  readonly workerId: unknown;
  readonly startSegment: unknown;
  readonly endSegment: unknown;
  readonly processingTimeMs: unknown;
  readonly checkpoint: unknown;
  readonly output: unknown;
}

/**
 * Capture every root field consumed by the legacy single-segment result validator.
 *
 * Worker results are runtime-untrusted even when an executor is typed as returning
 * SegmentResult. Accessor- or Proxy-backed values therefore need one stable root
 * envelope before type, identity, range, and nested-boundary validation begins.
 */
export function snapshotSegmentResultRoot(
  result: Record<string, unknown>,
): SegmentResultRootSnapshot {
  const requestId = result.requestId;
  const segmentIndex = result.segmentIndex;
  const workerId = result.workerId;
  const processingTimeMs = result.processingTimeMs;
  const checkpoint = result.checkpoint;
  const output = result.output;

  return Object.freeze({
    requestId,
    segmentIndex,
    workerId,
    processingTimeMs,
    checkpoint,
    output,
  });
}

/** Capture the root fields consumed by SpanPipeline validation exactly once. */
export function snapshotSpanResultRoot(
  result: Record<string, unknown>,
): SpanResultRootSnapshot {
  const requestId = result.requestId;
  const workerId = result.workerId;
  const startSegment = result.startSegment;
  const endSegment = result.endSegment;
  const processingTimeMs = result.processingTimeMs;
  const checkpoint = result.checkpoint;
  const output = result.output;

  return Object.freeze({
    requestId,
    workerId,
    startSegment,
    endSegment,
    processingTimeMs,
    checkpoint,
    output,
  });
}
