import { describe, expect, it, vi } from 'vitest';
import {
  createCheckpointEnvelope,
  verifyCheckpointDigest,
} from '../src/checkpoint-envelope.js';
import type { CreateCheckpointEnvelopeInput } from '../src/checkpoint-envelope.js';
import { generateAttemptId, generateRequestId, generateWorkerGeneration } from '../src/ids.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);

function baseInput(payload: Uint8Array): CreateCheckpointEnvelopeInput {
  return {
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex: 0,
    workerId: workerId('create-owned-worker'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: MANIFEST_DIGEST,
    formatVersion: 'float16',
    payload,
    ttlMs: 60_000,
    createdAt: 1_000,
  };
}

describe('createCheckpointEnvelope owned payload snapshot', () => {
  it('reads the caller payload once and binds digest, length, and returned bytes to that value', async () => {
    const first = new Uint8Array([1, 2, 3, 4]);
    const second = new Uint8Array([9, 9, 9, 9]);
    const input = { ...baseInput(first) } as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(input, 'payload', {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? first : second;
      },
    });

    const envelope = await createCheckpointEnvelope(input as unknown as CreateCheckpointEnvelopeInput);

    expect(reads).toBe(1);
    expect(Array.from(envelope.payload)).toEqual([1, 2, 3, 4]);
    expect(envelope.payload).not.toBe(first);
    expect(envelope.payload).not.toBe(second);
    expect(envelope.payloadLength).toBe(4);
    await expect(verifyCheckpointDigest(envelope)).resolves.toBe(true);
  });

  it('owns caller bytes before the async digest boundary', async () => {
    const callerPayload = new Uint8Array([1, 2, 3, 4]);
    const creation = createCheckpointEnvelope(baseInput(callerPayload));

    callerPayload[0] = 9;
    const envelope = await creation;

    expect(Array.from(envelope.payload)).toEqual([1, 2, 3, 4]);
    expect(envelope.payload).not.toBe(callerPayload);
    await expect(verifyCheckpointDigest(envelope)).resolves.toBe(true);
  });

  it('returns an envelope buffer independent from later caller mutation', async () => {
    const callerPayload = new Uint8Array([5, 6, 7, 8]);
    const envelope = await createCheckpointEnvelope(baseInput(callerPayload));

    callerPayload.fill(0);

    expect(Array.from(envelope.payload)).toEqual([5, 6, 7, 8]);
    await expect(verifyCheckpointDigest(envelope)).resolves.toBe(true);
  });

  it('hashes the same owned byte object that is returned in the envelope', async () => {
    const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    let digestInput: BufferSource | undefined;
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      digestInput = data;
      return originalDigest(algorithm, data);
    });

    try {
      const callerPayload = new Uint8Array([2, 4, 6, 8]);
      const envelope = await createCheckpointEnvelope(baseInput(callerPayload));
      expect(digestInput).toBe(envelope.payload);
      expect(envelope.payload).not.toBe(callerPayload);
    } finally {
      digest.mockRestore();
    }
  });

  it('rejects malformed runtime payloads before hashing', async () => {
    const input = { ...baseInput(new Uint8Array([1])), payload: { byteLength: 1 } };
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
    try {
      await expect(createCheckpointEnvelope(input as unknown as CreateCheckpointEnvelopeInput))
        .rejects.toThrow('checkpoint payload must be a Uint8Array');
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it('does not enumerate caller-owned input objects', async () => {
    const input = baseInput(new Uint8Array([1, 3, 5, 7]));
    const proxy = new Proxy(input, {
      ownKeys() {
        throw new Error('createCheckpointEnvelope must not enumerate caller input');
      },
    });

    const envelope = await createCheckpointEnvelope(proxy);
    expect(Array.from(envelope.payload)).toEqual([1, 3, 5, 7]);
    await expect(verifyCheckpointDigest(envelope)).resolves.toBe(true);
  });
});
