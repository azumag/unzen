import { describe, expect, it, vi } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

describe('artifact response body ownership', () => {
  it('captures response.body and getReader once and preserves receiver identity', async () => {
    const reader = {
      read: vi.fn(async () => ({ done: true, value: undefined })),
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    };
    let bodyReads = 0;
    let getReaderReads = 0;
    const body = { cancel: vi.fn() } as {
      cancel: ReturnType<typeof vi.fn>;
      getReader?: () => typeof reader;
    };
    const getReader = vi.fn(function (this: unknown) {
      expect(this).toBe(body);
      return reader;
    });
    Object.defineProperty(body, 'getReader', {
      get() {
        getReaderReads += 1;
        if (getReaderReads > 1) throw new Error('getReader was re-read');
        return getReader;
      },
    });
    const response = {
      headers: { get: () => null },
      get body() {
        bodyReads += 1;
        if (bodyReads > 1) throw new Error('body was re-read');
        return body;
      },
    };

    await expect(readResponseBytesBounded(response)).resolves.toEqual(new Uint8Array());
    expect(bodyReads).toBe(1);
    expect(getReaderReads).toBe(1);
    expect(getReader).toHaveBeenCalledTimes(1);
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('cancels the owned body when getReader capability lookup fails', async () => {
    const cancel = vi.fn();
    const body = { cancel };
    Object.defineProperty(body, 'getReader', {
      get() {
        throw new Error('getReader getter exploded');
      },
    });
    const response = {
      headers: { get: () => null },
      body,
    };

    await expect(readResponseBytesBounded(response))
      .rejects.toThrow('artifact response getReader capability could not be read');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves an abort preflight failure when body capture for cleanup also throws', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = {
      headers: { get: () => null },
      get body() {
        throw new Error('body getter exploded');
      },
    };

    await expect(readResponseBytesBounded(response, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
