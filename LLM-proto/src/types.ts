/**
 * Core types for unzen-LLM distributed inference pipeline.
 *
 * Architecture: Petals-inspired checkpoint-resume pipeline (PLAN.md v2.6 Section 5)
 * - A 30B model is split into 8 segments (~2.1GB VRAM each)
 * - Each segment is processed by a different browser worker via WebGPU
 * - Checkpoints (intermediate hidden states) are relayed through the Coordinator
 * - Workers are organized in 3 tiers by availability (PLAN.md 4.5.4)
 */

// --- Branded ID types for compile-time safety ---

export type WorkerId = string & { readonly __brand: 'WorkerId' };
export type InferenceRequestId = string & { readonly __brand: 'InferenceRequestId' };

export function workerId(id: string): WorkerId {
  return id as WorkerId;
}

export function inferenceRequestId(id: string): InferenceRequestId {
  return id as InferenceRequestId;
}

// --- Worker types (PLAN.md 4.5.4: Hybrid worker tiers) ---

/**
 * Worker tier classification per PLAN.md 4.5.4.
 * Lower tier number = higher priority for segment assignment.
 */
export enum WorkerTier {
  /** 24h devices: digital signage, kiosks. Most stable. */
  TIER_1 = 1,
  /** Long-running: OBS browser source, browser extensions, Electron apps. */
  TIER_2 = 2,
  /** Normal web visitors: 3-10 minutes average session. */
  TIER_3 = 3,
}

export enum WorkerStatus {
  IDLE = 'idle',
  BUSY = 'busy',
  DISCONNECTED = 'disconnected',
}

export interface WorkerInfo {
  readonly id: WorkerId;
  readonly tier: WorkerTier;
  /** Available GPU memory in MB. Must be >= segment's estimatedVramMB. */
  readonly vramMB: number;
  status: WorkerStatus;
  /** Unix timestamp (ms) of last heartbeat received. */
  lastHeartbeat: number;
  /** Segment index currently being processed, if busy. */
  currentSegment?: number;
}

// --- Segment types (PLAN.md 5.3: 8-segment model split) ---

export interface SegmentConfig {
  /** Segment index (0-7 for 8-segment split). */
  readonly index: number;
  /** First transformer layer in this segment (inclusive). */
  readonly layerStart: number;
  /** Last transformer layer in this segment (inclusive). */
  readonly layerEnd: number;
  /** SHA-256 hash of the model weight shard for integrity verification. */
  readonly modelWeightHash: string;
  /** Estimated VRAM required in MB (~2100 for 30B/8 segments). */
  readonly estimatedVramMB: number;
}

// --- Inference request types ---

export enum InferenceStatus {
  QUEUED = 'queued',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface InferenceRequest {
  readonly id: InferenceRequestId;
  readonly prompt: string;
  readonly createdAt: number;
  status: InferenceStatus;
  /** Index of the segment currently being processed (0-based). */
  currentSegment: number;
  /** Total number of segments (default: 8 per PLAN.md 5.3). */
  readonly totalSegments: number;
}

// --- Checkpoint types (PLAN.md 5.2: checkpoint-resume) ---

/**
 * Checkpoint: intermediate state saved between segments.
 * Contains the hidden states tensor and KV cache metadata needed
 * for the next segment to resume computation.
 *
 * Size: "数MB" (a few MB) per PLAN.md 5.3 - hidden states + partial KV cache.
 */
export interface Checkpoint {
  readonly requestId: InferenceRequestId;
  /** Segment index that produced this checkpoint. */
  readonly segmentIndex: number;
  /** Binary-encoded hidden states tensor. */
  readonly hiddenStates: Uint8Array;
  readonly metadata: CheckpointMetadata;
}

export interface CheckpointMetadata {
  /** Tensor shape, e.g. [1, seq_len, hidden_dim]. */
  readonly shape: readonly number[];
  /** Data type, e.g. 'float16'. */
  readonly dtype: string;
  /** Sequence length at this checkpoint. */
  readonly sequenceLength: number;
  /** Unix timestamp (ms) when this checkpoint was created. */
  readonly timestamp: number;
}

// --- Inference result ---

export interface InferenceResult {
  readonly requestId: InferenceRequestId;
  /** Generated token IDs. */
  readonly tokens: readonly number[];
  /** Decoded text output. */
  readonly text: string;
  /** Total wall-clock time in milliseconds. */
  readonly totalTimeMs: number;
  /** Number of segments that completed successfully. */
  readonly segmentsCompleted: number;
}
