/**
 * Tests for the checkpoint envelope (issue #103 deliverable 5).
 *
 * The issue forbids storing a checkpoint as a bare Uint8Array: the envelope
 * binds producer + model/run identity, payload digest, format version, and
 * TTL. A checkpoint from another request or a different model revision must
 * never be saved or relayed.
 */
import { describe, it, expect } from 'vitest';
import {
  createCheckpointEnvelope,
  verifyCheckpointDigest,
  isCheckpointExpired,
  validateCheckpointEnvelope,
  CheckpointIntegrityError,
  CHECKPOINT_FORMAT_VERSION,
} from '../src/checkpoint-envelope.js';
import { generateRequestId, generateAttemptId, generateWorkerGeneration } from '../src/ids.js';
import type { WorkerGeneration } from '../src/ids.js';
import { workerId } from '../src/types.js';
import type { WorkerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);
const FORMAT_VERSION = 'float16';

function buildEnvelope(overrides = {}) {
  return createCheckpointEnvelope({
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex: 0,
    workerId: workerId('w1'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: MANIFEST_DIGEST,
    formatVersion: FORMAT_VERSION,
    payload: new Uint8Array([1, 2, 3, 4]),
    ttlMs: 60_000,
    createdAt: 1_000,
    ...overrides,
  });
}

describe('checkpoint-envelope', () => {
  it('binds identity, digest, format version, and TTL', async () => {
    const envelope = await buildEnvelope();
    expect(envelope.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.payloadLength).toBe(4);
    expect(envelope.formatVersion).toBe(FORMAT_VERSION);
    expect(envelope.ttlMs).toBe(60_000);
    expect(envelope.workerGeneration).toMatch(/-gen/);
  });

  it('digest detects payload tampering', async () => {
    const envelope = await buildEnvelope();
    const tampered = { ...envelope, payload: new Uint8Array([1, 2, 3, 5]) };
    expect(await verifyCheckpointDigest(tampered)).toBe(false);
    expect(await verifyCheckpointDigest(envelope)).toBe(true);
  });

  it('digest detects payloadLength lying', async () => {
    const envelope = await buildEnvelope();
    expect(await verifyCheckpointDigest({ ...envelope, payloadLength: 5 })).toBe(false);
  });

  it('expires after TTL', async () => {
    const envelope = await buildEnvelope({ createdAt: 1_000, ttlMs: 5_000 });
    expect(isCheckpointExpired(envelope, 5_999)).toBe(false);
    expect(isCheckpointExpired(envelope, 6_000)).toBe(true);
  });

  it('defaults to the model checkpoint format when not overridden', async () => {
    const envelope = await createCheckpointEnvelope({
      requestId: generateRequestId(),
      attemptId: generateAttemptId(),
      segmentIndex: 1,
      workerId: workerId('w1'),
      workerGeneration: generateWorkerGeneration(),
      modelManifestDigest: MANIFEST_DIGEST,
      payload: new Uint8Array([9]),
      ttlMs: 10_000,
    });
    expect(envelope.formatVersion).toBe(CHECKPOINT_FORMAT_VERSION);
  });

  describe('validateCheckpointEnvelope', () => {
    const expected = async () => {
      const envelope = await buildEnvelope();
      return {
        envelope,
        expected: {
          requestId: envelope.requestId,
          segmentIndex: envelope.segmentIndex,
          workerId: envelope.workerId as WorkerId,
          workerGeneration: envelope.workerGeneration as WorkerGeneration,
          modelManifestDigest: envelope.modelManifestDigest,
          formatVersion: envelope.formatVersion,
          maxPayloadBytes: 1024,
          now: envelope.createdAt + 1,
        },
      };
    };

    it('accepts a valid, in-TTL envelope', async () => {
      const { envelope, expected: exp } = await expected();
      expect((await validateCheckpointEnvelope(envelope, exp)).ok).toBe(true);
    });

    it('rejects a checkpoint from another request', async () => {
      const { envelope, expected: exp } = await expected();
      const other = await buildEnvelope();
      const result = await validateCheckpointEnvelope(
        { ...envelope, requestId: other.requestId },
        exp,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('checkpoint-integrity-mismatch');
    });

    it('rejects a checkpoint from another worker generation', async () => {
      const { envelope, expected: exp } = await expected();
      const result = await validateCheckpointEnvelope(
        { ...envelope, workerGeneration: generateWorkerGeneration() },
        exp,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects a checkpoint for a different model revision', async () => {
      const { envelope, expected: exp } = await expected();
      const result = await validateCheckpointEnvelope(
        { ...envelope, modelManifestDigest: 'f'.repeat(64) },
        exp,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects a checkpoint that does not match the segment index', async () => {
      const { envelope, expected: exp } = await expected();
      const result = await validateCheckpointEnvelope({ ...envelope, segmentIndex: 3 }, exp);
      expect(result.ok).toBe(false);
    });

    it('rejects payloads over the size limit', async () => {
      const { envelope, expected: exp } = await expected();
      const result = await validateCheckpointEnvelope(
        envelope,
        { ...exp, maxPayloadBytes: 1 },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('checkpoint-integrity-mismatch');
    });

    it('rejects a corrupted payload digest', async () => {
      const { envelope, expected: exp } = await expected();
      const result = await validateCheckpointEnvelope(
        { ...envelope, payload: new Uint8Array([9, 9, 9, 9]) },
        exp,
      );
      expect(result.ok).toBe(false);
    });

    it('rejects an expired checkpoint', async () => {
      const { envelope, expected: exp } = await expected();
      const result = await validateCheckpointEnvelope(envelope, { ...exp, now: exp.now + 60_000 });
      expect(result.ok).toBe(false);
    });

    it('assertCheckpointIntegrity throws a typed integrity error', async () => {
      const { envelope, expected: exp } = await expected();
      const other = await buildEnvelope();
      let threw: unknown;
      try {
        await (await import('../src/checkpoint-envelope.js')).assertCheckpointIntegrity(
          { ...envelope, requestId: other.requestId },
          exp,
        );
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(CheckpointIntegrityError);
      expect((threw as CheckpointIntegrityError).code).toBe('checkpoint-integrity-mismatch');
    });
  });
});
