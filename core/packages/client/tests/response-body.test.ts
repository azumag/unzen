import { describe, expect, it, vi } from 'vitest';
import {
  readBoundedJsonResponse,
  readBoundedResponseBytes,
} from '../src/response-body';

describe('bounded response bodies', () => {
  it('rejects an oversized declared length without reading the body', async () => {
    const readBody = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = {
      headers: new Headers({ 'Content-Length': '11' }),
      body,
      arrayBuffer: readBody,
    } as unknown as Response;

    await expect(readBoundedResponseBytes(response, 10, 'Test response'))
      .rejects.toThrow('Test response exceeds 10 bytes');
    expect(readBody).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it('cancels a chunked body when its actual bytes exceed the limit', async () => {
    let pullCount = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      headers: { 'Content-Length': '1' },
    });

    await expect(readBoundedResponseBytes(response, 5, 'Chunked response'))
      .rejects.toThrow('Chunked response exceeds 5 bytes');
    expect(pullCount).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('rejects invalid UTF-8 JSON from a byte-readable response', async () => {
    const response = new Response(new Uint8Array([0xff]));

    await expect(readBoundedJsonResponse(response, 10, 'JSON response'))
      .rejects.toThrow('not valid UTF-8');
  });

  it('post-checks adapters that expose only json()', async () => {
    const response = {
      headers: new Headers(),
      json: async () => ({ value: 'too large' }),
    } as unknown as Response;

    await expect(readBoundedJsonResponse(response, 10, 'JSON response'))
      .rejects.toThrow('JSON response exceeds 10 bytes');
  });

  it('returns an owned copy from arrayBuffer-only adapters', async () => {
    const source = new Uint8Array([1, 2, 3]).buffer;
    const response = {
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => source,
    } as unknown as Response;

    const result = await readBoundedResponseBytes(response, 10, 'Byte response');
    new Uint8Array(source)[0] = 9;

    expect(result).not.toBe(source);
    expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
  });

  it('rejects a non-ArrayBuffer returned by an arrayBuffer adapter', async () => {
    const response = {
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => ({ byteLength: 1 }),
    } as unknown as Response;

    await expect(readBoundedResponseBytes(response, 10, 'Byte response'))
      .rejects.toThrow('body cannot be read');
  });

  it('cancels a stream that yields a non-byte chunk', async () => {
    let cancelled = false;
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue({ byteLength: 1, slice: () => new Uint8Array([1]) });
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = { headers: new Headers(), body } as unknown as Response;

    await expect(readBoundedResponseBytes(response, 10, 'Byte response'))
      .rejects.toThrow('non-byte chunk');
    expect(cancelled).toBe(true);
  });

  it('preserves the body error when custom reader cleanup throws', async () => {
    const reader = {
      read: vi.fn().mockResolvedValue({
        done: false,
        value: { byteLength: 1 },
      }),
      cancel: vi.fn(() => { throw new Error('cancel failed'); }),
      releaseLock: vi.fn(() => { throw new Error('release failed'); }),
    };
    const response = {
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;

    await expect(readBoundedResponseBytes(response, 10, 'Byte response'))
      .rejects.toThrow('non-byte chunk');
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it('does not let release cleanup invalidate captured bytes', async () => {
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2, 3]) })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(),
      releaseLock: vi.fn(() => { throw new Error('release failed'); }),
    };
    const response = {
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;

    await expect(readBoundedResponseBytes(response, 10, 'Byte response'))
      .resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(reader.cancel).not.toHaveBeenCalled();
  });

  it('round-trips json-only adapter payloads into an owned wire snapshot', async () => {
    const nested = { value: 1 };
    const response = {
      headers: new Headers(),
      json: async () => ({ result: nested }),
    } as unknown as Response;

    const result = await readBoundedJsonResponse(response, 100, 'JSON response') as {
      result: { value: number };
    };
    nested.value = 2;

    expect(result).toEqual({ result: { value: 1 } });
    expect(result.result).not.toBe(nested);
  });
});
