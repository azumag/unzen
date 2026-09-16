import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAbortableTimeout } from '../src/pipeline-utils.js';

function abortDuringSubscriptionSignal(): {
  readonly signal: AbortSignal;
  readonly addEventListener: ReturnType<typeof vi.fn>;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
} {
  let aborted = false;
  const addEventListener = vi.fn((type: string) => {
    if (type === 'abort') {
      // Model an AbortSignal that flips after the caller's first `.aborted`
      // check but before the newly registered listener becomes active. Abort
      // events are not replayed to listeners that missed dispatch.
      aborted = true;
    }
  });
  const removeEventListener = vi.fn();
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener,
    removeEventListener,
  } as unknown as AbortSignal;

  return { signal, addEventListener, removeEventListener };
}

describe('withAbortableTimeout AbortSignal registration race', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects before factory invocation when abort wins listener registration', async () => {
    vi.useFakeTimers();
    const race = abortDuringSubscriptionSignal();
    const factory = vi.fn(() => Promise.resolve('must-not-run'));

    const pending = withAbortableTimeout(factory, 10_000, 'segment', race.signal);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
    expect(race.addEventListener).toHaveBeenCalledOnce();
    expect(race.removeEventListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not invoke the factory when a structural signal calls back synchronously during registration', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const removeEventListener = vi.fn();
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type !== 'abort') return;
        aborted = true;
        if (typeof listener === 'function') listener(new Event('abort'));
        else listener.handleEvent(new Event('abort'));
      },
      removeEventListener,
    } as unknown as AbortSignal;
    const factory = vi.fn(() => Promise.resolve('must-not-run'));

    const pending = withAbortableTimeout(factory, 10_000, 'segment', signal);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(factory).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
