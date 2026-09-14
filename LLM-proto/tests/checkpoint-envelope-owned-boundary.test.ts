import { describe, expect, it, vi } from 'vitest';
import {
  createCheckpointEnvelope,
  validateCheckpointEnvelope,
} from '../src/checkpoint-envelope.js';
import type {
  CheckpointEnvelope,
  CheckpointExpected,
} from '../src/checkpoint-envelope.js';
import { generateAttemptId, generateRequestId, generateWorkerGeneration } from '../src/ids.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);
const FORMAT_VERSION = 'float16';

async function fixture(): Promise<{
  envelope: CheckpointEnvelope;
  expected: CheckpointExpected;
}> {
  const envelope = await createCheckpointEnvelope({
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex: 0,
    workerId: workerId('owned-boundary-worker'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: MANIFEST_DIGEST,
    formatVersion: FORMAT_VERSION,
    payload: new Uint8Array([1, 2, 3, 4]),
    ttlMs: 60_000,
    createdAt: 1_000,
  });

  return {
    envelope,
    expected: {
      requestId: envelope.requestId,
      segmentIndex: envelope.segmentIndex,
      workerId: envelope.workerId,
      workerGeneration: envelope.workerGeneration,
      modelManifestDigest: envelope.modelManifestDigest,
      formatVersion: envelope.formatVersion,
      maxPayloadBytes: 1024,
      now: envelope.createdAt + 1,
    },
  };
}

function changingGetter(
  target: Record<string, unknown>,
  field: string,
  first: unknown,
  second: unknown,
  reads: Record<string, number>,
): void {
  Object.defineProperty(target, field, {
    configurable: true,
    enumerable: true,
    get() {
      const count = (reads[field] ?? 0) + 1;
      reads[field] = count;
      return count === 1 ? first : second;
    },
  });
}

describe('validateCheckpointEnvelope owned runtime boundary', () => {
  it('reads each scoped envelope field once and binds later checks to the captured values', async () => {
    const { envelope, expected } = await fixture();
    const hostile = { ...envelope } as Record<string, unknown>;
    const reads: Record<string, number> = {};

    changingGetter(hostile, 'requestId', envelope.requestId, generateRequestId(), reads);
    changingGetter(hostile, 'attemptId', envelope.attemptId, '', reads);
    changingGetter(hostile, 'workerId', envelope.workerId, workerId('altered-worker'), reads);
    changingGetter(hostile, 'workerGeneration', envelope.workerGeneration, generateWorkerGeneration(), reads);
    changingGetter(hostile, 'formatVersion', envelope.formatVersion, 'altered-format', reads);
    changingGetter(hostile, 'segmentIndex', envelope.segmentIndex, 99, reads);
    changingGetter(hostile, 'payload', envelope.payload, new Uint8Array([9, 9, 9, 9]), reads);
    changingGetter(hostile, 'payloadLength', envelope.payloadLength, 3, reads);
    changingGetter(hostile, 'modelManifestDigest', envelope.modelManifestDigest, 'e'.repeat(64), reads);
    changingGetter(hostile, 'payloadDigest', envelope.payloadDigest, 'f'.repeat(64), reads);
    changingGetter(hostile, 'previousCheckpointDigest', envelope.previousCheckpointDigest, 'not-a-digest', reads);
    changingGetter(hostile, 'createdAt', envelope.createdAt, Number.NaN, reads);
    changingGetter(hostile, 'ttlMs', envelope.ttlMs, Number.NaN, reads);

    await expect(validateCheckpointEnvelope(hostile as unknown as CheckpointEnvelope, expected))
      .resolves.toEqual({ ok: true });

    expect(reads).toEqual({
      requestId: 1,
      attemptId: 1,
      workerId: 1,
      workerGeneration: 1,
      formatVersion: 1,
      segmentIndex: 1,
      payload: 1,
      payloadLength: 1,
      modelManifestDigest: 1,
      payloadDigest: 1,
      previousCheckpointDigest: 1,
      createdAt: 1,
      ttlMs: 1,
    });
  });

  it('reads each expected comparison field once', async () => {
    const { envelope, expected } = await fixture();
    const hostile = { ...expected } as Record<string, unknown>;
    const reads: Record<string, number> = {};

    changingGetter(hostile, 'requestId', expected.requestId, generateRequestId(), reads);
    changingGetter(hostile, 'segmentIndex', expected.segmentIndex, 99, reads);
    changingGetter(hostile, 'workerId', expected.workerId, workerId('altered-worker'), reads);
    changingGetter(hostile, 'workerGeneration', expected.workerGeneration, generateWorkerGeneration(), reads);
    changingGetter(hostile, 'modelManifestDigest', expected.modelManifestDigest, 'e'.repeat(64), reads);
    changingGetter(hostile, 'formatVersion', expected.formatVersion, 'altered-format', reads);
    changingGetter(hostile, 'maxPayloadBytes', expected.maxPayloadBytes, 0, reads);
    changingGetter(hostile, 'now', expected.now, Number.POSITIVE_INFINITY, reads);

    await expect(validateCheckpointEnvelope(envelope, hostile as unknown as CheckpointExpected))
      .resolves.toEqual({ ok: true });

    expect(reads).toEqual({
      requestId: 1,
      segmentIndex: 1,
      workerId: 1,
      workerGeneration: 1,
      modelManifestDigest: 1,
      formatVersion: 1,
      maxPayloadBytes: 1,
      now: 1,
    });
  });

  it('does not enumerate an accessor/Proxy-backed envelope', async () => {
    const { envelope, expected } = await fixture();
    const proxy = new Proxy(envelope, {
      ownKeys() {
        throw new Error('validateCheckpointEnvelope must not enumerate caller-owned envelopes');
      },
    });

    await expect(validateCheckpointEnvelope(proxy, expected)).resolves.toEqual({ ok: true });
  });

  it('rejects an oversized payload before digest allocation/work', async () => {
    const { envelope, expected } = await fixture();
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    try {
      const result = await validateCheckpointEnvelope(envelope, {
        ...expected,
        maxPayloadBytes: envelope.payloadLength - 1,
      });
      expect(result).toEqual({
        ok: false,
        code: 'checkpoint-integrity-mismatch',
        message: `checkpoint payload ${envelope.payloadLength}B exceeds the ${envelope.payloadLength - 1}B limit`,
      });
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it('hashes an owned payload copy rather than the caller-owned bytes', async () => {
    const { envelope, expected } = await fixture();
    const callerPayload = envelope.payload;
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestInput: BufferSource | undefined;
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      digestInput = data;
      return originalDigest(algorithm, data);
    });

    try {
      await expect(validateCheckpointEnvelope(envelope, expected)).resolves.toEqual({ ok: true });
      expect(digestInput).toBeInstanceOf(Uint8Array);
      expect(digestInput).not.toBe(callerPayload);
      expect(Array.from(digestInput as Uint8Array)).toEqual(Array.from(callerPayload));
    } finally {
      digest.mockRestore();
    }
  });

  it('keeps the existing request-mismatch message while using captured values', async () => {
    const { envelope, expected } = await fixture();
    const otherRequestId = generateRequestId();
    const result = await validateCheckpointEnvelope(
      { ...envelope, requestId: otherRequestId },
      expected,
    );

    expect(result).toEqual({
      ok: false,
      code: 'checkpoint-integrity-mismatch',
      message: `checkpoint belongs to request ${otherRequestId}, expected ${expected.requestId}`,
    });
  });
});
