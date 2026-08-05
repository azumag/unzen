/**
 * Checkpoint envelope: identity-bound, integrity-checked checkpoint payload
 * (issue #103 deliverable 5).
 *
 * The issue forbids storing a checkpoint as a bare Uint8Array. Every
 * checkpoint is wrapped in an envelope that binds:
 *   - producer / run identity (request, attempt, segment, worker, generation)
 *   - model manifest digest (a checkpoint from a different model revision is
 *     never relayed to the next segment)
 *   - checkpoint format version
 *   - payload byte length + SHA-256 digest
 *   - createdAt / TTL
 *   - optional previous-checkpoint digest (links the resume chain)
 *
 * Validation runs at the Coordinator boundary BEFORE the payload is handed to
 * the next segment or persisted, so a tampered or cross-request checkpoint can
 * never pollute another request's store entry.
 */

import { ErrorCode, UnzenError } from './errors.js';
import type { AttemptId, WorkerGeneration } from './ids.js';
import type { WorkerId, InferenceRequestId } from './types.js';

/** Default checkpoint format version = the model manifest checkpoint format. */
export const CHECKPOINT_FORMAT_VERSION = '1.0.0';

export interface CheckpointEnvelope {
  readonly requestId: InferenceRequestId;
  /** The attempt that produced this checkpoint. */
  readonly attemptId: AttemptId;
  /** The segment index that produced this checkpoint. */
  readonly segmentIndex: number;
  /** The worker that produced this checkpoint. */
  readonly workerId: WorkerId;
  /** The worker generation that produced this checkpoint. */
  readonly workerGeneration: WorkerGeneration;
  /** Digest of the model manifest driving this run. */
  readonly modelManifestDigest: string;
  /** Checkpoint format version; must match the run's manifest format. */
  readonly formatVersion: string;
  /** Exact payload byte length (independent of the buffer). */
  readonly payloadLength: number;
  /** Lowercase hex SHA-256 of the payload. */
  readonly payloadDigest: string;
  /** Unix ms timestamp when the checkpoint was created. */
  readonly createdAt: number;
  /** Time-to-live in ms after which the checkpoint must not be relayed. */
  readonly ttlMs: number;
  /** Digest of the previous segment's checkpoint, if any (resume chain). */
  readonly previousCheckpointDigest?: string;
  /** The serialized hidden-state bytes. */
  readonly payload: Uint8Array;
}

export interface CreateCheckpointEnvelopeInput {
  readonly requestId: InferenceRequestId;
  readonly attemptId: AttemptId;
  readonly segmentIndex: number;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly modelManifestDigest: string;
  readonly formatVersion?: string;
  readonly payload: Uint8Array;
  readonly ttlMs: number;
  readonly createdAt?: number;
  readonly previousCheckpointDigest?: string;
}

/** Lowercase hex SHA-256 over bytes (same crypto pattern as model-manifest). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-typed view so crypto.subtle.digest accepts
  // it regardless of the source buffer's (possibly SharedArrayBuffer) type.
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Build an envelope, computing the payload digest and byte length. */
export async function createCheckpointEnvelope(
  input: CreateCheckpointEnvelopeInput,
): Promise<CheckpointEnvelope> {
  const payloadDigest = await sha256Hex(input.payload);
  return {
    requestId: input.requestId,
    attemptId: input.attemptId,
    segmentIndex: input.segmentIndex,
    workerId: input.workerId,
    workerGeneration: input.workerGeneration,
    modelManifestDigest: input.modelManifestDigest,
    formatVersion: input.formatVersion ?? CHECKPOINT_FORMAT_VERSION,
    payloadLength: input.payload.byteLength,
    payloadDigest,
    createdAt: input.createdAt ?? Date.now(),
    ttlMs: input.ttlMs,
    previousCheckpointDigest: input.previousCheckpointDigest,
    payload: input.payload,
  };
}

/**
 * Recompute and compare the payload digest. `payloadLength` must equal the
 * actual byte length, so a lying length field is also caught.
 */
export async function verifyCheckpointDigest(
  envelope: CheckpointEnvelope,
): Promise<boolean> {
  if (envelope.payload.byteLength !== envelope.payloadLength) return false;
  return (await sha256Hex(envelope.payload)) === envelope.payloadDigest;
}

/** True when the envelope has outlived its TTL relative to `now`. */
export function isCheckpointExpired(envelope: CheckpointEnvelope, now: number): boolean {
  return now >= envelope.createdAt + envelope.ttlMs;
}

/** The run context a checkpoint must match to be accepted at the boundary. */
export interface CheckpointExpected {
  readonly requestId: InferenceRequestId;
  readonly segmentIndex: number;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly modelManifestDigest: string;
  readonly formatVersion: string;
  /** Size limit; oversized payloads are rejected before storage. */
  readonly maxPayloadBytes: number;
  /** Current time for the TTL check. */
  readonly now: number;
}

export type CheckpointValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** Typed integrity-mismatch error thrown by assertCheckpointIntegrity. */
export class CheckpointIntegrityError extends UnzenError {
  constructor(message: string) {
    super(message, ErrorCode.CheckpointIntegrityMismatch);
    this.name = 'CheckpointIntegrityError';
  }
}

/**
 * Validate an envelope against the run context at the Coordinator boundary.
 * Catches cross-request/cross-revision reuse, stale generations, tampered
 * payloads, over-sized payloads, and expired TTLs.
 */
export async function validateCheckpointEnvelope(
  envelope: CheckpointEnvelope,
  expected: CheckpointExpected,
): Promise<CheckpointValidationResult> {
  const mismatch = (message: string): CheckpointValidationResult => ({
    ok: false,
    code: ErrorCode.CheckpointIntegrityMismatch,
    message,
  });

  if (envelope.requestId !== expected.requestId) {
    return mismatch(
      `checkpoint belongs to request ${envelope.requestId}, expected ${expected.requestId}`,
    );
  }
  if (envelope.segmentIndex !== expected.segmentIndex) {
    return mismatch(
      `checkpoint produced by segment ${envelope.segmentIndex}, expected ${expected.segmentIndex}`,
    );
  }
  if (envelope.workerId !== expected.workerId || envelope.workerGeneration !== expected.workerGeneration) {
    return mismatch('checkpoint was produced by a different worker/generation');
  }
  if (envelope.modelManifestDigest !== expected.modelManifestDigest) {
    return mismatch('checkpoint was produced under a different model revision');
  }
  if (envelope.formatVersion !== expected.formatVersion) {
    return mismatch('checkpoint format version does not match the run');
  }
  if (envelope.payloadLength > expected.maxPayloadBytes) {
    return mismatch(`checkpoint payload ${envelope.payloadLength}B exceeds the ${expected.maxPayloadBytes}B limit`);
  }
  if (isCheckpointExpired(envelope, expected.now)) {
    return mismatch('checkpoint TTL expired');
  }
  if (!(await verifyCheckpointDigest(envelope))) {
    return mismatch('checkpoint payload digest mismatch');
  }
  return { ok: true };
}

/** Throw variant of validateCheckpointEnvelope. */
export async function assertCheckpointIntegrity(
  envelope: CheckpointEnvelope,
  expected: CheckpointExpected,
): Promise<void> {
  const result = await validateCheckpointEnvelope(envelope, expected);
  if (!result.ok) throw new CheckpointIntegrityError(result.message);
}
