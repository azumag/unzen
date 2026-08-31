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
  /** Key: `${requestId}:${segmentIndex}` */
  private readonly store = new Map<string, Checkpoint>();

  private static key(requestId: InferenceRequestId, segmentIndex: number): string {
    return `${requestId}:${segmentIndex}`;
  }

  /** Save a checkpoint produced by a completed segment. */
  save(checkpoint: Checkpoint): void {
    if (!Number.isInteger(checkpoint.segmentIndex) || checkpoint.segmentIndex < 0) {
      throw new Error(
        `checkpoint segmentIndex must be a non-negative integer; ` +
        `found ${checkpoint.segmentIndex}`,
      );
    }
    const key = CheckpointStore.key(checkpoint.requestId, checkpoint.segmentIndex);
    this.store.set(key, checkpoint);
  }

  /** Retrieve a specific checkpoint by request and segment index. */
  get(requestId: InferenceRequestId, segmentIndex: number): Checkpoint | undefined {
    return this.store.get(CheckpointStore.key(requestId, segmentIndex));
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
    if (!Number.isInteger(atOrBeforeSegmentIndex)) {
      throw new Error(
        `atOrBeforeSegmentIndex must be an integer; found ${atOrBeforeSegmentIndex}`,
      );
    }
    if (atOrBeforeSegmentIndex < 0) return undefined;

    let latest: Checkpoint | undefined;
    for (const checkpoint of this.store.values()) {
      if (checkpoint.requestId !== requestId) continue;
      if (checkpoint.segmentIndex > atOrBeforeSegmentIndex) continue;
      if (!latest || checkpoint.segmentIndex > latest.segmentIndex) {
        latest = checkpoint;
      }
    }
    return latest;
  }

  /** Delete all checkpoints for a completed or failed request. */
  deleteAll(requestId: InferenceRequestId): void {
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${requestId}:`)) {
        this.store.delete(key);
      }
    }
  }

  /** Number of stored checkpoints (for monitoring). */
  get size(): number {
    return this.store.size;
  }
}
