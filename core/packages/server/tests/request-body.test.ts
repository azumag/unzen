import { describe, expect, it } from 'vitest';
import {
  readBoundedJsonRequest,
  RequestBodyLimitError,
} from '../src/request-body';

describe('bounded request bodies', () => {
  it('parses a JSON request within the byte limit', async () => {
    const request = new Request('https://example.com/exec', {
      method: 'POST',
      body: JSON.stringify({ args: [1, 2] }),
    });

    await expect(readBoundedJsonRequest(request, 100, 'Test request'))
      .resolves.toEqual({ args: [1, 2] });
  });

  it('cancels a request rejected by its declared length', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const request = {
      headers: new Headers({ 'Content-Length': '11' }),
      body,
    } as unknown as Request;

    await expect(readBoundedJsonRequest(request, 10, 'Declared request'))
      .rejects.toThrow(RequestBodyLimitError);
    expect(cancelled).toBe(true);
  });

  it('cancels a chunked request when actual bytes exceed the limit', async () => {
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
    const request = {
      headers: new Headers({ 'Content-Length': '1' }),
      body,
    } as unknown as Request;

    await expect(readBoundedJsonRequest(request, 5, 'Chunked request'))
      .rejects.toThrow(RequestBodyLimitError);
    expect(pullCount).toBe(2);
    expect(cancelled).toBe(true);
  });
});
