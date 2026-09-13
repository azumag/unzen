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

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    '100',
  ])('rejects malformed timeout %p before arming a timer or invoking the factory', async (timeoutMs) => {
    vi.useFakeTimers();
    const factory = vi.fn(() => Promise.resolve('done'));

    const pending = withAbortableTimeout(
      factory,
      timeoutMs as unknown as number,
      'seg',
    );

    await expect(pending).rejects.toThrow('timeoutMs must be a finite non-negative number');
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves timeoutMs=0 as an immediate timeout', async () => {
    vi.useFakeTimers();
    const pending = withAbortableTimeout(
      () => new Promise(() => {}),
      0,
      'seg',
    );
    const assertion = expect(pending).rejects.toThrow(SegmentTimeoutError);

    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('rejects malformed labels before arming a timer or invoking the factory', async () => {
    vi.useFakeTimers();
    const factory = vi.fn(() => Promise.resolve('done'));

    const pending = withAbortableTimeout(
      factory,
      100,
      Symbol('seg') as unknown as string,
    );

    await expect(pending).rejects.toThrow('timeout label must be a non-empty string');
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects malformed external signals before arming a timer or invoking the factory', async () => {
    vi.useFakeTimers();
    const factory = vi.fn(() => Promise.resolve('done'));
    const malformedSignal = {
      aborted: false,
      addEventListener: null,
      removeEventListener: () => {},
    } as unknown as AbortSignal;

    const pending = withAbortableTimeout(factory, 100, 'seg', malformedSignal);

    await expect(pending).rejects.toThrow(
      'timeout signal must expose boolean aborted and callable addEventListener/removeEventListener',
    );
    expect(factory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts structurally compatible cross-realm-like abort signals', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const structuralSignal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await expect(
      withAbortableTimeout(() => Promise.resolve('done'), 1_000, 'seg', structuralSignal),
    ).resolves.toBe('done');
    expect(addEventListener).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it('rejects non-callable factories before arming a timer', async () => {
    vi.useFakeTimers();

    const pending = withAbortableTimeout(
      null as unknown as (signal: AbortSignal) => Promise<unknown>,
      100,
      'seg',
    );

    await expect(pending).rejects.toThrow('timeout factory must be a function');
    expect(vi.getTimerCount()).toBe(0);
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
