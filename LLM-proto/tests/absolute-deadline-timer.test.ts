import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleAbsoluteDeadline } from '../src/absolute-deadline-timer.js';
import { MAX_TIMER_DELAY_MS } from '../src/pipeline-utils.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduleAbsoluteDeadline', () => {
  it('chains legacy deadlines beyond the host timer range without shortening them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const onDeadline = vi.fn();
    const deadlineAt = MAX_TIMER_DELAY_MS + 1_000;

    const cleanup = scheduleAbsoluteDeadline(deadlineAt, onDeadline);

    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMER_DELAY_MS);
    expect(onDeadline).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_000);

    await vi.advanceTimersByTimeAsync(999);
    expect(onDeadline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeadline).toHaveBeenCalledTimes(1);

    for (const call of timeoutSpy.mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    }
    cleanup();
  });

  it('preserves ordinary and already-elapsed deadlines', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const future = vi.fn();
    const elapsed = vi.fn();

    const cleanup = scheduleAbsoluteDeadline(10_025, future);
    scheduleAbsoluteDeadline(10_000, elapsed);

    expect(elapsed).toHaveBeenCalledTimes(1);
    expect(future).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    expect(future).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('cancels the currently armed chunk and prevents re-arming', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onDeadline = vi.fn();
    const cleanup = scheduleAbsoluteDeadline(MAX_TIMER_DELAY_MS + 1_000, onDeadline);

    cleanup();
    await vi.runAllTimersAsync();

    expect(onDeadline).not.toHaveBeenCalled();
  });
});
