/**
 * WebSocket message protocol for Coordinator-Worker communication.
 *
 * All communication goes through the Coordinator (PLAN.md 1.2).
 * Workers never communicate directly with each other - checkpoints
 * are relayed via the Coordinator to enforce the "no third-party connections" policy.
 *
 * Transport: WSS (TLS-encrypted WebSocket) per PLAN.md 1.2.
 */

import type {
  WorkerId,
  WorkerTier,
  InferenceRequestId,
  SegmentConfig,
  Checkpoint,
} from './types.js';

// --- Coordinator → Worker messages ---

export type CoordinatorMessage =
  | SegmentAssignMessage
  | HeartbeatAckMessage;

export interface SegmentAssignMessage {
  readonly type: 'segment:assign';
  readonly payload: SegmentAssignment;
}

export interface HeartbeatAckMessage {
  readonly type: 'heartbeat:ack';
  readonly payload: { readonly timestamp: number };
}

/** Data sent from Coordinator to a Worker to start processing a segment. */
export interface SegmentAssignment {
  readonly requestId: InferenceRequestId;
  readonly segment: SegmentConfig;
  /** Checkpoint from the previous segment. Undefined for segment 0. */
  readonly checkpoint?: Checkpoint;
}

// --- Worker → Coordinator messages ---

export type WorkerMessage =
  | WorkerRegisterMessage
  | WorkerHeartbeatMessage
  | SegmentResultMessage
  | SegmentFailedMessage;

export interface WorkerRegisterMessage {
  readonly type: 'worker:register';
  readonly payload: WorkerRegistration;
}

export interface WorkerHeartbeatMessage {
  readonly type: 'worker:heartbeat';
  readonly payload: {
    readonly workerId: WorkerId;
    readonly timestamp: number;
  };
}

export interface SegmentResultMessage {
  readonly type: 'segment:result';
  readonly payload: SegmentResult;
}

export interface SegmentFailedMessage {
  readonly type: 'segment:failed';
  readonly payload: SegmentFailure;
}

/** Worker registration data sent on initial connection. */
export interface WorkerRegistration {
  readonly workerId: WorkerId;
  readonly tier: WorkerTier;
  /** Available VRAM in MB reported by the browser (via WebGPU adapter limits). */
  readonly vramMB: number;
}

/** Result of a successful segment computation. */
export interface SegmentResult {
  readonly requestId: InferenceRequestId;
  readonly segmentIndex: number;
  readonly workerId: WorkerId;
  /**
   * Checkpoint for the next segment.
   * Present for intermediate segments (0 through totalSegments-2).
   */
  readonly checkpoint?: Checkpoint;
  /**
   * Final output tokens and text.
   * Present only for the last segment.
   */
  readonly output?: {
    readonly tokens: readonly number[];
    readonly text: string;
  };
  readonly processingTimeMs: number;
}

/** Reported when a worker fails to process a segment. */
export interface SegmentFailure {
  readonly requestId: InferenceRequestId;
  readonly segmentIndex: number;
  readonly workerId: WorkerId;
  readonly reason: string;
}

// --- Span-based assignments (Petals-inspired) ---
// A span is a contiguous range of segments assigned to one worker.
// This eliminates checkpoint transfers between segments within the same span.

/**
 * Assigns multiple contiguous segments to a single worker as a "span".
 * Inspired by Petals' span-based pipeline parallelism where a single server
 * hosts a contiguous range of transformer blocks.
 *
 * The worker processes all segments in the span sequentially, keeping hidden
 * states in GPU memory between segments (no checkpoint serialization needed).
 * A checkpoint is only created after the last segment in the span.
 */
export interface SpanAssignment {
  readonly requestId: InferenceRequestId;
  /** Contiguous segments this worker should process (ordered by index). */
  readonly segments: readonly SegmentConfig[];
  /** Checkpoint from the previous span's last segment. Undefined for the first span. */
  readonly checkpoint?: Checkpoint;
}

/** Result of a span computation (multiple contiguous segments by one worker). */
export interface SpanResult {
  readonly requestId: InferenceRequestId;
  readonly startSegment: number;
  readonly endSegment: number;
  readonly workerId: WorkerId;
  /**
   * Checkpoint from the last segment in the span.
   * Present if this is not the final span of the pipeline.
   */
  readonly checkpoint?: Checkpoint;
  /**
   * Final output. Present only if this span includes the last segment.
   */
  readonly output?: {
    readonly tokens: readonly number[];
    readonly text: string;
  };
  readonly processingTimeMs: number;
}
