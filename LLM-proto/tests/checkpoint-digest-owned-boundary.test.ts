import { describe, expect, it, vi } from 'vitest';
import {
  createCheckpointEnvelope,
  verifyCheckpointDigest,
} from '../src/checkpoint-envelope.js';
import type { CheckpointEnvelope } from '../src/checkpoint-envelope.js';
import { generateAttemptId, generateRequestId, generateWorkerGeneration } from '../src/ids.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);

async function fixture(): Promise<CheckpointEnvelope> {
  return createCheckpointEnvelope({
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex: 0,
    workerId: workerId('digest-owned-worker'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: MANIFEST_DIGEST,
    formatVersion: 'float16',
    payload: new Uint8Array([1, 2, 3, 4]),
    ttlMs: 60_000,
    createdAt: 1_000,
  });
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

describe('verifyCheckpointDigest owned runtime boundary', () => {
  it('reads payload, payloadLength, and payloadDigest once and binds verification to captured values', async () => {
    const envelope = await fixture();
    const hostile = { ...envelope } as Record<string, unknown>;
    const reads: Record<string, number> = {};

    changingGetter(hostile, 'payload', envelope.payload, new Uint8Array([9, 9, 9, 9]), reads);
    changingGetter(hostile, 'payloadLength', envelope.payloadLength, 0, reads);
    changingGetter(hostile, 'payloadDigest', envelope.payloadDigest, 'f'.repeat(64), reads);

    await expect(verifyCheckpointDigest(hostile as unknown as CheckpointEnvelope)).resolves.toBe(true);
    expect(reads).toEqual({ payload: 1, payloadLength: 1, payloadDigest: 1 });
  });

  it('does not enumerate caller-owned envelopes', async () => {
    const envelope = await fixture();
    const proxy = new Proxy(envelope, {
      ownKeys() {
        throw new Error('verifyCheckpointDigest must not enumerate caller-owned envelopes');
      },
    });

    await expect(verifyCheckpointDigest(proxy)).resolves.toBe(true);
  });

  it('fails closed when a scoped getter throws', async () => {
    const envelope = await fixture();
    const hostile = { ...envelope } as Record<string, unknown>;
    Object.defineProperty(hostile, 'payloadLength', {
      enumerable: true,
      get() {
        throw new Error('hostile getter');
      },
    });

    await expect(verifyCheckpointDigest(hostile as unknown as CheckpointEnvelope)).resolves.toBe(false);
  });

  it.each([
    ['payload', { byteLength: 4 }],
    ['payloadLength', Number.NaN],
    ['payloadLength', -1],
    ['payloadLength', '4'],
    ['payloadDigest', 'not-a-digest'],
    ['payloadDigest', Symbol('digest')],
  ] as const)('fails closed on malformed runtime %s values', async (field, value) => {
    const envelope = await fixture();
    const malformed = { ...envelope, [field]: value } as unknown as CheckpointEnvelope;
    await expect(verifyCheckpointDigest(malformed)).resolves.toBe(false);
  });

  it('still rejects byte-length and digest mismatches', async () => {
    const envelope = await fixture();
    await expect(verifyCheckpointDigest({ ...envelope, payloadLength: envelope.payloadLength + 1 }))
      .resolves.toBe(false);
    await expect(verifyCheckpointDigest({ ...envelope, payload: new Uint8Array([1, 2, 3, 5]) }))
      .resolves.toBe(false);
  });

  it('passes only an owned byte copy across the asynchronous digest boundary', async () => {
    const envelope = await fixture();
    const callerPayload = envelope.payload;
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestInput: BufferSource | undefined;

    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      digestInput = data;
      await Promise.resolve();
      return originalDigest(algorithm, data);
    });

    try {
      const verification = verifyCheckpointDigest(envelope);
      callerPayload[0] = 9;

      await expect(verification).resolves.toBe(true);
      expect(digestInput).toBeInstanceOf(Uint8Array);
      expect(digestInput).not.toBe(callerPayload);
      expect(Array.from(digestInput as Uint8Array)).toEqual([1, 2, 3, 4]);
    } finally {
      digest.mockRestore();
    }
  });
});
