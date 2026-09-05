import { describe, expect, it } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

describe('browser artifact abort', () => {
  it('cancels a streamed artifact read after AbortSignal fires', async () => {
    const controller = new AbortController();
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(streamController) {
        pulls += 1;
        if (pulls === 1) {
          streamController.enqueue(new Uint8Array([1, 2, 3]));
          queueMicrotask(() => controller.abort());
          return;
        }
        streamController.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(stream);

    await expect(readResponseBytesBounded(response, {
      maxBytes: 100,
      signal: controller.signal,
      url: 'abort-fixture',
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(2);
  });

  it('rejects before reading when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let pulled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() {
        pulled = true;
      },
    }));

    await expect(readResponseBytesBounded(response, {
      maxBytes: 100,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pulled).toBe(false);
  });
});
