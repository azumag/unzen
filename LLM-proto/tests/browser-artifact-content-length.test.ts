import { describe, expect, it, vi } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

function structuralResponse(contentLength: unknown) {
  const cancel = vi.fn();
  const getReader = vi.fn(() => ({
    read: vi.fn(async () => ({ done: true, value: undefined })),
    cancel: vi.fn(),
    releaseLock: vi.fn(),
  }));
  return {
    response: {
      headers: { get: vi.fn(() => contentLength) },
      body: { cancel, getReader },
    },
    cancel,
    getReader,
  };
}

describe('artifact Content-Length runtime contract', () => {
  it.each(['', ' 4', '4 ', '+4', '-1', '1e1', '0x10', '1.5'])
    ('rejects non-decimal Content-Length syntax %j before reader acquisition', async (raw) => {
      const { response, cancel, getReader } = structuralResponse(raw);
      await expect(readResponseBytesBounded(response, { maxBytes: 100 }))
        .rejects.toThrow(`invalid Content-Length: ${raw}`);
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    });

  it.each([undefined, 4, true])
    ('rejects non-string Content-Length %s before reader acquisition', async (raw) => {
      const { response, cancel, getReader } = structuralResponse(raw);
      await expect(readResponseBytesBounded(response, { maxBytes: 100 }))
        .rejects.toThrow(/invalid Content-Length/);
      expect(getReader).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
    });

  it('does not invoke coercion hooks while rejecting a malformed Content-Length value', async () => {
    const primitive = vi.fn(() => {
      throw new Error('coercion must not run');
    });
    const toString = vi.fn(() => {
      throw new Error('string coercion must not run');
    });
    const raw = {
      [Symbol.toPrimitive]: primitive,
      toString,
    };
    const { response, cancel, getReader } = structuralResponse(raw);

    await expect(readResponseBytesBounded(response, { maxBytes: 100 }))
      .rejects.toThrow('invalid Content-Length: [object]');
    expect(primitive).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects decimal digit strings outside the safe-integer range', async () => {
    const { response, cancel, getReader } = structuralResponse('9007199254740992');
    await expect(readResponseBytesBounded(response, { maxBytes: Number.MAX_SAFE_INTEGER }))
      .rejects.toThrow('invalid Content-Length: 9007199254740992');
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts leading zeroes as decimal syntax and applies the byte limit numerically', async () => {
    const { response, cancel, getReader } = structuralResponse('0005');
    await expect(readResponseBytesBounded(response, { maxBytes: 4 }))
      .rejects.toThrow('artifact exceeds byte limit before body read for artifact: 5 > 4');
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('treats null as an absent Content-Length', async () => {
    const { response, cancel, getReader } = structuralResponse(null);
    await expect(readResponseBytesBounded(response, { maxBytes: 4 }))
      .resolves.toEqual(new Uint8Array());
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
  });
});
