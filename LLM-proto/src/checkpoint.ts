/**
 * CheckpointStore: in-memory storage for intermediate pipeline states.
 *
 * When a segment completes, its hidden states (checkpoint) are stored here.
 * The next segment retrieves the checkpoint to resume computation.
 * On failure, the checkpoint allows re-assignment to a different worker
 * without restarting from segment 0 (PLAN.md 5.2).
 *
 * Production note: In a real deployment this would use Cloudflare Durable Objects
 * or R2 for persistence. This in-memory implementation is for the pipeline logic prototype.
 */

import type { Checkpoint, InferenceRequestId } from './types.js';

export class CheckpointStore {
  /** Exact request identity -> segment index -> checkpoint. */
  private readonly store = new Map<InferenceRequestId, Map<number, Checkpoint>>();

  private static assertValidRequestId(requestId: unknown): asserts requestId is InferenceRequestId {
    if (typeof requestId !== 'string' || requestId.trim().length === 0) {
      throw new Error('checkpoint requestId must be a non-empty string');
    }
  }

  private static assertValidSegmentIndex(segmentIndex: unknown): asserts segmentIndex is number {
    if (
      typeof segmentIndex !== 'number' ||
      !Number.isSafeInteger(segmentIndex) ||
      segmentIndex < 0
    ) {
      throw new Error('checkpoint segmentIndex must be a non-negative safe integer');
    }
  }

  private static assertValidCheckpoint(checkpoint: Checkpoint): void {
    CheckpointStore.assertValidRequestId(checkpoint.requestId);
    CheckpointStore.assertValidSegmentIndex(checkpoint.segmentIndex);

    if (!(checkpoint.hiddenStates instanceof Uint8Array) || checkpoint.hiddenStates.byteLength === 0) {
      throw new Error('checkpoint hiddenStates must be a non-empty Uint8Array');
    }

    const metadata = checkpoint.metadata;
    if (metadata === null || typeof metadata !== 'object') {
      throw new Error('checkpoint metadata must be an object');
    }
    if (
      !Array.isArray(metadata.shape) ||
      metadata.shape.length === 0 ||
      !metadata.shape.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0)
    ) {
      throw new Error('checkpoint metadata.shape must contain positive safe integers');
    }
    if (typeof metadata.dtype !== 'string' || metadata.dtype.trim().length === 0) {
      throw new Error('checkpoint metadata.dtype must be a non-empty string');
    }
    if (!Number.isSafeInteger(metadata.sequenceLength) || metadata.sequenceLength < 0) {
      throw new Error(
        'checkpoint metadata.sequenceLength must be a non-negative safe integer',
      );
    }
    if (!Number.isSafeInteger(metadata.timestamp) || metadata.timestamp < 0) {
      throw new Error('checkpoint metadata.timestamp must be a non-negative safe integer');
    }
  }

  /**
   * Take an ownership-isolated snapshot of a validated checkpoint.
   *
   * `readonly` is only a TypeScript contract; Uint8Array and the shape array remain
   * mutable at runtime. Copy both mutable payloads whenever state crosses the store
   * boundary so caller-side mutation cannot silently rewrite a durable resume point.
   */
  private static snapshot(checkpoint: Checkpoint): Checkpoint {
    return {
      requestId: checkpoint.requestId,
      segmentIndex: checkpoint.segmentIndex,
      hiddenStates: checkpoint.hiddenStates.slice(),
      metadata: {
        shape: [...checkpoint.metadata.shape],
        dtype: checkpoint.metadata.dtype,
        sequenceLength: checkpoint.metadata.sequenceLength,
        timestamp: checkpoint.metadata.timestamp,
      },
    };
  }

  /** Save a checkpoint produced by a completed segment. */
  save(checkpoint: Checkpoint): void {
    CheckpointStore.assertValidCheckpoint(checkpoint);

    let checkpoints = this.store.get(checkpoint.requestId);
    if (!checkpoints) {
      checkpoints = new Map<number, Checkpoint>();
      this.store.set(checkpoint.requestId, checkpoints);
    }
    checkpoints.set(checkpoint.segmentIndex, CheckpointStore.snapshot(checkpoint));
  }

  /** Retrieve a specific checkpoint by request and segment index. */
  get(requestId: InferenceRequestId, segmentIndex: number): Checkpoint | undefined {
    CheckpointStore.assertValidRequestId(requestId);
    CheckpointStore.assertValidSegmentIndex(segmentIndex);
    const checkpoint = this.store.get(requestId)?.get(segmentIndex);
    return checkpoint ? CheckpointStore.snapshot(checkpoint) : undefined;
  }

  /**
   * Return the checkpoint at the highest completed segment for one request.
   *
   * `atOrBeforeSegmentIndex` lets a caller exclude a final-output segment or
   * another boundary that is not a valid resume point. A negative bound has no
   * eligible checkpoint and therefore returns `undefined`.
   */
  latest(
    requestId: InferenceRequestId,
    atOrBeforeSegmentIndex = Number.MAX_SAFE_INTEGER,
  ): Checkpoint | undefined {
    CheckpointStore.assertValidRequestId(requestId);
    if (!Number.isSafeInteger(atOrBeforeSegmentIndex)) {
      throw new Error(
        `atOrBeforeSegmentIndex must be a safe integer; found ${atOrBeforeSegmentIndex}`,
      );
    }
    if (atOrBeforeSegmentIndex < 0) return undefined;

    let latest: Checkpoint | undefined;
    const checkpoints = this.store.get(requestId);
    if (!checkpoints) return undefined;

    for (const checkpoint of checkpoints.values()) {
      if (checkpoint.segmentIndex > atOrBeforeSegmentIndex) continue;
      if (!latest || checkpoint.segmentIndex > latest.segmentIndex) {
        latest = checkpoint;
      }
    }
    return latest ? CheckpointStore.snapshot(latest) : undefined;
  }

  /** Delete all checkpoints for exactly one completed or failed request. */
  deleteAll(requestId: InferenceRequestId): void {
    CheckpointStore.assertValidRequestId(requestId);
    this.store.delete(requestId);
  }

  /** Number of stored checkpoints (for monitoring). */
  get size(): number {
    let count = 0;
    for (const checkpoints of this.store.values()) {
      count += checkpoints.size;
    }
    return count;
  }
}
