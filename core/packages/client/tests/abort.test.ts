import { describe, expect, it, vi } from 'vitest';
import { UnzenCancelledError } from '@unzen/shared';
import { raceWithAbort } from '../src/abort';

describe('abort helpers', () => {
  it('settles the source result even when listener cleanup throws', async () => {
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(() => {
        throw new Error('cleanup failed');
      }),
    } as unknown as AbortSignal;

    await expect(raceWithAbort(Promise.resolve(42), signal)).resolves.toBe(42);
    expect(signal.removeEventListener).toHaveBeenCalledOnce();
  });

  it('rejects promptly when listener registration throws', async () => {
    const signal = {
      aborted: false,
      addEventListener: vi.fn(() => {
        throw new Error('registration failed');
      }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(raceWithAbort(Promise.resolve(42), signal))
      .rejects.toThrow('signal could not be subscribed');
  });

  it('observes an abort that happens during listener registration', async () => {
    let aborted = false;
    const signal = {
      get aborted() {
        return aborted;
      },
      addEventListener: vi.fn(() => {
        aborted = true;
      }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(raceWithAbort(Promise.resolve(42), signal))
      .rejects.toThrow(UnzenCancelledError);
    expect(signal.removeEventListener).toHaveBeenCalledOnce();
  });

  it('removes a listener stored after a synchronous abort callback', async () => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const signal = {
      aborted: false,
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        if (typeof listener === 'function') listener(new Event('abort'));
        else listener.handleEvent(new Event('abort'));
        listeners.add(listener);
      },
      removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        listeners.delete(listener);
      },
    } as unknown as AbortSignal;

    await expect(raceWithAbort(new Promise(() => {}), signal))
      .rejects.toThrow(UnzenCancelledError);
    expect(listeners.size).toBe(0);
  });
});
