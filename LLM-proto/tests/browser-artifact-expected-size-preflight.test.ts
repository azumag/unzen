import { describe, expect, it, vi } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

describe('browser artifact expected-size preflight', () => {
  it('rejects an impossible expected size before reader acquisition or stream pulls', async () => {
    const read = vi.fn(async () => ({ done: true, value: undefined }));
    const getReader = vi.fn(() => ({
      read,
      cancel: vi.fn(),
      releaseLock: vi.fn(),
    }));
    const cancel = vi.fn(async () => {});
    const body = { getReader, cancel };
    let bodyReads = 0;
    const response = {
      headers: { get: () => null },
      get body() {
        bodyReads += 1;
        return body;
      },
    } as unknown as Response;

    await expect(readResponseBytesBounded(response, {
      maxBytes: 4,
      expectedBytes: 5,
      url: 'too-large.bin',
    })).rejects.toThrow('expectedBytes exceeds maxBytes for too-large.bin: 5 > 4');

    expect(bodyReads).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getReader).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves the impossible-size error when the cleanup body getter throws', async () => {
    const response = {
      headers: { get: () => null },
      get body() {
        throw new Error('hostile cleanup getter');
      },
    } as unknown as Response;

    await expect(readResponseBytesBounded(response, {
      maxBytes: 4,
      expectedBytes: 5,
      url: 'too-large.bin',
    })).rejects.toThrow('expectedBytes exceeds maxBytes for too-large.bin: 5 > 4');
  });

  it('keeps the initial abort boundary ahead of the impossible-size check', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = {
      headers: { get: () => null },
      body: null,
    } as unknown as Response;

    await expect(readResponseBytesBounded(response, {
      maxBytes: 4,
      expectedBytes: 5,
      url: 'too-large.bin',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
