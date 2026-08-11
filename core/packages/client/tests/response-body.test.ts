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
});
