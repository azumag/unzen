import { describe, expect, it } from 'vitest';
import {
  createCheckpointEnvelope,
  sha256Hex,
  validateCheckpointEnvelope,
  verifyCheckpointDigest,
  type CheckpointEnvelope,
  type CheckpointExpected,
  type CreateCheckpointEnvelopeInput,
} from '../src/checkpoint-envelope.js';
import { generateAttemptId, generateRequestId, generateWorkerGeneration } from '../src/ids.js';
import { workerId } from '../src/types.js';

const MANIFEST_DIGEST = 'd'.repeat(64);
const FORMAT_VERSION = 'float16';

function baseInput(payload: Uint8Array): CreateCheckpointEnvelopeInput {
  return {
    requestId: generateRequestId(),
    attemptId: generateAttemptId(),
    segmentIndex: 0,
    workerId: workerId('byte-boundary-worker'),
    workerGeneration: generateWorkerGeneration(),
    modelManifestDigest: MANIFEST_DIGEST,
    formatVersion: FORMAT_VERSION,
    payload,
    ttlMs: 60_000,
    createdAt: 1_000,
  };
}

function expectedFor(envelope: CheckpointEnvelope): CheckpointExpected {
  return {
    requestId: envelope.requestId,
    segmentIndex: envelope.segmentIndex,
    workerId: envelope.workerId,
    workerGeneration: envelope.workerGeneration,
    modelManifestDigest: envelope.modelManifestDigest,
    formatVersion: envelope.formatVersion,
    maxPayloadBytes: 1024,
    now: envelope.createdAt + 1,
  };
}

function hostileSubclass(bytes = [1, 2, 3, 4]): Uint8Array {
  class CheckpointBytes extends Uint8Array {}
  const payload = new CheckpointBytes(bytes);
  Object.defineProperty(payload, 'byteLength', {
    get() {
      throw new Error('checkpoint boundary must not read caller byteLength hooks');
    },
  });
  Object.defineProperty(payload, 'slice', {
    value() {
      throw new Error('checkpoint boundary must not invoke caller slice hooks');
    },
  });
  Object.defineProperty(payload, Symbol.iterator, {
    value() {
      throw new Error('checkpoint boundary must not iterate caller bytes');
    },
  });
  return payload;
}

function detachPayload(payload: Uint8Array): void {
  const buffer = payload.buffer as ArrayBuffer;
  structuredClone(buffer, { transfer: [buffer] });
}

describe('checkpoint envelope byte runtime boundary', () => {
  it('rejects Proxy-wrapped typed arrays without leaking native internal-slot errors', async () => {
    const proxied = new Proxy(new Uint8Array([1, 2, 3, 4]), {});

    await expect(createCheckpointEnvelope(baseInput(proxied as unknown as Uint8Array)))
      .rejects.toThrow('checkpoint payload must be a Uint8Array');
    await expect(sha256Hex(proxied as unknown as Uint8Array))
      .rejects.toThrow('SHA-256 input must be a Uint8Array');
  });

  it('fails verify and validate closed for Proxy-wrapped envelope payloads', async () => {
    const envelope = await createCheckpointEnvelope(baseInput(new Uint8Array([1, 2, 3, 4])));
    const proxied = new Proxy(envelope.payload, {});
    const hostile = { ...envelope, payload: proxied as unknown as Uint8Array };

    await expect(verifyCheckpointDigest(hostile)).resolves.toBe(false);
    await expect(validateCheckpointEnvelope(hostile, expectedFor(envelope))).resolves.toEqual({
      ok: false,
      code: 'checkpoint-integrity-mismatch',
      message: 'checkpoint payload must be a Uint8Array',
    });
  });

  it('accepts genuine subclasses without invoking caller-controlled byte hooks', async () => {
    const payload = hostileSubclass();
    const envelope = await createCheckpointEnvelope(baseInput(payload));

    expect(envelope.payload).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(Object.getPrototypeOf(envelope.payload)).toBe(Uint8Array.prototype);
    await expect(sha256Hex(payload)).resolves.toBe(envelope.payloadDigest);
  });

  it('verifies and validates genuine hostile subclasses using intrinsic byte operations', async () => {
    const envelope = await createCheckpointEnvelope(baseInput(new Uint8Array([1, 2, 3, 4])));
    const hostile = { ...envelope, payload: hostileSubclass() };

    await expect(verifyCheckpointDigest(hostile)).resolves.toBe(true);
    await expect(validateCheckpointEnvelope(hostile, expectedFor(envelope))).resolves.toEqual({
      ok: true,
    });
  });

  it('fails digest verification closed if a later getter detaches the captured payload', async () => {
    const envelope = await createCheckpointEnvelope(baseInput(new Uint8Array([1, 2, 3, 4])));
    const hostile = { ...envelope } as CheckpointEnvelope;
    Object.defineProperty(hostile, 'payloadDigest', {
      configurable: true,
      enumerable: true,
      get() {
        detachPayload(envelope.payload);
        return envelope.payloadDigest;
      },
    });

    await expect(verifyCheckpointDigest(hostile)).resolves.toBe(false);
  });

  it('returns an integrity mismatch if expected metadata detaches payload before validation copy', async () => {
    const envelope = await createCheckpointEnvelope(baseInput(new Uint8Array([1, 2, 3, 4])));
    const expected = expectedFor(envelope);
    Object.defineProperty(expected, 'now', {
      configurable: true,
      enumerable: true,
      get() {
        detachPayload(envelope.payload);
        return envelope.createdAt + 1;
      },
    });

    await expect(validateCheckpointEnvelope(envelope, expected)).resolves.toEqual({
      ok: false,
      code: 'checkpoint-integrity-mismatch',
      message: 'checkpoint payload digest mismatch',
    });
  });
});
