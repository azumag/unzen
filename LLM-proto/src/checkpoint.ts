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

interface ValidatedCheckpointCapture {
  readonly requestId: InferenceRequestId;
  readonly segmentIndex: number;
  readonly hiddenStates: Uint8Array;
  readonly metadata: Checkpoint['metadata'];
}

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

  /**
   * Capture and validate every consumed checkpoint field exactly once.
   *
   * This is intentionally separate from persistence: public validation callers
   * do not pay for a hidden-state byte copy, while save() can bind validation,
   * map identity, and the persisted snapshot to this same captured envelope.
   */
  private static captureValidatedCheckpoint(checkpoint: unknown): ValidatedCheckpointCapture {
    if (
      typeof checkpoint !== 'object' ||
      checkpoint === null ||
      Array.isArray(checkpoint)
    ) {
      throw new Error('checkpoint must be a non-null object');
    }

    const candidate = checkpoint as Record<string, unknown>;

    const requestId = candidate.requestId;
    CheckpointStore.assertValidRequestId(requestId);

    const segmentIndex = candidate.segmentIndex;
    CheckpointStore.assertValidSegmentIndex(segmentIndex);

    const hiddenStates = candidate.hiddenStates;
    if (!(hiddenStates instanceof Uint8Array) || hiddenStates.byteLength === 0) {
      throw new Error('checkpoint hiddenStates must be a non-empty Uint8Array');
    }

    const metadataValue = candidate.metadata;
    if (metadataValue === null || typeof metadataValue !== 'object') {
      throw new Error('checkpoint metadata must be an object');
    }
    const metadata = metadataValue as Record<string, unknown>;

    const shapeValue = metadata.shape;
    if (!Array.isArray(shapeValue) || shapeValue.length === 0) {
      throw new Error('checkpoint metadata.shape must contain positive safe integers');
    }
    const shapeLength = shapeValue.length;
    const shape: number[] = new Array(shapeLength);
    for (let index = 0; index < shapeLength; index += 1) {
      const dimension = shapeValue[index];
      if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension <= 0) {
        throw new Error('checkpoint metadata.shape must contain positive safe integers');
      }
      shape[index] = dimension;
    }

    const dtype = metadata.dtype;
    if (typeof dtype !== 'string' || dtype.trim().length === 0) {
      throw new Error('checkpoint metadata.dtype must be a non-empty string');
    }

    const sequenceLength = metadata.sequenceLength;
    if (typeof sequenceLength !== 'number' || !Number.isSafeInteger(sequenceLength) || sequenceLength < 0) {
      throw new Error(
        'checkpoint metadata.sequenceLength must be a non-negative safe integer',
      );
    }

    const timestamp = metadata.timestamp;
    if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error('checkpoint metadata.timestamp must be a non-negative safe integer');
    }

    return {
      requestId,
      segmentIndex,
      hiddenStates,
      metadata: {
        shape,
        dtype,
        sequenceLength,
        timestamp,
      },
    };
  }

  /**
   * Validate an untrusted checkpoint envelope without mutating the store.
   * Pipeline result boundaries use the same authority as save() so malformed
   * worker payloads are rejected before a worker becomes reusable.
   */
  static assertValidCheckpoint(checkpoint: unknown): asserts checkpoint is Checkpoint {
    CheckpointStore.captureValidatedCheckpoint(checkpoint);
  }

  /**
   * Take an ownership-isolated snapshot of a store-owned checkpoint.
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
    const captured = CheckpointStore.captureValidatedCheckpoint(checkpoint);
    const ownedCheckpoint: Checkpoint = {
      requestId: captured.requestId,
      segmentIndex: captured.segmentIndex,
      hiddenStates: captured.hiddenStates.slice(),
      metadata: {
        shape: [...captured.metadata.shape],
        dtype: captured.metadata.dtype,
        sequenceLength: captured.metadata.sequenceLength,
        timestamp: captured.metadata.timestamp,
      },
    };

    let checkpoints = this.store.get(captured.requestId);
    if (!checkpoints) {
      checkpoints = new Map<number, Checkpoint>();
      this.store.set(captured.requestId, checkpoints);
    }
    checkpoints.set(captured.segmentIndex, ownedCheckpoint);
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
    if (
      typeof atOrBeforeSegmentIndex !== 'number'
      || !Number.isSafeInteger(atOrBeforeSegmentIndex)
    ) {
      throw new Error('atOrBeforeSegmentIndex must be a safe integer');
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
