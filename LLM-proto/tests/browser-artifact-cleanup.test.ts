import { describe, expect, it, vi } from 'vitest';
import { readResponseBytesBounded } from '../browser-harness/webgpu-2b-split/artifact-cache.js';

describe('artifact body ownership and cleanup', () => {
  it.each(['5', 'invalid', '1.5'])('cancels a body rejected by Content-Length %s', async (length) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { headers: { 'Content-Length': length } });
    await expect(readResponseBytesBounded(response, { maxBytes: 4 })).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  it('releases an unread response when its caller has already aborted', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    controller.abort();
    await expect(readResponseBytesBounded(new Response(body), {
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized tee branch without waiting for its sibling to cancel', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    });
    const [reading, sibling] = source.tee();
    let outcome: unknown;
    const pending = readResponseBytesBounded(new Response(reading), { maxBytes: 1 })
      .then(() => { outcome = 'unexpected success'; }, (error) => { outcome = error; });
    try {
      // Drain this event-loop turn, not a wall-clock timeout. Tee cancellation
      // itself cannot settle until the sibling cancels; rejecting must not wait.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/exceeds byte limit/);
      expect(reading.locked).toBe(false);
    } finally {
      await sibling.cancel();
      await pending;
    }
  });

  it('owns each byte chunk before a producer reuses its buffer', async () => {
    const buffer = new Uint8Array([1, 2]);
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) controller.enqueue(buffer);
        else if (pulls === 1) {
          buffer.set([3, 4]);
          controller.enqueue(buffer);
        } else controller.close();
        pulls++;
      },
    }, { highWaterMark: 0 });
    const bytes = await readResponseBytesBounded(new Response(body), {
      maxBytes: 4, expectedBytes: 4,
    });
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('rejects non-byte chunks instead of coercing them into an allocation', async () => {
    const cancel = vi.fn();
    let sent = false;
    const body = new ReadableStream({
      pull(controller) {
        if (sent) controller.close();
        else { sent = true; controller.enqueue([1, 2]); }
      },
      cancel,
    }, { highWaterMark: 0 });
    await expect(readResponseBytesBounded(new Response(body), { maxBytes: 4 }))
      .rejects.toThrow(/non-byte chunk/);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});
