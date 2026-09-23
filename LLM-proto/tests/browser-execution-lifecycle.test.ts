import { describe, expect, it, vi } from 'vitest';
import {
  CheckpointWaitTimeoutError,
  MAX_HOST_TIMER_DELAY_MS,
  delayWithSignal,
  ownSession,
  waitForCheckpointBounded as waitForCheckpointBoundedImpl,
} from '../browser-harness/webgpu-2b-split/execution-lifecycle.js';

function response(status: number, value: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => value,
  };
}

function waitForCheckpointBounded(options: Parameters<typeof waitForCheckpointBoundedImpl>[0]) {
  return waitForCheckpointBoundedImpl({
    ...options,
    readCheckpointResponse: async (checkpointResponse: ReturnType<typeof response>) => checkpointResponse.json(),
  });
}

describe('browser execution lifecycle', () => {
  it('can stop a checkpoint wait and does not poll again', async () => {
    const controller = new AbortController();
    let fetches = 0;
    const waiting = waitForCheckpointBounded({
      signal: controller.signal,
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      fetchCheckpoint: async () => {
        fetches += 1;
        return response(404);
      },
      sleep: async (_ms, signal) => {
        controller.abort();
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      },
    });

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetches).toBe(1);
  });

  it('closes the abort race between the initial check and listener installation', async () => {
    let abortedReads = 0;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads >= 2;
      },
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await expect(delayWithSignal(10_000, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(abortedReads).toBe(2);
  });

  it('settles normally even when caller-owned listener removal throws', async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn(() => {
      throw new Error('cleanup exploded');
    });
    const signal = {
      aborted: false,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await expect(delayWithSignal(0, signal)).resolves.toBeUndefined();
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('rejects a throwing listener subscription without leaving the delay pending', async () => {
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener() {
        throw new Error('subscription exploded');
      },
      removeEventListener,
    } as unknown as AbortSignal;

    await expect(delayWithSignal(10_000, signal)).rejects.toThrow(
      'AbortSignal could not be subscribed for delay',
    );
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('rejects when AbortSignal state becomes unreadable after subscription', async () => {
    let abortedReads = 0;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const signal = {
      get aborted() {
        abortedReads += 1;
        if (abortedReads > 1) throw new Error('state exploded');
        return false;
      },
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await expect(delayWithSignal(10_000, signal)).rejects.toThrow(
      'AbortSignal could not be subscribed for delay',
    );
    expect(abortedReads).toBe(2);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['host timer overflow', MAX_HOST_TIMER_DELAY_MS + 1],
    ['runtime string', '1'],
  ])('rejects an invalid %s direct delay before listener registration', (_name, value) => {
    const addEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener,
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    expect(() => delayWithSignal(value as number, signal)).toThrow(/delay must be a non-negative safe integer/);
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('preserves a zero millisecond direct delay', async () => {
    await expect(delayWithSignal(0)).resolves.toBeUndefined();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['runtime string', '1000'],
  ])('rejects an invalid %s checkpoint timeout before fetching', async (_name, value) => {
    const fetchCheckpoint = vi.fn(async () => response(404));
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: value as number,
      pollIntervalMs: 500,
      fetchCheckpoint,
      sleep,
    })).rejects.toThrow(/checkpoint timeout must be a positive safe integer/);
    expect(fetchCheckpoint).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['host timer overflow', MAX_HOST_TIMER_DELAY_MS + 1],
    ['runtime string', '500'],
  ])('rejects an invalid %s poll interval before fetching a checkpoint', async (_name, value) => {
    const fetchCheckpoint = vi.fn(async () => response(404));

    await expect(waitForCheckpointBounded({
      timeoutMs: 10_000,
      pollIntervalMs: value as number,
      fetchCheckpoint,
    })).rejects.toThrow(/checkpoint poll interval must be a positive safe integer/);
    expect(fetchCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['runtime string', '1000'],
  ])('rejects an invalid initial %s checkpoint clock sample before fetching', async (_name, value) => {
    const fetchCheckpoint = vi.fn(async () => response(404));
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      now: () => value as number,
      fetchCheckpoint,
      sleep,
    })).rejects.toThrow(/checkpoint clock sample must be a non-negative safe integer/);
    expect(fetchCheckpoint).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a non-function checkpoint clock before fetching', async () => {
    const fetchCheckpoint = vi.fn(async () => response(404));

    await expect(waitForCheckpointBounded({
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      now: 'clock' as unknown as () => number,
      fetchCheckpoint,
    })).rejects.toThrow('checkpoint clock must be a function');
    expect(fetchCheckpoint).not.toHaveBeenCalled();
  });

  it('preserves an initial checkpoint clock failure as the root cause', async () => {
    const clockError = new Error('clock exploded before polling');
    const fetchCheckpoint = vi.fn(async () => response(404));
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      now: () => {
        throw clockError;
      },
      fetchCheckpoint,
      sleep,
    })).rejects.toBe(clockError);
    expect(fetchCheckpoint).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects a later invalid checkpoint clock sample before sleeping', async () => {
    let clockReads = 0;
    const fetchCheckpoint = vi.fn(async () => response(404));
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      now: () => {
        clockReads += 1;
        return clockReads === 1 ? 1_000 : Number.NaN;
      },
      fetchCheckpoint,
      sleep,
    })).rejects.toThrow(/checkpoint clock sample must be a non-negative safe integer/);
    expect(fetchCheckpoint).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('preserves a later checkpoint clock failure instead of reporting a timer error', async () => {
    const clockError = new Error('clock exploded after fetch');
    let clockReads = 0;
    const fetchCheckpoint = vi.fn(async () => response(404));
    const sleep = vi.fn(async () => {});

    await expect(waitForCheckpointBounded({
      timeoutMs: 10_000,
      pollIntervalMs: 500,
      now: () => {
        clockReads += 1;
        if (clockReads > 1) throw clockError;
        return 1_000;
      },
      fetchCheckpoint,
      sleep,
    })).rejects.toBe(clockError);
    expect(fetchCheckpoint).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps the absolute timeout independent from the host timer ceiling', async () => {
    const checkpoint = { checkpointId: 'cp-long-budget' };
    const value = await waitForCheckpointBounded({
      timeoutMs: MAX_HOST_TIMER_DELAY_MS + 10_000,
      pollIntervalMs: 500,
      fetchCheckpoint: async () => response(200, checkpoint),
    });

    expect(value).toEqual(checkpoint);
  });

  it('stops at the configured checkpoint deadline', async () => {
    let now = 1_000;
    let fetches = 0;
    const waiting = waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 400,
      now: () => now,
      fetchCheckpoint: async () => {
        fetches += 1;
        return response(404);
      },
      sleep: async (ms) => {
        now += ms;
      },
    });

    await expect(waiting).rejects.toBeInstanceOf(CheckpointWaitTimeoutError);
    expect(now).toBe(2_000);
    expect(fetches).toBe(3);
  });

  it('returns immediately once the checkpoint appears', async () => {
    let fetches = 0;
    const checkpoint = { checkpointId: 'cp-1' };
    const value = await waitForCheckpointBounded({
      timeoutMs: 1_000,
      pollIntervalMs: 1,
      fetchCheckpoint: async () => {
        fetches += 1;
        return fetches === 1 ? response(404) : response(200, checkpoint);
      },
      sleep: async () => {},
    });

    expect(value).toEqual(checkpoint);
    expect(fetches).toBe(2);
  });

  it('releases an ORT session exactly once after success', async () => {
    const release = vi.fn(async () => {});
    const owner = ownSession({ release });

    expect(await owner.release()).toBe(true);
    expect(await owner.release()).toBe(false);
    expect(owner.released).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('supports try/finally release when inference throws', async () => {
    const release = vi.fn(async () => {});
    const owner = ownSession({ release });

    await expect((async () => {
      try {
        throw new Error('fake ORT run failure');
      } finally {
        await owner.release();
      }
    })()).rejects.toThrow('fake ORT run failure');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
