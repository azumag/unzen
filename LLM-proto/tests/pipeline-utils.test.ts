/**
 * Tests for abortable timeout / signal propagation (issue #103 deliverable 6).
 *
 * The timeout must abort the underlying execution (via AbortSignal), not just
 * orphan the promise. External abort must surface as user cancellation; a
 * timeout must surface as SegmentTimeoutError.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { withAbortableTimeout, withTimeout, delay } from '../src/pipeline-utils.js';
import { SegmentTimeoutError, ErrorCode } from '../src/errors.js';

describe('withAbortableTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes a live signal to the factory', async () => {
    let signal: AbortSignal | undefined;
    await withAbortableTimeout(
      (s) => { signal = s; return Promise.resolve(42); },
      1_000,
      'seg',
    );
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
  });

  it('aborts the underlying work when the timeout fires', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = withAbortableTimeout(
      (s) => { signal = s; return new Promise(() => {}); },
      100,
      'seg',
    );
    expect(signal!.aborted).toBe(false);
    const assertion = expect(pending).rejects.toThrow(SegmentTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal!.aborted).toBe(true);
    await assertion;
  });

  it('propagates an external abort as AbortError (user cancellation)', async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = withAbortableTimeout(
      (s) => { signal = s; return new Promise(() => {}); },
      10_000,
      'seg',
      controller.signal,
    );
    const assertion = expect(pending).rejects.toThrow(/AbortError/);
    controller.abort();
    expect(signal!.aborted).toBe(true);
    await assertion;
  });

  it('rejects immediately when the external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withAbortableTimeout(
        (s) => new Promise((resolve) => resolve(s.aborted ? 'started' : 'no')),
        1_000,
        'seg',
        controller.signal,
      ),
    ).rejects.toThrow(/AbortError/);
  });

  it('settles with the factory value when it completes first', async () => {
    await expect(
      withAbortableTimeout((s) => Promise.resolve('done'), 10_000, 'seg'),
    ).resolves.toBe('done');
  });

  it('timeout rejection carries the segment-timeout code', async () => {
    vi.useFakeTimers();
    const pending = withAbortableTimeout(
      () => new Promise(() => {}),
      50,
      'seg',
    );
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCode.SegmentTimeout });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

describe('legacy withTimeout / delay', () => {
  it('withTimeout still races and rejects', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 50, 'seg');
    const assertion = expect(pending).rejects.toThrow('seg timed out after 50ms');
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('delay(0) resolves immediately (fake-timer friendly)', async () => {
    vi.useFakeTimers();
    await expect(delay(0)).resolves.toBeUndefined();
  });
});
