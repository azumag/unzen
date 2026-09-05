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
        streamController.enqueue(new Uint8Array([pulls]));
        if (pulls === 1) queueMicrotask(() => controller.abort());
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

    // Web Streams may prefetch more than one chunk before the abort microtask,
    // so do not assert an implementation-specific pull count. The contract is
    // that the reader receives cancellation and the read fails as AbortError.
    expect(cancelled).toBe(true);
  });

  it('rejects immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = new Response(new Uint8Array([1, 2, 3]));

    await expect(readResponseBytesBounded(response, {
      maxBytes: 100,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
