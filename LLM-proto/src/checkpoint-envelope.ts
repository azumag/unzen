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

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

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

async function digestOwnedBytes(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 over bytes (same crypto pattern as model-manifest). */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-typed view so crypto.subtle.digest accepts
  // it regardless of the source buffer's (possibly SharedArrayBuffer) type.
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  return digestOwnedBytes(bytes);
}

/**
 * Build an envelope whose digest, length, and returned payload all refer to one
 * owned byte snapshot. Metadata/default reads intentionally remain after the
 * digest await to preserve their existing observation timing.
 */
export async function createCheckpointEnvelope(
  input: CreateCheckpointEnvelopeInput,
): Promise<CheckpointEnvelope> {
  const capturedPayload = input.payload;
  if (!(capturedPayload instanceof Uint8Array)) {
    throw new TypeError('checkpoint payload must be a Uint8Array');
  }

  const ownedPayload = new Uint8Array(capturedPayload.byteLength);
  ownedPayload.set(capturedPayload);
  const payloadDigest = await digestOwnedBytes(ownedPayload);

  return {
    requestId: input.requestId,
    attemptId: input.attemptId,
    segmentIndex: input.segmentIndex,
    workerId: input.workerId,
    workerGeneration: input.workerGeneration,
    modelManifestDigest: input.modelManifestDigest,
    formatVersion: input.formatVersion ?? CHECKPOINT_FORMAT_VERSION,
    payloadLength: ownedPayload.byteLength,
    payloadDigest,
    createdAt: input.createdAt ?? Date.now(),
    ttlMs: input.ttlMs,
    previousCheckpointDigest: input.previousCheckpointDigest,
    payload: ownedPayload,
  };
}

/**
 * Recompute and compare the payload digest. `payloadLength` must equal the
 * actual byte length, so a lying length field is also caught. This helper is a
 * runtime boundary too: malformed objects return false instead of throwing or
 * allocating/hash-processing attacker-controlled non-byte payloads. Caller
 * fields are captured once and eligible bytes are copied before the async
 * digest yield so later accessor values cannot change what is authenticated.
 */
export async function verifyCheckpointDigest(
  envelope: CheckpointEnvelope,
): Promise<boolean> {
  if (typeof envelope !== 'object' || envelope === null) return false;

  const runtime = envelope as unknown as Record<string, unknown>;
  let payload: Uint8Array;
  let payloadLength: number;
  let payloadDigest: string;
  try {
    const capturedPayload = runtime.payload;
    if (!(capturedPayload instanceof Uint8Array)) return false;
    payload = capturedPayload;

    const capturedPayloadLength = runtime.payloadLength;
    if (!Number.isSafeInteger(capturedPayloadLength) || (capturedPayloadLength as number) < 0) return false;
    payloadLength = capturedPayloadLength as number;

    const capturedPayloadDigest = runtime.payloadDigest;
    if (typeof capturedPayloadDigest !== 'string' || !SHA256_HEX_PATTERN.test(capturedPayloadDigest)) return false;
    payloadDigest = capturedPayloadDigest;
  } catch {
    return false;
  }

  if (payload.byteLength !== payloadLength) return false;

  const ownedPayload = new Uint8Array(payloadLength);
  ownedPayload.set(payload);
  return (await digestOwnedBytes(ownedPayload)) === payloadDigest;
}

function isCheckpointTimingExpired(createdAt: number, ttlMs: number, now: number): boolean {
  // JSON/runtime values are not guaranteed to satisfy the TypeScript type.
  // NaN, Infinity and coercible values must not disable the relay TTL gate.
  if (![now, createdAt, ttlMs].every((value) => Number.isFinite(value) && value >= 0)) {
    return true;
  }
  const expiresAt = createdAt + ttlMs;
  return expiresAt > Number.MAX_SAFE_INTEGER || now >= expiresAt;
}

/** Invalid timing is unusable, just like an expired checkpoint. */
export function isCheckpointExpired(envelope: CheckpointEnvelope, now: number): boolean {
  const { createdAt, ttlMs } = envelope;
  return isCheckpointTimingExpired(createdAt, ttlMs, now);
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

function isNonEmptyRuntimeString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

interface CapturedCheckpointStructure {
  readonly requestId: InferenceRequestId;
  readonly attemptId: AttemptId;
  readonly segmentIndex: number;
  readonly workerId: WorkerId;
  readonly workerGeneration: WorkerGeneration;
  readonly modelManifestDigest: string;
  readonly formatVersion: string;
  readonly payloadLength: number;
  readonly payloadDigest: string;
  readonly previousCheckpointDigest?: string;
  readonly payload: Uint8Array;
}

type CheckpointStructureCapture =
  | { readonly ok: true; readonly value: CapturedCheckpointStructure }
  | { readonly ok: false; readonly message: string };

/**
 * Capture and validate the envelope fields that have structural constraints.
 * Each caller-owned property is read once, in the same fail-fast order as the
 * public validator, so later identity/size/digest checks operate only on owned
 * primitive references rather than re-reading an accessor or Proxy.
 */
function captureCheckpointStructure(input: unknown): CheckpointStructureCapture {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: 'checkpoint envelope must be an object' };
  }

  const envelope = input as Record<string, unknown>;

  const requestId = envelope.requestId;
  if (!isNonEmptyRuntimeString(requestId)) {
    return { ok: false, message: 'checkpoint requestId must be a non-empty string' };
  }
  const attemptId = envelope.attemptId;
  if (!isNonEmptyRuntimeString(attemptId)) {
    return { ok: false, message: 'checkpoint attemptId must be a non-empty string' };
  }
  const workerId = envelope.workerId;
  if (!isNonEmptyRuntimeString(workerId)) {
    return { ok: false, message: 'checkpoint workerId must be a non-empty string' };
  }
  const workerGeneration = envelope.workerGeneration;
  if (!isNonEmptyRuntimeString(workerGeneration)) {
    return { ok: false, message: 'checkpoint workerGeneration must be a non-empty string' };
  }
  const formatVersion = envelope.formatVersion;
  if (!isNonEmptyRuntimeString(formatVersion)) {
    return { ok: false, message: 'checkpoint formatVersion must be a non-empty string' };
  }

  const segmentIndex = envelope.segmentIndex;
  if (
    typeof segmentIndex !== 'number' ||
    !Number.isSafeInteger(segmentIndex) ||
    segmentIndex < 0
  ) {
    return { ok: false, message: 'checkpoint segmentIndex must be a non-negative safe integer' };
  }

  const payload = envelope.payload;
  if (!(payload instanceof Uint8Array)) {
    return { ok: false, message: 'checkpoint payload must be a Uint8Array' };
  }

  const payloadLength = envelope.payloadLength;
  if (
    typeof payloadLength !== 'number' ||
    !Number.isSafeInteger(payloadLength) ||
    payloadLength < 0
  ) {
    return { ok: false, message: 'checkpoint payloadLength must be a non-negative safe integer' };
  }
  if (payloadLength !== payload.byteLength) {
    return { ok: false, message: 'checkpoint payloadLength does not match payload byte length' };
  }

  const modelManifestDigest = envelope.modelManifestDigest;
  if (!isNonEmptyRuntimeString(modelManifestDigest) ||
      !SHA256_HEX_PATTERN.test(modelManifestDigest)) {
    return { ok: false, message: 'checkpoint modelManifestDigest must be canonical lowercase SHA-256' };
  }

  const payloadDigest = envelope.payloadDigest;
  if (!isNonEmptyRuntimeString(payloadDigest) ||
      !SHA256_HEX_PATTERN.test(payloadDigest)) {
    return { ok: false, message: 'checkpoint payloadDigest must be canonical lowercase SHA-256' };
  }

  const previousCheckpointDigest = envelope.previousCheckpointDigest;
  if (previousCheckpointDigest !== undefined &&
      (!isNonEmptyRuntimeString(previousCheckpointDigest) ||
       !SHA256_HEX_PATTERN.test(previousCheckpointDigest))) {
    return {
      ok: false,
      message: 'checkpoint previousCheckpointDigest must be canonical lowercase SHA-256 when present',
    };
  }

  return {
    ok: true,
    value: {
      requestId: requestId as InferenceRequestId,
      attemptId: attemptId as AttemptId,
      segmentIndex,
      workerId: workerId as WorkerId,
      workerGeneration: workerGeneration as WorkerGeneration,
      modelManifestDigest,
      formatVersion,
      payloadLength,
      payloadDigest,
      previousCheckpointDigest,
      payload,
    },
  };
}

/**
 * Validate an envelope against the run context at the Coordinator boundary.
 * Catches cross-request/cross-revision reuse, stale generations, tampered
 * payloads, over-sized payloads, and expired TTLs.
 *
 * This exported function is itself a runtime ownership boundary: metadata is
 * single-read from caller-owned objects, the size ceiling is checked before a
 * payload copy is allocated, and digest verification runs only on owned bytes.
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

  const captured = captureCheckpointStructure(envelope);
  if (!captured.ok) {
    return mismatch(captured.message);
  }
  const checkpoint = captured.value;

  const expectedRequestId = expected.requestId;
  if (checkpoint.requestId !== expectedRequestId) {
    return mismatch(
      `checkpoint belongs to request ${checkpoint.requestId}, expected ${expectedRequestId}`,
    );
  }

  const expectedSegmentIndex = expected.segmentIndex;
  if (checkpoint.segmentIndex !== expectedSegmentIndex) {
    return mismatch(
      `checkpoint produced by segment ${checkpoint.segmentIndex}, expected ${expectedSegmentIndex}`,
    );
  }

  const expectedWorkerId = expected.workerId;
  if (checkpoint.workerId !== expectedWorkerId) {
    return mismatch('checkpoint was produced by a different worker/generation');
  }
  const expectedWorkerGeneration = expected.workerGeneration;
  if (checkpoint.workerGeneration !== expectedWorkerGeneration) {
    return mismatch('checkpoint was produced by a different worker/generation');
  }

  const expectedModelManifestDigest = expected.modelManifestDigest;
  if (checkpoint.modelManifestDigest !== expectedModelManifestDigest) {
    return mismatch('checkpoint was produced under a different model revision');
  }

  const expectedFormatVersion = expected.formatVersion;
  if (checkpoint.formatVersion !== expectedFormatVersion) {
    return mismatch('checkpoint format version does not match the run');
  }

  // An invalid configured ceiling must not turn the size comparison into an
  // always-false test and allow unbounded hashing/storage at this boundary.
  const maxPayloadBytes = expected.maxPayloadBytes;
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
    return mismatch('checkpoint payload byte limit must be a non-negative safe integer');
  }
  if (checkpoint.payloadLength > maxPayloadBytes) {
    return mismatch(`checkpoint payload ${checkpoint.payloadLength}B exceeds the ${maxPayloadBytes}B limit`);
  }

  // Preserve the pre-existing call-order semantics: expected.now is observed
  // before timing fields from the envelope. Each value is then retained once.
  const now = expected.now;
  const createdAt = envelope.createdAt;
  const ttlMs = envelope.ttlMs;
  if (isCheckpointTimingExpired(createdAt, ttlMs, now)) {
    return mismatch('checkpoint TTL expired');
  }

  // The copy happens only after structure, identity, budget, and TTL checks.
  // From this point through the async digest yield, caller mutation cannot
  // change the bytes that are authenticated.
  const ownedPayload = new Uint8Array(checkpoint.payloadLength);
  ownedPayload.set(checkpoint.payload);
  if ((await digestOwnedBytes(ownedPayload)) !== checkpoint.payloadDigest) {
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
