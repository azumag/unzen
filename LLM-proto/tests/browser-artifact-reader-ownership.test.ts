import { describe, expect, it, vi } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

describe('artifact stream reader ownership', () => {
  it('snapshots reader methods once and preserves their receiver across async pulls', async () => {
    let readGetterReads = 0;
    let cancelGetterReads = 0;
    let releaseGetterReads = 0;
    let pulls = 0;
    const reader: Record<string, unknown> = {};
    const read = vi.fn(async function (this: unknown) {
      expect(this).toBe(reader);
      pulls += 1;
      return pulls === 1
        ? { done: false, value: new Uint8Array([1, 2]) }
        : { done: true, value: undefined };
    });
    const cancel = vi.fn(function (this: unknown) {
      expect(this).toBe(reader);
    });
    const releaseLock = vi.fn(function (this: unknown) {
      expect(this).toBe(reader);
    });
    Object.defineProperties(reader, {
      read: {
        get() {
          readGetterReads += 1;
          if (readGetterReads > 1) throw new Error('read method was re-read');
          return read;
        },
      },
      cancel: {
        get() {
          cancelGetterReads += 1;
          if (cancelGetterReads > 1) throw new Error('cancel method was re-read');
          return cancel;
        },
      },
      releaseLock: {
        get() {
          releaseGetterReads += 1;
          if (releaseGetterReads > 1) throw new Error('releaseLock method was re-read');
          return releaseLock;
        },
      },
    });
    const response = {
      headers: { get: () => null },
      body: { getReader: () => reader },
    };

    await expect(readResponseBytesBounded(response, {
      maxBytes: 2,
      expectedBytes: 2,
    })).resolves.toEqual(new Uint8Array([1, 2]));

    expect(readGetterReads).toBe(1);
    expect(cancelGetterReads).toBe(1);
    expect(releaseGetterReads).toBe(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('uses the captured cancel capability when a later pull violates the byte limit', async () => {
    let cancelGetterReads = 0;
    let releaseGetterReads = 0;
    const reader: Record<string, unknown> = {
      read: vi.fn(async () => ({ done: false, value: new Uint8Array([1, 2]) })),
    };
    const cancel = vi.fn(function (this: unknown) {
      expect(this).toBe(reader);
    });
    const releaseLock = vi.fn(function (this: unknown) {
      expect(this).toBe(reader);
    });
    Object.defineProperties(reader, {
      cancel: {
        get() {
          cancelGetterReads += 1;
          if (cancelGetterReads > 1) throw new Error('cancel method was re-read');
          return cancel;
        },
      },
      releaseLock: {
        get() {
          releaseGetterReads += 1;
          if (releaseGetterReads > 1) throw new Error('releaseLock method was re-read');
          return releaseLock;
        },
      },
    });
    const response = {
      headers: { get: () => null },
      body: { getReader: () => reader },
    };

    await expect(readResponseBytesBounded(response, { maxBytes: 1 }))
      .rejects.toThrow(/exceeds byte limit/);
    expect(cancelGetterReads).toBe(1);
    expect(releaseGetterReads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a throwing read getter before subscription or the first pull', async () => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = { cancel, releaseLock } as Record<string, unknown>;
    Object.defineProperty(reader, 'read', {
      get() {
        throw new Error('read getter exploded');
      },
    });
    const response = {
      headers: { get: () => null },
      body: { getReader: () => reader },
    };
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(readResponseBytesBounded(response, { signal }))
      .rejects.toThrow('artifact reader read capability could not be read');
    expect(signal.addEventListener).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a non-callable read capability before subscription', async () => {
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = { read: null, cancel, releaseLock };
    const response = {
      headers: { get: () => null },
      body: { getReader: () => reader },
    };
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(readResponseBytesBounded(response, { signal }))
      .rejects.toThrow('artifact reader read capability must be a function');
    expect(signal.addEventListener).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
